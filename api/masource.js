// FRONTAGE — Massachusetts sourcing (statewide), from MassGIS's standardized assessor
// parcels (Level 3). MA keeps owner data PUBLIC (unlike NJ, which redacts it), so this
// gives near-CT parity for MA towns — Boston trophy retail plus Nantucket / Martha's
// Vineyard luxury.
//
// Source: MassGIS "Massachusetts Property Tax Parcels" feature service, assessor table
// (GISDATA.L3_ASSESS, layer 4). ArcGIS REST, free, no key. Per parcel: OWNER + mailing
// (absentee surfaces), site address, use code, assessed value, building SF, year built,
// units, zoning, and the latest sale (price + date). Password-gated.

const MA_BASE = process.env.MA_PARCELS_URL ||
  "https://arcgisserver.digital.mass.gov/arcgisserver/rest/services/AGOL/MassachusettsPropertyTaxParcels/FeatureServer/4";

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const toNum = (v) => { if (v == null || v === "") return null; const n = Number(String(v).replace(/[$,]/g, "")); return Number.isFinite(n) ? n : null; };
const addr = (parts) => parts.map(clean).filter(Boolean).join(", ");
const sqlStr = (s) => clean(s).toUpperCase().replace(/'/g, "''");
// MassGIS LS_DATE is YYYYMMDD -> YYYY-MM-DD.
const fmtDate = (v) => { const s = clean(v); return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s; };

// Friendly type -> a MA state use-code prefix (LIKE-matched against USE_CODE).
// MA classes: 1xx residential, 11x apartments, 3xx commercial, 34x office, 4xx industrial.
const USE_PREFIX = {
  any: null, commercial: "3", retail: "3", office: "34", apartments: "11", multifamily: "11",
  industrial: "4", single_family: "101", condo: "102", residential: "1", vacant: "13",
};

async function arcgis(where, { order = "TOTAL_VAL DESC", count = 2000 } = {}) {
  const params = new URLSearchParams({
    where, outFields: "OWNER1,OWN_CO,OWN_ADDR,OWN_CITY,OWN_STATE,OWN_ZIP,SITE_ADDR,CITY,ZIP,USE_CODE,STYLE,ZONING,TOTAL_VAL,LAND_VAL,BLDG_VAL,LOT_SIZE,BLD_AREA,YEAR_BUILT,UNITS,STORIES,LS_PRICE,LS_DATE,PROP_ID,LOC_ID",
    orderByFields: order, returnGeometry: "false", resultRecordCount: String(count), f: "json",
  });
  const r = await fetch(`${MA_BASE}/query?${params}`);
  if (!r.ok) return [];
  const j = await r.json().catch(() => ({}));
  return (j.features || []).map((f) => f.attributes || {});
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, town, propertyType, address, minValue, maxValue, minSqft, sinceYear, limit, check, debug } = req.body || {};
    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    if (check) return res.status(200).json({ ok: true });
    if (debug) return res.status(200).json({ ok: true, build: "masource-v1", base: MA_BASE });

    const townName = clean(town) || "Boston";
    const where = [`UPPER(CITY)='${sqlStr(townName)}'`];

    const typeKey = clean(propertyType).toLowerCase().replace(/[\s/-]+/g, "_");
    const pre = typeKey in USE_PREFIX ? USE_PREFIX[typeKey] : null;
    if (pre) where.push(`USE_CODE LIKE '${pre}%'`);
    if (address) where.push(`UPPER(SITE_ADDR) LIKE '%${sqlStr(address)}%'`);
    const lo = toNum(minValue), hi = toNum(maxValue), minSf = toNum(minSqft), yr = toNum(sinceYear);
    if (lo != null) where.push(`TOTAL_VAL >= ${lo}`);
    if (hi != null) where.push(`TOTAL_VAL <= ${hi}`);
    if (minSf != null) where.push(`BLD_AREA >= ${minSf}`);
    if (yr != null) where.push(`LS_DATE >= '${yr}0000'`); // YYYYMMDD string compare

    const rows = await arcgis(where.join(" AND "));
    const cap = Math.min(Number(limit) || 100, 400);
    const out = [];
    for (const r of rows) {
      const mState = clean(r.OWN_STATE).toUpperCase();
      const mCity = clean(r.OWN_CITY).toUpperCase();
      const absentee = mState && mState !== "MA" ? "out-of-state" : (mCity && mCity !== townName.toUpperCase() ? "out-of-area" : null);
      const property = clean(r.SITE_ADDR);
      out.push({
        owner: clean(r.OWNER1), co_owner: clean(r.OWN_CO),
        mailing: addr([r.OWN_ADDR, r.OWN_CITY, r.OWN_STATE, r.OWN_ZIP]),
        mailing_city: clean(r.OWN_CITY), mailing_state: mState, absentee,
        address: property, town: clean(r.CITY) || townName,
        use_code: clean(r.USE_CODE), use: clean(r.STYLE), zone: clean(r.ZONING),
        assessed_value: toNum(r.TOTAL_VAL), land_value: toNum(r.LAND_VAL), building_value: toNum(r.BLDG_VAL),
        building_sqft: toNum(r.BLD_AREA), lot_sqft: toNum(r.LOT_SIZE), year_built: toNum(r.YEAR_BUILT),
        units: toNum(r.UNITS), stories: toNum(r.STORIES),
        sale_price: toNum(r.LS_PRICE) || null, sale_date: fmtDate(r.LS_DATE),
        prop_id: clean(r.PROP_ID), loc_id: clean(r.LOC_ID),
        maps_url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(property + ", " + townName + " MA")}`,
      });
      if (out.length >= cap) break;
    }

    return res.status(200).json({
      count: out.length, town: townName,
      note: "Massachusetts assessor parcels (MassGIS Level 3) — owner of record + mailing (absentee flagged), use code, assessed value, building SF, year, and latest sale. For an owner LLC, find principals/contacts via web_research. MA assessed value tracks market reasonably (unlike NY's ratio rolls).",
      properties: out,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "masource" });
  }
}
