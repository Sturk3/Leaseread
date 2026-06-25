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

async function soda(dataset, params) {
  const token = process.env.SOCRATA_APP_TOKEN;
  const r = await fetch(`${SF}/${dataset}.json?${new URLSearchParams(params)}`, token ? { headers: { "X-App-Token": token } } : {});
  if (!r.ok) return [];
  return r.json().catch(() => []);
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
    const addrLike = num && street ? `upper(full_business_address) like '%${num}%${street}%'` : (street ? `upper(full_business_address) like '%${street}%'` : null);

    const [permits, complaints, biz, evictions, fire, c311] = await Promise.all([
      blockLotWhere ? soda("i98e-djp9", { $where: blockLotWhere, $select: "permit_number,permit_type_definition,description,status,estimated_cost,revised_cost,proposed_use,existing_use,filed_date,issued_date", $order: "filed_date DESC", $limit: 25 }) : [],
      blockLotWhere ? soda("gm2e-bten", { $where: blockLotWhere, $select: "complaint_number,complaint_description,status,date_filed,date_abated", $order: "date_filed DESC", $limit: 25 }) : [],
      addrLike ? soda("g8m3-pdis", { $where: addrLike, $select: "ownership_name,dba_name,full_business_address,location_start_date,location_end_date", $order: "location_start_date DESC", $limit: 30 }) : [],
      street ? soda("5cei-gny5", { $where: `upper(address) like '%${street}%'`, $select: "address,file_date,ellis_act_withdrawal,owner_move_in,demolition,capital_improvement,substantial_rehab,condo_conversion,development,nuisance,breach,non_payment", $order: "file_date DESC", $limit: 30 }) : [],
      num && street ? soda("4zuq-2cbe", { $where: `upper(address) like '%${num}%${street}%'`, $select: "address,violation_item_description,status,violation_date,corrective_action", $order: "violation_date DESC", $limit: 20 }) : [],
      num && street ? soda("vw6y-z8j6", { $where: `upper(street) like '%${street}%'`, $select: "service_name,status_description,requested_datetime", $order: "requested_datetime DESC", $limit: 50 }) : [],
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

    return res.status(200).json({
      block: b || null, lot: l || null,
      permits: { count: permits.length, recent: permitList.slice(0, 8) },
      dbi_complaints: { total: complaints.length, open: openComplaints.length, recent: complaintList },
      businesses: { active: active.slice(0, 12), recently_closed: closed.slice(0, 8) },
      evictions: { street_count: evictionRows.length, landlord_intent: landlordIntent, recent: evictionRows.slice(0, 10) },
      fire_violations: { open: fireOpen.length, recent: fireList },
      complaints_311: c311.length,
      note: "SF intel (DataSF). NO owner name in CA open data — get the owner via web_research; the active business 'operator' (ownership_name) is a real contact lead. Eviction addresses are masked to the block, so they're a street/corridor signal, not building-exact; Ellis Act / owner move-in / demolition / capital-improvement causes = landlord clearing the building = strong motivation/repositioning signal. Permits with a use change or high cost = active repositioning.",
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "sfintel" });
  }
}
