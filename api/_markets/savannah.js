// FRONTAGE — Savannah / Chatham County, GA search, from SAGIS (Savannah Area GIS) open data.
// Georgia is an open-records state, so this is a FULL owner-sourcing market: per parcel it
// gives the OWNER of record (+ co-owner) + mailing address (absentee flagged), property
// address, GA use class, fair-market value (land/building split), acreage, year built,
// last SALE price + year (→ years owned), and street frontage. Free, no key.
//
// Source: SAGIS "OpenData/Parcels" FeatureServer, the current "Parcel Digest <year>" layer.
// The layer index increments yearly (…/26 = 2024, /27 = 2025); override with SAV_PARCELS_URL
// when the next digest publishes.

import { clean, toNum, addr, sqlStr } from "../_lib/util.js";

const SAV_BASE = process.env.SAV_PARCELS_URL ||
  "https://pub.sagis.org/arcgis/rest/services/OpenData/Parcels/FeatureServer/27";

export const BUILD = "savannah-v1";

// Friendly type -> GA Dept. of Revenue property-CLASS prefix on Property_Use (R/C/I/A/E/U).
// GA doesn't separate retail from other commercial in the class code, so retail/office/
// commercial all map to C% (surfaced honestly in the note); refine by eye via Commercial_Cat.
const USE_PATTERNS = {
  any: null,
  commercial: ["C"], retail: ["C"], office: ["C"], hotel: ["C"],
  industrial: ["I"],
  residential: ["R"], single_family: ["R"], apartments: ["R", "C"], multifamily: ["R", "C"],
  agricultural: ["A"], vacant: ["V"],
};
// Class prefixes to DROP from an "any"-type area browse — tax-exempt + utility parcels that
// aren't acquisition targets (governments, churches, schools = E; utilities = U).
const EXCLUDE_CLASS = ["E", "U"];

// spatial: { lat, lon, distanceMeters } — point-in-polygon (distance 0 = the one parcel at
// that point) or a buffer around it (distance > 0). Null = attribute-only query.
async function arcgis(where, spatial) {
  const params = {
    where: where || "1=1",
    outFields: "PIN,Owner,Owner2,Mailing_Address,Mailing_City,Mailing_State,Mailing_Zip,PropAddress_Full,PropAddress_City,PropAddress_Zip,Property_Use,Commercial_Cat,FairMarketValue,FMV_Land,FMV_Building,Total_Assessment,Acres,YearBuilt,Sale_Price,Sale_YY,Land_Frontage_1,Legal_Description,Municipality",
    orderByFields: "FairMarketValue DESC", returnGeometry: "false", resultRecordCount: "2000", f: "json",
  };
  if (spatial) {
    params.geometry = JSON.stringify({ x: spatial.lon, y: spatial.lat, spatialReference: { wkid: 4326 } });
    params.geometryType = "esriGeometryPoint";
    params.inSR = "4326";
    params.spatialRel = "esriSpatialRelIntersects";
    if (spatial.distanceMeters > 0) { params.distance = String(spatial.distanceMeters); params.units = "esriSRUnit_Meter"; }
  }
  const r = await fetch(`${SAV_BASE}/query?${new URLSearchParams(params)}`);
  if (!r.ok) return [];
  const j = await r.json().catch(() => ({}));
  return (j.features || []).map((f) => f.attributes || {});
}

export async function search(q) {
  const { propertyType, address, owner, minValue, maxValue, minAcres, sinceYear, limit, centerLat, centerLon, radiusMiles } = q;

  const where = [];
  // OWNER-PORTFOLIO mode: every Chatham County parcel held by this exact owner (the LLC tracker).
  // Skips the type filter so the whole book shows.
  const ownerQ = clean(owner);
  if (ownerQ) {
    where.push(`UPPER(Owner) LIKE '%${sqlStr(ownerQ)}%'`);
  } else {
    const typeKey = clean(propertyType).toLowerCase().replace(/[\s/-]+/g, "_");
    const prefixes = typeKey in USE_PATTERNS ? USE_PATTERNS[typeKey] : null;
    if (prefixes && prefixes.length) {
      where.push(`(${prefixes.map((p) => `Property_Use LIKE '${p}%'`).join(" OR ")})`);
    } else if (!address) {
      // AREA BROWSE with no type → drop tax-exempt / utility parcels so the list leads with
      // real targets. Not applied to a specific-address lookup (you may be looking one up).
      where.push(`NOT (${EXCLUDE_CLASS.map((p) => `Property_Use LIKE '${p}%'`).join(" OR ")})`);
    }
  }
  if (address) where.push(`UPPER(PropAddress_Full) LIKE '%${sqlStr(String(address).toUpperCase().replace(/\s+/g, " ").trim())}%'`);
  const lo = toNum(minValue), hi = toNum(maxValue);
  if (lo != null) where.push(`FairMarketValue >= ${lo}`);
  if (hi != null) where.push(`FairMarketValue <= ${hi}`);

  // A picked address searches SPATIALLY: radius 0 = the single parcel at that point ("just it");
  // radius > 0 = parcels within that many miles.
  const cLat = toNum(centerLat), cLon = toNum(centerLon), rad = toNum(radiusMiles);
  const spatial = (cLat != null && cLon != null) ? { lat: cLat, lon: cLon, distanceMeters: rad && rad > 0 ? rad * 1609.34 : 0 } : null;
  const rows = await arcgis(where.length ? where.join(" AND ") : "1=1", spatial);

  const minAc = toNum(minAcres), yr = toNum(sinceYear), nowY = new Date().getUTCFullYear();
  const cap = Math.min(Number(limit) || 250, 500);
  const out = [];
  for (const r of rows) {
    const acres = toNum(r.Acres);
    if (minAc != null && (acres == null || acres < minAc)) continue;
    const saleYear = toNum(r.Sale_YY);
    if (yr != null && (saleYear == null || saleYear < yr)) continue;

    const mState = clean(r.Mailing_State).toUpperCase();
    const mCity = clean(r.Mailing_City).toUpperCase();
    const propCity = clean(r.PropAddress_City).toUpperCase();
    const absentee = mState && mState !== "GA" ? "out-of-state" : (mCity && propCity && mCity !== propCity ? "out-of-area" : null);
    const property = clean(r.PropAddress_Full);
    const cityName = clean(r.PropAddress_City) || clean(r.Municipality) || "Savannah";
    out.push({
      owner: clean(r.Owner), co_owner: clean(r.Owner2) || null,
      mailing: addr([r.Mailing_Address, r.Mailing_City, r.Mailing_State, r.Mailing_Zip]),
      mailing_city: clean(r.Mailing_City), mailing_state: mState, mailing_zip: clean(r.Mailing_Zip), absentee,
      address: property, city: cityName, pin: clean(r.PIN),
      use: clean(r.Property_Use), commercial_cat: clean(r.Commercial_Cat) || null,
      market_value: toNum(r.FairMarketValue), assessed_value: toNum(r.FairMarketValue),
      land_value: toNum(r.FMV_Land), improvement_value: toNum(r.FMV_Building), total_assessment: toNum(r.Total_Assessment),
      acres, year_built: toNum(r.YearBuilt) || null, frontage_ft: toNum(r.Land_Frontage_1) || null,
      sale_price: toNum(r.Sale_Price) || null, sale_year: saleYear,
      years_owned: saleYear ? nowY - saleYear : null,
      legal: clean(r.Legal_Description) || null,
      maps_url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(property + ", " + cityName + " GA")}`,
    });
    if (out.length >= cap) break;
  }

  return {
    market: "savannah", count: out.length, county: "Chatham (Savannah)",
    note: "SAGIS / Chatham County Board of Assessors parcel data (pub.sagis.org, annual digest). Owner of record + mailing (absentee flagged), GA use class, fair-market value (land/building split), acreage, year built, last sale + years owned, and street frontage — GA is an open-records state, so owners are public. Note: GA's use class doesn't separate retail from other commercial (both are class C), so a retail/office/commercial filter returns all commercial. For an owner LLC, use the dossier's unmask + web research for principals/contacts.",
    properties: out,
  };
}
