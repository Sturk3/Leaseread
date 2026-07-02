// FRONTAGE — Charleston, SC search (Charleston County: downtown Charleston, Mount
// Pleasant, North Charleston, the beach towns, Johns/James/Daniel Island…).
// South Carolina keeps owner data PUBLIC, so this is a full owner-sourcing market.
//
// Sources (all free, no key, discovered + verified live):
//  - Charleston County PARCELS (gisccapps.charlestoncounty.org, GIS_VIEWER/New_Public_Search
//    layer 7): OWNER1/OWNER2 + full mailing (absentee flags), assessor CLASS_CODE (doubles
//    as the use description), deeded acreage, last SALE_PRICE + RECORDED_DATE (→ years
//    owned), deed book/page. Supports attribute, LIKE, date, and spatial (point+radius)
//    queries. NOTE: no assessed-value or building-SF field is public here — $ filters and
//    the value column run on the last sale price.
//  - Situs addresses join by parcel PID from TWO layers: county Address Points (layer 1,
//    unincorporated areas, keyed PID) and the City of Charleston's own City_Addresses
//    hosted layer (keyed PARCELID = "C"+PID). Mt Pleasant / North Charleston publish
//    address points WITHOUT a parcel key, so some parcels keep a legal-description
//    fallback instead of a street address.
//  - City of Charleston New Construction Permits (2010–present, keyed "C"+PID): permit
//    count / latest year / valuation / repositioning flag on the top results.

import { clean, toNum, addr, sqlStr, chunk } from "../_lib/util.js";

const CC_PARCELS = process.env.CHS_PARCELS_URL ||
  "https://gisccapps.charlestoncounty.org/arcgis/rest/services/GIS_VIEWER/New_Public_Search/MapServer/7";
const CC_ADDRESS = process.env.CHS_ADDRESS_URL ||
  "https://gisccapps.charlestoncounty.org/arcgis/rest/services/GIS_VIEWER/New_Public_Search/MapServer/1";
const CITY_ADDRESS = process.env.CHS_CITY_ADDRESS_URL ||
  "https://services2.arcgis.com/tQaXW7Zb1Vphzvgd/arcgis/rest/services/City_Addresses/FeatureServer/0";
const CITY_PERMITS = process.env.CHS_PERMITS_URL ||
  "https://services2.arcgis.com/tQaXW7Zb1Vphzvgd/arcgis/rest/services/New_Construction_Permits/FeatureServer/0";

export const BUILD = "charleston-v1";

const msYear = (ms) => { const n = Number(ms); return Number.isFinite(n) && n > 0 ? new Date(n).getUTCFullYear() : null; };

// Friendly type -> assessor CLASS_CODE prefixes ("530 - SPCLTY-RTL", "500 - General
// Commercial", "700 - SPCLTY-HTL", …). Sampled from the live layer.
const CLASS_PREFIX = {
  any: null,
  retail: ["530", "500"],
  commercial: ["500", "530", "580", "650", "700", "250", "460", "910", "952"],
  office: ["650"],
  apartments: ["200", "210", "130"],
  multifamily: ["200", "210", "130"],
  hotel: ["700"],
  industrial: ["630"],
  vacant: ["905", "910", "952", "900"],
  single_family: ["101"],
  condo: ["160"],
  residential: ["101", "110", "120", "130", "160"],
};
// Dropped from an "any"-type browse: government, schools, churches, rights-of-way,
// utilities, museums, HOA common property — not acquisition targets.
const EXCLUDE_PREFIX = ["671", "681", "691", "451", "481", "411", "711", "742", "990", "165", "167"];

async function arcgisQuery(base, params) {
  const r = await fetch(`${base}/query?${new URLSearchParams({ returnGeometry: "false", f: "json", ...params })}`);
  if (!r.ok) return [];
  const j = await r.json().catch(() => ({}));
  return (j.features || []).map((f) => f.attributes || {});
}

const quoteIn = (vals) => vals.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(",");

// Situs addresses for a set of PIDs — county Address Points (PID) + City of
// Charleston addresses ("C"+PID), batched IN() queries, city label wins.
async function situsByPid(pids) {
  const ids = [...new Set(pids.filter(Boolean))];
  if (!ids.length) return {};
  const byPid = {};
  const waves = await Promise.all(chunk(ids, 80).flatMap((g) => [
    arcgisQuery(CC_ADDRESS, { where: `PID IN (${quoteIn(g)})`, outFields: "PID,WHOLE_ADDRESS,POSTAL_TOWN,POSTAL_CODE", resultRecordCount: "2000" }),
    arcgisQuery(CITY_ADDRESS, { where: `PARCELID IN (${quoteIn(g.map((p) => "C" + p))})`, outFields: "PARCELID,ADDRLABEL,CMTYNAME,ZIPCODE", resultRecordCount: "2000" }),
  ]));
  for (const rows of waves) for (const a of rows) {
    const pid = clean(a.PID || String(a.PARCELID || "").replace(/^C/, ""));
    if (!pid) continue;
    const street = clean(a.WHOLE_ADDRESS || a.ADDRLABEL);
    if (!street) continue;
    const town = clean(a.POSTAL_TOWN || a.CMTYNAME) || "Charleston";
    // Prefer the shortest street label per parcel (multi-unit parcels list many points;
    // the shortest is usually the base building address).
    if (!byPid[pid] || street.length < byPid[pid].street.length) byPid[pid] = { street, town, zip: clean(a.POSTAL_CODE || a.ZIPCODE) };
  }
  return byPid;
}

// Address-first search: find PIDs whose situs matches the typed street, across both
// address layers (the county layer only covers unincorporated Charleston County).
// Exported for api/charlestonintel.js (address → parcel resolution).
export async function pidsByAddress(text) {
  const q = sqlStr(text);
  const [county, city] = await Promise.all([
    arcgisQuery(CC_ADDRESS, { where: `UPPER(WHOLE_ADDRESS) LIKE '%${q}%'`, outFields: "PID", resultRecordCount: "400" }),
    arcgisQuery(CITY_ADDRESS, { where: `UPPER(ADDRLABEL) LIKE '%${q}%'`, outFields: "PARCELID", resultRecordCount: "400" }),
  ]);
  const pids = new Set();
  for (const r of county) if (clean(r.PID)) pids.add(clean(r.PID));
  for (const r of city) { const p = clean(r.PARCELID).replace(/^C/, ""); if (p) pids.add(p); }
  return [...pids];
}

// City of Charleston construction permits (2010–present) for the top parcels —
// development-activity signal for the Opportunity Score.
const REPOSITION_RE = /new construction|demolition|renovation|rehab|addition|change of use|commercial/i;
async function enrichPermits(props, cap = 60) {
  const targets = props.filter((p) => p.pid).slice(0, cap);
  if (!targets.length) return;
  const groups = await Promise.all(chunk(targets.map((p) => "C" + p.pid), 80).map((g) =>
    arcgisQuery(CITY_PERMITS, { where: `MAIN_PARCEL_NUMBER IN (${quoteIn(g)})`, outFields: "MAIN_PARCEL_NUMBER,PERMIT_TYPE,WORK_CLASS,ISSUE_YEAR,VALUATION", resultRecordCount: "2000" })));
  const byPid = {};
  for (const rows of groups) for (const r of rows) {
    const pid = clean(r.MAIN_PARCEL_NUMBER).replace(/^C/, "");
    if (pid) (byPid[pid] = byPid[pid] || []).push(r);
  }
  for (const p of targets) {
    const rows = byPid[p.pid] || [];
    p.permit_count = rows.length;
    if (rows.length) {
      p.latest_permit_year = Math.max(...rows.map((r) => toNum(r.ISSUE_YEAR) || 0)) || null;
      p.permit_valuation = rows.reduce((s, r) => s + (toNum(r.VALUATION) || 0), 0) || null;
      p.permit_types = [...new Set(rows.map((r) => clean(r.WORK_CLASS || r.PERMIT_TYPE)).filter(Boolean))].slice(0, 4);
      p.repositioning = rows.some((r) => REPOSITION_RE.test(`${r.PERMIT_TYPE} ${r.WORK_CLASS}`));
    }
  }
}

export async function search(q) {
  const { propertyType, address, owner, minValue, maxValue, minAcres, sinceYear, limit, centerLat, centerLon, radiusMiles } = q;

  const where = [];
  // OWNER-PORTFOLIO mode: every Charleston County parcel held by this owner; type filter off.
  const ownerQ = clean(owner);
  if (ownerQ) {
    where.push(`(UPPER(OWNER1) LIKE '%${sqlStr(ownerQ)}%' OR UPPER(OWNER2) LIKE '%${sqlStr(ownerQ)}%')`);
  } else {
    const typeKey = clean(propertyType).toLowerCase().replace(/[\s/-]+/g, "_");
    const prefixes = typeKey in CLASS_PREFIX ? CLASS_PREFIX[typeKey] : null;
    if (prefixes) where.push(`(${prefixes.map((p) => `CLASS_CODE LIKE '${p}%'`).join(" OR ")})`);
    else if (!address) where.push(`NOT (${EXCLUDE_PREFIX.map((p) => `CLASS_CODE LIKE '${p}%'`).join(" OR ")})`);
  }

  // Address search resolves to PIDs first (situs lives on the address layers, not the parcel).
  if (address) {
    const pids = await pidsByAddress(address);
    if (!pids.length) return { market: "charleston", count: 0, county: "Charleston, SC", note: `No Charleston County address matched "${clean(address)}".`, properties: [] };
    where.push(`PID IN (${quoteIn(pids.slice(0, 200))})`);
  }

  const lo = toNum(minValue), hi = toNum(maxValue);
  if (lo != null) where.push(`SALE_PRICE >= ${lo}`);
  if (hi != null) where.push(`SALE_PRICE <= ${hi}`);
  const yr = toNum(sinceYear);
  if (yr != null) where.push(`RECORDED_DATE >= DATE '${yr}-01-01'`);

  const params = {
    where: where.join(" AND ") || "1=1",
    outFields: "PID,OWNER1,OWNER2,MAIL_ST_NO,MAIL_ST_NAME,MAIL_ST_TYPE,MAIL_2ND_ADDR,MAIL_CITY,MAIL_STATE,MAIL_ZIP,CLASS_CODE,ACREAGE,SALE_PRICE,RECORDED_DATE,DEED_BOOK_PAGE,LEGAL_DESCR,SUBDIVISION,TAX_DISTRICT",
    orderByFields: "SALE_PRICE DESC",
    resultRecordCount: "2000",
  };
  const cLat = toNum(centerLat), cLon = toNum(centerLon), rad = toNum(radiusMiles);
  if (cLat != null && cLon != null) {
    params.geometry = JSON.stringify({ x: cLon, y: cLat, spatialReference: { wkid: 4326 } });
    params.geometryType = "esriGeometryPoint";
    params.inSR = "4326";
    params.spatialRel = "esriSpatialRelIntersects";
    if (rad && rad > 0) { params.distance = String(rad * 1609.34); params.units = "esriSRUnit_Meter"; }
  }
  const rows = await arcgisQuery(CC_PARCELS, params);

  const minAc = toNum(minAcres), nowY = new Date().getUTCFullYear();
  const cap = Math.min(Number(limit) || 250, 500);
  const out = [];
  const seen = new Set(); // condo stacks repeat a PID — one lead per parcel
  for (const r of rows) {
    const pid = clean(r.PID);
    if (!pid || seen.has(pid)) continue;
    const acres = toNum(r.ACREAGE);
    if (minAc != null && (acres == null || acres < minAc)) continue;
    seen.add(pid);

    const mState = clean(r.MAIL_STATE).toUpperCase();
    const salePrice = toNum(r.SALE_PRICE) || null;
    const saleYear = msYear(r.RECORDED_DATE);
    out.push({
      owner: clean(r.OWNER1), co_owner: clean(r.OWNER2),
      mailing: addr([[clean(r.MAIL_ST_NO), clean(r.MAIL_ST_NAME), clean(r.MAIL_ST_TYPE)].filter(Boolean).join(" "), r.MAIL_2ND_ADDR, r.MAIL_CITY, r.MAIL_STATE, r.MAIL_ZIP]),
      mailing_city: clean(r.MAIL_CITY), mailing_state: mState, mailing_zip: clean(r.MAIL_ZIP),
      absentee: mState && mState !== "SC" ? "out-of-state" : null, // out-of-area refined after the situs join
      address: "", town: "", pid,
      use: clean(r.CLASS_CODE), zone: null,
      acres, legal_descr: clean(r.LEGAL_DESCR), subdivision: clean(r.SUBDIVISION), tax_district: clean(r.TAX_DISTRICT),
      deed_book_page: clean(r.DEED_BOOK_PAGE),
      sale_price: salePrice, sale_year: saleYear,
      years_owned: saleYear ? nowY - saleYear : null,
      maps_url: "",
    });
    if (out.length >= cap) break;
  }

  // Situs addresses (two layers) + city construction permits, batched.
  const [situs] = await Promise.all([
    situsByPid(out.map((p) => p.pid)).catch(() => ({})),
    enrichPermits(out).catch(() => {}),
  ]);
  for (const p of out) {
    const s = situs[p.pid];
    if (s) {
      p.address = s.street;
      p.town = s.town;
      if (!p.absentee && p.mailing_city && s.town && p.mailing_city.toUpperCase() !== s.town.toUpperCase()) p.absentee = "out-of-area";
    } else {
      // Mt Pleasant / North Charleston publish no parcel-keyed address points —
      // fall back to the legal description so the row isn't blank.
      p.address = p.legal_descr || `Parcel ${p.pid}`;
      p.town = "Charleston County";
    }
    p.maps_url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((s ? `${p.address}, ${p.town}` : p.pid + " Charleston County") + " SC")}`;
  }

  return {
    market: "charleston", count: out.length, county: "Charleston, SC",
    note: "Charleston County assessor parcels (gisccapps.charlestoncounty.org) — OWNER of record + mailing (absentee flagged), assessor class/use, deeded acreage, last sale price + recorded date (→ years owned), deed book/page. Situs addresses joined from county + City of Charleston address layers (Mt Pleasant / N. Charleston parcels may show a legal description instead). permit_count / latest_permit_year / repositioning come from City of Charleston construction permits (2010–present) on the top results. NO assessed value or building SF is published — $ figures are last SALE prices, so long-held parcels show none; treat minValue as a recent-sale filter. For an owner LLC, use web_research (SC Secretary of State) for principals/contacts.",
    properties: out,
  };
}
