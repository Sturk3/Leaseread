// Vercel serverless backend for FRONTAGE — live NYC sourcing.
// Pulls real-estate deals + the parties/owners attached to them from NYC Open
// Data (ACRIS deeds + DOB job filings) via the Socrata API, normalizes them, and
// optionally saves them to the shared Postgres store. Password-gated like
// api/screen.js. This is the JS port of the standalone Python agent's connectors.

const SOCRATA_BASE = "https://data.cityofnewyork.us/resource";
const ACRIS_MASTER = process.env.ACRIS_MASTER_DATASET || "bnx9-e6tj"; // Real Property Master
const ACRIS_LEGALS = process.env.ACRIS_LEGALS_DATASET || "8h5j-fqxa"; // Real Property Legals
const ACRIS_PARTIES = process.env.ACRIS_PARTIES_DATASET || "636b-3b5g"; // Real Property Parties
const DOB_JOBS = process.env.DOB_JOBS_DATASET || "ic3t-wcy2"; // DOB Job Application Filings
const PLUTO = process.env.PLUTO_DATASET || "64uk-42ks"; // Primary Land Use Tax Lot Output (PLUTO)
const TAX_LIEN = process.env.TAX_LIEN_DATASET || "9rz4-mjek"; // Tax Lien Sale List (distress signal)

const PLUTO_BOROUGH = { Manhattan: "MN", Bronx: "BX", Brooklyn: "BK", Queens: "QN", "Staten Island": "SI" };
const PLUTO_BOROUGH_NAME = { MN: "Manhattan", BX: "Bronx", BK: "Brooklyn", QN: "Queens", SI: "Staten Island" };

// Asset type -> NYC building-class prefixes (PLUTO `bldgclass`). null = any.
const ASSET_TYPES = {
  any: null,
  retail: ["K"],                // store buildings
  office: ["O"],
  multifamily: ["C", "D"],      // walk-up + elevator apartments
  mixed_use: ["S", "RM", "RR"], // mixed residential / commercial
  industrial: ["E", "F"],       // warehouse + factory / industrial
  hotel: ["H"],
  vacant: ["V"],                // vacant land / development sites
  one_two_family: ["A", "B"],
  condo: ["R"],
};

const BOROUGH_CODE = { "1": "Manhattan", "2": "Bronx", "3": "Brooklyn", "4": "Queens", "5": "Staten Island" };
const BOROUGH_NAME_TO_CODE = Object.fromEntries(Object.entries(BOROUGH_CODE).map(([k, v]) => [v.toLowerCase(), k]));
const ACRIS_PARTY_ROLE = { "1": "grantor", "2": "grantee", "3": "party-3" };

const COMPANY_TOKENS = new Set([
  "LLC", "L.L.C", "INC", "INCORPORATED", "CORP", "CORPORATION", "CO", "COMPANY", "LP", "L.P", "LLP",
  "TRUST", "ASSOCIATES", "REALTY", "PARTNERS", "HOLDINGS", "GROUP", "FUND", "BANK", "NA", "N.A",
  "MANAGEMENT", "MGMT", "PROPERTIES", "PROPERTY", "DEVELOPMENT", "VENTURES", "CAPITAL", "ENTERPRISES",
  "FOUNDATION", "CHURCH", "HOUSING", "HDFC", "CONDOMINIUM", "CONDO", "TENANTS", "ESTATE", "EQUITIES",
  "PARTNERSHIP", "SERVICES", "INVESTORS", "INVESTMENT",
]);

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const toNum = (v) => {
  if (v === null || v === undefined || v === "" || v === "0") return null;
  const n = Number(String(v).replace(/[$,]/g, "").trim());
  return Number.isFinite(n) ? n : null;
};
const boroughName = (v) => {
  const s = clean(v);
  if (BOROUGH_CODE[s]) return BOROUGH_CODE[s];
  return s ? s.replace(/\b\w/g, (c) => c.toUpperCase()) : "";
};

function looksLikeCompany(name) {
  return name.toUpperCase().split(/[\s,.\-]+/).some((t) => t && COMPANY_TOKENS.has(t));
}
function splitPersonName(name) {
  const n = clean(name);
  const title = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());
  if (n.includes(",")) {
    const [last, rest = ""] = n.split(",");
    const first = clean(rest).split(" ")[0] || "";
    return [title(clean(first)), title(clean(last))];
  }
  const parts = n.split(" ").filter(Boolean);
  if (parts.length === 1) return ["", title(parts[0])];
  return [title(parts[1]), title(parts[0])]; // ACRIS stores LAST FIRST ...
}
function normalizeContact(c) {
  if (looksLikeCompany(c.name)) {
    c.entity_type = "company";
    c.first_name = "";
    c.last_name = "";
  } else {
    c.entity_type = "person";
    [c.first_name, c.last_name] = splitPersonName(c.name);
  }
  return c;
}

// NYC 3-digit ZIP prefixes (Manhattan/Bronx/SI/Brooklyn/Queens). Owner mailing ZIPs
// outside this set flag an out-of-area / absentee owner — a strong sourcing signal.
const NYC_ZIP3 = new Set(["100", "101", "102", "103", "104", "110", "111", "112", "113", "114", "116"]);
function absenteeFlag(state, zip) {
  const st = clean(state).toUpperCase();
  if (st && st !== "NY") return "out-of-state";
  const z3 = clean(zip).replace(/\D/g, "").slice(0, 3);
  if (z3 && !NYC_ZIP3.has(z3)) return "out-of-area";
  return "";
}

const sodaQuote = (vals) => vals.map((v) => "'" + String(v).replace(/'/g, "''") + "'").join(", ");
// Escape user text for a SoQL upper(...) like '%...%' clause.
const likeEsc = (s) => String(s).toUpperCase().replace(/'/g, "''");
// Whole-street match: treats the input as a complete street token, so "9 STREET"
// matches "9 STREET" / "EAST 9 STREET" but NOT "19 STREET" or "29 STREET".
function streetClause(field, street) {
  const s = likeEsc(street);
  return `(upper(${field})='${s}' OR upper(${field}) like '% ${s}' OR upper(${field}) like '${s} %' OR upper(${field}) like '% ${s} %')`;
}

// Geocode an address — NYC GeoSearch (free, no key), with a US Census geocoder
// fallback so radius search keeps working when GeoSearch is down/unavailable.
async function geocodeNyc(text) {
  try {
    const r = await fetch(`https://geosearch.planninglabs.nyc/v2/search?size=1&text=${encodeURIComponent(text)}`);
    if (r.ok) {
      const d = await r.json();
      const f = d.features && d.features[0];
      if (f && f.geometry) {
        const [lon, lat] = f.geometry.coordinates;
        return { lat, lon, label: (f.properties && f.properties.label) || text };
      }
    }
  } catch {
    /* fall through to Census */
  }
  try {
    const r = await fetch(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=${encodeURIComponent(text)}`);
    if (r.ok) {
      const d = await r.json();
      const m = d.result && d.result.addressMatches && d.result.addressMatches[0];
      if (m && m.coordinates) return { lat: m.coordinates.y, lon: m.coordinates.x, label: m.matchedAddress || text };
    }
  } catch {
    /* no geocoder available */
  }
  return null;
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchSocrata(dataset, { where, order, limit, appToken }) {
  const params = new URLSearchParams({ $limit: String(limit) });
  if (where) params.set("$where", where);
  if (order) params.set("$order", order);
  const headers = appToken ? { "X-App-Token": appToken } : {};
  const r = await fetch(`${SOCRATA_BASE}/${dataset}.json?${params.toString()}`, { headers });
  if (!r.ok) throw new Error(`Socrata ${dataset} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function sourceAcris({ borough, docType, since, street, limit, appToken }) {
  const code = borough ? (BOROUGH_NAME_TO_CODE[borough.toLowerCase()] || borough) : null;
  let master;
  let legals;

  if (street) {
    // Street-first: find lots on this street (ACRIS Legals carries street_name),
    // then pull the deeds recorded against them. Without this, a street filter on
    // the recent-deeds feed would almost always come back empty.
    const lw = [];
    if (code) lw.push(`borough='${code}'`);
    lw.push(streetClause("street_name", street));
    // Pull a generous candidate set (newest documents first — ACRIS document_id is
    // year-prefixed), then filter by doc_type/date and trim, so a doc-type filter
    // doesn't accidentally prune the few legals we happened to fetch.
    const candidateCap = Math.min(Math.max(limit * 6, 150), 400);
    legals = await fetchSocrata(ACRIS_LEGALS, { where: lw.join(" AND "), order: "document_id DESC", limit: candidateCap, appToken });
    const docIds = [...new Set(legals.map((r) => clean(r.document_id)).filter(Boolean))];
    if (!docIds.length) return { deals: [], contacts: [] };
    let masterAll = [];
    for (const batch of chunk(docIds, 75)) {
      const mw = [`document_id in (${sodaQuote(batch)})`];
      if (docType) mw.push(`upper(doc_type)='${docType.toUpperCase()}'`);
      if (since) mw.push(`document_date>='${since}'`);
      masterAll = masterAll.concat(await fetchSocrata(ACRIS_MASTER, { where: mw.join(" AND "), limit: 2000, appToken }));
    }
    masterAll.sort((a, b) =>
      String(b.recorded_datetime || b.document_date || "").localeCompare(String(a.recorded_datetime || a.document_date || "")));
    master = masterAll.slice(0, limit);
  } else {
    const mw = [];
    if (code) mw.push(`recorded_borough='${code}'`);
    if (docType) mw.push(`upper(doc_type)='${docType.toUpperCase()}'`);
    if (since) mw.push(`document_date>='${since}'`);
    master = await fetchSocrata(ACRIS_MASTER, {
      where: mw.join(" AND ") || undefined, order: "recorded_datetime DESC", limit, appToken,
    });
    const docIds = master.map((r) => clean(r.document_id)).filter(Boolean);
    if (!docIds.length) return { deals: [], contacts: [] };
    legals = [];
    for (const batch of chunk(docIds, 75)) {
      legals = legals.concat(await fetchSocrata(ACRIS_LEGALS, { where: `document_id in (${sodaQuote(batch)})`, limit: 2000, appToken }));
    }
  }

  const masterDocIds = [...new Set(master.map((r) => clean(r.document_id)).filter(Boolean))];
  if (!masterDocIds.length) return { deals: [], contacts: [] };
  let parties = [];
  for (const batch of chunk(masterDocIds, 75)) {
    parties = parties.concat(await fetchSocrata(ACRIS_PARTIES, { where: `document_id in (${sodaQuote(batch)})`, limit: 4000, appToken }));
  }

  const legalByDoc = {};
  for (const row of legals) {
    const id = clean(row.document_id);
    if (id && !legalByDoc[id]) legalByDoc[id] = row;
  }

  const deals = master.map((row) => {
    const id = clean(row.document_id);
    const legal = legalByDoc[id] || {};
    const street = clean(`${legal.street_number || ""} ${legal.street_name || ""}`);
    const unit = clean(legal.unit || legal.addr_unit || "");
    return {
      source: "acris", deal_id: id, doc_type: clean(row.doc_type),
      borough: boroughName(row.recorded_borough || legal.borough),
      address: clean(`${street} ${unit ? "Unit " + unit : ""}`),
      block: clean(legal.block), lot: clean(legal.lot),
      amount: toNum(row.document_amt), date: clean(row.document_date || row.recorded_datetime),
    };
  }).filter((d) => d.deal_id);

  const contacts = parties.filter((p) => clean(p.name)).map((row) => ({
    name: clean(row.name),
    role: ACRIS_PARTY_ROLE[clean(row.party_type)] || "party",
    address: clean(`${row.address_1 || ""} ${row.address_2 || ""}`),
    city: clean(row.city), state: clean(row.state), zip: clean(row.zip),
    source: "acris", deal_id: clean(row.document_id),
  }));
  return { deals, contacts };
}

async function sourceDob({ borough, since, street, limit, appToken }) {
  const where = [];
  if (borough) where.push(`upper(borough)='${borough.toUpperCase()}'`);
  if (since) where.push(`pre__filing_date>='${since}'`);
  if (street) where.push(streetClause("street_name", street));
  const rows = await fetchSocrata(DOB_JOBS, {
    where: where.join(" AND ") || undefined, order: "pre__filing_date DESC", limit, appToken,
  });
  const deals = [];
  const contacts = [];
  for (const row of rows) {
    const job = clean(row.job__ || row.job || row.job_number);
    if (!job) continue;
    deals.push({
      source: "dob", deal_id: job, doc_type: clean(row.job_type || "DOB-JOB"),
      borough: boroughName(row.borough),
      address: clean(`${row.house__ || ""} ${row.street_name || ""}`),
      block: clean(row.block), lot: clean(row.lot),
      amount: toNum(row.initial_cost), date: clean(row.pre__filing_date || row.latest_action_date),
    });
    const owner = clean(row.owner_s_business_name || `${row.owner_s_last_name || ""} ${row.owner_s_first_name || ""}`);
    if (owner) {
      contacts.push({
        name: owner, role: "owner",
        address: clean(`${row.owner_s_house__ || ""} ${row.owner_s_house_street_name || ""}`),
        city: clean(row.city), state: clean(row.state),
        zip: clean(row.owner_s_zip_code || row.zip), source: "dob", deal_id: job,
      });
    }
  }
  return { deals, contacts };
}

// Development potential from PLUTO zoning: how much more can be built as-of-right.
// Unused FAR (max allowable − built) × lot area = additional buildable sqft (air rights).
function devFields(row) {
  const lotarea = toNum(row.lotarea) || 0;
  const builtFar = toNum(row.builtfar) || (lotarea ? (toNum(row.bldgarea) || 0) / lotarea : 0);
  const maxFar = Math.max(toNum(row.residfar) || 0, toNum(row.commfar) || 0, toNum(row.facilfar) || 0);
  const buildable = maxFar > builtFar && lotarea ? Math.round((maxFar - builtFar) * lotarea) : 0;
  return {
    built_far: builtFar || null, max_far: maxFar || null, buildable_sqft: buildable, underbuilt: buildable >= 2500,
    // Square footage — this is a retail tool, so surface retail SF (PLUTO `retailarea`)
    // alongside total building area and lot area.
    retail_sqft: toNum(row.retailarea) || null,
    bldg_sqft: toNum(row.bldgarea) || null,
    lot_sqft: lotarea || null,
    // Trophy-retail fundamentals (all from PLUTO, no extra call):
    //  frontage = linear feet on the street (THE high-street value driver),
    //  commercial overlay = whether retail is permitted, special district = signage/
    //  use overlays (Times Sq, 5th Ave), landmark/historic = facade/alteration limits.
    frontage_ft: toNum(row.bldgfront) || toNum(row.lotfront) || null,
    num_floors: toNum(row.numfloors) || null,
    zoning: clean(row.zonedist1) || null,
    overlay: clean(row.overlay1) || null,
    special_district: clean(row.spdist1) || null,
    landmark: clean(row.landmark) || null,
    hist_district: clean(row.histdist) || null,
  };
}

// Fetch one exact PLUTO lot by BBL (the typed address), ignoring asset filters, so
// it can be pinned as the first result. BBL = boro(1) + block(5) + lot(4).
const DIGIT_BOROUGH = { 1: "MN", 2: "BX", 3: "BK", 4: "QN", 5: "SI" };
// Build a pinned single-property deal+contact from one PLUTO row.
function plutoAnchorFromRow(row, fallbackId) {
  const id = clean(row.bbl) || String(fallbackId || "");
  const deal = {
    source: "pluto", deal_id: id, doc_type: clean(row.bldgclass),
    borough: PLUTO_BOROUGH_NAME[clean(row.borough)] || clean(row.borough),
    address: clean(row.address), block: clean(row.block), lot: clean(row.lot),
    amount: toNum(row.assesstot), date: "", lat: toNum(row.latitude), lon: toNum(row.longitude),
    distance: 0, pinned: true, ...devFields(row),
  };
  const owner = clean(row.ownername);
  const contact = owner ? { name: owner, role: "owner", address: clean(row.address), city: "", state: "", zip: "", source: "pluto", deal_id: id } : null;
  return { deal, contact };
}
async function fetchAnchorPluto(bbl, appToken) {
  const m = /^(\d)(\d{5})(\d{4})$/.exec(String(bbl));
  if (!m) return null;
  const boro2 = DIGIT_BOROUGH[m[1]];
  if (!boro2) return null;
  const rows = await fetchSocrata(PLUTO, {
    where: `borough='${boro2}' AND block=${Number(m[2])} AND lot=${Number(m[3])}`, limit: 1, appToken,
  }).catch(() => []);
  if (!rows[0]) return null;
  return plutoAnchorFromRow(rows[0], bbl);
}
// No BBL (address was geocoded, not picked) — return the single PLUTO lot nearest the
// coordinates, so "just this property" still works.
async function fetchNearestPluto(lat, lon, appToken) {
  const dlat = 0.05 / 69;
  const dlon = 0.05 / ((69 * Math.cos((lat * Math.PI) / 180)) || 1);
  const rows = await fetchSocrata(PLUTO, {
    where: `latitude between ${lat - dlat} and ${lat + dlat} AND longitude between ${lon - dlon} and ${lon + dlon}`,
    limit: 300, appToken,
  }).catch(() => []);
  let best = null, bestDist = Infinity;
  for (const row of rows) {
    const rlat = toNum(row.latitude), rlon = toNum(row.longitude);
    if (rlat == null || rlon == null) continue;
    const dist = haversineMiles(lat, lon, rlat, rlon);
    if (dist < bestDist) { bestDist = dist; best = row; }
  }
  return best ? plutoAnchorFromRow(best) : null;
}

// PLUTO: find lots by asset type + street or radius, with the owner as the lead.
async function sourcePluto({ borough, assetType, street, centerLat, centerLon, radiusMiles, anchorBbl, anchorOnly, minSqft, minUnits, builtAfter, builtBefore, limit, appToken }) {
  // Single-property mode: an address was given with the radius "off" — return ONLY
  // that one lot (ignoring asset/zoning filters), nothing nearby.
  if (anchorOnly) {
    let anchor = null;
    if (anchorBbl) anchor = await fetchAnchorPluto(String(anchorBbl).split(".")[0], appToken);
    if (!anchor && centerLat != null && centerLon != null) anchor = await fetchNearestPluto(centerLat, centerLon, appToken);
    if (!anchor) return { deals: [], contacts: [] };
    return { deals: [anchor.deal], contacts: anchor.contact ? [anchor.contact] : [] };
  }
  const where = [];
  const code = PLUTO_BOROUGH[borough] || null;
  if (code) where.push(`borough='${code}'`);
  const prefixes = ASSET_TYPES[assetType] || null;
  if (prefixes) where.push("(" + prefixes.map((p) => `starts_with(bldgclass,'${p}')`).join(" OR ") + ")");
  if (street) where.push(streetClause("address", street));
  if (minSqft) where.push(`bldgarea>=${Number(minSqft)}`);
  if (minUnits) where.push(`unitstotal>=${Number(minUnits)}`);
  if (builtAfter) where.push(`yearbuilt>=${Number(builtAfter)}`);
  if (builtBefore) where.push(`(yearbuilt<=${Number(builtBefore)} AND yearbuilt>0)`);

  const radius = radiusMiles ? Number(radiusMiles) : null;
  const hasCenter = centerLat != null && centerLon != null && radius;
  if (hasCenter) {
    // Bounding box around the point (a square that contains the circle); the exact
    // circle is enforced below with haversine distance.
    const dlat = radius / 69;
    const dlon = radius / ((69 * Math.cos((centerLat * Math.PI) / 180)) || 1);
    where.push(`latitude between ${centerLat - dlat} and ${centerLat + dlat}`);
    where.push(`longitude between ${centerLon - dlon} and ${centerLon + dlon}`);
  }

  // In radius mode pull the whole area (then trim to the exact circle below) so the
  // result is every matching property, not an arbitrary capped slice.
  const fetchLimit = hasCenter ? 5000 : limit;
  const rows = await fetchSocrata(PLUTO, {
    where: where.join(" AND ") || undefined,
    order: hasCenter ? undefined : "address",
    limit: fetchLimit, appToken,
  });

  let deals = [];
  const contacts = [];
  for (const row of rows) {
    const bbl = clean(row.bbl) || clean(`${row.borough}${row.block}${row.lot}`);
    if (!bbl) continue;
    const lat = toNum(row.latitude);
    const lon = toNum(row.longitude);
    let distance = null;
    if (hasCenter && lat != null && lon != null) {
      distance = haversineMiles(centerLat, centerLon, lat, lon);
      if (distance > radius) continue; // trim the bbox square down to the circle
    }
    deals.push({
      source: "pluto", deal_id: bbl, doc_type: clean(row.bldgclass),
      borough: PLUTO_BOROUGH_NAME[clean(row.borough)] || clean(row.borough),
      address: clean(row.address), block: clean(row.block), lot: clean(row.lot),
      amount: toNum(row.assesstot), date: "", lat, lon, distance, ...devFields(row),
    });
    const owner = clean(row.ownername);
    if (owner) {
      contacts.push({
        name: owner, role: "owner", address: clean(row.address),
        city: "", state: "", zip: "", source: "pluto", deal_id: bbl,
      });
    }
  }

  if (hasCenter) {
    // Return EVERY property inside the circle, nearest first — no trim to `limit`.
    deals.sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));
    // Pin the typed address itself as the first result (even if the asset filter
    // would exclude it), then everyone else by proximity.
    if (anchorBbl) {
      const norm = String(anchorBbl).split(".")[0];
      let anchor = deals.find((d) => String(d.deal_id).split(".")[0] === norm);
      if (!anchor) {
        const fetched = await fetchAnchorPluto(norm, appToken);
        if (fetched) {
          deals.push(fetched.deal);
          if (fetched.contact) contacts.push(fetched.contact);
          anchor = fetched.deal;
        }
      }
      if (anchor) { anchor.distance = 0; anchor.pinned = true; }
    }
    // Cap nearest-first so a dense, large-radius search can't exceed Vercel's ~4.5MB
    // response limit (which returns a non-JSON error page and breaks the client).
    // Smaller radii return far fewer than the cap, so they're unaffected; only the
    // farthest lots in a huge circle get dropped. The pinned anchor is always kept.
    const RADIUS_CAP = 1200;
    if (deals.length > RADIUS_CAP) {
      const pinnedDeals = deals.filter((d) => d.pinned);
      const rest = deals.filter((d) => !d.pinned).slice(0, Math.max(0, RADIUS_CAP - pinnedDeals.length));
      deals = [...pinnedDeals, ...rest].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (a.distance ?? 1e9) - (b.distance ?? 1e9));
    }
    const keep = new Set(deals.map((d) => d.deal_id));
    return { deals, contacts: contacts.filter((c) => keep.has(c.deal_id)) };
  }
  return { deals, contacts };
}

function dedupeDeals(deals) {
  const seen = new Set();
  return deals.filter((d) => {
    const k = `${d.source}|${clean(d.deal_id).toUpperCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
function dedupeContacts(contacts) {
  const seen = new Set();
  return contacts.filter((c) => {
    const k = `${clean(c.name).toUpperCase()}|${clean(c.deal_id).toUpperCase()}|${clean(c.role).toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Join each contact to its deal so a saved lead row is self-contained.
function buildLeads(deals, contacts) {
  const dealByKey = {};
  for (const d of deals) dealByKey[`${d.source}|${d.deal_id}`] = d;
  return contacts.map((c) => {
    const d = dealByKey[`${c.source}|${c.deal_id}`] || {};
    return {
      source: c.source, deal_id: c.deal_id, doc_type: d.doc_type || "", borough: d.borough || "",
      address: d.address || "", block: d.block || "", lot: d.lot || "",
      amount: d.amount ?? null, deal_date: d.date || "",
      last_sale_date: d.last_sale_date || "", last_sale_price: d.last_sale_price ?? null,
      years_owned: d.last_sale_date ? Math.max(0, new Date().getFullYear() - Number(String(d.last_sale_date).slice(0, 4))) : null,
      tax_lien: d.tax_lien || false,
      built_far: d.built_far ?? null, max_far: d.max_far ?? null,
      buildable_sqft: d.buildable_sqft ?? null, underbuilt: d.underbuilt || false,
      retail_sqft: d.retail_sqft ?? null, bldg_sqft: d.bldg_sqft ?? null, lot_sqft: d.lot_sqft ?? null,
      frontage_ft: d.frontage_ft ?? null, num_floors: d.num_floors ?? null, zoning: d.zoning ?? null,
      overlay: d.overlay ?? null, special_district: d.special_district ?? null, landmark: d.landmark ?? null, hist_district: d.hist_district ?? null,
      lat: d.lat ?? null, lon: d.lon ?? null, distance: d.distance ?? null, pinned: d.pinned || false,
      name: c.name, role: c.role, entity_type: c.entity_type || "unknown",
      first_name: c.first_name || "", last_name: c.last_name || "",
      contact_address: c.address || "", city: c.city || "", state: c.state || "", zip: c.zip || "",
      absentee: absenteeFlag(c.state, c.zip),
    };
  });
}

// PLUTO only carries the owner's NAME, not where they get mail — so by default the
// mailing column would just repeat the property address. Fix it by deriving each
// property's mailing address from the grantee (buyer) on its most recent ACRIS deed,
// i.e. the current owner's address on record. Capped to the nearest `cap` properties
// to stay within the serverless time budget; uncapped properties keep the fallback.
async function enrichOwnerMailing(deals, contacts, appToken, cap = 80) {
  const targets = deals
    .filter((d) => d.source === "pluto" && d.block && d.lot && d.borough)
    .slice(0, cap);
  if (!targets.length) return;

  const codeOf = (boro) => BOROUGH_NAME_TO_CODE[String(boro).toLowerCase()] || null;
  const keyOf = (code, block, lot) => `${code}|${Number(block)}|${Number(lot)}`;

  // 1. lot -> ACRIS document ids (query Legals by exact block/lot, grouped by borough)
  const byBoro = {};
  for (const d of targets) {
    const code = codeOf(d.borough);
    if (code) (byBoro[code] = byBoro[code] || []).push(d);
  }
  const docToKey = {};
  for (const [code, list] of Object.entries(byBoro)) {
    for (const group of chunk(list, 40)) {
      const ors = group.map((d) => `(block=${Number(d.block)} AND lot=${Number(d.lot)})`).join(" OR ");
      const rows = await fetchSocrata(ACRIS_LEGALS, {
        where: `borough='${code}' AND (${ors})`, select: "document_id,block,lot", limit: 5000, appToken,
      }).catch(() => []);
      for (const r of rows) {
        const id = clean(r.document_id);
        if (id) docToKey[id] = keyOf(code, r.block, r.lot);
      }
    }
  }

  // 2. which of those docs are DEEDs, and when (parallel waves to keep it quick)
  const deedDate = {};
  const deedAmt = {};
  const docBatches = chunk([...new Set(Object.keys(docToKey))], 75);
  for (const wave of chunk(docBatches, 6)) {
    const res = await Promise.all(wave.map((b) =>
      fetchSocrata(ACRIS_MASTER, { where: `document_id in (${sodaQuote(b)}) AND doc_type='DEED'`, select: "document_id,document_date,recorded_datetime,document_amt", limit: 2000, appToken }).catch(() => [])));
    for (const rows of res) for (const r of rows) { const id = clean(r.document_id); deedDate[id] = clean(r.document_date || r.recorded_datetime); deedAmt[id] = toNum(r.document_amt); }
  }

  // 3. latest deed per lot
  const latestByKey = {};
  for (const [id, date] of Object.entries(deedDate)) {
    const key = docToKey[id];
    if (!key) continue;
    if (!latestByKey[key] || (date || "") > (latestByKey[key].date || "")) latestByKey[key] = { id, date };
  }

  // 4. grantee (buyer) mailing address on each latest deed
  const granteeByDoc = {};
  const latestDocs = [...new Set(Object.values(latestByKey).map((v) => v.id))];
  for (const wave of chunk(chunk(latestDocs, 75), 6)) {
    const res = await Promise.all(wave.map((b) =>
      fetchSocrata(ACRIS_PARTIES, { where: `document_id in (${sodaQuote(b)}) AND party_type='2'`, select: "document_id,name,address_1,address_2,city,state,zip", limit: 2000, appToken }).catch(() => [])));
    for (const rows of res) for (const r of rows) { const id = clean(r.document_id); if (!granteeByDoc[id]) granteeByDoc[id] = r; }
  }

  // 5. apply: last sale onto each PLUTO deal, mailing onto its owner contact
  const dealKey = {};
  for (const d of targets) {
    const code = codeOf(d.borough);
    if (!code) continue;
    const key = keyOf(code, d.block, d.lot);
    dealKey[d.deal_id] = key;
    const v = latestByKey[key];
    if (v) { d.last_sale_date = v.date || ""; d.last_sale_price = deedAmt[v.id] ?? null; }
  }
  for (const c of contacts) {
    if (c.source !== "pluto") continue;
    const v = latestByKey[dealKey[c.deal_id]];
    const g = v && granteeByDoc[v.id];
    if (!g) continue;
    const addr = clean(`${g.address_1 || ""} ${g.address_2 || ""}`);
    const city = clean(g.city);
    // Only overwrite the property-address fallback when the deed actually recorded a
    // usable owner address (some deeds leave it blank or just a 00000 zip).
    if (addr || city) {
      const zip = clean(g.zip);
      c.address = addr;
      c.city = city;
      c.state = clean(g.state);
      c.zip = zip === "00000" ? "" : zip;
    }
  }

  // 6. tax-lien distress flag (property is on the lien sale list — behind on taxes/water)
  const lienSet = new Set();
  for (const [code, list] of Object.entries(byBoro)) {
    for (const group of chunk(list, 50)) {
      const ors = group.map((d) => `(block=${Number(d.block)} AND lot=${Number(d.lot)})`).join(" OR ");
      const rows = await fetchSocrata(TAX_LIEN, { where: `borough='${code}' AND (${ors})`, select: "block,lot", limit: 5000, appToken }).catch(() => []);
      for (const r of rows) lienSet.add(keyOf(code, r.block, r.lot));
    }
  }
  for (const d of targets) {
    const code = codeOf(d.borough);
    if (code && lienSet.has(keyOf(code, d.block, d.lot))) d.tax_lien = true;
  }
}

async function saveLeads(leads) {
  if (!process.env.DATABASE_URL) return { saved: 0, dbConfigured: false };
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  let saved = 0;
  try {
    for (const l of leads) {
      const res = await client.query(
        `insert into leads
           (source, deal_id, doc_type, borough, address, block, lot, amount, deal_date,
            name, role, entity_type, first_name, last_name, contact_address, city, state, zip)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         on conflict (source, deal_id, name, role) do nothing`,
        [l.source, l.deal_id, l.doc_type, l.borough, l.address, l.block, l.lot, l.amount, l.deal_date,
         l.name, l.role, l.entity_type, l.first_name, l.last_name, l.contact_address, l.city, l.state, l.zip],
      );
      saved += res.rowCount || 0;
    }
  } finally {
    await client.end();
  }
  return { saved, dbConfigured: true };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, check, sources, borough, docType, since, limit, save, assetType, street, nearAddress, radiusMiles, centerLat, centerLon, pickedBbl, minSqft, minUnits, builtAfter, builtBefore, devOnly, minBuildable } = req.body || {};

    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    if (check) return res.status(200).json({ ok: true, dbConfigured: !!process.env.DATABASE_URL });

    const appToken = null; // NYC account/token disconnected — anonymous requests only
    const wanted = Array.isArray(sources) && sources.length ? sources : ["acris", "dob"];
    const lim = Math.max(1, Math.min(Number(limit) || 100, 250));

    // Radius search needs a center (PLUTO only — it's the source with coords). If the
    // browser already picked an address from autocomplete it sends exact coords; else
    // geocode the typed text.
    let center = null;
    if (nearAddress) {
      const clat = Number(centerLat);
      const clon = Number(centerLon);
      if (Number.isFinite(clat) && Number.isFinite(clon)) {
        center = { lat: clat, lon: clon, label: nearAddress };
      } else {
        center = await geocodeNyc(nearAddress);
        if (!center) {
          return res.status(200).json({ error: `Couldn't find "${nearAddress}". Try picking an address from the dropdown.` });
        }
      }
    }
    // Address with radius "off" → return just that one property; with a radius → the area.
    const radiusNum = center && radiusMiles ? Number(radiusMiles) : null;
    const anchorOnly = !!center && !radiusNum;

    const filters = {
      borough: borough || undefined, docType: docType || undefined, since: since || undefined,
      assetType: assetType || "any", street: (street || "").trim() || undefined,
      centerLat: center ? center.lat : undefined, centerLon: center ? center.lon : undefined,
      radiusMiles: radiusNum || undefined, anchorOnly,
      anchorBbl: center && pickedBbl ? pickedBbl : undefined,
      minSqft: minSqft || undefined, minUnits: minUnits || undefined,
      builtAfter: builtAfter || undefined, builtBefore: builtBefore || undefined,
      limit: lim, appToken,
    };

    // A radius search is inherently about an area — only PLUTO has coordinates, so
    // ACRIS/DOB can't honor it. When a center is set, query PLUTO alone so the
    // result is just the properties in the circle (not the deed/filing feeds too).
    const effectiveWanted = center ? ["pluto"] : wanted;

    let deals = [];
    let contacts = [];
    if (effectiveWanted.includes("acris")) {
      const a = await sourceAcris(filters);
      deals = deals.concat(a.deals);
      contacts = contacts.concat(a.contacts);
    }
    if (effectiveWanted.includes("dob")) {
      const d = await sourceDob(filters);
      deals = deals.concat(d.deals);
      contacts = contacts.concat(d.contacts);
    }
    if (effectiveWanted.includes("pluto")) {
      const p = await sourcePluto(filters);
      deals = deals.concat(p.deals);
      contacts = contacts.concat(p.contacts);
    }

    deals = dedupeDeals(deals);
    contacts = dedupeContacts(contacts).map(normalizeContact);

    // Replace PLUTO's property-address placeholder with the real owner mailing
    // address (from the latest deed's buyer).
    if (contacts.some((c) => c.source === "pluto")) {
      await enrichOwnerMailing(deals, contacts, appToken);
    }

    let leads = buildLeads(deals, contacts);
    // Display order for area searches: typed address first, then nearest outward.
    if (center) {
      leads.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (a.distance ?? 1e9) - (b.distance ?? 1e9));
    }

    // Development-potential filters (keep the pinned typed address regardless).
    if (devOnly) leads = leads.filter((l) => l.underbuilt || l.pinned);
    const minB = Number(minBuildable);
    if (Number.isFinite(minB) && minB > 0) leads = leads.filter((l) => (l.buildable_sqft || 0) >= minB || l.pinned);

    // Portfolio: how many properties in this result set share the same owner.
    const ownerCount = {};
    for (const l of leads) { const k = clean(l.name).toUpperCase(); if (k) ownerCount[k] = (ownerCount[k] || 0) + 1; }
    for (const l of leads) l.portfolio_count = ownerCount[clean(l.name).toUpperCase()] || 1;

    let savedInfo = { saved: 0, dbConfigured: !!process.env.DATABASE_URL };
    if (save) savedInfo = await saveLeads(leads);

    return res.status(200).json({
      counts: { deals: deals.length, contacts: contacts.length },
      deals, leads, saved: savedInfo.saved, dbConfigured: savedInfo.dbConfigured,
      center: center ? { lat: center.lat, lon: center.lon, label: center.label, radiusMiles: radiusNum || 0, single: anchorOnly } : null,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "source" });
  }
}
