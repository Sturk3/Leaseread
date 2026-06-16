// Vercel serverless backend for FRONTAGE — LEASE RADAR.
//
// Given a batch of properties (borough/block/lot), pulls their recorded ACRIS
// lease documents (LEAS/LSE/MLSE/SLEA), then ESTIMATES which leases are nearing
// expiration so the team can get ahead of the space coming available — off-market,
// before it ever hits LoopNet/CoStar.
//
// HONEST DATA NOTE: there is NO public dataset of lease *expiration* dates. NYC
// Open Data only records when a lease was *recorded*. So we infer an estimated
// expiration = (latest recorded lease date) + (assumed term, default 10yr) and
// rank by how close that estimate is to today. These are MODELED estimates, not
// ground truth — the frontend labels them as such. Password-gated.

const SOCRATA_BASE = "https://data.cityofnewyork.us/resource";
const ACRIS_MASTER = process.env.ACRIS_MASTER_DATASET || "bnx9-e6tj";
const ACRIS_LEGALS = process.env.ACRIS_LEGALS_DATASET || "8h5j-fqxa";
const ACRIS_PARTIES = process.env.ACRIS_PARTIES_DATASET || "636b-3b5g";

const BOROUGH_NAME_TO_CODE = { manhattan: "1", bronx: "2", brooklyn: "3", queens: "4", "staten island": "5" };
// ACRIS doc types that represent an actual lease of the premises.
const LEASE_DOC_TYPES = ["LEAS", "LSE", "MLSE", "SLEA"];
const LEASE_LABEL = { LEAS: "Lease", LSE: "Lease", MLSE: "Memo of Lease", SLEA: "Sublease" };
const PARTY_ROLE = { "1": "landlord", "2": "tenant", "3": "party" };

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const toNum = (v) => {
  if (v == null || v === "" || v === "0") return null;
  const n = Number(String(v).replace(/[$,]/g, "").trim());
  return Number.isFinite(n) ? n : null;
};
const sodaQuote = (vals) => vals.map((v) => "'" + String(v).replace(/'/g, "''") + "'").join(", ");
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
async function fetchSocrata(dataset, { where, select, limit }) {
  const params = new URLSearchParams({ $limit: String(limit) });
  if (where) params.set("$where", where);
  if (select) params.set("$select", select);
  const token = process.env.SOCRATA_APP_TOKEN;
  const headers = token ? { "X-App-Token": token } : {};
  const r = await fetch(`${SOCRATA_BASE}/${dataset}.json?${params.toString()}`, { headers });
  if (!r.ok) throw new Error(`Socrata ${dataset} ${r.status}`);
  return r.json();
}

// Whole months from `from` to `to` (negative if `to` is in the past).
function monthsBetween(from, to) {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}

// Rank a property by how actionable its (estimated) lease expiration is. Highest
// for leases estimated to come available in the near term; high-ish for ones that
// estimate as recently expired (likely holdover / month-to-month / available now);
// low for long leases and properties with no lease on record.
function scoreLease(status, monthsToExpiry, horizonMonths) {
  if (status === "expiring") {
    const frac = Math.max(0, Math.min(1, monthsToExpiry / horizonMonths));
    return Math.round(100 - frac * 38); // 100 (due now) → ~62 (edge of horizon)
  }
  if (status === "expired") {
    const ago = -monthsToExpiry;
    if (ago <= 6) return 72;
    if (ago <= 18) return 64;
    if (ago <= 36) return 50;
    return 30; // long past estimate — probably renewed
  }
  if (status === "active") {
    const over = monthsToExpiry - horizonMonths;
    return Math.max(5, Math.round(40 - over)); // longer remaining → lower
  }
  return 8; // no recorded lease — could be vacant or owner-occupied
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, properties, termYears, horizonMonths } = req.body || {};
    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    if (!Array.isArray(properties) || !properties.length) {
      return res.status(400).json({ error: "Need a list of properties to scan." });
    }
    const term = Number(termYears) > 0 ? Number(termYears) : 10;
    const horizon = Number(horizonMonths) > 0 ? Number(horizonMonths) : 24;
    const now = new Date();

    // Normalize input → one entry per distinct lot, keyed by the EXACT borough/block/lot
    // values we received so the frontend can join results back without re-deriving codes.
    const byKey = new Map();
    for (const p of properties.slice(0, 60)) {
      const code = /^[1-5]$/.test(String(p.borough)) ? String(p.borough)
        : BOROUGH_NAME_TO_CODE[clean(p.borough).toLowerCase()];
      const b = Number(p.block);
      const l = Number(p.lot);
      if (!code || !Number.isFinite(b) || !Number.isFinite(l)) continue;
      const key = `${clean(p.borough)}|${clean(p.block)}|${clean(p.lot)}`;
      if (!byKey.has(key)) byKey.set(key, { key, code, b, l, address: clean(p.address) });
    }
    const lots = [...byKey.values()];
    if (!lots.length) return res.status(200).json({ results: [], termYears: term, horizonMonths: horizon });

    // 1) ACRIS Legals → document_ids for every lot in one OR'd query, mapped back to lot.
    const legalKey = (r) => `${clean(r.borough)}-${clean(r.block)}-${clean(r.lot)}`;
    const lotByLegalKey = new Map(lots.map((x) => [`${x.code}-${x.b}-${x.l}`, x]));
    const docToLot = new Map();
    const allDocIds = new Set();
    for (const grp of chunk(lots, 40)) {
      const where = grp.map((x) => `(borough='${x.code}' AND block=${x.b} AND lot=${x.l})`).join(" OR ");
      const legals = await fetchSocrata(ACRIS_LEGALS, { where, select: "document_id,borough,block,lot", limit: 5000 });
      for (const row of legals) {
        const id = clean(row.document_id);
        const lot = lotByLegalKey.get(legalKey(row));
        if (!id || !lot) continue;
        docToLot.set(id, lot.key);
        allDocIds.add(id);
      }
    }

    // 2) ACRIS Master → keep only lease-type docs among those document_ids.
    const leaseDocs = []; // { id, key, doc_type, date, amount }
    const leaseTypeClause = `doc_type in (${sodaQuote(LEASE_DOC_TYPES)})`;
    for (const batch of chunk([...allDocIds], 75)) {
      const where = `document_id in (${sodaQuote(batch)}) AND ${leaseTypeClause}`;
      const master = await fetchSocrata(ACRIS_MASTER, {
        where, select: "document_id,doc_type,document_date,recorded_datetime,document_amt", limit: 4000,
      });
      for (const m of master) {
        const id = clean(m.document_id);
        const key = docToLot.get(id);
        if (!key) continue;
        const dt = clean(m.document_date || m.recorded_datetime);
        leaseDocs.push({ id, key, doc_type: clean(m.doc_type), date: dt ? dt.slice(0, 10) : "", amount: toNum(m.document_amt) });
      }
    }

    // 3) Parties for the lease docs only (tenant = lessee, landlord = lessor).
    const partiesByDoc = {};
    const leaseDocIds = leaseDocs.map((d) => d.id);
    for (const batch of chunk(leaseDocIds, 75)) {
      const parties = await fetchSocrata(ACRIS_PARTIES, {
        where: `document_id in (${sodaQuote(batch)})`, select: "document_id,name,party_type", limit: 6000,
      });
      for (const p of parties) {
        const id = clean(p.document_id);
        const nm = clean(p.name);
        if (!nm) continue;
        (partiesByDoc[id] = partiesByDoc[id] || []).push({ name: nm, role: PARTY_ROLE[clean(p.party_type)] || "party" });
      }
    }

    // 4) Per-lot: take the latest recorded lease, estimate expiration, score it.
    const leasesByLot = {};
    for (const d of leaseDocs) (leasesByLot[d.key] = leasesByLot[d.key] || []).push(d);

    const results = lots.map((lot) => {
      const leases = (leasesByLot[lot.key] || []).filter((d) => d.date)
        .sort((a, b) => b.date.localeCompare(a.date));
      const latest = leases[0] || null;

      if (!latest) {
        return {
          key: lot.key, address: lot.address, status: "none", lease_count: 0,
          latest_lease_date: null, estimated_expiration: null, months_to_expiry: null,
          term_years: term, tenant: null, landlord: null, score: scoreLease("none"),
          off_market_opportunity: false,
        };
      }

      const exp = new Date(latest.date);
      exp.setFullYear(exp.getFullYear() + term);
      const mte = monthsBetween(now, exp);
      let status;
      if (mte < 0) status = "expired";
      else if (mte <= horizon) status = "expiring";
      else status = "active";

      const parties = partiesByDoc[latest.id] || [];
      const tenant = (parties.find((p) => p.role === "tenant") || {}).name || null;
      const landlord = (parties.find((p) => p.role === "landlord") || {}).name || null;
      const score = scoreLease(status, mte, horizon);

      return {
        key: lot.key, address: lot.address,
        status, lease_count: leases.length,
        latest_lease_type: LEASE_LABEL[latest.doc_type] || latest.doc_type || "Lease",
        latest_lease_date: latest.date,
        estimated_expiration: exp.toISOString().slice(0, 10),
        months_to_expiry: mte,
        term_years: term,
        tenant, landlord,
        score,
        // Off-market opportunity = a lease estimated to be ending soon (or just ended)
        // that we're surfacing from public records — not from any listing feed.
        off_market_opportunity: status === "expiring" || status === "expired",
      };
    }).sort((a, b) => b.score - a.score);

    return res.status(200).json({ results, termYears: term, horizonMonths: horizon, scanned: lots.length });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "leasescan" });
  }
}
