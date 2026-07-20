// FRONTAGE — consolidated Charleston, SC public-records intel for ONE parcel
// (the Charleston analog of nashvilleintel / sfintel). Pass the PID from a
// Charleston search (or an address — it resolves to the parcel), and this fans
// out across the county's and the City of Charleston's open data, joined
// parcel-exact where a key exists and point-in-polygon at the parcel centroid
// for the regulatory/risk overlays. All free ArcGIS layers, no key:
//
//  - Parcel + owner (county assessor PARCELS, by PID)
//  - CONSTRUCTION PERMITS detail, 2010–present (city, keyed "C"+PID)
//  - HOTEL ENTITLEMENT on the parcel (city Hotel_Entitlements, keyed PARCELID —
//    name, rooms, status, opening date: hospitality is Charleston's big use fight)
//  - ZONING at the point: city Base_Zoning (+ PUD name) inside the city,
//    county Zoning Districts elsewhere
//  - OLD & HISTORIC DISTRICT + OLD CITY HEIGHT DISTRICT membership (the binding
//    regulatory constraint on the peninsula — BAR review, height caps)
//  - SHORT-TERM-RENTAL overlay + ACCOMMODATIONS overlay membership
//  - FEMA FLOOD zone at the point (county DFIRM: zone, SFHA yes/no, static BFE)
//  - STREET-FLOODING history nearby (city Flooded_Vehicle_History points — the
//    Charleston-specific diligence signal FEMA maps miss)
//  - CRIME nearby (city PDI Reported Incidents: count by category, recent years)
//
// Password-gated like the rest of the API.

import { clean, toNum, chunk } from "./_lib/util.js";
import { pidsByAddress } from "./_markets/charleston.js";

const CC_PARCELS = process.env.CHS_PARCELS_URL ||
  "https://gisccapps.charlestoncounty.org/arcgis/rest/services/GIS_VIEWER/New_Public_Search/MapServer/7";
const CC_FEMA = "https://gisccapps.charlestoncounty.org/arcgis/rest/services/GIS_VIEWER/New_Public_Search/MapServer/36";
const CC_ZONING = "https://gisccapps.charlestoncounty.org/arcgis/rest/services/GIS_VIEWER/New_Public_Search/MapServer/44";
const CC_FOOTPRINTS = "https://gisccapps.charlestoncounty.org/arcgis/rest/services/GIS_VIEWER/New_Public_Search/MapServer/61"; // 2025 building footprints (by PID)
const CC_APPRAISAL = "https://gisccapps.charlestoncounty.org/arcgis/rest/services/ENERGOV/energov_css/MapServer/4";       // parcels w/ appraised values (by PID)
const CC_ENERGOV = "https://gisccapps.charlestoncounty.org/arcgis/rest/services/ENERGOV/energov_history/MapServer/0";     // code enforcement / permits / inspections (spatial)
const CITY = "https://services2.arcgis.com/tQaXW7Zb1Vphzvgd/arcgis/rest/services";

async function q(base, params) {
  try {
    const r = await fetch(`${base}/query?${new URLSearchParams({ returnGeometry: "false", f: "json", ...params })}`);
    if (!r.ok) return [];
    const j = await r.json().catch(() => ({}));
    return (j.features || []).map((f) => ({ ...f.attributes, __geom: f.geometry }));
  } catch { return []; }
}
// Point-in-polygon / near-point query helpers (WGS84).
const ptParams = (lon, lat, meters) => ({
  geometry: JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }),
  geometryType: "esriGeometryPoint", inSR: "4326", spatialRel: "esriSpatialRelIntersects",
  ...(meters ? { distance: String(meters), units: "esriSRUnit_Meter" } : {}),
});
const fmtDate = (ms) => { const n = Number(ms); return Number.isFinite(n) && n > 0 ? new Date(n).toISOString().slice(0, 10) : null; };

// Parcel row + centroid (the parcel layer publishes polygons; average the outer ring).
async function fetchParcel(pid) {
  const rows = await q(CC_PARCELS, {
    where: `PID = '${String(pid).replace(/'/g, "''")}'`,
    outFields: "PID,OWNER1,OWNER2,CLASS_CODE,ACREAGE,SALE_PRICE,RECORDED_DATE,DEED_BOOK_PAGE,LEGAL_DESCR,SUBDIVISION,TAX_DISTRICT",
    returnGeometry: "true", outSR: "4326", resultRecordCount: "1",
  });
  const r = rows[0];
  if (!r) return null;
  let lat = null, lon = null;
  const ring = r.__geom && r.__geom.rings && r.__geom.rings[0];
  if (ring && ring.length) {
    let cx = 0, cy = 0;
    for (const [x, y] of ring) { cx += x; cy += y; }
    lon = cx / ring.length; lat = cy / ring.length;
  }
  const saleMs = Number(r.RECORDED_DATE);
  return {
    pid: clean(r.PID), owner: clean(r.OWNER1), co_owner: clean(r.OWNER2),
    use: clean(r.CLASS_CODE), acres: toNum(r.ACREAGE),
    sale_price: toNum(r.SALE_PRICE) || null, sale_recorded: fmtDate(saleMs),
    deed_book_page: clean(r.DEED_BOOK_PAGE), legal_descr: clean(r.LEGAL_DESCR),
    subdivision: clean(r.SUBDIVISION), tax_district: clean(r.TAX_DISTRICT),
    lat, lon,
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, pid, address, check, debug } = req.body || {};
    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    if (check) return res.status(200).json({ ok: true });
    if (debug) return res.status(200).json({ ok: true, build: "charlestonintel-v1" });

    // Resolve the parcel: PID preferred; else resolve the address to a PID.
    let key = clean(pid);
    if (!key && clean(address)) {
      const pids = await pidsByAddress(clean(address));
      key = pids[0] || "";
    }
    if (!key) return res.status(200).json({ error: "Pass a Charleston County PID (from search_charleston_properties) or a street address." });

    const parcel = await fetchParcel(key);
    if (!parcel) return res.status(200).json({ error: `No Charleston County parcel found for PID ${key}.` });
    const { lat, lon } = parcel;
    const cpid = "C" + parcel.pid;

    const [permits, hotel, cityZoning, countyZoning, historic, heightDist, strOverlay, accomOverlay, fema, floodPts, crime, appraisal, footprints, codeCases] = await Promise.all([
      q(`${CITY}/New_Construction_Permits/FeatureServer/0`, { where: `MAIN_PARCEL_NUMBER = '${cpid}'`, outFields: "PERMIT_NUMBER,PERMIT_TYPE,WORK_CLASS,PERMIT_STATUS,DESCRIPTION,ISSUE_YEAR,ISSUE_DATE,VALUATION,PASSEDFINAL", orderByFields: "ISSUE_DATE DESC", resultRecordCount: "50" }),
      q(`${CITY}/Hotel_Entitlements/FeatureServer/0`, { where: `PARCELID = '${cpid}' OR TMS_ALL LIKE '%${parcel.pid}%'`, outFields: "NAME,ADDRESS,Rooms,STATUS,Open_Date,DECADE_OPEN,HOTEL", resultRecordCount: "5" }),
      lat != null ? q(`${CITY}/Base_Zoning/FeatureServer/0`, { ...ptParams(lon, lat), outFields: "ZONE_BASE,PUD_NAME,ORDSTAT", resultRecordCount: "3" }) : [],
      lat != null ? q(CC_ZONING, { ...ptParams(lon, lat), outFields: "ZONING,ZONE_DESC", resultRecordCount: "3" }) : [],
      lat != null ? q(`${CITY}/Old_and_Historic_District/FeatureServer/0`, { ...ptParams(lon, lat), outFields: "District,ORDSTAT", resultRecordCount: "3" }) : [],
      lat != null ? q(`${CITY}/Old_City_Height_Districts/FeatureServer/0`, { ...ptParams(lon, lat), outFields: "ZONE_HD,HD_TYPE", resultRecordCount: "3" }) : [],
      lat != null ? q(`${CITY}/Short_Term_Rentals_Overlay/FeatureServer/0`, { ...ptParams(lon, lat), outFields: "NAME,ORDSTAT", resultRecordCount: "3" }) : [],
      lat != null ? q(`${CITY}/Accommodations_Overlay/FeatureServer/0`, { ...ptParams(lon, lat), outFields: "ZONE_A,ACCOM", resultRecordCount: "3" }) : [],
      lat != null ? q(CC_FEMA, { ...ptParams(lon, lat), outFields: "FLD_ZONE,SFHA_TF,STATIC_BFE,FLOODWAY", resultRecordCount: "3" }) : [],
      lat != null ? q(`${CITY}/Flooded_Vehicle_History/FeatureServer/0`, { ...ptParams(lon, lat, 400), outFields: "Date,Location,Cars", resultRecordCount: "200" }) : [],
      lat != null ? q(`${CITY}/PDI_Reported_Incidents/FeatureServer/0`, { ...ptParams(lon, lat, 300), where: `IncidentYear >= ${new Date().getUTCFullYear() - 2}`, outFields: "IncidentCategory,IncidentYear", resultRecordCount: "1000" }) : [],
      // County appraised value (assessed land/improvement/total — the NYC-parity value fields) by PID.
      q(CC_APPRAISAL, { where: `PID = '${parcel.pid.replace(/'/g, "''")}'`, outFields: "LAND_APPR,IMP_APPR,APPRAISAL", resultRecordCount: "1" }),
      // Building footprints (count + square footage per building on the lot) by PID.
      q(CC_FOOTPRINTS, { where: `PID = '${parcel.pid.replace(/'/g, "''")}'`, outFields: "SDE_S_BLDG_2025_area,status", resultRecordCount: "20" }),
      // Code enforcement / violations at the parcel — county EnerGov, spatial (no PID field).
      // ~45m buffer at the centroid catches the lot's own cases; join by MODULENAME.
      lat != null ? q(CC_ENERGOV, { ...ptParams(lon, lat, 45), where: `MODULENAME='CodeManagement'`, outFields: "CASENUMBER,CASETYPE,APPLICATIONDATE,PROJECTNAME", resultRecordCount: "50" }) : [],
    ]);

    // Permits: detail rows + repositioning signals (hospitality/commercial work).
    const permitRows = permits.slice(0, 25).map((p) => ({
      number: clean(p.PERMIT_NUMBER), type: clean(p.PERMIT_TYPE), work: clean(p.WORK_CLASS),
      status: clean(p.PERMIT_STATUS), desc: clean(p.DESCRIPTION).slice(0, 140),
      year: toNum(p.ISSUE_YEAR), issued: fmtDate(p.ISSUE_DATE), valuation: toNum(p.VALUATION) || null,
      finaled: clean(p.PASSEDFINAL) || null,
    }));
    const permitTotal = permitRows.reduce((s, p) => s + (p.valuation || 0), 0) || null;

    // Crime: roll 1,000-record sample into count-by-category + the active years.
    const crimeByCat = {};
    let crimeYears = [];
    for (const c of crime) {
      const cat = clean(c.IncidentCategory) || "Other";
      crimeByCat[cat] = (crimeByCat[cat] || 0) + 1;
      const y = toNum(c.IncidentYear); if (y) crimeYears.push(y);
    }
    crimeYears = [...new Set(crimeYears)].sort();
    const crimeTop = Object.entries(crimeByCat).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([category, count]) => ({ category, count }));

    // Street flooding: events within ~400m (a Charleston-specific risk read).
    const floodEvents = floodPts.length;
    const floodDates = [...new Set(floodPts.map((f) => fmtDate(f.Date)).filter(Boolean))].sort().slice(-6);

    const femaRow = fema[0] || {};
    const hotelRow = hotel[0] || null;

    // Appraised values (the assessed land/improvement/total the NYC dossier carries).
    const av = appraisal[0] || {};
    const valuation = {
      land_appraised: toNum(av.LAND_APPR) || null,
      improvement_appraised: toNum(av.IMP_APPR) || null,
      total_appraised: toNum(av.APPRAISAL) || null,
    };
    // Building footprints: count + total square footage on the lot (existing buildings).
    const existing = footprints.filter((f) => clean(f.status).toLowerCase() !== "demolished");
    const buildings = {
      count: existing.length,
      total_sqft: Math.round(existing.reduce((s, f) => s + (toNum(f.SDE_S_BLDG_2025_area) || 0), 0)) || null,
      note: footprints.some((f) => clean(f.status).toLowerCase() === "new") ? "includes a newly-added footprint" : null,
    };
    // Code enforcement / violations — case number, type, year; sorted newest first.
    const codeRows = (codeCases || [])
      .map((c) => ({ case: clean(c.CASENUMBER), type: clean(c.CASETYPE) || clean(c.PROJECTNAME) || "Code enforcement", year: toNum(new Date(Number(c.APPLICATIONDATE)).getUTCFullYear()) || null, date: fmtDate(c.APPLICATIONDATE) }))
      .filter((c) => c.case)
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const codeEnforcement = {
      count: codeRows.length,
      recent_year: codeRows[0] ? codeRows[0].year : null,
      rows: codeRows.slice(0, 12),
    };

    return res.status(200).json({
      pid: parcel.pid, address: clean(address) || null, lat, lon,
      parcel,
      valuation,
      buildings,
      code_enforcement: codeEnforcement,
      zoning: {
        city_base_zone: clean((cityZoning[0] || {}).ZONE_BASE) || null,
        city_pud: clean((cityZoning[0] || {}).PUD_NAME) || null,
        county_zone: clean((countyZoning[0] || {}).ZONING) || null,
        county_zone_desc: clean((countyZoning[0] || {}).ZONE_DESC) || null,
        old_and_historic_district: clean((historic[0] || {}).District) || null,
        old_city_height_district: heightDist[0] ? clean(`${heightDist[0].ZONE_HD || ""} ${heightDist[0].HD_TYPE || ""}`) : null,
        short_term_rental_overlay: clean((strOverlay[0] || {}).NAME) || null,
        accommodations_overlay: accomOverlay[0] ? clean(`${accomOverlay[0].ZONE_A || ""} ${accomOverlay[0].ACCOM || ""}`) : null,
      },
      hotel_entitlement: hotelRow ? {
        name: clean(hotelRow.NAME), address: clean(hotelRow.ADDRESS), rooms: toNum(hotelRow.Rooms),
        status: clean(hotelRow.STATUS), open_date: fmtDate(hotelRow.Open_Date) || clean(hotelRow.DECADE_OPEN) || null,
      } : null,
      permits: { count: permits.length, total_valuation: permitTotal, rows: permitRows },
      flood: {
        fema_zone: clean(femaRow.FLD_ZONE) || null,
        special_flood_hazard_area: clean(femaRow.SFHA_TF) === "T",
        static_bfe_ft: toNum(femaRow.STATIC_BFE) > -999 ? toNum(femaRow.STATIC_BFE) : null,
        floodway: clean(femaRow.FLOODWAY) || null,
        street_flood_events_400m: floodEvents, recent_flood_dates: floodDates,
      },
      crime_300m: { count: crime.length, years_covered: crimeYears, by_category: crimeTop },
      note: "Charleston parcel intel — county assessor parcel + APPRAISED land/improvement/total value + building footprint count & SF + CODE-ENFORCEMENT case history (county EnerGov, ~45m at the centroid) + FEMA DFIRM + county zoning, and City of Charleston open data: construction permits (2010–present, parcel-exact), hotel entitlements (parcel-exact), base zoning/PUD, Old & Historic District + Old City height district, short-term-rental + accommodations overlays (point-in-polygon at the parcel centroid), street-flooding history within 400m (Charleston's chronic-flooding signal, distinct from the FEMA zone), and reported crime within 300m. City layers only cover the City of Charleston — parcels in Mt Pleasant / N. Charleston etc. get county zoning + FEMA + parcel facts only. NOT available as a free feed (HTML-portal only): property-tax delinquency / tax-sale status, full multi-year deed history (only the latest sale is public here), and evictions.",
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "charlestonintel" });
  }
}
