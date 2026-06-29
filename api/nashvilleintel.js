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
    if (debug) return res.status(200).json({ ok: true, build: "nashvilleintel-v1", maps: MAPS, hub: HUB });

    const ap = clean(apn);
    if (!ap && !address) return res.status(400).json({ error: "Need an APN (preferred) or address." });
    const parcelWhere = ap ? `Parcel='${apnSql(ap)}'` : null;
    const { num, street } = addrParts(address);
    const a311Where = num && street ? `UPPER(Address) LIKE '%${num}%${street}%'` : (street ? `UPPER(Address) LIKE '%${street}%'` : null);

    // Centroid first (overlays need it); then fan everything else out in parallel.
    const centroid = ap ? await parcelGeomCentroid(ap) : null;

    const [permits, applications, trade, beer, str, c311, overlays, flood, policy, footprints, bidRows] = await Promise.all([
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

    return res.status(200).json({
      apn: ap || null, address: clean(address) || null, centroid,
      building, business_improvement_district: bid,
      building_permits: { count: permits.length, signals: permitSignals, recent: permitList.slice(0, 10) },
      pending_applications: { count: pendingApps.length, recent: pendingApps.slice(0, 6) },
      trade_permits: { count: trade.length, recent: tradeList.slice(0, 8) },
      beer_permits: { count: beerRows.length, active: activeBeer.length, recent: beerRows.slice(0, 8) },
      short_term_rentals: { count: strList.length, recent: strList.slice(0, 5) },
      service_requests_311: { total: c311Rows.length, codes_related: codes311.length, recent_codes: codes311.slice(0, 8) },
      zoning_overlays: { historic: historicOverlay, districts: overlayList },
      flood: floodInfo,
      policy: policyInfo,
      note: "Nashville / Davidson County consolidated intel. Records join BUILDING-EXACT on the parcel APN (no fuzzy matching) — TN is open-records, so this is deep. BUILDING = footprint-derived size: Metro publishes NO assessor gross building area, so footprint_sqft (real) + est_stories (from height ÷ ~12ft) give est_gross_sqft — present it as an estimate, not a measured figure. BUSINESS_IMPROVEMENT_DISTRICT = the property sits in a managed BID (e.g. downtown Central BID) = a foot-traffic / retail-quality signal. BUILDING_PERMITS signal tags: demolition / new_construction / tenant_buildout (a tenant fitting out space) / use_occupancy (recently delivered & occupied) / major_structural / rehab / signage — a demo or commercial-new permit = active repositioning = motivation. PENDING_APPLICATIONS = filed, not yet issued = forward-looking activity. TRADE_PERMITS (electrical/plumbing/mechanical) with a contract value = live renovation. BEER_PERMITS: an ACTIVE permit names the operating bar/restaurant + its owner (a real tenant/operator contact lead); a lapsed permit on a former F&B space is a vacancy signal. 311 codes_related = property-condition / codes complaints (distress). ZONING_OVERLAYS: historic overlay = redevelopment constraint (and a possible push-to-sell). FLOOD: special_flood_hazard true = FEMA SFHA = real diligence/insurance cost. POLICY = Metro's land-use vision for the site (transect/policy). For the OWNER of record + mailing + sale + frontage, use search_nashville_properties; to unmask an owner LLC to its principals, use tn_entity_lookup; for principals/contacts on the web, web_research.",
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "nashvilleintel" });
  }
}
