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

const sodaQuote = (vals) => vals.map((v) => "'" + String(v).replace(/'/g, "''") + "'").join(", ");
// Escape user text for a SoQL upper(...) like '%...%' clause.
const likeEsc = (s) => String(s).toUpperCase().replace(/'/g, "''");
// Whole-street match: treats the input as a complete street token, so "9 STREET"
// matches "9 STREET" / "EAST 9 STREET" but NOT "19 STREET" or "29 STREET".
function streetClause(field, street) {
  const s = likeEsc(street);
  return `(upper(${field})='${s}' OR upper(${field}) like '% ${s}' OR upper(${field}) like '${s} %' OR upper(${field}) like '% ${s} %')`;
}

// Geocode an address with NYC Planning's GeoSearch (free, no API key).
async function geocodeNyc(text) {
  try {
    const r = await fetch(`https://geosearch.planninglabs.nyc/v2/search?size=1&text=${encodeURIComponent(text)}`);
    if (!r.ok) return null;
    const d = await r.json();
    const f = d.features && d.features[0];
    if (!f || !f.geometry) return null;
    const [lon, lat] = f.geometry.coordinates;
    return { lat, lon, label: (f.properties && f.properties.label) || text };
  } catch {
    return null;
  }
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

// PLUTO: find lots by asset type + street or radius, with the owner as the lead.
async function sourcePluto({ borough, assetType, street, centerLat, centerLon, radiusMiles, limit, appToken }) {
  const where = [];
  const code = PLUTO_BOROUGH[borough] || null;
  if (code) where.push(`borough='${code}'`);
  const prefixes = ASSET_TYPES[assetType] || null;
  if (prefixes) where.push("(" + prefixes.map((p) => `starts_with(bldgclass,'${p}')`).join(" OR ") + ")");
  if (street) where.push(streetClause("address", street));

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

  const fetchLimit = hasCenter ? Math.min(Math.max(limit * 3, 100), 500) : limit;
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
      amount: toNum(row.assesstot), date: "", lat, lon, distance,
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
    deals.sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));
    deals = deals.slice(0, limit);
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
      lat: d.lat ?? null, lon: d.lon ?? null, distance: d.distance ?? null,
      name: c.name, role: c.role, entity_type: c.entity_type || "unknown",
      first_name: c.first_name || "", last_name: c.last_name || "",
      contact_address: c.address || "", city: c.city || "", state: c.state || "", zip: c.zip || "",
    };
  });
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
    const { password, check, sources, borough, docType, since, limit, save, assetType, street, nearAddress, radiusMiles } = req.body || {};

    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    if (check) return res.status(200).json({ ok: true, dbConfigured: !!process.env.DATABASE_URL });

    const appToken = process.env.SOCRATA_APP_TOKEN;
    const wanted = Array.isArray(sources) && sources.length ? sources : ["acris", "dob"];
    const lim = Math.max(1, Math.min(Number(limit) || 100, 250));

    // Radius search needs a geocoded center (PLUTO only — it's the source with coords).
    let center = null;
    if (nearAddress && radiusMiles) {
      center = await geocodeNyc(nearAddress);
      if (!center) {
        return res.status(200).json({ error: `Couldn't find "${nearAddress}". Try a fuller NYC address, e.g. "350 5 Avenue, Manhattan".` });
      }
    }

    const filters = {
      borough: borough || undefined, docType: docType || undefined, since: since || undefined,
      assetType: assetType || "any", street: (street || "").trim() || undefined,
      centerLat: center ? center.lat : undefined, centerLon: center ? center.lon : undefined,
      radiusMiles: center ? Number(radiusMiles) : undefined, limit: lim, appToken,
    };

    let deals = [];
    let contacts = [];
    if (wanted.includes("acris")) {
      const a = await sourceAcris(filters);
      deals = deals.concat(a.deals);
      contacts = contacts.concat(a.contacts);
    }
    if (wanted.includes("dob")) {
      const d = await sourceDob(filters);
      deals = deals.concat(d.deals);
      contacts = contacts.concat(d.contacts);
    }
    if (wanted.includes("pluto")) {
      const p = await sourcePluto(filters);
      deals = deals.concat(p.deals);
      contacts = contacts.concat(p.contacts);
    }

    deals = dedupeDeals(deals);
    contacts = dedupeContacts(contacts).map(normalizeContact);
    const leads = buildLeads(deals, contacts);

    let savedInfo = { saved: 0, dbConfigured: !!process.env.DATABASE_URL };
    if (save) savedInfo = await saveLeads(leads);

    return res.status(200).json({
      counts: { deals: deals.length, contacts: contacts.length },
      deals, leads, saved: savedInfo.saved, dbConfigured: savedInfo.dbConfigured,
      center: center ? { lat: center.lat, lon: center.lon, label: center.label, radiusMiles: Number(radiusMiles) } : null,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "source" });
  }
}
