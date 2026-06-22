// FRONTAGE — Connecticut sourcing (Greenwich and other CT towns).
//
// NYC's engines (ACRIS/PLUTO/DOB) don't exist outside the city, so this is the CT
// equivalent built on Connecticut's FREE open data: the statewide "Real Estate Sales"
// dataset on data.ct.gov (Socrata, no key). For a town (default Greenwich) it returns
// properties that have traded — address, SALE PRICE, assessed value, sale/assessment
// ratio, property type, sale date, and lat/lon — filterable by type, price, and year.
//
// IMPORTANT: this dataset has NO owner names or building SF (CT doesn't publish those
// freely). Owner of record + contacts come from Scout's web research (web_research),
// which is exactly the agreed combo for thin-data markets. Password-gated like the rest.

const CT_BASE = "https://data.ct.gov/resource";
const CT_SALES = process.env.CT_SALES_DATASET || "5mzw-sjtu"; // Real Estate Sales (statewide)

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const toNum = (v) => { if (v == null || v === "") return null; const n = Number(String(v).replace(/[$,]/g, "")); return Number.isFinite(n) ? n : null; };

async function fetchSocrata(dataset, params) {
  const token = process.env.SOCRATA_APP_TOKEN;
  const qs = new URLSearchParams(params);
  const r = await fetch(`${CT_BASE}/${dataset}.json?${qs}`, token ? { headers: { "X-App-Token": token } } : {});
  if (!r.ok) return [];
  return r.json().catch(() => []);
}

// CT property types in the dataset: Single Family, Residential, Condo, Two/Three/Four
// Family, Commercial, Apartments, Vacant Land, Industrial. Map a friendly request.
const TYPE_MAP = {
  any: null, commercial: "Commercial", retail: "Commercial", office: "Commercial",
  apartments: "Apartments", multifamily: "Apartments", industrial: "Industrial",
  single_family: "Single Family", residential: "Residential", condo: "Condo", vacant: "Vacant Land",
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, town, propertyType, minPrice, maxPrice, sinceYear, address, limit, check, debug } = req.body || {};
    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    if (check) return res.status(200).json({ ok: true });
    if (debug) return res.status(200).json({ ok: true, build: "ctsource-v1", dataset: CT_SALES });

    const townName = clean(town) || "Greenwich";
    const where = [`upper(town)='${townName.toUpperCase().replace(/'/g, "''")}'`];

    const typeKey = clean(propertyType).toLowerCase().replace(/[\s/-]+/g, "_");
    const mapped = typeKey in TYPE_MAP ? TYPE_MAP[typeKey] : (propertyType ? clean(propertyType) : null);
    if (mapped) where.push(`propertytype='${mapped.replace(/'/g, "''")}'`);

    if (sinceYear) where.push(`listyear>='${Number(sinceYear)}'`);
    if (address) where.push(`upper(address) like '%${clean(address).toUpperCase().replace(/'/g, "''")}%'`);

    // Fetch newest first; price-filter in JS (saleamount is stored as text in places, so a
    // numeric SoQL comparison isn't reliable — same lesson as ACRIS document_amt).
    const rows = await fetchSocrata(CT_SALES, {
      $where: where.join(" AND "),
      $order: "daterecorded DESC",
      $limit: 2000,
    });

    const lo = toNum(minPrice), hi = toNum(maxPrice);
    const cap = Math.min(Number(limit) || 100, 500);
    const properties = [];
    const seen = new Set();
    for (const r of rows) {
      const price = toNum(r.saleamount);
      if (lo != null && (price == null || price < lo)) continue;
      if (hi != null && (price == null || price > hi)) continue;
      const addr = clean(r.address);
      const dt = clean(r.daterecorded).slice(0, 10);
      const key = `${addr}|${dt}`;
      if (seen.has(key)) continue; // de-dupe re-recorded sales
      seen.add(key);
      const coords = (r.geo_coordinates && r.geo_coordinates.coordinates) || null;
      properties.push({
        address: addr,
        town: clean(r.town),
        sale_amount: price,
        assessed_value: toNum(r.assessedvalue),
        sales_ratio: toNum(r.salesratio),
        sale_date: dt,
        list_year: clean(r.listyear),
        property_type: clean(r.propertytype),
        residential_type: clean(r.residentialtype) || "",
        lat: coords ? coords[1] : null,
        lon: coords ? coords[0] : null,
        maps_url: coords ? `https://www.google.com/maps/search/?api=1&query=${coords[1]},${coords[0]}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr + ", " + clean(r.town) + " CT")}`,
      });
      if (properties.length >= cap) break;
    }

    return res.status(200).json({
      count: properties.length,
      town: townName,
      note: "Connecticut public sale records (data.ct.gov). No owner name or building SF in this source — identify owners via web research.",
      properties,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "ctsource" });
  }
}
