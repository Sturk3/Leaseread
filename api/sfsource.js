// FRONTAGE — San Francisco property search, from DataSF's Assessor secured-roll
// (data.sfgov.org wv5m-vpq2). SF/California do NOT publish owner-of-record names in
// open data, so unlike NYC/CT/MA this returns property characteristics + assessed value
// but NOT the owner — the owner is found via web_research (and the operating business's
// legal name comes from sf_property_intel's business-registration pull). Free, no key.

const SF_BASE = "https://data.sfgov.org/resource";
const SF_ROLL = process.env.SF_ROLL_DATASET || "wv5m-vpq2"; // Assessor Historical Secured Property Tax Rolls
const ROLL_YEAR = process.env.SF_ROLL_YEAR || "2024";

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const toNum = (v) => { if (v == null || v === "") return null; const n = Number(String(v).replace(/[$,]/g, "")); return Number.isFinite(n) ? n : null; };
const sqlStr = (s) => clean(s).toUpperCase().replace(/'/g, "''");
// SF assessor property_location is a fixed-width blob like "0000 0415 MISSION ST0000"
// (leading unit zeros + zero-padded number + street + trailing unit zeros). Tidy it.
function fmtLoc(s) {
  let a = clean(s).replace(/0000$/, "").replace(/^0+\s+/, "").replace(/\b0+(\d)/g, "$1");
  return clean(a);
}

async function fetchSocrata(dataset, params) {
  const token = process.env.SOCRATA_APP_TOKEN;
  const r = await fetch(`${SF_BASE}/${dataset}.json?${new URLSearchParams(params)}`, token ? { headers: { "X-App-Token": token } } : {});
  if (!r.ok) return [];
  return r.json().catch(() => []);
}

// Friendly type -> a token to LIKE-match against use_definition.
// SF use_definitions: Single Family Residential, Multi-Family Residential, Commercial
// Retail, Commercial Office, Commercial Hotel, Commercial Misc, Industrial, Mixed-Use.
const USE_PATTERN = {
  any: null, commercial: "COMMERCIAL", retail: "RETAIL", office: "OFFICE", hotel: "HOTEL",
  apartments: "MULTI-FAMILY", multifamily: "MULTI-FAMILY", industrial: "INDUSTRIAL",
  mixed_use: "MIXED", single_family: "SINGLE FAMILY", residential: "RESIDENTIAL",
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, neighborhood, address, propertyType, minValue, maxValue, minSqft, limit, check, debug } = req.body || {};
    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    if (check) return res.status(200).json({ ok: true });
    if (debug) return res.status(200).json({ ok: true, build: "sfsource-v1", dataset: SF_ROLL, year: ROLL_YEAR });

    const where = [`closed_roll_year='${ROLL_YEAR}'`];
    const typeKey = clean(propertyType).toLowerCase().replace(/[\s/-]+/g, "_");
    const pat = typeKey in USE_PATTERN ? USE_PATTERN[typeKey] : (propertyType ? sqlStr(propertyType) : null);
    if (pat) where.push(`upper(use_definition) like '%${pat}%'`);
    if (neighborhood) where.push(`upper(analysis_neighborhood) like '%${sqlStr(neighborhood)}%'`);
    if (address) where.push(`upper(property_location) like '%${sqlStr(address)}%'`);

    // Order by improvement value (best-effort; assessed totals are text, summed in JS).
    const rows = await fetchSocrata(SF_ROLL, {
      $where: where.join(" AND "),
      $order: "assessed_improvement_value DESC",
      $limit: 2000,
    });

    const lo = toNum(minValue), hi = toNum(maxValue), minSf = toNum(minSqft);
    const out = [];
    for (const r of rows) {
      const land = toNum(r.assessed_land_value) || 0, imp = toNum(r.assessed_improvement_value) || 0;
      const fixtures = toNum(r.assessed_fixtures_value) || 0;
      const assessed = land + imp + fixtures;
      if (lo != null && assessed < lo) continue;
      if (hi != null && assessed > hi) continue;
      const sqft = toNum(r.property_area);
      if (minSf != null && (sqft == null || sqft < minSf)) continue;
      const property = fmtLoc(r.property_location);
      out.push({
        address: property, block: clean(r.block), lot: clean(r.lot), parcel_number: clean(r.parcel_number),
        use: clean(r.use_definition), property_class: clean(r.property_class_code_definition),
        zoning: clean(r.zoning_code), neighborhood: clean(r.analysis_neighborhood), supervisor_district: clean(r.supervisor_district),
        assessed_value: assessed || null, assessed_land: land || null, assessed_improvement: imp || null,
        building_sqft: sqft, lot_sqft: toNum(r.lot_area), frontage_ft: toNum(r.lot_frontage),
        year_built: toNum(r.year_property_built), units: toNum(r.number_of_units), stories: toNum(r.number_of_stories),
        maps_url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(property + ", San Francisco CA")}`,
      });
    }
    out.sort((a, b) => (b.assessed_value || 0) - (a.assessed_value || 0));
    const cap = Math.min(Number(limit) || 100, 400);

    return res.status(200).json({
      count: out.length, neighborhood: clean(neighborhood) || null, roll_year: ROLL_YEAR,
      note: "San Francisco assessor roll (DataSF) — property characteristics + assessed value. CALIFORNIA DOES NOT PUBLISH OWNER NAMES in open data, so there is NO owner of record here: find the owner via web_research, and use sf_property_intel for the operating business's legal name (a real contact lead), permits, evictions, and complaints. Pass block+lot to sf_property_intel.",
      properties: out.slice(0, cap),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "sfsource" });
  }
}
