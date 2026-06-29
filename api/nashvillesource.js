// FRONTAGE — Nashville / Davidson County, TN sourcing, from Metro Nashville's daily-updated
// parcel + ownership ArcGIS service. Tennessee is an open-records state, so this is a FULL
// owner-sourcing market (unlike CA/SF): per parcel it gives the OWNER of record + mailing
// address (absentee flagged), property address, land use, zoning, appraised/assessed value,
// last SALE price + date (→ years owned), and acreage. Free, no key, password-gated.

const NASH_BASE = process.env.NASH_PARCELS_URL ||
  "https://maps.nashville.gov/arcgis/rest/services/Cadastral/Parcels/MapServer/0";
// Metro's ArcGIS-Hub org (permits, code violations) — for the parcel-exact distress / activity
// enrichment that feeds the Opportunity Score, joined by APN in ONE batched query per layer.
const NASH_HUB = process.env.NASH_HUB_URL || "https://services2.arcgis.com/HdTo6HJqh92wn4D8/arcgis/rest/services";

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const toNum = (v) => { if (v == null || v === "") return null; const n = Number(String(v).replace(/[$,]/g, "")); return Number.isFinite(n) ? n : null; };
const addr = (parts) => parts.map(clean).filter(Boolean).join(", ");
const sqlStr = (s) => clean(s).toUpperCase().replace(/'/g, "''");
const msYear = (ms) => { const n = Number(ms); return Number.isFinite(n) && n > 0 ? new Date(n).getUTCFullYear() : null; };

// Metro stores street names ABBREVIATED ("12TH AVE S"), but geocoders hand back full words
// ("12th Avenue South"). Normalize a typed/geocoded street to Metro's form so the LIKE matches.
const STREET_ABBR = {
  AVENUE: "AVE", STREET: "ST", DRIVE: "DR", ROAD: "RD", BOULEVARD: "BLVD", LANE: "LN", COURT: "CT",
  PLACE: "PL", PARKWAY: "PKWY", HIGHWAY: "HWY", CIRCLE: "CIR", TERRACE: "TER", TRAIL: "TRL",
  SQUARE: "SQ", COVE: "CV", CROSSING: "XING", BEND: "BND", LOOP: "LOOP", PIKE: "PIKE",
  NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W", NORTHEAST: "NE", NORTHWEST: "NW", SOUTHEAST: "SE", SOUTHWEST: "SW",
};
const normStreet = (s) => clean(s).toUpperCase().split(/\s+/).map((w) => STREET_ABBR[w] || w).join(" ").trim();

// Friendly type -> LUDesc LIKE tokens (Nashville land use is granular; OR them together).
const USE_PATTERNS = {
  any: null,
  commercial: ["RETAIL", "STORE", "OFFICE", "MALL", "RESTURANT", "HOTEL", "MOTEL", "MARKET", "SHOP", "COMMERCIAL", "BUSINESS CENTER"],
  retail: ["RETAIL", "STORE", "MALL", "SUPERMARKET", "RESTURANT", "FAST FOOD", "DEPARTMENT STORE", "SHOP", "MARKET"],
  office: ["OFFICE"],
  apartments: ["APARTMENT", "DUPLEX", "QUADPLEX", "TRIPLEX"],
  multifamily: ["APARTMENT", "DUPLEX", "QUADPLEX", "TRIPLEX"],
  industrial: ["MANUFACTURING", "WAREHOUSE", "PROCESSING", "LUMBER", "OPEN STORAGE"],
  hotel: ["HOTEL", "MOTEL"],
  vacant: ["VACANT"],
  single_family: ["SINGLE FAMILY"],
  residential: ["RESIDENTIAL", "SINGLE FAMILY", "DUPLEX", "CONDO", "MOBILE HOME", "APARTMENT"],
};

// spatial: { lat, lon, distanceMeters } — point-in-polygon (distance 0 = the one lot at that point)
// or a buffer search around the point (distance > 0 = the lots within radius). Null = attribute-only.
async function arcgis(where, spatial) {
  const params = {
    where: where || "1=1", outFields: "APN,ParID,Owner,OwnAddr1,OwnAddr2,OwnCity,OwnState,OwnZip,PropAddr,PropCity,PropZip,LUCode,LUDesc,Zoning,LandAppr,ImprAppr,TotlAppr,TotlAssd,Acres,StatedArea,Front,Side,SalePrice,OwnDate,Council",
    orderByFields: "TotlAppr DESC", returnGeometry: "false", resultRecordCount: "2000", f: "json",
  };
  if (spatial) {
    params.geometry = JSON.stringify({ x: spatial.lon, y: spatial.lat, spatialReference: { wkid: 4326 } });
    params.geometryType = "esriGeometryPoint";
    params.inSR = "4326";
    params.spatialRel = "esriSpatialRelIntersects";
    if (spatial.distanceMeters > 0) { params.distance = String(spatial.distanceMeters); params.units = "esriSRUnit_Meter"; }
  }
  const r = await fetch(`${NASH_BASE}/query?${new URLSearchParams(params)}`);
  if (!r.ok) return [];
  const j = await r.json().catch(() => ({}));
  return (j.features || []).map((f) => f.attributes || {});
}

// Generic ArcGIS-Hub query → attribute rows; never throws (a dead layer just yields no enrichment).
async function hubQuery(layer, params) {
  try {
    const r = await fetch(`${NASH_HUB}/${layer}/FeatureServer/0/query?${new URLSearchParams({ returnGeometry: "false", f: "json", ...params })}`);
    if (!r.ok) return [];
    const j = await r.json().catch(() => ({}));
    return (j.features || []).map((f) => f.attributes || {});
  } catch { return []; }
}

// Attach a parcel-exact DISTRESS + development-activity read to each lead, so the grade can use it.
// Two batched queries (open code violations by Property_APN, building permits by Parcel) for the
// top `cap` parcels — joined by APN in memory. Bounded so a big result set can't blow the budget.
const REPOSITION_RE = /demolition|commercial - new|tenant finish|finish out|rehab|addition|use & occupancy/i;
async function enrichNashville(props, cap = 60) {
  const targets = props.filter((p) => p.apn).slice(0, cap);
  if (!targets.length) return;
  const inList = targets.map((p) => `'${String(p.apn).replace(/'/g, "''")}'`).join(",");
  const [viol, perms] = await Promise.all([
    hubQuery("Property_Standards_Violations_2", { where: `Property_APN IN (${inList}) AND Status<>'Closed'`, outFields: "Property_APN,Reported_Problem,Status", resultRecordCount: "2000" }),
    hubQuery("Building_Permits_Issued_2", { where: `Parcel IN (${inList})`, outFields: "Parcel,Permit_Type_Description,Date_Issued", orderByFields: "Date_Issued DESC", resultRecordCount: "2000" }),
  ]);
  const vByApn = {}, pByApn = {};
  for (const v of viol) { const k = clean(v.Property_APN); if (k) (vByApn[k] = vByApn[k] || []).push(clean(v.Reported_Problem)); }
  for (const p of perms) { const k = clean(p.Parcel); if (k) (pByApn[k] = pByApn[k] || []).push(clean(p.Permit_Type_Description)); }
  for (const p of targets) {
    const vs = vByApn[p.apn] || [], ps = pByApn[p.apn] || [];
    p.open_violations = vs.length;
    p.violation_types = [...new Set(vs.filter(Boolean))].slice(0, 4);
    p.permit_count = ps.length;
    p.repositioning = ps.some((t) => REPOSITION_RE.test(t));
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, propertyType, address, owner, minValue, maxValue, minAcres, sinceYear, limit, centerLat, centerLon, radiusMiles, check, debug } = req.body || {};
    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    if (check) return res.status(200).json({ ok: true });
    if (debug) return res.status(200).json({ ok: true, build: "nashvillesource-v4-owner", base: NASH_BASE });

    const where = ["IsActive='Y'"];
    // OWNER-PORTFOLIO mode: every Davidson County parcel held by this exact owner (the LLC tracker).
    // Skips the type filter so the whole book shows, regardless of each parcel's land use.
    const ownerQ = clean(owner);
    if (!ownerQ) {
      const typeKey = clean(propertyType).toLowerCase().replace(/[\s/-]+/g, "_");
      const pats = typeKey in USE_PATTERNS ? USE_PATTERNS[typeKey] : (propertyType ? [sqlStr(propertyType)] : null);
      if (pats && pats.length) where.push(`(${pats.map((p) => `UPPER(LUDesc) LIKE '%${p.replace(/'/g, "''")}%'`).join(" OR ")})`);
    } else {
      where.push(`UPPER(Owner) LIKE '%${sqlStr(ownerQ)}%'`);
    }
    if (address) where.push(`UPPER(PropAddr) LIKE '%${normStreet(address).replace(/'/g, "''")}%'`);
    const lo = toNum(minValue), hi = toNum(maxValue);
    if (lo != null) where.push(`TotlAppr >= ${lo}`);
    if (hi != null) where.push(`TotlAppr <= ${hi}`);

    // When the caller passes a point (a picked address), search SPATIALLY: radius 0 = the single
    // parcel at that point ("just it"); radius > 0 = the parcels within that many miles.
    const cLat = toNum(centerLat), cLon = toNum(centerLon), rad = toNum(radiusMiles);
    const spatial = (cLat != null && cLon != null) ? { lat: cLat, lon: cLon, distanceMeters: rad && rad > 0 ? rad * 1609.34 : 0 } : null;
    const rows = await arcgis(where.join(" AND "), spatial);
    const minAc = toNum(minAcres), yr = toNum(sinceYear), nowY = new Date().getUTCFullYear();
    const cap = Math.min(Number(limit) || 100, 400);
    const out = [];
    for (const r of rows) {
      const acres = toNum(r.Acres);
      if (minAc != null && (acres == null || acres < minAc)) continue;
      const saleYear = msYear(r.OwnDate);
      if (yr != null && (saleYear == null || saleYear < yr)) continue;

      const mState = clean(r.OwnState).toUpperCase();
      const propCity = clean(r.PropCity).toUpperCase();
      const mCity = clean(r.OwnCity).toUpperCase();
      const absentee = mState && mState !== "TN" ? "out-of-state" : (mCity && propCity && mCity !== propCity ? "out-of-area" : null);
      const property = clean(r.PropAddr);
      out.push({
        owner: clean(r.Owner),
        mailing: addr([r.OwnAddr1, r.OwnAddr2, r.OwnCity, r.OwnState, r.OwnZip]),
        mailing_city: clean(r.OwnCity), mailing_state: mState, absentee,
        address: property, city: clean(r.PropCity) || "Nashville", apn: clean(r.APN),
        use: clean(r.LUDesc), use_code: clean(r.LUCode), zone: clean(r.Zoning),
        appraised_value: toNum(r.TotlAppr), land_value: toNum(r.LandAppr), improvement_value: toNum(r.ImprAppr),
        assessed_value: toNum(r.TotlAssd), acres, council_district: clean(r.Council),
        frontage_ft: toNum(r.Front) || null, depth_ft: toNum(r.Side) || null,
        sale_price: toNum(r.SalePrice) || null, sale_year: saleYear,
        years_owned: saleYear ? nowY - saleYear : null,
        maps_url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(property + ", " + (clean(r.PropCity) || "Nashville") + " TN")}`,
      });
      if (out.length >= cap) break;
    }

    // Parcel-exact distress + activity enrichment (open code violations / building permits),
    // so the Opportunity Score can grade Nashville on distress like NYC's tax-lien signal.
    await enrichNashville(out).catch(() => {});

    return res.status(200).json({
      count: out.length, county: "Davidson (Nashville)",
      note: "Metro Nashville / Davidson County parcel + ownership data (maps.nashville.gov, updated daily). Owner of record + mailing (absentee flagged), land use, value, last sale, and years owned — TN is an open-records state, so owners are public. No building SF in this dataset (land acreage only). For an owner LLC, use web_research for principals/contacts.",
      properties: out,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "nashvillesource" });
  }
}
