// FRONTAGE — nationwide property + owner data connector ("the firehose").
//
// Wraps third-party property-data APIs so FRONTAGE works OUTSIDE NYC (where the
// ACRIS/PLUTO/DOB public datasets don't exist). One call returns the owner of record,
// mailing address, last sale, assessment/market value, mortgage, and building basics
// for any US address — the structured backbone that pairs with Scout's web research.
//
// PROVIDER-PLUGGABLE (same waterfall pattern as api/skiptrace.js): pick the lane with
// the `provider` body param or PROPERTY_PROVIDER env ("attom" default, "regrid" alt,
// "auto" = try attom then regrid). Each lane reads its OWN key from server-side env:
//   ATTOM  -> ATTOM_API_KEY     (attomdata.com — free 30-day trial key)
//   Regrid -> REGRID_API_TOKEN  (regrid.com — developer plan)
//
// CONTRACTS: endpoint paths + response field names below follow each vendor's public
// docs but are marked CONFIRM where not yet verified against a live key — the response
// parser is intentionally TOLERANT (harvest() walks for the value regardless of exact
// key) so a field rename won't break the connector. The first real call (or the
// {debug:true} probe) verifies the contract, exactly like the skip-trace lane did.
//
// COST/SAFETY: on-demand only (Scout calls it for a specific address, or a future
// "enrich" button). Password-gated; keys never leave the server. Returns {noKey:true}
// gracefully when the chosen lane has no key configured.

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const toNum = (v) => { if (v == null || v === "") return null; const n = Number(String(v).replace(/[$,]/g, "")); return Number.isFinite(n) ? n : null; };

// Walk an object/array for the first present, non-empty value among candidate keys
// (case-insensitive, nested). Keeps the connector resilient to vendor field renames.
function harvest(obj, keys, seen = new Set()) {
  if (obj == null || typeof obj !== "object" || seen.has(obj)) return null;
  seen.add(obj);
  const want = keys.map((k) => k.toLowerCase());
  for (const [k, v] of Object.entries(obj)) {
    if (want.includes(k.toLowerCase()) && v != null && v !== "" && typeof v !== "object") return v;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") { const hit = harvest(v, keys, seen); if (hit != null) return hit; }
  }
  return null;
}

// ── ATTOM Data lane ───────────────────────────────────────────────────────────
// Docs: api.gateway.attomdata.com, header "apikey". The expanded profile bundles
// property + owner + assessment + last sale in one call; AVM adds a market value.
async function attomLookup({ address, city, state, zip }) {
  const key = process.env.ATTOM_API_KEY;
  if (!key) return { noKey: true, provider: "attom" };
  const base = process.env.ATTOM_BASE || "https://api.gateway.attomdata.com/propertyapi/v1.0.0";
  const address1 = clean(address);
  const address2 = clean([city, state, zip].filter(Boolean).join(" "));
  const url = `${base}/property/expandedprofile?address1=${encodeURIComponent(address1)}&address2=${encodeURIComponent(address2)}`;
  const r = await fetch(url, { headers: { apikey: key, Accept: "application/json" } });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data) return { provider: "attom", matched: false, status: r.status, raw: data };
  const prop = (data.property && data.property[0]) || null;
  if (!prop) return { provider: "attom", matched: false, raw: data };
  return normalize("attom", prop, data);
}

// ── Regrid lane ───────────────────────────────────────────────────────────────
// Docs: app.regrid.com/api — parcels by address, token as query param. Returns a
// GeoJSON FeatureCollection; parcel fields live under properties.fields.
async function regridLookup({ address, city, state, zip }) {
  const token = process.env.REGRID_API_TOKEN;
  if (!token) return { noKey: true, provider: "regrid" };
  const base = process.env.REGRID_BASE || "https://app.regrid.com/api/v2";
  const query = clean([address, city, state, zip].filter(Boolean).join(", "));
  const url = `${base}/parcels/address?query=${encodeURIComponent(query)}&token=${encodeURIComponent(token)}&limit=1`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data) return { provider: "regrid", matched: false, status: r.status, raw: data };
  const feat = harvestFeature(data);
  if (!feat) return { provider: "regrid", matched: false, raw: data };
  const fields = (feat.properties && (feat.properties.fields || feat.properties)) || feat;
  return normalize("regrid", fields, data);
}
function harvestFeature(data) {
  const fc = data.parcels || data;
  if (fc && Array.isArray(fc.features) && fc.features.length) return fc.features[0];
  if (Array.isArray(data) && data.length) return data[0];
  return null;
}

// Tolerant normalization → one consistent shape for the UI / Scout regardless of vendor.
function normalize(provider, node, raw) {
  return {
    provider, matched: true,
    owner_name: clean(harvest(node, ["owner1full", "ownername", "owner", "ownername1", "ownerName"])) || null,
    owner_mailing: clean(harvest(node, ["mailingaddressoneline", "mailaddress", "owneraddress", "mail_address", "mailadd"])) || null,
    last_sale_date: clean(harvest(node, ["saletransdate", "saledate", "saleTransDate", "lastsaledate"])) || null,
    last_sale_price: toNum(harvest(node, ["saleamt", "saleprice", "saleAmt", "lastsaleprice"])),
    assessed_value: toNum(harvest(node, ["assdttlvalue", "assessedvalue", "assdTtlValue", "totalvalue", "parval"])),
    market_value: toNum(harvest(node, ["mktttlvalue", "marketvalue", "avmvalue", "estimatedvalue", "value"])),
    year_built: toNum(harvest(node, ["yearbuilt", "yearBuilt", "yrblt"])),
    building_sqft: toNum(harvest(node, ["universalsize", "bldgsize", "grosssize", "sqft", "ll_bldg_footprint_sqft", "buildingarea"])),
    lot_sqft: toNum(harvest(node, ["lotsize2", "lotsize", "ll_gisacre", "gisacre", "landsize"])),
    use: clean(harvest(node, ["proptype", "propclass", "usedesc", "landuse", "usecode", "zoning"])) || null,
    raw: raw && JSON.stringify(raw).length < 24000 ? raw : { note: "raw omitted (too large)" },
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, provider, address, city, state, zip } = req.body || {};
    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    if (req.body && req.body.debug) {
      return res.status(200).json({
        ok: true, build: "property-v1",
        attomConfigured: !!process.env.ATTOM_API_KEY,
        regridConfigured: !!process.env.REGRID_API_TOKEN,
        defaultProvider: process.env.PROPERTY_PROVIDER || "attom",
      });
    }
    if (!address) return res.status(400).json({ error: "Need at least an address to look up." });

    const lane = (provider || process.env.PROPERTY_PROVIDER || "attom").toLowerCase();
    const args = { address, city, state, zip };

    let result;
    if (lane === "regrid") result = await regridLookup(args);
    else if (lane === "auto") {
      result = await attomLookup(args);
      if (!result.matched) { const rg = await regridLookup(args); if (rg.matched) result = rg; }
    } else result = await attomLookup(args);

    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "property" });
  }
}
