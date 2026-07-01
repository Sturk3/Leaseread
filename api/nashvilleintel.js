// FRONTAGE — Nashville / Davidson County consolidated property intel (the TN analog of
// sfintel.js / NYC intel.js). One parallel fan-out for ONE property, keyed on its APN
// (the Metro parcel id) plus address. Tennessee is open-records, so this goes DEEPER than
// SF — owners are public (from the parcel layer) AND the activity/distress records join
// building-exact on the parcel number:
//
//   Parcel core        maps.nashville.gov Cadastral/Parcels/0  (APN)   -> owner, value, sale, FRONTAGE, zoning, land use, centroid
//   Building permits    services2 Building_Permits_Issued_2      (Parcel) -> dev activity: commercial new/rehab/demo/tenant-finish/use&occ/sign + cost + purpose
//   Permit applications services2 Building_Permit_Applications    (Parcel) -> pending/in-process work (forward-looking)
//   Trade permits       services2 Trade_Permits_View             (Parcel) -> electrical/plumbing/mechanical = active renovation + contract value
//   Beer permits        services2 Beer_Permit_Locations          (Parcel) -> the active F&B operator (Business_Name + owner = a lead); lapsed = vacancy signal
//   Short-term rentals  services2 Residential_Short_Term_Rental  (Parcel) -> STR activity + owner/applicant contacts
//   311 (hubNashville)  services2 hubNashville_(311)_Requests     (address) -> codes/property complaints + condition
//   Zoning overlays     maps Zoning_Landuse/ZoningOverlayDistricts (point) -> historic / contextual / corridor / UDO overlays = constraints
//   FEMA flood          maps Hydrography/FEMA_FloodHazardAreas     (point) -> regulatory flood zone (diligence)
//   Policy designation  maps Planning/CCM Community Character Pol. (point) -> the land-use policy / transect (what the city wants here)
//
// Free, no key, password-gated. Every sub-fetch is wrapped so one dead source never sinks the dossier.

const MAPS = process.env.NASH_MAPS_URL || "https://maps.nashville.gov/arcgis/rest/services";
// Metro's ArcGIS-Hub hosted feature services (permits, beer, 311, STR) live on this org.
const HUB = process.env.NASH_HUB_URL || "https://services2.arcgis.com/HdTo6HJqh92wn4D8/arcgis/rest/services";
// TDOT (STATE) traffic-count stations — AADT (vehicles/day) by year. This is the freely queryable
// ArcGIS layer; its latest column is ~2015 (fresher counts are only in TDOT's non-API MS2 system),
// so it's a directional corridor-traffic signal with an explicit year, not a current count.
const TDOT_TRAFFIC = process.env.TDOT_TRAFFIC_URL || "https://services1.arcgis.com/HLC8bAygObK4fhPW/arcgis/rest/services/Traffic_History_TDOT/FeatureServer/0";
// WeGo Public Transit — the real system-wide bus-stop layer (Metro's org only has corridor-specific
// stop layers). Layer 0 = Stops (points: StopName, RoutesServed, ADACompliant). Transit access = a
// walkability / retail-catchment signal.
const WEGO_STOPS = process.env.WEGO_STOPS_URL || "https://services7.arcgis.com/EGmB20G57rbr4fjI/arcgis/rest/services/WeGo_Transit_Stops_and_Routes/FeatureServer/0";

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const toNum = (v) => { if (v == null || v === "") return null; const n = Number(String(v).replace(/[$,]/g, "")); return Number.isFinite(n) ? n : null; };
const dayMs = (ms) => { const n = Number(ms); return Number.isFinite(n) && n > 0 ? new Date(n).toISOString().slice(0, 10) : null; };
const apnSql = (s) => clean(s).replace(/'/g, "''");

// Generic ArcGIS REST query -> array of attribute objects. Never throws.
async function agQuery(layerUrl, params) {
  try {
    const qs = new URLSearchParams({ returnGeometry: "false", f: "json", ...params });
    const r = await fetch(`${layerUrl}/query?${qs}`);
    if (!r.ok) return [];
    const j = await r.json().catch(() => ({}));
    return (j.features || []).map((f) => f.attributes || {});
  } catch { return []; }
}

// Pull the parcel polygon (lon/lat WGS84) and return a representative interior point for
// the point-in-polygon overlay lookups. Averaging the outer ring is fine for parcels.
async function parcelGeomCentroid(apn) {
  try {
    const qs = new URLSearchParams({
      where: `APN='${apnSql(apn)}'`, outFields: "APN", returnGeometry: "true", outSR: "4326", resultRecordCount: "1", f: "json",
    });
    const r = await fetch(`${MAPS}/Cadastral/Parcels/MapServer/0/query?${qs}`);
    if (!r.ok) return null;
    const j = await r.json().catch(() => ({}));
    const rings = j.features && j.features[0] && j.features[0].geometry && j.features[0].geometry.rings;
    if (!rings || !rings[0] || !rings[0].length) return null;
    let sx = 0, sy = 0, n = 0;
    for (const [x, y] of rings[0]) { sx += x; sy += y; n++; }
    return n ? { lon: sx / n, lat: sy / n } : null;
  } catch { return null; }
}

// Point-in-polygon: which feature of a maps.nashville.gov layer contains (lon,lat).
async function pointInLayer(layerUrl, lon, lat, outFields) {
  if (lon == null || lat == null) return [];
  return agQuery(layerUrl, {
    geometry: JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPoint", inSR: "4326", spatialRel: "esriSpatialRelIntersects",
    outFields, resultRecordCount: "8",
  });
}

// Radius search on a POINT layer: features within `meters` of (lon,lat), with geometry so we can
// compute each one's distance. Optional `where` (e.g. a recency filter) narrows server-side.
async function nearLayer(layerUrl, lon, lat, meters, outFields, count = 15, where) {
  if (lon == null || lat == null) return [];
  const params = {
    geometry: JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPoint", inSR: "4326", distance: String(meters), units: "esriSRUnit_Meter",
    spatialRel: "esriSpatialRelIntersects", outFields, returnGeometry: "true", outSR: "4326", resultRecordCount: String(count), f: "json",
  };
  if (where) params.where = where;
  try {
    const r = await fetch(`${layerUrl}/query?${new URLSearchParams(params)}`);
    if (!r.ok) return [];
    const j = await r.json().catch(() => ({}));
    return (j.features || []).map((f) => ({ ...(f.attributes || {}), _geom: f.geometry || null }));
  } catch { return []; }
}
const milesBetween = (lat1, lon1, lat2, lon2) => {
  const R = 3958.8, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};
const distMi = (g, lat, lon) => (g && g.y != null && g.x != null && lat != null) ? Math.round(milesBetween(lat, lon, g.y, g.x) * 100) / 100 : null;

// TDOT station rows carry AADT_<year> columns; return the most recent populated count.
const AADT_YEARS = []; for (let y = 2015; y >= 1990; y--) AADT_YEARS.push(y);
function latestAadt(a) {
  for (const y of AADT_YEARS) { const v = toNum(a["AADT_" + y]); if (v && v > 0) return { aadt: v, year: y }; }
  return null;
}

// "<houseNumber>" + primary street token out of a free-form address, for the 311 LIKE join.
function addrParts(address) {
  const a = clean(address);
  const num = (a.match(/^\s*(\d+)/) || [])[1] || "";
  const rest = a.replace(/^\s*\d+\s*/, "").replace(/\b(ste|suite|unit|apt|#)\b.*$/i, "").trim();
  const street = rest.split(/\s+/).slice(0, 2).join(" ");
  return { num, street: street.toUpperCase().replace(/'/g, "''") };
}

// Permit-type buckets that signal repositioning / lifecycle (for the motivation read).
const permitSignal = (t) => {
  const s = clean(t).toLowerCase();
  if (/demolition/.test(s)) return "demolition";
  if (/commercial - new|commercial new/.test(s)) return "new_construction";
  if (/tenant finish|finish out/.test(s)) return "tenant_buildout";
  if (/use & occupancy|use and occupancy/.test(s)) return "use_occupancy";
  if (/foundation|shell|structural/.test(s)) return "major_structural";
  if (/sign/.test(s)) return "signage";
  if (/rehab|addition/.test(s)) return "rehab";
  return null;
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, apn, address, check, debug } = req.body || {};
    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    if (check) return res.status(200).json({ ok: true });
    if (debug) return res.status(200).json({ ok: true, build: "nashvilleintel-v8-wego-bza-dtc-adult", maps: MAPS, hub: HUB });

    const ap = clean(apn);
    if (!ap && !address) return res.status(400).json({ error: "Need an APN (preferred) or address." });
    const parcelWhere = ap ? `Parcel='${apnSql(ap)}'` : null;
    const violWhere = ap ? `Property_APN='${apnSql(ap)}'` : null;       // code-violation layer keys on Property_APN
    const { num, street } = addrParts(address);
    const a311Where = num && street ? `UPPER(Address) LIKE '%${num}%${street}%'` : (street ? `UPPER(Address) LIKE '%${street}%'` : null);

    // Centroid first (overlays need it); then fan everything else out in parallel.
    const centroid = ap ? await parcelGeomCentroid(ap) : null;
    // Crime recency cutoff (~24 months). Incident_Occurred is an ArcGIS DATE field, so it needs
    // TIMESTAMP 'YYYY-MM-DD ...' syntax — a raw epoch-ms comparison is rejected by the service.
    const crimeCut = new Date(Date.now() - 730 * 86400 * 1000).toISOString().slice(0, 10);

    const [permits, applications, trade, beer, str, c311, overlays, flood, policy, footprints, bidRows, violations, rezonings, tif, redevelopment, pedestrian, historic, crime, bcycle, foodstores, hood, traffic, wego, bza, dtc, adult] = await Promise.all([
      parcelWhere ? agQuery(`${HUB}/Building_Permits_Issued_2/FeatureServer/0`, { where: parcelWhere, outFields: "Permit__,Permit_Type_Description,Permit_Subtype_Description,Const_Cost,Address,Purpose,Contact,Date_Issued,Date_Entered,Lat,Lon", orderByFields: "Date_Entered DESC", resultRecordCount: "30" }) : [],
      parcelWhere ? agQuery(`${HUB}/Building_Permit_Applications_Feature_Layer_view/FeatureServer/0`, { where: parcelWhere, outFields: "Permit__,Permit_Type_Description,Permit_Subtype_Description,Const_Cost,Purpose,Contact,Date_Entered,Date_Issued", orderByFields: "Date_Entered DESC", resultRecordCount: "20" }) : [],
      parcelWhere ? agQuery(`${HUB}/Trade_Permits_View/FeatureServer/0`, { where: parcelWhere, outFields: "PermitNumber,Trade,Permit_Subtype_Description,Contract_Value,Purpose,Case_Status,Date_Entered", orderByFields: "Date_Entered DESC", resultRecordCount: "20" }) : [],
      parcelWhere ? agQuery(`${HUB}/Beer_Permit_Locations_Feature_Layer_view/FeatureServer/0`, { where: parcelWhere, outFields: "Business_Name,Business_Owner,Status,Permit_Subtype_Description,Date_Issued,Address", orderByFields: "Date_Issued DESC", resultRecordCount: "15" }) : [],
      parcelWhere ? agQuery(`${HUB}/Residential_Short_Term_Rental_Permits_view/FeatureServer/0`, { where: parcelWhere, outFields: "Permit__,Permit_Status,Permit_Owner_Name,Applicant,Contact,Expiration_Date,Date_Issued", orderByFields: "Date_Issued DESC", resultRecordCount: "10" }) : [],
      a311Where ? agQuery(`${HUB}/hubNashville_(311)_Service_Requests_1/FeatureServer/0`, { where: a311Where, outFields: "Request__,Request_Type,Subrequest_Type,Status,Date_Time_Opened,Address", orderByFields: "Date_Time_Opened DESC", resultRecordCount: "40" }) : [],
      centroid ? pointInLayer(`${MAPS}/Zoning_Landuse/ZoningOverlayDistricts/MapServer/0`, centroid.lon, centroid.lat, "ZONE_DESC,NAME,CASE_NO,ORD_DATE") : [],
      centroid ? pointInLayer(`${MAPS}/Hydrography/FEMA_FloodHazardAreas/MapServer/0`, centroid.lon, centroid.lat, "FloodZone,SFHA_TF,ZoneDescription") : [],
      centroid ? pointInLayer(`${MAPS}/Planning/CCM/MapServer/2`, centroid.lon, centroid.lat, "PolicyCode,PolicyDesc,Transect") : [],
      // Building footprint at the parcel (TN State Plane ft, so Shape__Area is already sqft) — a
      // building-SF proxy, since the parcel/CAMA gross-area is NOT in Metro's open data.
      centroid ? pointInLayer(`${HUB}/Building_Footprints_view/FeatureServer/0`, centroid.lon, centroid.lat, "BuildingType,Height,RoofType,Shape__Area") : [],
      // Business Improvement District (e.g. the downtown Central BID) — a managed-district / retail-quality signal.
      centroid ? pointInLayer(`${HUB}/Business_Improvement_Districts_view/FeatureServer/0`, centroid.lon, centroid.lat, "Name") : [],
      // Property Standards (code) violations — the dedicated, owner-named distress layer (cleaner than 311).
      violWhere ? agQuery(`${HUB}/Property_Standards_Violations_2/FeatureServer/0`, { where: violWhere, outFields: "Request_Nbr,Reported_Problem,Subtype_Description,Status,Date_Received,Violations_Noted", orderByFields: "Date_Received DESC", resultRecordCount: "30" }) : [],
      // Planning Development Tracker — rezonings / SP plans / PUDs touching this parcel (existing → new
      // zoning). The Parcels field is human-readable ("Map 175, Parcel(s) 143-146"), NOT the APN, so
      // join SPATIALLY (point-in-polygon on the case footprint) instead of a text match.
      centroid ? pointInLayer(`${HUB}/Development_Tracker_Cases_view/FeatureServer/0`, centroid.lon, centroid.lat, "CASE_TYPE_DESC,SUB_TYPE_DESC,PROJECT_DESC,ExistingZoning,NewZoning,DATE_ACCEPTED,PSTAT,CAPTION") : [],
      // TIF — Tax-Increment Financing projects on the parcel (keyed by Parcel = APN, same as permits).
      // Public redevelopment financing here = a value-add / entitlement signal.
      parcelWhere ? agQuery(`${HUB}/Tax_Increment_Financing_Projects/FeatureServer/0`, { where: parcelWhere, outFields: "Name,Amount_of_TIF,Year_of_Project,Date_Paid_Off,Description", resultRecordCount: "10" }) : [],
      // MDHA Redevelopment District (point-in-polygon) — an urban-renewal district with its own
      // design review / incentives (e.g. Capitol Mall, Rutledge Hill) = repositioning context.
      centroid ? pointInLayer(`${HUB}/MDHA_Redevelopment_Districts/FeatureServer/0`, centroid.lon, centroid.lat, "DistrictName") : [],
      // Pedestrian Benefit Zone (point-in-polygon) — a designated walkable district where parking
      // minimums are reduced ("in-lieu" area) = a pro-retail, pro-density location signal.
      centroid ? pointInLayer(`${HUB}/Pedestrian_Benefit_Zones_View/FeatureServer/0`, centroid.lon, centroid.lat, "Zone,Description,InLieuArea") : [],
      // Historic designation (keyed by ParcelID = APN) — a landmark/district property = redevelopment
      // constraint (design review) and sometimes a push-to-sell.
      ap ? agQuery(`${HUB}/Historic_Districts_and_Properties/FeatureServer/0`, { where: `ParcelID='${apnSql(ap)}'`, outFields: "Status,YearConstructed,THC_Survey,Notes,Address", resultRecordCount: "5" }) : [],
      // CRIME / SAFETY — MNPD incidents within ~0.25mi over the last ~24 months (corridor-safety read).
      centroid ? nearLayer(`${HUB}/Metro_Nashville_Police_Department_Incidents_view/FeatureServer/0`, centroid.lon, centroid.lat, 400, "Offense_Description,Incident_Occurred,Offense_NIBRS", 500, `Incident_Occurred >= TIMESTAMP '${crimeCut} 00:00:00'`) : [],
      // WALKABILITY — nearest BCycle bike-share stations within ~0.75mi (micromobility / walkable-district proxy).
      centroid ? nearLayer(`${HUB}/BCycle_Locations_view/FeatureServer/0`, centroid.lon, centroid.lat, 1200, "StationName,Address", 20) : [],
      // RETAIL CONTEXT — food/grocery/convenience stores within ~0.3mi + their operating flag (amenity density + a vacancy read).
      centroid ? nearLayer(`${HUB}/FoodStores_Total_view/FeatureServer/0`, centroid.lon, centroid.lat, 500, "StoreName,BusinessType,USER_Currently_Operational__Yes", 25) : [],
      // SUBMARKET — the named neighborhood the parcel sits in (blank downtown, populated elsewhere).
      centroid ? pointInLayer(`${HUB}/Neighborhood_Boundaries/FeatureServer/0`, centroid.lon, centroid.lat, "Name") : [],
      // TRAFFIC (STATE) — nearest TDOT AADT count station within ~0.4mi = retail visibility (cars/day).
      centroid ? nearLayer(TDOT_TRAFFIC, centroid.lon, centroid.lat, 650, "*", 10) : [],
      // TRANSIT — WeGo bus stops within ~0.4mi (routes served + count = transit access / catchment).
      centroid ? nearLayer(WEGO_STOPS, centroid.lon, centroid.lat, 650, "StopName,RoutesServed,ShelterCount,ADACompliant", 20) : [],
      // ZONING APPEALS — Board of Zoning Appeals cases on the parcel (keyed by APN) = variance /
      // entitlement activity (someone worked the zoning here).
      ap ? agQuery(`${HUB}/Board_of_Zoning_Appeals_Cases_view/FeatureServer/0`, { where: `APN='${apnSql(ap)}'`, outFields: "CASE_NUMBER,APPEALTYPE,BZAACTION_DESC,PERSTATUS,PURPOSE,BZA_DATE", orderByFields: "BZA_DATE DESC", resultRecordCount: "10" }) : [],
      // DOWNTOWN CODE — the DTC subdistrict + use area (point-in-polygon), the granular downtown zoning.
      centroid ? pointInLayer(`${HUB}/Downtown_Code_Subdistricts_and_Use_Areas_view/FeatureServer/0`, centroid.lon, centroid.lat, "Subdistrict,UseArea") : [],
      // ADULT BUSINESSES — sexually-oriented permitted businesses within ~0.25mi (a negative retail-adjacency flag).
      centroid ? nearLayer(`${HUB}/Sexually_Oriented_Permitted_Businesses_view/FeatureServer/0`, centroid.lon, centroid.lat, 400, "Business_Name", 10) : [],
    ]);

    // Building permits — recent, with the repositioning signal tagged.
    const permitList = permits.map((p) => ({
      number: clean(p.Permit__), type: clean(p.Permit_Type_Description), subtype: clean(p.Permit_Subtype_Description) || null,
      signal: permitSignal(p.Permit_Type_Description), cost: toNum(p.Const_Cost), purpose: clean(p.Purpose).slice(0, 160) || null,
      contact: clean(p.Contact) || null, issued: dayMs(p.Date_Issued), filed: dayMs(p.Date_Entered),
    }));
    const permitSignals = [...new Set(permitList.map((p) => p.signal).filter(Boolean))];

    const appList = applications.map((p) => ({
      number: clean(p.Permit__), type: clean(p.Permit_Type_Description), subtype: clean(p.Permit_Subtype_Description) || null,
      cost: toNum(p.Const_Cost), purpose: clean(p.Purpose).slice(0, 160) || null, filed: dayMs(p.Date_Entered), issued: dayMs(p.Date_Issued),
    }));
    // Pending = filed but not yet issued.
    const pendingApps = appList.filter((p) => !p.issued);

    const tradeList = trade.map((t) => ({
      number: clean(t.PermitNumber), trade: clean(t.Trade) || clean(t.Permit_Subtype_Description),
      value: toNum(t.Contract_Value), status: clean(t.Case_Status) || null, purpose: clean(t.Purpose).slice(0, 120) || null, filed: dayMs(t.Date_Entered),
    }));

    // Beer permits: an ACTIVE one names the operating bar/restaurant + its owner (a real lead);
    // a lapsed/closed one on a former F&B space is a vacancy signal.
    const beerRows = beer.map((b) => ({
      business: clean(b.Business_Name) || null, owner: clean(b.Business_Owner) || null,
      status: clean(b.Status) || null, kind: clean(b.Permit_Subtype_Description) || null, issued: dayMs(b.Date_Issued),
    })).filter((b) => b.business || b.owner);
    const activeBeer = beerRows.filter((b) => /active|current|valid/i.test(b.status || ""));

    const strList = str.map((s) => ({
      number: clean(s.Permit__), status: clean(s.Permit_Status) || null, owner: clean(s.Permit_Owner_Name) || null,
      applicant: clean(s.Applicant) || null, expires: dayMs(s.Expiration_Date), issued: dayMs(s.Date_Issued),
    })).filter((s) => s.number || s.owner);

    // 311: condition/codes complaints. Tag the property/codes-relevant ones.
    // Property-CONDITION / codes complaints only (a distress proxy). Deliberately NOT a bare
    // "property" token — that caught "Public Safety / Lost-Stolen Property" etc.
    const codesRe = /codes|property standard|zoning viol|junk|trash|recycl|litter|debris|weed|overgrow|abandon|illegal dump|dumping|nuisance|graffiti|stormwater|drainage|standing water|rodent|sewer|dilapidat|unsafe|substandard/i;
    const c311Rows = c311.map((c) => ({
      type: clean(c.Request_Type), subtype: clean(c.Subrequest_Type) || null, status: clean(c.Status) || null, opened: dayMs(c.Date_Time_Opened),
    }));
    const codes311 = c311Rows.filter((c) => codesRe.test(`${c.type} ${c.subtype || ""}`));

    // Spatial context.
    const overlayList = overlays.map((o) => ({ type: clean(o.ZONE_DESC) || null, name: clean(o.NAME) || null })).filter((o) => o.type || o.name);
    const historicOverlay = overlayList.some((o) => /historic/i.test(`${o.type} ${o.name}`));
    const floodRow = flood && flood[0] ? flood[0] : null;
    const floodInfo = floodRow ? {
      zone: clean(floodRow.FloodZone) || null,
      special_flood_hazard: /^(t|true|y|1)/i.test(clean(floodRow.SFHA_TF)),
      description: clean(floodRow.ZoneDescription) || null,
    } : null;
    const policyRow = policy && policy[0] ? policy[0] : null;
    const policyInfo = policyRow ? { code: clean(policyRow.PolicyCode) || null, policy: clean(policyRow.PolicyDesc) || null, transect: clean(policyRow.Transect) || null } : null;

    // Building footprint — pick the largest footprint intersecting the centroid (the main building).
    // Shape__Area is in sq ft (TN State Plane). Estimate stories from height (~12 ft/floor) and
    // gross building area = footprint x stories. Clearly an ESTIMATE — Metro publishes no CAMA GBA.
    const fp = (footprints || []).slice().sort((a, b) => (toNum(b.Shape__Area) || 0) - (toNum(a.Shape__Area) || 0))[0] || null;
    let building = null;
    if (fp) {
      const footSqft = toNum(fp.Shape__Area) ? Math.round(toNum(fp.Shape__Area)) : null;
      const height = toNum(fp.Height);
      const stories = height && height > 0 ? Math.max(1, Math.round(height / 12)) : null;
      building = {
        type: clean(fp.BuildingType) || null, footprint_sqft: footSqft, height_ft: height || null, roof: clean(fp.RoofType) || null,
        est_stories: stories, est_gross_sqft: footSqft && stories ? footSqft * stories : footSqft,
        note: "footprint-derived estimate (Metro publishes no assessor gross building area)",
      };
    }
    const bid = bidRows && bidRows[0] ? clean(bidRows[0].Name) || null : null;

    // Property Standards code violations (owner-named distress). Open = not closed/resolved.
    const violList = (violations || []).map((v) => ({
      problem: clean(v.Reported_Problem) || clean(v.Subtype_Description) || null,
      noted: clean(v.Violations_Noted) || null, status: clean(v.Status) || null, received: dayMs(v.Date_Received),
    })).filter((v) => v.problem || v.noted);
    const openViol = violList.filter((v) => !/closed|resolved|complete/i.test(v.status || ""));

    // Rezonings / SP / PUD cases touching the parcel (existing → new zoning = active repositioning).
    const rezList = (rezonings || []).map((z) => ({
      type: clean(z.CASE_TYPE_DESC) || clean(z.SUB_TYPE_DESC) || null,
      from_zone: clean(z.ExistingZoning) || null, to_zone: clean(z.NewZoning) || null,
      project: clean(z.PROJECT_DESC || z.CAPTION).slice(0, 140) || null, status: clean(z.PSTAT) || null, filed: dayMs(z.DATE_ACCEPTED),
    })).filter((z) => z.type || z.project);

    // TIF projects on the parcel (redevelopment financing = value-add signal).
    const tifList = (tif || []).map((t) => ({
      name: clean(t.Name) || null, amount: toNum(t.Amount_of_TIF), year: toNum(t.Year_of_Project),
      paid_off: !!(clean(t.Date_Paid_Off) && clean(t.Date_Paid_Off) !== "0"),
      description: clean(t.Description).slice(0, 160) || null,
    })).filter((t) => t.name || t.amount);
    // MDHA urban-renewal district containing the parcel.
    const redevelopmentDistrict = redevelopment && redevelopment[0] ? clean(redevelopment[0].DistrictName) || null : null;
    // Pedestrian Benefit Zone (walkable, reduced-parking district) containing the parcel.
    const pedRow = pedestrian && pedestrian[0] ? pedestrian[0] : null;
    const pedestrianZone = pedRow ? { zone: clean(pedRow.Zone) || null, description: clean(pedRow.Description) || null } : null;
    // Historic designation on the parcel (landmark / historic district = design-review constraint).
    const histRow = historic && historic[0] ? historic[0] : null;
    const historicProperty = histRow ? {
      status: clean(histRow.Status) || null, year_built: toNum(histRow.YearConstructed) || null,
      survey: clean(histRow.THC_Survey) || null, notes: clean(histRow.Notes).slice(0, 160) || null,
    } : null;

    // CRIME / SAFETY — MNPD incidents in the last ~24 months within ~0.25mi. Count + violent share +
    // the top offense types (a corridor-safety read; MNPD masks each point to ~block level).
    const VIOLENT_RE = /homicide|murder|robbery|assault|shooting|weapon|rape|kidnap|carjack/i;
    const crimeRows = (crime || []).map((c) => ({ offense: clean(c.Offense_Description), when: dayMs(c.Incident_Occurred) })).filter((c) => c.offense);
    const offCounts = {};
    for (const c of crimeRows) offCounts[c.offense] = (offCounts[c.offense] || 0) + 1;
    const crimeInfo = crimeRows.length ? {
      count: crimeRows.length, capped: crimeRows.length >= 500, radius_mi: 0.25, months: 24,
      violent: crimeRows.filter((c) => VIOLENT_RE.test(c.offense)).length,
      top_offenses: Object.entries(offCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([offense, n]) => ({ offense, count: n })),
    } : null;

    // WALKABILITY — nearest BCycle stations (with distance). Nearest one + how many within ~0.75mi.
    const bcList = (bcycle || []).map((b) => ({ name: clean(b.StationName), address: clean(b.Address) || null, dist_mi: distMi(b._geom, centroid && centroid.lat, centroid && centroid.lon) }))
      .filter((b) => b.name).sort((a, b) => (a.dist_mi ?? 9) - (b.dist_mi ?? 9));
    const walkability = bcList.length ? { nearest_bcycle: bcList[0], bcycle_within_075mi: bcList.length } : null;

    // RETAIL CONTEXT — nearby food/grocery/convenience operators + how many are currently operating
    // (amenity density; a cluster of closed stores near a target is a soft vacancy read).
    const foodList = (foodstores || []).map((s) => ({
      name: clean(s.StoreName), type: clean(s.BusinessType) || null,
      operating: /^y/i.test(clean(s.USER_Currently_Operational__Yes)),
      dist_mi: distMi(s._geom, centroid && centroid.lat, centroid && centroid.lon),
    })).filter((s) => s.name).sort((a, b) => (a.dist_mi ?? 9) - (b.dist_mi ?? 9));
    const foodStores = foodList.length ? { count: foodList.length, operating: foodList.filter((s) => s.operating).length, nearest: foodList.slice(0, 6) } : null;

    // SUBMARKET — the named neighborhood containing the parcel.
    const neighborhood = hood && hood[0] ? clean(hood[0].Name) || null : null;

    // TRAFFIC — nearest TDOT AADT count station (retail visibility). Each station's latest populated
    // AADT year (often ~2015 in this layer) + location + distance; sorted nearest.
    const trafficStations = (traffic || []).map((t) => {
      const la = latestAadt(t);
      return la ? { aadt: la.aadt, year: la.year, location: clean(t.LOCATION) || null, route: clean(t.RTE_NUMBER) || null, dist_mi: distMi(t._geom, centroid && centroid.lat, centroid && centroid.lon) } : null;
    }).filter(Boolean).sort((a, b) => (a.dist_mi ?? 9) - (b.dist_mi ?? 9));
    const trafficInfo = trafficStations.length ? { nearest: trafficStations[0], stations: trafficStations.slice(0, 3) } : null;

    // TRANSIT — WeGo bus stops near the parcel: nearest stop (+ its routes) and how many within reach.
    const stopList = (wego || []).map((s) => ({
      name: clean(s.StopName), routes: clean(s.RoutesServed) || null, ada: /^(y|t|1)/i.test(clean(s.ADACompliant)),
      dist_mi: distMi(s._geom, centroid && centroid.lat, centroid && centroid.lon),
    })).filter((s) => s.name).sort((a, b) => (a.dist_mi ?? 9) - (b.dist_mi ?? 9));
    const routeSet = new Set();
    for (const s of stopList) for (const r of (s.routes || "").split(/[,\s]+/).filter(Boolean)) routeSet.add(r);
    const transit = stopList.length ? { nearest: stopList[0], stops_nearby: stopList.length, routes: [...routeSet].slice(0, 12) } : null;

    // ZONING APPEALS — BZA cases on the parcel (variance / entitlement activity).
    const bzaList = (bza || []).map((z) => ({
      case: clean(z.CASE_NUMBER) || null, type: clean(z.APPEALTYPE) || null, action: clean(z.BZAACTION_DESC) || null,
      status: clean(z.PERSTATUS) || null, purpose: clean(z.PURPOSE).slice(0, 120) || null, date: dayMs(z.BZA_DATE),
    })).filter((z) => z.case || z.type);
    const bzaInfo = bzaList.length ? { count: bzaList.length, recent: bzaList.slice(0, 4) } : null;

    // DOWNTOWN CODE subdistrict + use area (granular downtown zoning).
    const dtcRow = dtc && dtc[0] ? dtc[0] : null;
    const downtownCode = dtcRow ? { subdistrict: clean(dtcRow.Subdistrict) || null, use_area: clean(dtcRow.UseArea) || null } : null;

    // ADULT businesses within ~0.25mi (a negative retail-adjacency flag).
    const adultList = (adult || []).map((s) => ({ name: clean(s.Business_Name), dist_mi: distMi(s._geom, centroid && centroid.lat, centroid && centroid.lon) }))
      .filter((s) => s.name).sort((a, b) => (a.dist_mi ?? 9) - (b.dist_mi ?? 9));
    const adultBusinesses = adultList.length ? { count: adultList.length, nearest: adultList[0] } : null;

    return res.status(200).json({
      apn: ap || null, address: clean(address) || null, centroid,
      building, business_improvement_district: bid,
      building_permits: { count: permits.length, signals: permitSignals, recent: permitList.slice(0, 10) },
      pending_applications: { count: pendingApps.length, recent: pendingApps.slice(0, 6) },
      trade_permits: { count: trade.length, recent: tradeList.slice(0, 8) },
      beer_permits: { count: beerRows.length, active: activeBeer.length, recent: beerRows.slice(0, 8) },
      short_term_rentals: { count: strList.length, recent: strList.slice(0, 5) },
      service_requests_311: { total: c311Rows.length, codes_related: codes311.length, recent_codes: codes311.slice(0, 8) },
      code_violations: { count: violList.length, open: openViol.length, recent: violList.slice(0, 8) },
      rezonings: { count: rezList.length, recent: rezList.slice(0, 6) },
      tif: { count: tifList.length, projects: tifList.slice(0, 5) },
      redevelopment_district: redevelopmentDistrict,
      pedestrian_zone: pedestrianZone,
      historic_property: historicProperty,
      crime: crimeInfo,
      walkability,
      food_stores: foodStores,
      neighborhood,
      traffic: trafficInfo,
      transit,
      bza: bzaInfo,
      downtown_code: downtownCode,
      adult_businesses: adultBusinesses,
      zoning_overlays: { historic: historicOverlay, districts: overlayList },
      flood: floodInfo,
      policy: policyInfo,
      note: "Nashville / Davidson County consolidated intel. Records join BUILDING-EXACT on the parcel APN (no fuzzy matching) — TN is open-records, so this is deep. BUILDING = footprint-derived size: Metro publishes NO assessor gross building area, so footprint_sqft (real) + est_stories (from height ÷ ~12ft) give est_gross_sqft — present it as an estimate, not a measured figure. BUSINESS_IMPROVEMENT_DISTRICT = the property sits in a managed BID (e.g. downtown Central BID) = a foot-traffic / retail-quality signal. BUILDING_PERMITS signal tags: demolition / new_construction / tenant_buildout (a tenant fitting out space) / use_occupancy (recently delivered & occupied) / major_structural / rehab / signage — a demo or commercial-new permit = active repositioning = motivation. PENDING_APPLICATIONS = filed, not yet issued = forward-looking activity. TRADE_PERMITS (electrical/plumbing/mechanical) with a contract value = live renovation. BEER_PERMITS: an ACTIVE permit names the operating bar/restaurant + its owner (a real tenant/operator contact lead); a lapsed permit on a former F&B space is a vacancy signal. 311 codes_related = property-condition / codes complaints (distress). ZONING_OVERLAYS: historic overlay = redevelopment constraint (and a possible push-to-sell). FLOOD: special_flood_hazard true = FEMA SFHA = real diligence/insurance cost. POLICY = Metro's land-use vision for the site (transect/policy). For the OWNER of record + mailing + sale + frontage, use search_nashville_properties; to unmask an owner LLC to its principals, use tn_entity_lookup; for principals/contacts on the web, web_research.",
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "nashvilleintel" });
  }
}
