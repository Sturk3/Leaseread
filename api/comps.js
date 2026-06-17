// FRONTAGE — recent sale comps for a property's block.
// Given borough + block, returns recent recorded DEED sales on that block (address,
// date, price), newest first — block-level pricing context for underwriting. ACRIS
// has no coordinates, so "same block" is the tightest free spatial comp. Password-gated.

const SOCRATA_BASE = "https://data.cityofnewyork.us/resource";
const ACRIS_MASTER = process.env.ACRIS_MASTER_DATASET || "bnx9-e6tj";
const ACRIS_LEGALS = process.env.ACRIS_LEGALS_DATASET || "8h5j-fqxa";

const BORO = { manhattan: "1", bronx: "2", brooklyn: "3", queens: "4", "staten island": "5" };
const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const toNum = (v) => { const n = Number(String(v ?? "").replace(/[$,]/g, "")); return Number.isFinite(n) ? n : null; };
const sodaQuote = (vals) => vals.map((v) => "'" + String(v).replace(/'/g, "''") + "'").join(",");
function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
async function fetchSocrata(dataset, { where, select, order, limit, appToken }) {
  const p = new URLSearchParams({ $limit: String(limit) });
  if (where) p.set("$where", where);
  if (select) p.set("$select", select);
  if (order) p.set("$order", order);
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
      where: `borough='${code}' AND block=${b}`,
      select: "document_id,street_number,street_name", limit: 3000, appToken,
    });
    const addrByDoc = {};
    for (const lg of legals) {
      const id = clean(lg.document_id);
      if (id && !addrByDoc[id]) addrByDoc[id] = clean(`${lg.street_number || ""} ${lg.street_name || ""}`);
    }
    const docIds = Object.keys(addrByDoc);
    if (!docIds.length) return res.status(200).json({ comps: [] });

    // The deed records among them, with price.
    let master = [];
    for (const batch of chunk(docIds, 75)) {
      master = master.concat(await fetchSocrata(ACRIS_MASTER, {
        where: `document_id in (${sodaQuote(batch)}) AND doc_type='DEED'`,
        select: "document_id,document_date,recorded_datetime,document_amt", limit: 2000, appToken,
      }));
    }

    const seen = new Set();
    const comps = master
      .map((m) => {
        const id = clean(m.document_id);
        const dt = clean(m.document_date || m.recorded_datetime);
        return { address: addrByDoc[id] || "", date: dt ? dt.slice(0, 10) : "", price: toNum(m.document_amt) };
      })
      .filter((c) => { const k = c.address + "|" + c.date + "|" + c.price; if (!c.price || c.price < 100000 || seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b2) => (b2.date || "").localeCompare(a.date || ""))
      .slice(0, 12);

    return res.status(200).json({ comps });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "comps" });
  }
}
