// FRONTAGE — Connecticut sales comps (the CT analog of NYC's /api/comps).
//
// CT publishes every recorded real-estate sale statewide (data.ct.gov, "Real Estate
// Sales GL"): town, address, SALE AMOUNT, assessed value, SALES RATIO (sale ÷ assessment
// — a real over/under-market signal), property type, and date. This gives the CT path
// the comps/underwriting layer it was missing. Free, no key, password-gated.

const CT_BASE = "https://data.ct.gov/resource";
const CT_SALES = process.env.CT_SALES_DATASET || "5mzw-sjtu"; // Real Estate Sales 2001-2023 GL

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const toNum = (v) => { if (v == null || v === "") return null; const n = Number(String(v).replace(/[$,%]/g, "")); return Number.isFinite(n) ? n : null; };

async function fetchSocrata(dataset, params) {
  const token = process.env.SOCRATA_APP_TOKEN;
  const r = await fetch(`${CT_BASE}/${dataset}.json?${new URLSearchParams(params)}`, token ? { headers: { "X-App-Token": token } } : {});
  if (!r.ok) return [];
  return r.json().catch(() => []);
}

// Friendly type -> a token to LIKE-match against the dataset's propertytype.
const TYPE_PATTERN = {
  any: null, commercial: "Commercial", retail: "Commercial", office: "Commercial",
  apartments: "Apartments", multifamily: "Apartments", industrial: "Industrial",
  condo: "Condo", residential: "Residential", single_family: "Single", vacant: "Vacant",
};

// geo_coordinates comes back either as a GeoJSON Point or a "POINT (lon lat)" string.
function coords(g) {
  try {
    if (g && Array.isArray(g.coordinates)) return { lon: toNum(g.coordinates[0]), lat: toNum(g.coordinates[1]) };
    const m = /POINT\s*\(([-\d.]+)\s+([-\d.]+)\)/i.exec(String(g || ""));
    if (m) return { lon: toNum(m[1]), lat: toNum(m[2]) };
  } catch { /* ignore */ }
  return { lon: null, lat: null };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, town, address, propertyType, sinceYear, minAmount, maxAmount, limit, check, debug } = req.body || {};
    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    if (check) return res.status(200).json({ ok: true });
    if (debug) return res.status(200).json({ ok: true, build: "ctcomps-v1", dataset: CT_SALES });

    const townName = clean(town) || "Greenwich";
    const where = [`upper(town)='${townName.toUpperCase().replace(/'/g, "''")}'`];

    const typeKey = clean(propertyType).toLowerCase().replace(/[\s/-]+/g, "_");
    const pat = typeKey in TYPE_PATTERN ? TYPE_PATTERN[typeKey] : (propertyType ? clean(propertyType) : null);
    if (pat) where.push(`upper(propertytype) like '%${pat.toUpperCase().replace(/'/g, "''")}%'`);
    if (address) where.push(`upper(address) like '%${clean(address).toUpperCase().replace(/'/g, "''")}%'`);
    const yr = toNum(sinceYear);
    if (yr != null) where.push(`listyear >= ${yr}`);

    // Most recent sales first; amount filtered in JS (Socrata number/text safe).
    const rows = await fetchSocrata(CT_SALES, {
      $where: where.join(" AND "),
      $order: "daterecorded DESC",
      $limit: 2000,
    });

    const lo = toNum(minAmount), hi = toNum(maxAmount);
    const cap = Math.min(Number(limit) || 60, 200);
    const comps = [];
    for (const r of rows) {
      const amount = toNum(r.saleamount);
      if (lo != null && (amount == null || amount < lo)) continue;
      if (hi != null && (amount == null || amount > hi)) continue;
      const { lat, lon } = coords(r.geo_coordinates);
      comps.push({
        address: clean(r.address), town: clean(r.town) || townName,
        sale_amount: amount, sale_date: clean(r.daterecorded).slice(0, 10), list_year: toNum(r.listyear),
        assessed_value: toNum(r.assessedvalue), sales_ratio: toNum(r.salesratio),
        property_type: clean(r.propertytype), residential_type: clean(r.residentialtype),
        non_use_code: clean(r.nonusecode) || null, lat, lon,
      });
      if (comps.length >= cap) break;
    }

    return res.status(200).json({
      count: comps.length, town: townName,
      note: "Connecticut recorded sales (data.ct.gov Real Estate Sales GL). sales_ratio = sale price ÷ town assessment; a ratio well above/below ~0.7 (CT's common assessment level) flags an over/under-market trade. non_use_code present = a non-arm's-length sale (family/foreclosure/etc.) — treat its price with caution.",
      comps,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "ctcomps" });
  }
}
