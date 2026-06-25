// FRONTAGE — San Francisco consolidated property intel (the SF analog of NYC's intel.js).
//
// One parallel fan-out across DataSF for a property (block+lot + address):
//   Building permits   i98e-djp9  (block/lot)  -> development activity, est. cost, use change
//   DBI complaints     gm2e-bten  (block/lot)  -> open building complaints
//   Business regs      g8m3-pdis  (address)    -> active operators (legal name = a lead) + recent closures (vacancy signal)
//   Eviction notices   5cei-gny5  (street)     -> Ellis Act / owner move-in / demolition / cap-improvement = landlord-intent distress (addresses masked to block)
//   Fire violations    4zuq-2cbe  (address)    -> open fire-code violations
//   311 cases          vw6y-z8j6  (address)    -> recent service requests (neighborhood condition)
// Free, no key, password-gated. SF/CA publish NO owner name — owner via web_research.

const SF = "https://data.sfgov.org/resource";
const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const toNum = (v) => { if (v == null || v === "") return null; const n = Number(String(v).replace(/[$,]/g, "")); return Number.isFinite(n) ? n : null; };
const sqlStr = (s) => clean(s).toUpperCase().replace(/'/g, "''");
const day = (v) => clean(v).slice(0, 10);
const milesBetween = (la1, lo1, la2, lo2) => {
  const R = 3958.8, d2r = Math.PI / 180;
  const dLa = (la2 - la1) * d2r, dLo = (lo2 - lo1) * d2r;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * d2r) * Math.cos(la2 * d2r) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

async function soda(dataset, params) {
  const token = process.env.SOCRATA_APP_TOKEN;
  const r = await fetch(`${SF}/${dataset}.json?${new URLSearchParams(params)}`, token ? { headers: { "X-App-Token": token } } : {});
  if (!r.ok) return [];
  return r.json().catch(() => []);
}

// DTSC EnviroStor cleanup/contamination sites (statewide ArcGIS) — a diligence flag.
const ENVIROSTOR = process.env.ENVIROSTOR_URL || "https://services3.arcgis.com/Oy2JTCD10wkoelxS/arcgis/rest/services/Envirostor_Public_Data_Export/FeatureServer/0";
async function envirostor(where) {
  const params = new URLSearchParams({
    where, outFields: "project_name,address,apn,site_type,status,status_date,potential_coc,confirmed_coc",
    returnGeometry: "false", orderByFields: "status_date DESC", resultRecordCount: "15", f: "json",
  });
  const r = await fetch(`${ENVIROSTOR}/query?${params}`);
  if (!r.ok) return [];
  const j = await r.json().catch(() => ({}));
  return (j.features || []).map((f) => f.attributes || {});
}

// Pull "<houseNumber>" and the primary street token out of a free-form address.
function addrParts(address) {
  const a = clean(address);
  const num = (a.match(/^\s*(\d+)/) || [])[1] || "";
  // street name = words after the number, minus a leading unit token; take up to 2 words.
  const rest = a.replace(/^\s*\d+\s*/, "").replace(/\b(ste|suite|unit|apt|#)\b.*$/i, "").trim();
  const street = rest.split(/\s+/).slice(0, 2).join(" ");
  return { num, street: street.toUpperCase().replace(/'/g, "''") };
}

const EVICTION_FLAGS = [
  ["ellis_act_withdrawal", "Ellis Act"], ["owner_move_in", "Owner move-in"], ["demolition", "Demolition"],
  ["capital_improvement", "Capital improvement"], ["substantial_rehab", "Substantial rehab"],
  ["condo_conversion", "Condo conversion"], ["development", "Development"], ["nuisance", "Nuisance"],
  ["breach", "Breach"], ["non_payment", "Non-payment"],
];

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, block, lot, address, check, debug } = req.body || {};
    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    if (check) return res.status(200).json({ ok: true });
    if (debug) return res.status(200).json({ ok: true, build: "sfintel-v1" });

    const b = clean(block), l = clean(lot);
    const { num, street } = addrParts(address);
    const blockLotWhere = b && l ? `block='${b.replace(/'/g, "''")}' AND lot='${l.replace(/'/g, "''")}'` : null;
    // Development Pipeline keys on the concatenated map block-lot: 4-digit block + 3-digit
    // lot + an optional alpha suffix (e.g. "5323014A" for block 5323, lot 014A).
    const lotM = l.match(/^(\d+)([A-Za-z]*)$/);
    const mapblklot = b && l && lotM
      ? `${b.replace(/\D/g, "").padStart(4, "0")}${lotM[1].padStart(3, "0")}${lotM[2].toUpperCase()}`
      : null;
    // EnviroStor apn matches SF's blocklot (4-digit block + 3-digit numeric lot); match on
    // that OR the street address, scoped to SF.
    const apnCandidate = b && lotM ? `${b.replace(/\D/g, "").padStart(4, "0")}${lotM[1].padStart(3, "0")}` : null;
    const envWhere = [
      apnCandidate ? `apn='${apnCandidate}'` : null,
      num && street ? `(UPPER(city)='SAN FRANCISCO' AND UPPER(address) LIKE '%${num}%${street}%')` : null,
    ].filter(Boolean).join(" OR ") || null;
    const addrLike = num && street ? `upper(full_business_address) like '%${num}%${street}%'` : (street ? `upper(full_business_address) like '%${street}%'` : null);

    const [permits, complaints, biz, evictions, fire, c311, planning, pipeline, env, soft, parcel] = await Promise.all([
      blockLotWhere ? soda("i98e-djp9", { $where: blockLotWhere, $select: "permit_number,permit_type_definition,description,status,estimated_cost,revised_cost,proposed_use,existing_use,filed_date,issued_date", $order: "filed_date DESC", $limit: 25 }) : [],
      blockLotWhere ? soda("gm2e-bten", { $where: blockLotWhere, $select: "complaint_number,complaint_description,status,date_filed,date_abated", $order: "date_filed DESC", $limit: 25 }) : [],
      addrLike ? soda("g8m3-pdis", { $where: addrLike, $select: "ownership_name,dba_name,full_business_address,location_start_date,location_end_date", $order: "location_start_date DESC", $limit: 30 }) : [],
      street ? soda("5cei-gny5", { $where: `upper(address) like '%${street}%'`, $select: "address,file_date,ellis_act_withdrawal,owner_move_in,demolition,capital_improvement,substantial_rehab,condo_conversion,development,nuisance,breach,non_payment", $order: "file_date DESC", $limit: 30 }) : [],
      num && street ? soda("4zuq-2cbe", { $where: `upper(address) like '%${num}%${street}%'`, $select: "address,violation_item_description,status,violation_date,corrective_action", $order: "violation_date DESC", $limit: 20 }) : [],
      num && street ? soda("vw6y-z8j6", { $where: `upper(street) like '%${street}%'`, $select: "service_name,status_description,requested_datetime", $order: "requested_datetime DESC", $limit: 50 }) : [],
      // Planning entitlement filings -> the APPLICANT name (often the owner or their rep).
      blockLotWhere ? soda("qvu5-m3a2", { $where: blockLotWhere, $select: "project_address,project_name,description,record_status,open_date,applicant,applicant_org,number_of_units_prop", $order: "open_date DESC", $limit: 15 }) : [],
      // Development pipeline -> the SPONSOR + a named CONTACT and PHONE for active projects.
      mapblklot ? soda("6jgi-cpb4", { $where: `blklot='${mapblklot}'`, $select: "nameaddr,sponsor,contact,contactph,current_status,current_status_date,description_planning,net_pipeline_units,ret", $order: "current_status_date DESC", $limit: 10 }) : [],
      // EnviroStor contamination / cleanup sites (DTSC, statewide) at/near the lot.
      envWhere ? envirostor(envWhere) : [],
      // Mandatory soft-story seismic retrofit list -> compliance/cost pressure.
      blockLotWhere ? soda("beah-shgi", { $where: blockLotWhere, $select: "tier,status,property_address", $limit: 3 }) : [],
      // Parcel centroid -> coordinates for the transit-proximity (foot-traffic) signal.
      mapblklot ? soda("acdm-wktn", { $where: `blklot='${mapblklot}'`, $select: "centroid_latitude,centroid_longitude", $limit: 1 }) : [],
    ]);

    // Permits: recent + total estimated cost of open work.
    const permitList = permits.map((p) => ({
      type: clean(p.permit_type_definition), description: clean(p.description).slice(0, 140), status: clean(p.status),
      cost: toNum(p.revised_cost) || toNum(p.estimated_cost) || null,
      use_change: clean(p.existing_use) && clean(p.proposed_use) && clean(p.existing_use) !== clean(p.proposed_use) ? `${clean(p.existing_use)} → ${clean(p.proposed_use)}` : null,
      filed: day(p.filed_date), issued: day(p.issued_date),
    }));

    // DBI complaints: surface the open ones.
    const openComplaints = complaints.filter((c) => !/complete|closed|abated/i.test(clean(c.status)) && !clean(c.date_abated));
    const complaintList = complaints.slice(0, 8).map((c) => ({ description: clean(c.complaint_description), status: clean(c.status), filed: day(c.date_filed) }));

    // Businesses: active operators (a legal name to chase) + recently-closed (vacancy signal).
    const active = [], closed = [];
    for (const x of biz) {
      const row = { operator: clean(x.ownership_name), dba: clean(x.dba_name), address: clean(x.full_business_address), since: day(x.location_start_date), ended: day(x.location_end_date) };
      if (clean(x.location_end_date)) closed.push(row); else active.push(row);
    }

    // Evictions on the street (addresses masked to block range): roll up the high-signal causes.
    const evictionRows = evictions.map((e) => {
      const flags = EVICTION_FLAGS.filter(([k]) => /^(t|true|1|y)/i.test(clean(e[k]))).map(([, label]) => label);
      return { area: clean(e.address), date: day(e.file_date), causes: flags };
    });
    const landlordIntent = evictionRows.some((e) => e.causes.some((c) => /Ellis Act|Owner move-in|Demolition|Capital improvement|Substantial rehab|Development|Condo conversion/.test(c)));

    // Fire violations: open ones.
    const fireOpen = fire.filter((f) => !/close|complete|abated/i.test(clean(f.status)));
    const fireList = fireOpen.slice(0, 8).map((f) => ({ item: clean(f.violation_item_description), status: clean(f.status), date: day(f.violation_date) }));

    // Planning filings: the applicant is a named human/firm tied to the property (a lead).
    const planningList = planning.map((p) => ({
      project: clean(p.project_name) || clean(p.description).slice(0, 100),
      applicant: clean(p.applicant) || null, applicant_org: clean(p.applicant_org) || null,
      status: clean(p.record_status), opened: day(p.open_date), units_proposed: toNum(p.number_of_units_prop),
    })).filter((p) => p.applicant || p.project);

    // Development pipeline: sponsor + named contact + PHONE for active projects.
    const pipelineList = pipeline.map((p) => ({
      project: clean(p.nameaddr), sponsor: clean(p.sponsor) || null,
      contact: clean(p.contact) || null, contact_phone: clean(p.contactph) || null,
      status: clean(p.current_status), retail_gsf: toNum(p.ret) || null, net_units: toNum(p.net_pipeline_units),
      description: clean(p.description_planning).slice(0, 140) || null,
    })).filter((p) => p.sponsor || p.contact || p.project);

    // EnviroStor: contamination / cleanup sites at or near the lot (development diligence).
    const envSites = env.map((e) => ({
      name: clean(e.project_name) || clean(e.address), address: clean(e.address),
      type: clean(e.site_type), status: clean(e.status),
      contaminants: clean(e.confirmed_coc || e.potential_coc) || null,
    })).filter((e) => e.name || e.address);
    const envOpen = envSites.filter((e) => /active|state response|open|operation|investigation/i.test(e.status));

    // Soft-story seismic retrofit: on the list and not yet completed = compliance/cost pressure.
    const softRow = soft && soft[0] ? soft[0] : null;
    const softStory = softRow ? {
      tier: clean(softRow.tier) || null, status: clean(softRow.status),
      retrofit_pending: !/complete|cfc issued|exempt|not.*required/i.test(clean(softRow.status)),
    } : null;

    // Transit proximity (foot-traffic proxy): nearest Muni stops to the parcel centroid.
    let transit = null;
    const lat = parcel && parcel[0] ? toNum(parcel[0].centroid_latitude) : null;
    const lon = parcel && parcel[0] ? toNum(parcel[0].centroid_longitude) : null;
    if (lat != null && lon != null) {
      const d = 0.0028; // ~0.19 mi bbox
      const stops = await soda("i28k-bkz6", {
        $where: `latitude between ${lat - d} and ${lat + d} and longitude between ${lon - d} and ${lon + d}`,
        $select: "stopname,onstreet,latitude,longitude", $limit: 80,
      }).catch(() => []);
      const ranked = stops.map((s) => ({ stop: clean(s.stopname), on: clean(s.onstreet), dist: milesBetween(lat, lon, toNum(s.latitude), toNum(s.longitude)) }))
        .filter((s) => Number.isFinite(s.dist)).sort((a, b) => a.dist - b.dist);
      transit = {
        nearest_stop: ranked[0] ? { stop: ranked[0].stop, on_street: ranked[0].on, miles: Math.round(ranked[0].dist * 100) / 100 } : null,
        stops_within_quarter_mile: ranked.filter((s) => s.dist <= 0.25).length,
      };
    }

    return res.status(200).json({
      block: b || null, lot: l || null,
      permits: { count: permits.length, recent: permitList.slice(0, 8) },
      dbi_complaints: { total: complaints.length, open: openComplaints.length, recent: complaintList },
      businesses: { active: active.slice(0, 12), recently_closed: closed.slice(0, 8) },
      evictions: { street_count: evictionRows.length, landlord_intent: landlordIntent, recent: evictionRows.slice(0, 10) },
      fire_violations: { open: fireOpen.length, recent: fireList },
      complaints_311: c311.length,
      planning_applications: { count: planningList.length, recent: planningList.slice(0, 6) },
      development_pipeline: pipelineList.slice(0, 4),
      environmental: { count: envSites.length, open: envOpen.length, sites: envSites.slice(0, 6) },
      soft_story: softStory,
      transit,
      note: "SF intel (DataSF). NO owner name in CA open data — get the owner via web_research; the active business 'operator' (ownership_name) is a real contact lead. PLANNING applicant + DEVELOPMENT PIPELINE sponsor/contact/contact_phone are the closest thing to an owner contact here — a named person/firm tied to the property (CAVEAT: often the owner's rep — architect/attorney/expediter — not the owner directly, but a warm lead who routes to the owner). Eviction addresses are masked to the block (street/corridor signal, not building-exact); Ellis Act / owner move-in / demolition / capital-improvement causes = landlord clearing the building = strong motivation. Permits with a use change or high cost = active repositioning. ENVIRONMENTAL = DTSC EnviroStor contamination/cleanup sites at/near the lot (open/Active = a real diligence + cost issue, especially on commercial/industrial/development targets). SOFT_STORY = mandatory seismic retrofit list; retrofit_pending = unfinished work = compliance/cost pressure (a motivation signal). TRANSIT = nearest Muni stop + stops within 0.25mi = a foot-traffic / retail-quality proxy (SF analog of the NYC subway signal).",
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "sfintel" });
  }
}
