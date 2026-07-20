// FRONTAGE — RetailAvailability engine, CHARLESTON connector: the same deterministic
// five-stage corridor screen as the NYC connector (_engines/retailavailability.js),
// built on the Charleston County / City of Charleston ArcGIS layers the market
// connector (_markets/charleston.js) and charlestonintel.js already verified live:
//
//   1. resolve_universe  — address points on each corridor street (city City_Addresses
//                          + county Address Points), clipped between the cross streets
//                          (shared corridorgeo math), joined to county assessor PARCELS
//                          by PID. Retail detection = commercial CLASS_CODE union
//                          vacant-commercial class (no storefront registry exists here).
//   2. enrich            — owner + full mailing + last sale straight off the parcel row
//                          (SC keeps owners public); City of Charleston construction
//                          permits ("C"+PID); hotel entitlements (parcel-exact — the
//                          King St use fight).
//   3. availability_signal — composite from active repositioning permit + vacant-class
//                          parcel + recent trade + hotel-pipeline entitlement. Charleston
//                          publishes NO vacancy registry or business-license feed, so the
//                          signal set is thinner than NYC's — reflected in the wording.
//   4. score             — buy-box fit weighted by corridor.scoring_weights. NO public
//                          frontage or building-SF field exists in the county layer, so
//                          frontage/GLA score neutral (0.5) and are OM-stage; corner
//                          lots are detected from address points on the cross streets.
//   5. rank_and_emit     — the SAME fixed row schema as the NYC connector (fit desc,
//                          availability desc, pid asc), with pid as the join key so
//                          Scout chains charleston_property_intel on any candidate.
//
// City layers only cover the City of Charleston — fine for King St (all city). All
// layers are free ArcGIS, no key; failures land in the coverage report, not throws.

import { clean, toNum, addr, chunk } from "../_lib/util.js";
import { normStreet } from "../_markets/charleston.js";
import { clipToSegment } from "./corridorgeo.js";

export const BUILD = "retailavail-chs-v1";

const CC_PARCELS = process.env.CHS_PARCELS_URL ||
  "https://gisccapps.charlestoncounty.org/arcgis/rest/services/GIS_VIEWER/New_Public_Search/MapServer/7";
const CC_ADDRESS = process.env.CHS_ADDRESS_URL ||
  "https://gisccapps.charlestoncounty.org/arcgis/rest/services/GIS_VIEWER/New_Public_Search/MapServer/1";
const CITY_ADDRESS = process.env.CHS_CITY_ADDRESS_URL ||
  "https://services2.arcgis.com/tQaXW7Zb1Vphzvgd/arcgis/rest/services/City_Addresses/FeatureServer/0";
const CITY_PERMITS = process.env.CHS_PERMITS_URL ||
  "https://services2.arcgis.com/tQaXW7Zb1Vphzvgd/arcgis/rest/services/New_Construction_Permits/FeatureServer/0";
const CITY_HOTELS = process.env.CHS_HOTELS_URL ||
  "https://services2.arcgis.com/tQaXW7Zb1Vphzvgd/arcgis/rest/services/Hotel_Entitlements/FeatureServer/0";

const TIER_RANK = { flagship: 3, luxury: 2, boutique: 1 };
const TIER_SCORE = { flagship: 1.0, luxury: 0.85, boutique: 0.7 };

// Signal weights (stage 3). Thinner public signal set than NYC — no vacancy registry,
// no license feed — so the build-out permit (the strongest observable "space is being
// re-fit" tell) leads. Sums to 1.0 over a 0.05 base.
const SIGNAL_W = { reposition_permit: 0.40, vacant_class: 0.30, recent_trade: 0.20, hotel_pipeline: 0.10 };
const PERMIT_WINDOW_MONTHS = 18;
const TRADE_WINDOW_MONTHS = 24;
const REPOSITION_RE = /new construction|demolition|renovation|rehab|addition|change of use|commercial/i;

// Assessor CLASS_CODE detection (sampled from the live layer — see _markets/charleston.js):
// 530 specialty retail, 500 general commercial lead; the wider commercial set catches
// King St's mixed-use stock (office/hotel/other-commercial over ground retail); the
// vacant-commercial codes are literally available space.
const RETAIL_CLASS = ["530", "500"];
const COMMERCIAL_CLASS = ["580", "650", "700", "250", "460"];
const VACANT_CLASS = ["905", "910", "952", "900"];

const quoteIn = (vals) => [...new Set(vals)].map((v) => `'${String(v).replace(/'/g, "''")}'`).join(",");
const fmtDate = (ms) => { const n = Number(ms); return Number.isFinite(n) && n > 0 ? new Date(n).toISOString().slice(0, 10) : null; };
const monthsAgoISO = (m) => { const d = new Date(); d.setMonth(d.getMonth() - m); return d.toISOString().slice(0, 10); };

// ── coverage-aware ArcGIS fetch (paginates past the server's transfer limit) ────
async function arcgis(base, params, cov, cap = 6000) {
  const out = [];
  let offset = 0;
  for (;;) {
    cov.queries += 1;
    try {
      const r = await fetch(`${base}/query?${new URLSearchParams({ returnGeometry: "false", f: "json", ...(offset ? { resultOffset: String(offset) } : {}), ...params })}`);
      if (!r.ok) { cov.errors.push(`HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`); return out; }
      const j = await r.json().catch(() => null);
      if (!j || j.error) { cov.errors.push(`ArcGIS error: ${String(j?.error?.message || "unparseable response").slice(0, 160)}`); return out; }
      out.push(...(j.features || []).map((f) => ({ ...(f.attributes || {}), __geom: f.geometry || null })));
      if (out.length >= cap) { cov.notes.push(`hit the ${cap}-row pagination cap — results may be truncated`); return out; }
      if (!j.exceededTransferLimit || !(j.features || []).length) return out;
      offset = out.length;
    } catch (e) {
      cov.errors.push(`fetch failed: ${String(e.message).slice(0, 160)}`);
      return out;
    }
  }
}

// ── street matching ─────────────────────────────────────────────────────────────
// Both address layers store abbreviated uppercase street names ("360 KING ST").
// The street part of an address label, unit noise stripped.
const streetPart = (label) => clean(label).toUpperCase()
  .replace(/^\d[\dA-Z\-/]*(\s+1\/2)?\s+/, "")
  .replace(/\s+(#|UNIT|STE|SUITE|APT|BLDG|FL|FLR)\b.*$/, "")
  .trim();

// Does this label sit on the corridor street? Exact abbreviated match first; accept
// directional halves (N/S MARKET ST for "Market St") — same all-or-nothing idea as
// the NYC connector so "King St" never absorbs a different KING-prefixed street.
const onStreet = (part, norm) => part === norm || /^(N|S|E|W) /.test(part) && part.replace(/^(N|S|E|W) /, "") === norm;

// Address points for ALL corridor streets in ONE query per layer (city covers the
// City of Charleston, county covers unincorporated). The un-indexed LIKE scan is the
// slow part of the whole screen, so six per-street queries — sequential OR concurrent
// — blow the 60s serverless budget; one OR'd scan per layer costs about the same as
// one street. Points are classified back to their street client-side.
// Returns Map<normalized street, [{ pid, label, town, zip, lat, lon }]>.
async function fetchAllStreetPoints(streets, cov) {
  const norms = [...new Set(streets.map(normStreet))];
  // Leading-space LIKE so VIKING ST can't match KING ST; exact filter runs client-side.
  const likes = (col) => norms.map((n) => `UPPER(${col}) LIKE '% ${n.replace(/'/g, "''")}%'`).join(" OR ");
  const [city, county] = await Promise.all([
    arcgis(CITY_ADDRESS, { where: likes("ADDRLABEL"), outFields: "PARCELID,ADDRLABEL,CMTYNAME,ZIPCODE", returnGeometry: "true", outSR: "4326", resultRecordCount: "2000" }, cov.city_addresses),
    arcgis(CC_ADDRESS, { where: likes("WHOLE_ADDRESS"), outFields: "PID,WHOLE_ADDRESS,POSTAL_TOWN,POSTAL_CODE", returnGeometry: "true", outSR: "4326", resultRecordCount: "2000" }, cov.county_addresses),
  ]);
  const byNorm = new Map(norms.map((n) => [n, []]));
  for (const rows of [city, county]) for (const a of rows) {
    const label = clean(a.ADDRLABEL || a.WHOLE_ADDRESS).toUpperCase();
    const part = streetPart(label);
    const norm = norms.find((n) => onStreet(part, n));
    if (!norm) continue;
    const pid = clean(a.PID || String(a.PARCELID || "").replace(/^C/, ""));
    const g = a.__geom;
    byNorm.get(norm).push({
      pid: pid || null, label,
      town: clean(a.CMTYNAME || a.POSTAL_TOWN) || "Charleston",
      zip: clean(a.ZIPCODE || a.POSTAL_CODE),
      lat: g && Number.isFinite(g.y) ? g.y : null,
      lon: g && Number.isFinite(g.x) ? g.x : null,
    });
  }
  // Stable order so geometry anchoring is identical run to run.
  for (const pts of byNorm.values()) pts.sort((a, b) => a.label.localeCompare(b.label) || String(a.pid).localeCompare(String(b.pid)));
  return byNorm;
}

// ── stage 1: resolve_universe ───────────────────────────────────────────────────
async function resolveUniverse(corridor, cov) {
  const byPid = new Map();     // pid -> { points: [], street, tier }
  const cornerPids = new Set(); // pid also holds an address point on a cross street

  const allStreets = corridor.geometry.flatMap((s) => [s.street, s.from_cross, s.to_cross]);
  const pointsByStreet = await fetchAllStreetPoints(allStreets, cov.sources);
  const forStreet = (s) => pointsByStreet.get(normStreet(s)) || [];

  for (const seg of corridor.geometry) {
    const label = `${seg.street} (${seg.from_cross} → ${seg.to_cross})`;
    const segCov = { street: seg.street, tier: seg.tier, points_on_street: 0, points_in_segment: 0 };
    cov.universe.segments.push(segCov);
    if (seg.side !== "both") cov.notes.push(`${label}: side="${seg.side}" not yet supported — treated as "both"`);
    const [main, crossA, crossB] = [forStreet(seg.street), forStreet(seg.from_cross), forStreet(seg.to_cross)];
    segCov.points_on_street = main.length;
    if (!main.length) { cov.notes.push(`${label}: NO address points found on street — check the street name`); continue; }
    for (const c of [...crossA, ...crossB]) if (c.pid) cornerPids.add(c.pid);
    const pts = (arr) => arr.filter((p) => p.lat != null && p.lon != null).map((p) => ({ lat: p.lat, lon: p.lon, ref: p }));
    const { kept, note } = clipToSegment(pts(main), pts(crossA), pts(crossB));
    if (note) cov.notes.push(`${label}: ${note}`);
    segCov.points_in_segment = kept.length;
    for (const p of kept) {
      if (!p.pid) { cov.universe.orphan_points += 1; continue; } // broken "C" parcel key — rare, counted
      const prev = byPid.get(p.pid);
      if (!prev) byPid.set(p.pid, { points: [p], street: seg.street, tier: seg.tier });
      else {
        prev.points.push(p);
        if (TIER_RANK[seg.tier] > TIER_RANK[prev.tier]) { prev.tier = seg.tier; prev.street = seg.street; }
      }
    }
  }

  // Join to the assessor parcel layer by PID — owner, class, sale, acreage.
  const parcelByPid = new Map();
  for (const batch of chunk([...byPid.keys()], 80)) {
    const rows = await arcgis(CC_PARCELS, {
      where: `PID IN (${quoteIn(batch)})`,
      outFields: "PID,OWNER1,OWNER2,MAIL_ST_NO,MAIL_ST_NAME,MAIL_ST_TYPE,MAIL_2ND_ADDR,MAIL_CITY,MAIL_STATE,MAIL_ZIP,CLASS_CODE,ACREAGE,SALE_PRICE,RECORDED_DATE,DEED_BOOK_PAGE,LEGAL_DESCR",
      resultRecordCount: "2000",
    }, cov.sources.parcels);
    for (const r of rows) { const pid = clean(r.PID); if (pid && !parcelByPid.has(pid)) parcelByPid.set(pid, r); }
  }
  cov.universe.pids_no_parcel = [...byPid.keys()].filter((pid) => !parcelByPid.has(pid)).length;

  // Retail detection: commercial CLASS_CODE union vacant-commercial. Residential
  // (condos over the shops, single-family off the corridor ends) drops out here.
  const universe = [];
  const det = cov.universe.retail_detected;
  for (const [pid, u] of byPid) {
    const parcel = parcelByPid.get(pid);
    if (!parcel) continue;
    const cls = clean(parcel.CLASS_CODE);
    const detected = new Set();
    if (RETAIL_CLASS.some((p) => cls.startsWith(p))) { detected.add("retail-class"); det.retail_class++; }
    if (COMMERCIAL_CLASS.some((p) => cls.startsWith(p))) { detected.add("commercial-class-mixed-use"); det.commercial_class++; }
    if (VACANT_CLASS.some((p) => cls.startsWith(p))) { detected.add("vacant-commercial-class"); det.vacant_class++; }
    if (!detected.size) continue;
    universe.push({ pid, ...u, parcel, detected, corner: cornerPids.has(pid) });
  }
  cov.universe.corners = universe.filter((u) => u.corner).length;

  // Deterministic cap, same policy as NYC: best tiers first, pid as stable tiebreak.
  const MAX_UNIVERSE = 450;
  universe.sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || a.pid.localeCompare(b.pid));
  if (universe.length > MAX_UNIVERSE) {
    cov.notes.push(`universe trimmed ${universe.length} → ${MAX_UNIVERSE} (tier, then pid)`);
    universe.length = MAX_UNIVERSE;
  }
  cov.universe.pids = universe.length;
  return universe;
}

// ── stage 2: enrich ─────────────────────────────────────────────────────────────
async function enrich(universe, cov) {
  // Owner + mailing + last sale come straight off the parcel row — SC publishes them.
  for (const u of universe) {
    const r = u.parcel;
    u.owner_entity = [clean(r.OWNER1), clean(r.OWNER2)].filter(Boolean).join(" & ") || null;
    u.owner_mailing = addr([[clean(r.MAIL_ST_NO), clean(r.MAIL_ST_NAME), clean(r.MAIL_ST_TYPE)].filter(Boolean).join(" "), r.MAIL_2ND_ADDR, r.MAIL_CITY, r.MAIL_STATE, r.MAIL_ZIP]) || null;
    u.last_sale_date = fmtDate(r.RECORDED_DATE);
    u.last_sale_price = toNum(r.SALE_PRICE) || null;
  }
  cov.sources.parcels.pids_with_last_sale = universe.filter((u) => u.last_sale_date).length;
  cov.notes.push("principal: SC gates its SOS registry behind a captcha (no free feed) — unmask owner LLCs via web_research / sc_entity, not this screen");

  // City construction permits, keyed "C"+PID. Build-out/repositioning window.
  const permitCutoff = monthsAgoISO(PERMIT_WINDOW_MONTHS);
  const permitsByPid = new Map();
  for (const batch of chunk(universe.map((u) => "C" + u.pid), 80)) {
    const rows = await arcgis(CITY_PERMITS, {
      where: `MAIN_PARCEL_NUMBER IN (${quoteIn(batch)})`,
      outFields: "MAIN_PARCEL_NUMBER,PERMIT_TYPE,WORK_CLASS,ISSUE_DATE,ISSUE_YEAR,VALUATION",
      resultRecordCount: "2000",
    }, cov.sources.permits);
    for (const r of rows) {
      const pid = clean(r.MAIN_PARCEL_NUMBER).replace(/^C/, "");
      if (!pid) continue;
      if (!permitsByPid.has(pid)) permitsByPid.set(pid, []);
      permitsByPid.get(pid).push({
        type: clean(r.WORK_CLASS || r.PERMIT_TYPE),
        issued: fmtDate(r.ISSUE_DATE) || (toNum(r.ISSUE_YEAR) ? `${toNum(r.ISSUE_YEAR)}-01-01` : null),
        valuation: toNum(r.VALUATION) || null,
        repositioning: REPOSITION_RE.test(`${r.PERMIT_TYPE} ${r.WORK_CLASS}`),
      });
    }
  }
  for (const u of universe) {
    const ps = (permitsByPid.get(u.pid) || []).filter((p) => p.issued)
      .sort((a, b) => b.issued.localeCompare(a.issued) || a.type.localeCompare(b.type));
    u.permits = ps;
    u.active_reposition_permit = ps.find((p) => p.repositioning && p.issued >= permitCutoff) || null;
  }
  cov.sources.permits.pids_with_recent_reposition = universe.filter((u) => u.active_reposition_permit).length;

  // Hotel entitlements, parcel-exact — an entitlement not yet open = the use is changing.
  const hotelByPid = new Map();
  for (const batch of chunk(universe.map((u) => "C" + u.pid), 80)) {
    const rows = await arcgis(CITY_HOTELS, {
      where: `PARCELID IN (${quoteIn(batch)})`,
      outFields: "PARCELID,NAME,Rooms,STATUS",
      resultRecordCount: "2000",
    }, cov.sources.hotels);
    for (const r of rows) {
      const pid = clean(r.PARCELID).replace(/^C/, "");
      if (pid && !hotelByPid.has(pid)) hotelByPid.set(pid, { name: clean(r.NAME), rooms: toNum(r.Rooms), status: clean(r.STATUS) });
    }
  }
  for (const u of universe) {
    u.hotel = hotelByPid.get(u.pid) || null;
    u.hotel_pipeline = !!u.hotel && /to be|under|propos|approv|pending|review/i.test(u.hotel.status);
  }
  cov.sources.hotels.pids_with_entitlement = hotelByPid.size;
}

// ── stage 3: availability_signal ────────────────────────────────────────────────
function availabilitySignal(universe, cov) {
  const tradeCutoff = monthsAgoISO(TRADE_WINDOW_MONTHS);
  for (const u of universe) {
    const reasons = [];
    let p = 0.05; // baseline — no Charleston public dataset proves a space is NOT available

    if (u.active_reposition_permit) {
      const ap = u.active_reposition_permit;
      p += SIGNAL_W.reposition_permit;
      reasons.push(`active City build-out permit (${ap.type}, issued ${ap.issued}${ap.valuation ? `, $${Math.round(ap.valuation).toLocaleString("en-US")}` : ""} — space being re-fit / repositioned)`);
    }
    if (u.detected.has("vacant-commercial-class")) {
      p += SIGNAL_W.vacant_class;
      reasons.push(`assessor classes the parcel VACANT commercial (${clean(u.parcel.CLASS_CODE)})`);
    }
    if (u.last_sale_date && u.last_sale_date >= tradeCutoff) {
      p += SIGNAL_W.recent_trade;
      // A deed for a few dollars is an entity/family transfer, not an arm's-length
      // sale — still a change of control worth flagging, but say what it is.
      const nominal = u.last_sale_price != null && u.last_sale_price < 1000;
      reasons.push(nominal
        ? `recent deed recorded ${u.last_sale_date} for nominal consideration ($${Math.round(u.last_sale_price)}) — entity/family transfer or restructuring, control changed hands`
        : `recent trade (deed recorded ${u.last_sale_date}${u.last_sale_price ? `, $${Math.round(u.last_sale_price).toLocaleString("en-US")}` : ""} — new owner, re-tenanting window)`);
    }
    if (u.hotel_pipeline) {
      p += SIGNAL_W.hotel_pipeline;
      reasons.push(`hotel entitlement in the pipeline (${u.hotel.name || "unnamed"}${u.hotel.rooms ? `, ${u.hotel.rooms} rooms` : ""}, status "${u.hotel.status}" — use changing)`);
    }

    u.availability_probability = Math.round(Math.min(0.95, p) * 100) / 100;
    u.availability_reasons = reasons;
  }
  cov.signals = {
    reposition_permit: universe.filter((u) => u.active_reposition_permit).length,
    vacant_class: universe.filter((u) => u.detected.has("vacant-commercial-class")).length,
    recent_trade: universe.filter((u) => u.last_sale_date && u.last_sale_date >= tradeCutoff).length,
    hotel_pipeline: universe.filter((u) => u.hotel_pipeline).length,
  };
}

// ── stage 4: score ──────────────────────────────────────────────────────────────
// Charleston County publishes NO frontage or building-SF field, so frontage/GLA are
// unknowable here: both score neutral (0.5) and remain OM-stage criteria. The corner
// bump IS observable (address points on the cross street), so corner_pref still bites.
function scoreCandidates(universe, buyBox, weights, cov) {
  cov.notes.push("buy_box.frontage_ft_min / gla_range: no public Charleston frontage or building-SF field — both score neutral 0.5 (OM stage)");
  if (buyBox.ceiling_ht_min != null) cov.notes.push("buy_box.ceiling_ht_min: not in any public Charleston dataset — not scored (OM stage)");
  if (buyBox.asking_psf_max != null) cov.notes.push("buy_box.asking_psf_max: no public asking-rent feed — not scored (OM stage)");

  const wSum = Object.values(weights).reduce((s, w) => s + (Number(w) || 0), 0) || 1;
  for (const u of universe) {
    const comp = {};
    comp.availability_probability = u.availability_probability;
    comp.corridor_tier = TIER_SCORE[u.tier] ?? 0.6;
    comp.frontage_fit = Math.min(1, 0.5 + (buyBox.corner_pref && u.corner ? 0.1 : 0));
    comp.gla_fit = 0.5;
    let acc = 0;
    for (const [k, w] of Object.entries(weights)) acc += (Number(w) || 0) * (comp[k] ?? 0.5);
    u.fit_components = comp;
    u.fit_score = Math.round((acc / wSum) * 100);
  }
}

// ── stage 5: rank_and_emit ──────────────────────────────────────────────────────
// Same fixed schema and ordering as the NYC connector; pid is the join key.
function rankAndEmit(universe, corridor) {
  const sorted = [...universe].sort((a, b) =>
    b.fit_score - a.fit_score ||
    b.availability_probability - a.availability_probability ||
    a.pid.localeCompare(b.pid));
  return sorted.map((u) => {
    // Display address: the shortest label on the corridor street (the base building
    // address — corner lots also carry their side-street aliases).
    const best = u.points.reduce((s, p) => (!s || p.label.length < s.label.length ? p : s), null);
    const aliases = [...new Set(u.points.map((p) => p.label).filter((l) => l !== best.label))].slice(0, 4);
    return {
      pid: u.pid,
      address: best.label,
      ...(aliases.length ? { address_aliases: aliases } : {}),
      corridor: corridor.id,
      street: u.street,
      tier: u.tier,
      frontage_ft: null,          // no public field — OM stage
      gla: null,                  // no public building-SF field — OM stage
      gla_source: null,
      corner: u.corner,
      class_code: clean(u.parcel.CLASS_CODE) || null,
      acres: toNum(u.parcel.ACREAGE),
      ownership_entity: u.owner_entity,
      owner_mailing: u.owner_mailing,
      principal: null,            // SC SOS is captcha-gated — chain web_research/sc_entity
      principal_role: null,
      availability_probability: u.availability_probability,
      availability_reasons: u.availability_reasons,
      fit_score: u.fit_score,
      on_market_flag: false,      // no free listings feed — availability_probability ranks instead
      source: [...u.detected],
      last_sale_date: u.last_sale_date,
      last_sale_price: u.last_sale_price,
      deed_book_page: clean(u.parcel.DEED_BOOK_PAGE) || null,
      hotel_entitlement: u.hotel,
      permit_count: u.permits.length,
      latest_permit: u.permits[0] || null,
      // Join keys + coords so Scout can chain charleston_property_intel / map the shortlist.
      city: "Charleston",
      town: best.town,
      lat: best.lat,
      lon: best.lon,
    };
  });
}

const mkSourceCov = (layer) => ({ layer, queries: 0, errors: [], notes: [] });

// ── the engine ──────────────────────────────────────────────────────────────────
export async function runRetailAvailabilityCharleston(corridor, opts = {}) {
  const cov = {
    universe: { segments: [], pids: 0, orphan_points: 0, pids_no_parcel: 0, corners: 0, retail_detected: { retail_class: 0, commercial_class: 0, vacant_class: 0 } },
    sources: {
      city_addresses: mkSourceCov("City_Addresses (City of Charleston)"),
      county_addresses: mkSourceCov("Address Points (Charleston County)"),
      parcels: mkSourceCov("New_Public_Search/7 (county assessor parcels)"),
      permits: mkSourceCov("New_Construction_Permits (City of Charleston, 2010–present)"),
      hotels: mkSourceCov("Hotel_Entitlements (City of Charleston)"),
    },
    signals: null,
    nulls: null,
    notes: [],
  };

  const universe = await resolveUniverse(corridor, cov);
  await enrich(universe, cov);
  availabilitySignal(universe, cov);
  scoreCandidates(universe, corridor.buy_box, corridor.scoring_weights, cov);
  const rows = rankAndEmit(universe, corridor);

  const nullCount = (k) => rows.filter((r) => r[k] == null).length;
  cov.nulls = {
    of: rows.length,
    ownership_entity: nullCount("ownership_entity"),
    owner_mailing: nullCount("owner_mailing"),
    last_sale_date: nullCount("last_sale_date"),
    lat: nullCount("lat"),
  };

  return {
    engine: "retail_availability",
    build: BUILD,
    corridor: { id: corridor.id, name: corridor.name, market: corridor.market, asset_class: corridor.asset_class },
    candidate_count: rows.length,
    // Finite-guard the limit (same reason as the NYC connector): Number("top 10") is
    // NaN and slice(0, NaN) returns [] — a malformed limit must not empty the screen.
    rows: Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0 ? rows.slice(0, Math.max(1, Math.floor(Number(opts.limit)))) : rows,
    coverage: cov,
  };
}
