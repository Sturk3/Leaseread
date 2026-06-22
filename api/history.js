// Vercel serverless backend for FRONTAGE — per-property transaction history.
// Given a property (borough + block + lot), returns its ACRIS document history
// (deeds, mortgages, etc. — date, amount, and the parties on each). Loaded on
// demand when a property row is expanded in the Sourcing tab. Password-gated.

const SOCRATA_BASE = "https://data.cityofnewyork.us/resource";
const ACRIS_MASTER = process.env.ACRIS_MASTER_DATASET || "bnx9-e6tj";
const ACRIS_LEGALS = process.env.ACRIS_LEGALS_DATASET || "8h5j-fqxa";
const ACRIS_PARTIES = process.env.ACRIS_PARTIES_DATASET || "636b-3b5g";

const BOROUGH_NAME_TO_CODE = { manhattan: "1", bronx: "2", brooklyn: "3", queens: "4", "staten island": "5" };
const PARTY_ROLE = { "1": "grantor/seller", "2": "grantee/buyer", "3": "party" };
// Friendly labels for the common ACRIS document types.
const DOC_LABEL = {
  DEED: "Deed", MTGE: "Mortgage", SAT: "Satisfaction", ASST: "Assignment", AGMT: "Agreement",
  LEAS: "Lease", LSE: "Lease", MLSE: "Memo of Lease", SLEA: "Sublease",
  "AL&R": "Assign. Leases & Rents", "TL&R": "Term. Leases & Rents", RPTT: "Transfer Tax Return",
  LIS: "Lis Pendens", CORR: "Correction", PAT: "Power of Attorney", UCC1: "UCC Filing",
  UCC3: "UCC Amendment", MMTG: "Mortgage Modification", SPRD: "Spreader Agreement",
};

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
async function fetchSocrata(dataset, { where, select, order, limit, appToken }) {
  const params = new URLSearchParams({ $limit: String(limit) });
  if (where) params.set("$where", where);
  if (select) params.set("$select", select);
  if (order) params.set("$order", order);
  const headers = appToken ? { "X-App-Token": appToken } : {};
  const r = await fetch(`${SOCRATA_BASE}/${dataset}.json?${params.toString()}`, { headers });
  if (!r.ok) throw new Error(`Socrata ${dataset} ${r.status}`);
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, borough, block, lot } = req.body || {};
    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    const code = /^[1-5]$/.test(String(borough)) ? String(borough) : BOROUGH_NAME_TO_CODE[clean(borough).toLowerCase()];
    const b = Number(block);
    const l = Number(lot);
    if (!code || !Number.isFinite(b) || !Number.isFinite(l)) {
      return res.status(400).json({ error: "Need borough, block, and lot." });
    }
    const appToken = null; // NYC account/token disconnected — anonymous requests only

    const legals = await fetchSocrata(ACRIS_LEGALS, {
      where: `borough='${code}' AND block=${b} AND lot=${l}`, select: "document_id", limit: 500, appToken,
    });
    const docIds = [...new Set(legals.map((r) => clean(r.document_id)).filter(Boolean))];
    if (!docIds.length) return res.status(200).json({ history: [] });

    let master = [];
    let parties = [];
    for (const batch of chunk(docIds, 75)) {
      const inc = `document_id in (${sodaQuote(batch)})`;
      master = master.concat(await fetchSocrata(ACRIS_MASTER, {
        where: inc, select: "document_id,doc_type,document_date,recorded_datetime,document_amt", limit: 2000, appToken,
      }));
      parties = parties.concat(await fetchSocrata(ACRIS_PARTIES, {
        where: inc, select: "document_id,name,party_type", limit: 4000, appToken,
      }));
    }

    const partiesByDoc = {};
    for (const p of parties) {
      const id = clean(p.document_id);
      const nm = clean(p.name);
      if (!nm) continue;
      (partiesByDoc[id] = partiesByDoc[id] || []).push({ name: nm, role: PARTY_ROLE[clean(p.party_type)] || "party" });
    }

    const history = master.map((m) => {
      const id = clean(m.document_id);
      const dt = clean(m.document_date || m.recorded_datetime);
      const t = clean(m.doc_type);
      return {
        doc_type: t, doc_label: DOC_LABEL[t] || t || "Document",
        date: dt ? dt.slice(0, 10) : "", amount: toNum(m.document_amt),
        document_id: id, parties: partiesByDoc[id] || [],
      };
    }).sort((a, b) => (b.date || "").localeCompare(a.date || ""));

    return res.status(200).json({ history });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "history" });
  }
}
