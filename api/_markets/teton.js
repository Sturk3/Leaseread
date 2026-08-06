// FRONTAGE — Jackson Hole / Teton County, WY search, from the Wyoming Property Tax
// Division's statewide parcel layer (wyo-prop-div on ArcGIS Online, compiled annually
// from every county assessor). Wyoming is an open-records state, so this is a FULL
// owner-sourcing market: per parcel it gives the OWNER of record (+ co-owner) + mailing
// address (absentee flagged), property address, ACTUAL (market) value + assessed value,
// gross acreage, tax district, legal description, and the county parcel/account numbers.
// Free, no key. ~12,500 Teton County parcels (Jackson, Teton Village, Wilson, Moose,
// Kelly, Moran, Alta, Hoback).
//
// Source: "Wyoming_Parcels_for_<year>" FeatureServer. A new vintage publishes each
// January; override with WY_PARCELS_URL when the next year's layer lands.
// QUIRK: the statewide roll carries NO use/class code, NO year built, and NO sale
// history — filter by value/acreage/street/owner and refine type by eye.

import { clean, toNum, addr, sqlStr } from "../_lib/util.js";

const WY_BASE = process.env.WY_PARCELS_URL ||
  "https://services3.arcgis.com/r0iJ85SKZ4zAzz3P/arcgis/rest/services/Wyoming_Parcels_for_2026/FeatureServer/0";

export const BUILD = "teton-v1";

// Mailing cities that count as LOCAL to Teton County — a WY mailing outside these is
// still flagged out-of-area (e.g. a Cheyenne holding company).
const TETON_CITIES = new Set(["JACKSON", "JACKSON HOLE", "TETON VILLAGE", "WILSON", "MOOSE", "KELLY", "MORAN", "ALTA", "HOBACK"]);

const OUT_FIELDS = "jurisdicti,ownername1,ownername2,mailaddres,mailcity,mailstate,mailzipcod,locationad,legal,actualvalu,assessedva,landgrossa,parcelnb,accountno,taxyear,DEFAULTTAX";

// spatial: { lat, lon, distanceMeters } — point-in-polygon (distance 0 = the one parcel at
// that point) or a buffer around it (distance > 0). Null = attribute-only query.
async function arcgis(where, spatial) {
  const params = {
    where: where || "1=1",
    outFields: OUT_FIELDS,
    orderByFields: "actualvalu DESC", returnGeometry: "false", returnCentroid: "true", outSR: "4326", resultRecordCount: "2000", f: "json",
  };
  if (spatial) {
    params.geometry = JSON.stringify({ x: spatial.lon, y: spatial.lat, spatialReference: { wkid: 4326 } });
    params.geometryType = "esriGeometryPoint";
    params.inSR = "4326";
    params.spatialRel = "esriSpatialRelIntersects";
    if (spatial.distanceMeters > 0) { params.distance = String(spatial.distanceMeters); params.units = "esriSRUnit_Meter"; }
  }
  const r = await fetch(`${WY_BASE}/query?${new URLSearchParams(params)}`);
  if (!r.ok) return [];
  const j = await r.json().catch(() => ({}));
  return (j.features || []).map((f) => ({ ...(f.attributes || {}), __c: f.centroid || null })); // centroid → row lat/lon for the map
}

export async function search(q) {
  const { address, owner, minValue, maxValue, minAcres, limit, centerLat, centerLon, radiusMiles } = q;

  // Everything is scoped to Teton County — the layer is statewide.
  const where = ["UPPER(jurisdicti) LIKE '%TETON%'"];
  // OWNER-PORTFOLIO mode: every Teton County parcel held by this exact owner (the LLC tracker).
  const ownerQ = clean(owner);
  if (ownerQ) {
    const o = sqlStr(ownerQ);
    where.push(`(UPPER(ownername1) LIKE '%${o}%' OR UPPER(ownername2) LIKE '%${o}%')`);
  }
  if (address) where.push(`UPPER(locationad) LIKE '%${sqlStr(String(address).toUpperCase().replace(/\s+/g, " ").trim())}%'`);
  const lo = toNum(minValue), hi = toNum(maxValue);
  if (lo != null) where.push(`actualvalu >= ${lo}`);
  if (hi != null) where.push(`actualvalu <= ${hi}`);

  // A picked address searches SPATIALLY: radius 0 = the single parcel at that point ("just it");
  // radius > 0 = parcels within that many miles.
  const cLat = toNum(centerLat), cLon = toNum(centerLon), rad = toNum(radiusMiles);
  const spatial = (cLat != null && cLon != null) ? { lat: cLat, lon: cLon, distanceMeters: rad && rad > 0 ? rad * 1609.34 : 0 } : null;
  const rows = await arcgis(where.join(" AND "), spatial);

  const minAc = toNum(minAcres);
  const cap = Math.min(Number(limit) || 250, 500);
  const out = [];
  for (const r of rows) {
    const ownerName = clean(r.ownername1);
    const property = clean(r.locationad);
    const value = toNum(r.actualvalu);
    // The roll carries placeholder rows (blank owner, $0 — roads/common area); skip them.
    if (!ownerName && !property) continue;
    const acres = toNum(r.landgrossa);
    if (minAc != null && (acres == null || acres < minAc)) continue;

    const mState = clean(r.mailstate).toUpperCase();
    const mCity = clean(r.mailcity).toUpperCase();
    const absentee = mState && mState !== "WY" ? "out-of-state" : (mCity && !TETON_CITIES.has(mCity) ? "out-of-area" : null);
    out.push({
      owner: ownerName, co_owner: clean(r.ownername2) || null,
      mailing: addr([r.mailaddres, r.mailcity, r.mailstate, r.mailzipcod]),
      mailing_city: clean(r.mailcity), mailing_state: mState, mailing_zip: clean(r.mailzipcod), absentee,
      address: property, city: mCity && TETON_CITIES.has(mCity) ? mCity.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : "Jackson",
      parcel: clean(r.parcelnb), account: clean(r.accountno) || null,
      lat: r.__c && Number.isFinite(r.__c.y) ? r.__c.y : null, lon: r.__c && Number.isFinite(r.__c.x) ? r.__c.x : null,
      market_value: value, assessed_value: toNum(r.assessedva),
      acres, tax_district: clean(r.DEFAULTTAX) || null, tax_year: clean(r.taxyear) || null,
      legal: clean(r.legal) || null,
      maps_url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(property + ", Teton County WY")}`,
    });
    if (out.length >= cap) break;
  }

  return {
    market: "teton", count: out.length, county: "Teton (Jackson Hole)",
    note: "Wyoming Property Tax Division statewide parcel roll (compiled from the Teton County Assessor, annual vintage). Owner of record + mailing (absentee flagged), actual (market) value + assessed value, gross acreage, tax district, and parcel/account numbers — Wyoming is an open-records state, so owners are public. QUIRKS: the roll has NO use/class code (a type filter can't apply — refine retail vs residential by eye/street), NO year built, and NO sale history. NOTE the 'city' shown is inferred from the owner's local mailing city; site addresses don't carry one. For an owner LLC, use the dossier's unmask + web research — Wyoming hides LLC members, but the registered agent is public at wyobiz.wyo.gov.",
    properties: out,
  };
}
