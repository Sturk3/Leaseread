// FRONTAGE — RetailAvailability engine: a DETERMINISTIC corridor availability screen.
//
// Given a Corridor config (api/_corridors), it runs five fixed stages:
//   1. resolve_universe  — BBLs inside the corridor geometry that are retail-detected:
//                          (store BldgClass) ∪ (ground-floor retail in mixed-use, via
//                          PLUTO retail floor area / commercial overlay zoning) ∪
//                          (BBLs in the storefront registry). Filtering on K/store class
//                          alone undercounts inline retail — the union is the fix.
//   2. enrich            — PLUTO attributes; ACRIS ownership + last trade (reusing
//                          _markets/nyc.js's enrichOwnerMailing resolution chain); DOB
//                          alteration permits (BIS + DOB NOW); DCWP operating status;
//                          HPD registration contacts (the named principal).
//   3. availability_signal — composite availability_probability from storefront vacancy
//                          + active DOB alteration permit + DCWP license lapse + recent
//                          ACRIS trade, each with a human-readable reason. The storefront
//                          registry is a LEAD signal, not ground truth (self-reported,
//                          lagged, class-1 gaps) — reflected in its weight and wording.
//   4. score             — buy-box fit against corridor.buy_box, weighted by
//                          corridor.scoring_weights (the buy-box idea api/screen.js
//                          grades OMs with, made deterministic — no LLM in this pipeline).
//   5. rank_and_emit     — fixed-schema rows in a fixed order (fit desc, availability
//                          desc, bbl asc). Same config → same output shape and ordering.
//
// Dataset ids/fields rotate on NYC Open Data, so every query runs through soql(), which
// records failures in the coverage report (in-band VERIFY) instead of throwing, and wide
// $select queries fall back to full rows on a column error. Each id is env-overridable,
// matching the repo convention. Underscore folder = shared code, not a Vercel function.

import { clean, toNum, chunk } from "../_lib/util.js";
import { devFields, enrichOwnerMailing, streetClause } from "../_markets/nyc.js";
import { clipToSegment } from "./corridorgeo.js";

export const BUILD = "retailavail-v1";

const SOCRATA_BASE = "https://data.cityofnewyork.us/resource";
const PLUTO = process.env.PLUTO_DATASET || "64uk-42ks";                 // PLUTO (same id _markets/nyc.js uses)
const STOREFRONT = process.env.STOREFRONT_DATASET || "92iy-9c3n";       // Storefronts Reported Vacant or Not (confirmed)
const DOB_PERMIT = process.env.DOB_PERMIT_DATASET || "ipu4-2q9a";       // DOB Permit Issuance, legacy BIS (VERIFY — errors surface in coverage)
const DOBNOW_PERMIT = process.env.DOBNOW_PERMIT_DATASET || "rbx6-tga4"; // DOB NOW: Build — Approved Permits (VERIFY)
const DCWP_BIZ = process.env.DCWP_BIZ_DATASET || "w7w3-xahh";           // DCWP Legally Operating Businesses (VERIFY)
const HPD_REG = process.env.HPD_REG_DATASET || "tesw-yqqr";             // HPD registrations (VERIFY)
const HPD_CONTACTS = process.env.HPD_CONTACTS_DATASET || "feu5-w2e2";   // HPD registration contacts (VERIFY)

const PLUTO_BOROUGH = { manhattan: "MN", bronx: "BX", brooklyn: "BK", queens: "QN", "staten island": "SI" };
const BOROUGH_DIGIT = { manhattan: "1", bronx: "2", brooklyn: "3", queens: "4", "staten island": "5" };

const TIER_RANK = { flagship: 3, luxury: 2, boutique: 1 };
const TIER_SCORE = { flagship: 1.0, luxury: 0.85, boutique: 0.7 };

// Signal weights for the availability composite (stage 3). Storefront vacancy leads but
// doesn't dominate (lead signal, not ground truth); the four sum to 1.0 over a 0.05 base.
const SIGNAL_W = { storefront_vacant: 0.40, dob_alteration: 0.25, dcwp_lapse: 0.20, recent_trade: 0.15 };
const PERMIT_WINDOW_MONTHS = 18; // "active" alteration permit = issued/approved this recently
const TRADE_WINDOW_MONTHS = 24;  // "recent" ACRIS trade

const sodaQuote = (vals) => [...new Set(vals)].map((v) => `'${String(v).replace(/'/g, "''")}'`).join(",");

// ── coverage-aware Socrata fetch ────────────────────────────────────────────────
// Returns rows, or null on an HTTP/parse error (recorded on cov). Callers use the
// null/[] distinction to retry a wide $select as a full-row fetch (in-band VERIFY).
async function soql(dataset, params, cov) {
  cov.queries += 1;
  // Match _markets/nyc.js: the NYC account/token is disconnected — anonymous requests
  // only. Sending a dead token 403s every query (nyc.js would keep working), so a stale
  // SOCRATA_APP_TOKEN env var must not silently zero-out corridor screens.
  const token = null;
  try {
    const r = await fetch(`${SOCRATA_BASE}/${dataset}.json?${new URLSearchParams(params)}`, token ? { headers: { "X-App-Token": token } } : {});
    if (!r.ok) {
      cov.errors.push(`${dataset} HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
      return null;
    }
    return await r.json();
  } catch (e) {
    cov.errors.push(`${dataset} fetch failed: ${String(e.message).slice(0, 160)}`);
    return null;
  }
}
async function soqlWithFallback(dataset, params, cov, note) {
  let rows = await soql(dataset, params, cov);
  if (rows === null && params.$select) {
    // Column names rotate; a bad $select 400s. Retry with full rows and read defensively.
    const { $select, ...rest } = params;
    rows = await soql(dataset, rest, cov);
    if (rows !== null) cov.notes.push(`${dataset}: $select rejected (${note || "columns changed?"}) — fell back to full rows`);
  }
  return rows || [];
}

// ── street-name normalization ───────────────────────────────────────────────────
// Corridor configs use street names as people write them ("Prince St", "6th Ave");
// PLUTO addresses use the official spelled-out form ("PRINCE STREET", "AVENUE OF THE
// AMERICAS"). Normalize + alias so the config never has to know PLUTO's spelling.
const SUFFIX = { ST: "STREET", AVE: "AVENUE", AV: "AVENUE", BLVD: "BOULEVARD", RD: "ROAD", DR: "DRIVE", LN: "LANE", PL: "PLACE", SQ: "SQUARE", PKWY: "PARKWAY", TER: "TERRACE", CT: "COURT" };
const DIR = { E: "EAST", W: "WEST", N: "NORTH", S: "SOUTH" };
const STREET_ALIASES = {
  "6 AVENUE": ["AVENUE OF THE AMERICAS"],
  "AVENUE OF THE AMERICAS": ["6 AVENUE"],
  "7 AVENUE": ["FASHION AVENUE"],
};
export function normalizeStreet(s) {
  const parts = clean(s).toUpperCase().replace(/[.,'’]/g, "").split(/\s+/).filter(Boolean);
  return parts.map((tok, i) => {
    const t = tok.replace(/^(\d+)(ST|ND|RD|TH)$/, "$1"); // 6TH -> 6
    if (i === 0 && parts.length > 1 && DIR[t]) return DIR[t];
    if (i === parts.length - 1 && SUFFIX[t]) return SUFFIX[t];
    return t;
  }).join(" ");
}
const streetVariants = (street) => { const n = normalizeStreet(street); return [n, ...(STREET_ALIASES[n] || [])]; };

// The street part of a PLUTO address ("72-76 GREENE STREET" -> "GREENE STREET").
const streetPart = (address) => clean(address).toUpperCase().replace(/^\d[\dA-Z\-/]*\s+/, "");

// All PLUTO lots on a street. Exact street-name match first; if that finds nothing,
// accept directional halves (EAST/WEST HOUSTON STREET for "Houston St"). The fallback
// is all-or-nothing on purpose: "Broadway" must never absorb "WEST BROADWAY" (a
// different street), but "Houston St" must reach its EAST/WEST halves.
const PLUTO_SELECT = "bbl,borough,block,lot,address,bldgclass,ownername,latitude,longitude,lottype,lotarea,bldgarea,builtfar,residfar,commfar,facilfar,retailarea,officearea,resarea,comarea,garagearea,strgearea,factryarea,otherarea,numfloors,unitstotal,yearbuilt,zonedist1,overlay1,overlay2,spdist1,landmark,histdist,bldgfront,lotfront";
async function fetchStreetLots(street, boroCode, cov, cache) {
  const variants = streetVariants(street);
  const key = `${boroCode}|${variants[0]}`;
  if (cache.has(key)) return cache.get(key);
  const where = `borough='${boroCode}' AND (${variants.map((v) => streetClause("address", v)).join(" OR ")})`;
  const rows = await soqlWithFallback(PLUTO, { $where: where, $select: PLUTO_SELECT, $limit: "5000" }, cov, "PLUTO columns");
  const exact = rows.filter((r) => variants.includes(streetPart(r.address)));
  let lots = exact;
  if (!exact.length && rows.length) {
    lots = rows.filter((r) => variants.some((v) => {
      const p = streetPart(r.address);
      return /^(EAST|WEST|NORTH|SOUTH) /.test(p) && p.replace(/^(EAST|WEST|NORTH|SOUTH) /, "") === v;
    }));
    if (lots.length) cov.notes.push(`"${street}": no exact-name lots — using directional variants (${lots.length} lots)`);
  }
  // Socrata returns rows in no guaranteed order; sort by bbl so every downstream
  // step (geometry anchoring, tie-breaks) sees an identical sequence run to run.
  lots.sort((a, b) => clean(a.bbl).localeCompare(clean(b.bbl)));
  cache.set(key, lots);
  return lots;
}

// ── segment geometry ────────────────────────────────────────────────────────────
// Shared with the other market connectors (see _engines/corridorgeo.js): cross-street
// point clouds locate the corners, main-street lots kept if they project between them.
function clipSegment(mainLots, crossA, crossB, cov, label) {
  const pts = (rows) => rows.map((r) => ({ lat: toNum(r.latitude), lon: toNum(r.longitude), ref: r })).filter((p) => p.lat != null && p.lon != null);
  const { kept, note } = clipToSegment(pts(mainLots), pts(crossA), pts(crossB));
  if (note) cov.notes.push(`${label}: ${note}`);
  return kept;
}

// ── stage 1: resolve_universe ───────────────────────────────────────────────────
async function resolveUniverse(corridor, boroName, boroCode, cov) {
  const cache = new Map();
  const byBbl = new Map(); // bbl -> { row, street, tier, detected: Set }
  for (const seg of corridor.geometry) {
    const label = `${seg.street} (${seg.from_cross} → ${seg.to_cross})`;
    const segCov = { street: seg.street, tier: seg.tier, lots_on_street: 0, lots_in_segment: 0 };
    cov.universe.segments.push(segCov);
    if (seg.side !== "both") cov.notes.push(`${label}: side="${seg.side}" not yet supported — treated as "both"`);
    const [main, crossA, crossB] = [
      await fetchStreetLots(seg.street, boroCode, cov.sources.pluto, cache),
      await fetchStreetLots(seg.from_cross, boroCode, cov.sources.pluto, cache),
      await fetchStreetLots(seg.to_cross, boroCode, cov.sources.pluto, cache),
    ];
    segCov.lots_on_street = main.length;
    if (!main.length) { cov.notes.push(`${label}: NO lots found on street — check the street name`); continue; }
    const inSeg = clipSegment(main, crossA, crossB, cov, label);
    segCov.lots_in_segment = inSeg.length;
    for (const row of inSeg) {
      const bbl = clean(row.bbl).split(".")[0];
      if (!bbl) continue;
      const prev = byBbl.get(bbl);
      if (!prev || TIER_RANK[seg.tier] > TIER_RANK[prev.tier]) {
        byBbl.set(bbl, { row, street: seg.street, tier: seg.tier, detected: prev ? prev.detected : new Set() });
      }
    }
  }

  // Storefront registry over EVERY segment lot (not just class-filtered ones), so a
  // registry hit can pull a lot into the universe the PLUTO filters would have missed.
  const allBbls = [...byBbl.keys()];
  const storefrontByBbl = new Map(); // bbl -> registry rows
  for (const batch of chunk(allBbls, 100)) {
    const rows = await soqlWithFallback(STOREFRONT, {
      $where: `bbl in (${sodaQuote(batch)})`,
      $select: "bbl,reporting_year,vacant_on_12_31,primary_business_activity,expir_dt_of_most_recent_lease",
      $limit: "5000",
    }, cov.sources.storefront, "storefront columns");
    for (const r of rows) {
      const bbl = clean(r.bbl).split(".")[0];
      if (!bbl) continue;
      if (!storefrontByBbl.has(bbl)) storefrontByBbl.set(bbl, []);
      storefrontByBbl.get(bbl).push(r);
    }
  }

  // Retail detection: the three-way union. K/store class alone undercounts inline
  // retail in SoHo's loft/mixed-use stock, hence retail floor area + commercial
  // overlay/zoning + the registry as independent ways in.
  const universe = [];
  const det = cov.universe.retail_detected;
  for (const [bbl, u] of byBbl) {
    const r = u.row;
    const cls = clean(r.bldgclass).toUpperCase();
    const retailArea = toNum(r.retailarea) || 0;
    const comArea = toNum(r.comarea) || 0;
    const zone = clean(r.zonedist1).toUpperCase();
    const overlays = [clean(r.overlay1), clean(r.overlay2)].map((o) => o.toUpperCase());
    const commercialZoned = zone.startsWith("C") || overlays.some((o) => o.startsWith("C1") || o.startsWith("C2"));
    if (cls.startsWith("K")) { u.detected.add("store-class"); det.store_class++; }
    if (retailArea > 0) { u.detected.add("retail-floor-area"); det.retail_area++; }
    if (comArea > 0 && commercialZoned && !cls.startsWith("K")) { u.detected.add("commercial-overlay-mixed-use"); det.overlay_mixed_use++; }
    if (storefrontByBbl.has(bbl)) { u.detected.add("storefront-registry"); det.storefront_registry++; }
    if (u.detected.size) universe.push({ bbl, ...u });
  }

  // Deterministic cap so a mis-drawn corridor can't blow the serverless budget:
  // best tiers first, biggest retail area first, bbl as the stable tiebreak.
  const MAX_UNIVERSE = 450;
  universe.sort((a, b) =>
    TIER_RANK[b.tier] - TIER_RANK[a.tier] ||
    (toNum(b.row.retailarea) || 0) - (toNum(a.row.retailarea) || 0) ||
    a.bbl.localeCompare(b.bbl));
  if (universe.length > MAX_UNIVERSE) {
    cov.notes.push(`universe trimmed ${universe.length} → ${MAX_UNIVERSE} (tier, then retail SF)`);
    universe.length = MAX_UNIVERSE;
  }
  cov.universe.bbls = universe.length;
  return { universe, storefrontByBbl };
}

// ── stage 2: enrich ─────────────────────────────────────────────────────────────
const blkLotKey = (block, lot) => `${Number(block)}|${Number(lot)}`;
const monthsAgoISO = (m) => { const d = new Date(); d.setMonth(d.getMonth() - m); return d.toISOString().slice(0, 10); };

async function enrich(universe, boroName, boroDigit, cov, opts) {
  // PLUTO attributes via the same devFields the NYC search uses.
  for (const u of universe) u.pluto = devFields(u.row);

  // ACRIS ownership + last trade — REUSE the existing resolution chain from
  // _markets/nyc.js by handing it deals/contacts in its pluto shape. It fills
  // last_sale_date/price, tax_lien, and the deed grantee (current owner + mailing).
  const deals = universe.map((u) => ({ source: "pluto", deal_id: u.bbl, borough: boroName, block: clean(u.row.block), lot: clean(u.row.lot) }));
  const contacts = universe.map((u) => ({ source: "pluto", deal_id: u.bbl, name: clean(u.row.ownername), role: "owner", address: "", city: "", state: "", zip: "" }));
  // 240 ≈ the whole prime universe within the 60s serverless budget (the full
  // 16s validation run enriched 150 in ~6s); coverage reports whatever was capped.
  const enrichCap = Math.min(opts.enrichCap || 240, universe.length);
  try {
    await enrichOwnerMailing(deals, contacts, null, enrichCap); // null token — see soql() above
  } catch (e) {
    cov.sources.acris.errors.push(`enrichOwnerMailing failed: ${String(e.message).slice(0, 160)}`);
  }
  const dealByBbl = new Map(deals.map((d) => [d.deal_id, d]));
  const contactByBbl = new Map(contacts.map((c) => [c.deal_id, c]));
  for (const u of universe) {
    u.acris = dealByBbl.get(u.bbl) || {};
    const c = contactByBbl.get(u.bbl) || {};
    u.owner_entity = clean(c.deed_owner) || clean(u.row.ownername) || null;
    u.owner_mailing = [c.address, c.city, c.state, c.zip].map(clean).filter(Boolean).join(", ") || null;
  }
  cov.sources.acris.enrich_cap = enrichCap;
  cov.sources.acris.bbls_with_last_sale = universe.filter((u) => u.acris.last_sale_date).length;
  cov.sources.acris.bbls_with_deed_owner = universe.filter((u) => contactByBbl.get(u.bbl)?.deed_owner).length;

  // DOB alteration permits — legacy BIS by bbl (falls back to block+lot if the bbl
  // column is gone), plus DOB NOW approved permits by block (lot matched client-side).
  const permitsByBbl = new Map();
  const addPermit = (bbl, p) => { if (!permitsByBbl.has(bbl)) permitsByBbl.set(bbl, []); permitsByBbl.get(bbl).push(p); };
  const bbls = universe.map((u) => u.bbl);
  const bblToKey = new Map(universe.map((u) => [u.bbl, blkLotKey(u.row.block, u.row.lot)]));
  const keyToBbl = new Map(universe.map((u) => [blkLotKey(u.row.block, u.row.lot), u.bbl]));
  const permitCutoff = monthsAgoISO(PERMIT_WINDOW_MONTHS);

  for (const batch of chunk(bbls, 100)) {
    let rows = await soql(DOB_PERMIT, {
      $where: `bbl in (${sodaQuote(batch)}) AND job_type in ('A1','A2','A3')`,
      $select: "bbl,job_type,issuance_date,filing_status",
      $limit: "5000",
    }, cov.sources.dob);
    if (rows === null) {
      // bbl column missing/renamed — re-query by block (padded + unpadded) and join on
      // block|lot client-side. In-band VERIFY: the coverage errors above say why.
      const blocks = [...new Set(batch.map((b) => bblToKey.get(b).split("|")[0]))];
      const blockList = sodaQuote(blocks.flatMap((b) => [b, b.padStart(5, "0")]));
      rows = (await soql(DOB_PERMIT, {
        $where: `borough='${boroName.toUpperCase()}' AND block in (${blockList}) AND job_type in ('A1','A2','A3')`,
        $limit: "5000",
      }, cov.sources.dob)) || [];
      rows = rows.filter((r) => keyToBbl.has(blkLotKey(r.block, r.lot)));
      for (const r of rows) r.bbl = keyToBbl.get(blkLotKey(r.block, r.lot));
      cov.sources.dob.notes.push("legacy permits joined by block+lot (bbl query failed)");
    }
    for (const r of rows) {
      const bbl = clean(r.bbl).split(".")[0];
      const issued = clean(r.issuance_date).slice(0, 10);
      if (bbl && issued) addPermit(bbl, { type: clean(r.job_type), issued, source: "dob-bis" });
    }
  }
  // DOB NOW has block/lot but not always bbl; query by block, match lot client-side,
  // read fields defensively (this dataset's columns are the most VERIFY-prone here).
  {
    const blocks = [...new Set(universe.map((u) => String(Number(u.row.block))))];
    for (const batch of chunk(blocks, 60)) {
      const rows = await soqlWithFallback(DOBNOW_PERMIT, {
        $where: `upper(borough)='${boroName.toUpperCase()}' AND block in (${sodaQuote(batch.flatMap((b) => [b, b.padStart(5, "0")]))})`,
        $select: "block,lot,work_type,issued_date,approved_date,job_filing_number",
        $limit: "5000",
      }, cov.sources.dob, "DOB NOW columns");
      for (const r of rows) {
        const bbl = keyToBbl.get(blkLotKey(r.block, r.lot));
        if (!bbl) continue;
        const issued = clean(r.issued_date || r.approved_date || r.issuance_date).slice(0, 10);
        const wt = clean(r.work_type || r.job_type || "");
        // Allowlist of build-out work types. DOB NOW is dominated by maintenance noise
        // (scaffolds, sheds, fences, boilers, antennas) that says nothing about a
        // space turning over; GC/structural/demo = real alteration, and a Sign permit
        // is the classic new-tenant fit-out tell.
        if (issued && /general construction|structural|full demolition|^sign$/i.test(wt)) {
          addPermit(bbl, { type: wt, issued, source: "dob-now" });
        }
      }
    }
  }
  for (const u of universe) {
    const ps = (permitsByBbl.get(u.bbl) || []).sort((a, b) => b.issued.localeCompare(a.issued) || a.type.localeCompare(b.type));
    u.permits = ps;
    u.active_alt_permit = ps.find((p) => p.issued >= permitCutoff) || null;
  }
  cov.sources.dob.bbls_with_recent_alt = universe.filter((u) => u.active_alt_permit).length;

  // DCWP operating status: licensed businesses on the lot. A lot that HAD licenses but
  // has none active reads as an operator that folded/left — a lapse signal.
  const dcwpByBbl = new Map();
  for (const batch of chunk(bbls, 100)) {
    const rows = await soqlWithFallback(DCWP_BIZ, {
      $where: `bbl in (${sodaQuote(batch)})`,
      $select: "bbl,business_name,license_status",
      $limit: "5000",
    }, cov.sources.dcwp, "DCWP columns");
    for (const r of rows) {
      const bbl = clean(r.bbl).split(".")[0];
      if (!bbl) continue;
      if (!dcwpByBbl.has(bbl)) dcwpByBbl.set(bbl, { total: 0, active: 0, names: [] });
      const d = dcwpByBbl.get(bbl);
      d.total++;
      if (/active/i.test(clean(r.license_status))) { d.active++; if (d.names.length < 3) d.names.push(clean(r.business_name)); }
    }
  }
  for (const u of universe) {
    const d = dcwpByBbl.get(u.bbl);
    u.dcwp = d || { total: 0, active: 0, names: [] };
    u.dcwp_lapse = !!d && d.total > 0 && d.active === 0;
  }
  cov.sources.dcwp.bbls_with_licenses = dcwpByBbl.size;
  cov.sources.dcwp.bbls_lapsed = universe.filter((u) => u.dcwp_lapse).length;

  // HPD registration contacts → the named PRINCIPAL behind the owning entity (head
  // officer / individual owner / agent). Only registered buildings (residential /
  // mixed-use) have one; pure-commercial lots stay null — reported in coverage.
  const regToBbl = new Map();
  for (const batch of chunk(universe, 40)) {
    const ors = batch.map((u) => `(block=${Number(u.row.block)} AND lot=${Number(u.row.lot)})`).join(" OR ");
    const rows = await soqlWithFallback(HPD_REG, {
      $where: `boroid='${boroDigit}' AND (${ors})`,
      $select: "registrationid,block,lot",
      $limit: "5000",
    }, cov.sources.hpd, "HPD reg columns");
    for (const r of rows) {
      const bbl = keyToBbl.get(blkLotKey(r.block, r.lot));
      const rid = clean(r.registrationid);
      if (bbl && rid) regToBbl.set(rid, bbl);
    }
  }
  const principalByBbl = new Map();
  const roleRank = (t) => (/head/i.test(t) ? 0 : /individualowner|jointowner/i.test(t) ? 1 : /^officer$/i.test(t) ? 2 : /agent/i.test(t) ? 3 : 5);
  for (const batch of chunk([...regToBbl.keys()], 75)) {
    const rows = await soqlWithFallback(HPD_CONTACTS, {
      $where: `registrationid in (${sodaQuote(batch)})`,
      $select: "registrationid,type,firstname,lastname,corporationname",
      $limit: "5000",
    }, cov.sources.hpd, "HPD contacts columns");
    for (const r of rows) {
      const bbl = regToBbl.get(clean(r.registrationid));
      if (!bbl) continue;
      const person = [clean(r.firstname), clean(r.lastname)].filter(Boolean).join(" ");
      const name = person || clean(r.corporationname);
      if (!name) continue;
      const cand = { name, role: clean(r.type), isPerson: !!person, rank: roleRank(clean(r.type)) + (person ? 0 : 0.5) };
      const prev = principalByBbl.get(bbl);
      // Strictly-better rank wins; equal rank breaks on name so unordered Socrata
      // rows can't flip which principal a rerun reports.
      if (!prev || cand.rank < prev.rank || (cand.rank === prev.rank && cand.name < prev.name)) principalByBbl.set(bbl, cand);
    }
  }
  for (const u of universe) {
    const p = principalByBbl.get(u.bbl);
    u.principal = p ? p.name : null;
    u.principal_role = p ? p.role : null;
  }
  cov.sources.hpd.bbls_with_principal = principalByBbl.size;
}

// ── stage 3: availability_signal ────────────────────────────────────────────────
function availabilitySignal(universe, storefrontByBbl, cov) {
  const tradeCutoff = monthsAgoISO(TRADE_WINDOW_MONTHS);
  for (const u of universe) {
    const reasons = [];
    let p = 0.05; // baseline — nothing in NYC public data proves a space is NOT available

    const sfRows = storefrontByBbl.get(u.bbl) || [];
    if (sfRows.length) {
      const latestYear = sfRows.reduce((y, r) => Math.max(y, toNum(r.reporting_year) || 0), 0);
      const latest = sfRows.filter((r) => (toNum(r.reporting_year) || 0) === latestYear);
      const vacant = latest.filter((r) => /^y/i.test(clean(r.vacant_on_12_31)));
      u.storefront = { reporting_year: latestYear, units: latest.length, vacant_units: vacant.length };
      if (vacant.length) {
        p += SIGNAL_W.storefront_vacant;
        reasons.push(`storefront registry: ${vacant.length} of ${latest.length} unit${latest.length === 1 ? "" : "s"} reported vacant (${latestYear} filing — owner-reported, lagged; lead signal, not ground truth)`);
      }
    } else u.storefront = null;

    if (u.active_alt_permit) {
      p += SIGNAL_W.dob_alteration;
      reasons.push(`active DOB alteration permit (${u.active_alt_permit.type}, issued ${u.active_alt_permit.issued} — build-out / repositioning underway)`);
    }
    if (u.dcwp_lapse) {
      p += SIGNAL_W.dcwp_lapse;
      reasons.push(`DCWP: ${u.dcwp.total} license${u.dcwp.total === 1 ? "" : "s"} on the lot, none active (operator lapsed/closed)`);
    }
    const sale = clean(u.acris.last_sale_date).slice(0, 10);
    if (sale && sale >= tradeCutoff) {
      p += SIGNAL_W.recent_trade;
      // Nominal-consideration deeds ($0/$10) are entity transfers, not arm's-length
      // sales — still a change of control, but the wording must not oversell it.
      const price = u.acris.last_sale_price;
      const nominal = price != null && price < 1000;
      reasons.push(nominal
        ? `recent ACRIS deed ${sale} for nominal consideration ($${Math.round(price)}) — entity/family transfer or restructuring, control changed hands`
        : `recent ACRIS trade (deed ${sale}${price ? `, $${Math.round(price).toLocaleString("en-US")}` : ""} — new owner, re-tenanting window)`);
    }

    u.availability_probability = Math.round(Math.min(0.95, p) * 100) / 100;
    u.availability_reasons = reasons;
  }
  cov.signals = {
    storefront_vacant: universe.filter((u) => u.storefront && u.storefront.vacant_units > 0).length,
    dob_alteration: universe.filter((u) => u.active_alt_permit).length,
    dcwp_lapse: universe.filter((u) => u.dcwp_lapse).length,
    recent_trade: universe.filter((u) => { const s = clean(u.acris.last_sale_date).slice(0, 10); return s && s >= tradeCutoff; }).length,
  };
}

// ── stage 4: score ──────────────────────────────────────────────────────────────
// Deterministic buy-box fit — the same buy-box idea api/screen.js grades OMs with,
// computed from data instead of an LLM. Criteria with no public dataset (ceiling
// height, asking rent, divisibility, use restrictions) are OM-stage and noted once.
function scoreCandidates(universe, buyBox, weights, cov) {
  if (buyBox.ceiling_ht_min != null) cov.notes.push("buy_box.ceiling_ht_min: no public NYC dataset carries ceiling heights — not scored (OM stage)");
  if (buyBox.asking_psf_max != null) cov.notes.push("buy_box.asking_psf_max: no public asking-rent feed — not scored (OM stage)");
  if (Array.isArray(buyBox.use_restrictions) && buyBox.use_restrictions.length) cov.notes.push("buy_box.use_restrictions: not evaluable from public data — not scored (OM stage)");

  const wSum = Object.values(weights).reduce((s, w) => s + (Number(w) || 0), 0) || 1;
  for (const u of universe) {
    const gla = u.pluto.retail_sqft ?? u.pluto.commercial_sqft ?? u.pluto.bldg_sqft ?? null;
    u.gla = gla;
    u.gla_source = u.pluto.retail_sqft != null ? "pluto-retailarea" : u.pluto.commercial_sqft != null ? "pluto-comarea" : u.pluto.bldg_sqft != null ? "pluto-bldgarea" : null;

    const comp = {};
    comp.availability_probability = u.availability_probability;
    comp.corridor_tier = TIER_SCORE[u.tier] ?? 0.6;

    const f = u.pluto.frontage_ft;
    const fMin = toNum(buyBox.frontage_ft_min);
    let frontageFit = f == null ? 0.5 : fMin ? Math.min(1, f / fMin) : 1; // unknown = neutral
    if (buyBox.corner_pref && toNum(u.row.lottype) === 3) frontageFit = Math.min(1, frontageFit + 0.1); // PLUTO lot type 3 = corner
    comp.frontage_fit = frontageFit;

    const [glo, ghi] = Array.isArray(buyBox.gla_range) ? buyBox.gla_range : [null, null];
    comp.gla_fit = gla == null ? 0.5 : glo && gla < glo ? gla / glo : ghi && gla > ghi ? ghi / gla : 1;

    let acc = 0;
    for (const [k, w] of Object.entries(weights)) acc += (Number(w) || 0) * (comp[k] ?? 0.5);
    u.fit_components = comp;
    u.fit_score = Math.round((acc / wSum) * 100);
  }
}

// ── stage 5: rank_and_emit ──────────────────────────────────────────────────────
// Fixed schema, fixed ordering: fit desc, availability desc, bbl asc. Every row has
// every key (null when unknown), so the output shape never varies run to run.
function rankAndEmit(universe, corridor, boroName) {
  const sorted = [...universe].sort((a, b) =>
    b.fit_score - a.fit_score ||
    b.availability_probability - a.availability_probability ||
    a.bbl.localeCompare(b.bbl));
  return sorted.map((u) => ({
    bbl: u.bbl,
    address: clean(u.row.address) || null,
    corridor: corridor.id,
    street: u.street,
    tier: u.tier,
    frontage_ft: u.pluto.frontage_ft ?? null,
    gla: u.gla ?? null,
    gla_source: u.gla_source,
    ownership_entity: u.owner_entity,
    owner_mailing: u.owner_mailing,
    principal: u.principal,
    principal_role: u.principal_role,
    availability_probability: u.availability_probability,
    availability_reasons: u.availability_reasons,
    fit_score: u.fit_score,
    // No free public listings feed exists — this stays false until a listings
    // connector lands; availability_probability is the ranking signal meanwhile.
    on_market_flag: false,
    source: [...u.detected],
    last_sale_date: clean(u.acris.last_sale_date).slice(0, 10) || null,
    last_sale_price: u.acris.last_sale_price ?? null,
    tax_lien: !!u.acris.tax_lien,
    // Join keys + coords so Scout can chain the dossier tools / map the shortlist.
    city: "New York",
    borough: boroName,
    block: clean(u.row.block) || null,
    lot: clean(u.row.lot) || null,
    lat: toNum(u.row.latitude),
    lon: toNum(u.row.longitude),
  }));
}

const mkSourceCov = (dataset) => ({ dataset, queries: 0, errors: [], notes: [] });

// ── the engine ──────────────────────────────────────────────────────────────────
export async function runRetailAvailability(corridor, opts = {}) {
  if (corridor.connector !== "nyc") {
    throw new Error(`RetailAvailability: no "${corridor.connector}" connector yet (only "nyc"). Corridor "${corridor.id}" can't run.`);
  }
  const boroName = clean(corridor.target_filters?.borough) || "Manhattan"; // NYC connector default
  const boroCode = PLUTO_BOROUGH[boroName.toLowerCase()];
  const boroDigit = BOROUGH_DIGIT[boroName.toLowerCase()];
  if (!boroCode) throw new Error(`RetailAvailability: unknown borough "${boroName}" in target_filters`);

  const cov = {
    universe: { segments: [], bbls: 0, retail_detected: { store_class: 0, retail_area: 0, overlay_mixed_use: 0, storefront_registry: 0 } },
    sources: {
      pluto: mkSourceCov(PLUTO),
      storefront: mkSourceCov(STOREFRONT),
      acris: { via: "_markets/nyc.js enrichOwnerMailing (ACRIS Master/Legals/Parties + tax-lien list)", errors: [] },
      dob: { ...mkSourceCov(`${DOB_PERMIT} + ${DOBNOW_PERMIT}`) },
      dcwp: mkSourceCov(DCWP_BIZ),
      hpd: mkSourceCov(`${HPD_REG} + ${HPD_CONTACTS}`),
    },
    signals: null,
    nulls: null,
    notes: [],
  };

  const { universe, storefrontByBbl } = await resolveUniverse(corridor, boroName, boroCode, cov);
  await enrich(universe, boroName, boroDigit, cov, opts);
  availabilitySignal(universe, storefrontByBbl, cov);
  scoreCandidates(universe, corridor.buy_box, corridor.scoring_weights, cov);
  const rows = rankAndEmit(universe, corridor, boroName);

  // Null report — where the data is thin, per emitted field.
  const nullCount = (k) => rows.filter((r) => r[k] == null).length;
  cov.nulls = {
    of: rows.length,
    frontage_ft: nullCount("frontage_ft"),
    gla: nullCount("gla"),
    ownership_entity: nullCount("ownership_entity"),
    principal: nullCount("principal"),
    last_sale_date: nullCount("last_sale_date"),
  };

  return {
    engine: "retail_availability",
    build: BUILD,
    corridor: { id: corridor.id, name: corridor.name, market: corridor.market, asset_class: corridor.asset_class },
    candidate_count: rows.length,
    // Finite-guard the limit: Number("top 10") is NaN and slice(0, NaN) returns [] —
    // a malformed model-supplied limit must not silently empty the screen.
    rows: Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0 ? rows.slice(0, Math.max(1, Math.floor(Number(opts.limit)))) : rows,
    coverage: cov,
  };
}
