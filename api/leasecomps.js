// FRONTAGE — recorded LEASE comps for a property's block.
// Given borough + block, returns recorded ACRIS leases on that block (address, date,
// doc type, tenant, landlord) — the lease analog of comps.js. ACRIS has no coordinates,
// so "same block" is the tightest free spatial unit; and most retail leases are never
// recorded, so results are sparse — this surfaces the ones that exist. Password-gated.

const SOCRATA_BASE = "https://data.cityofnewyork.us/resource";
const ACRIS_MASTER = process.env.ACRIS_MASTER_DATASET || "bnx9-e6tj";
const ACRIS_LEGALS = process.env.ACRIS_LEGALS_DATASET || "8h5j-fqxa";
const ACRIS_PARTIES = process.env.ACRIS_PARTIES_DATASET || "636b-3b5g";

const BORO = { manhattan: "1", bronx: "2", brooklyn: "3", queens: "4", "staten island": "5" };
const LEASE_DOCS = ["LEAS", "LSE", "MLSE", "SLEA", "AL&R"];
const DOC_LABEL = { LEAS: "Lease", LSE: "Lease", MLSE: "Memo of Lease", SLEA: "Sublease", "AL&R": "Assign. Leases & Rents" };
const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const sodaQuote = (vals) => vals.map((v) => "'" + String(v).replace(/'/g, "''") + "'").join(",");
function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
async function fetchSocrata(dataset, { where, select, limit, appToken }) {
  const p = new URLSearchParams({ $limit: String(limit) });
  if (where) p.set("$where", where);
  if (select) p.set("$select", select);
  const headers = appToken ? { "X-App-Token": appToken } : {};
  const r = await fetch(`${SOCRATA_BASE}/${dataset}.json?${p}`, { headers });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, borough, block } = req.body || {};
    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    const code = /^[1-5]$/.test(String(borough)) ? String(borough) : BORO[clean(borough).toLowerCase()];
    const b = Number(block);
    if (!code || !Number.isFinite(b)) return res.status(400).json({ error: "Need borough and block." });
    const appToken = process.env.SOCRATA_APP_TOKEN || null;

    // All legals on the block → addresses keyed by document_id.
    const legals = await fetchSocrata(ACRIS_LEGALS, {
      where: `borough='${code}' AND block=${b}`, select: "document_id,street_number,street_name", limit: 3000, appToken,
    });
    const addrByDoc = {};
    for (const lg of legals) { const id = clean(lg.document_id); if (id && !addrByDoc[id]) addrByDoc[id] = clean(`${lg.street_number || ""} ${lg.street_name || ""}`); }
    const docIds = Object.keys(addrByDoc);
    if (!docIds.length) return res.status(200).json({ leases: [] });

    // The lease records among them.
    let master = [];
    for (const batch of chunk(docIds, 75)) {
      master = master.concat(await fetchSocrata(ACRIS_MASTER, {
        where: `document_id in (${sodaQuote(batch)}) AND doc_type in (${sodaQuote(LEASE_DOCS)})`,
        select: "document_id,doc_type,document_date,recorded_datetime", limit: 2000, appToken,
      }));
    }
    if (!master.length) return res.status(200).json({ leases: [] });

    // Parties on those lease docs → tenant (lessee, party_type 2) + landlord (lessor, 1).
    const leaseIds = master.map((m) => clean(m.document_id));
    const partiesByDoc = {};
    for (const batch of chunk([...new Set(leaseIds)], 75)) {
      const rows = await fetchSocrata(ACRIS_PARTIES, {
        where: `document_id in (${sodaQuote(batch)})`, select: "document_id,name,party_type", limit: 4000, appToken,
      });
      for (const p of rows) { const id = clean(p.document_id); (partiesByDoc[id] = partiesByDoc[id] || []).push({ name: clean(p.name), role: clean(p.party_type) }); }
    }

    const leases = master.map((m) => {
      const id = clean(m.document_id);
      const dt = clean(m.document_date || m.recorded_datetime);
      const parties = partiesByDoc[id] || [];
      const landlord = (parties.find((p) => p.role === "1") || {}).name || "";
      const tenant = (parties.find((p) => p.role === "2") || {}).name || "";
      const t = clean(m.doc_type);
      return { address: addrByDoc[id] || "", date: dt ? dt.slice(0, 10) : "", doc_label: DOC_LABEL[t] || t || "Lease", tenant, landlord, document_id: id };
    }).sort((a, c) => (c.date || "").localeCompare(a.date || "")).slice(0, 20);

    return res.status(200).json({ leases });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "leasecomps" });
  }
}
