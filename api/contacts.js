// FRONTAGE — shared contact file (the PropertyShark import, team-wide).
//
// localStorage made the imported contacts per-browser; this endpoint makes them
// SITE-WIDE: whoever imports the CSV, everyone on FRONTAGE gets the same numbers.
// The browser still keeps a local cache (psStore) so lookups stay synchronous —
// psEnsureSynced() in App.jsx pulls this store once per session and merges.
//
//   POST /api/contacts { password, action: "get" }                → { rows, imported, shared }
//   POST /api/contacts { password, action: "put", rows: [...] }   → { count, shared }
//   POST /api/contacts { password, action: "clear" }              → { cleared, shared }
//
// STORAGE: Upstash Redis via its REST API (no SDK/npm dependency) — the free
// "Upstash for Redis" integration in the Vercel dashboard (Storage → Create →
// Upstash) injects KV_REST_API_URL/KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_*).
// Until those env vars exist every action returns { noStore: true } and the
// frontend gracefully stays per-browser — nothing breaks.

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = "frontage:ps_contacts_v1";
const MAX_ROWS = 25000; // plenty of runway (500 PropertyShark exports/mo for years)

const kvHeaders = { Authorization: `Bearer ${KV_TOKEN}` };

async function kvGet() {
  const r = await fetch(`${KV_URL}/get/${KEY}`, { headers: kvHeaders });
  if (!r.ok) throw new Error(`KV get ${r.status}`);
  const j = await r.json();
  if (!j || j.result == null) return null;
  try { return JSON.parse(j.result); } catch { return null; }
}
async function kvSet(obj) {
  // Upstash REST: POST /set/<key> stores the raw request body as the value.
  const r = await fetch(`${KV_URL}/set/${KEY}`, { method: "POST", headers: kvHeaders, body: JSON.stringify(obj) });
  if (!r.ok) throw new Error(`KV set ${r.status}`);
}
async function kvDel() {
  const r = await fetch(`${KV_URL}/del/${KEY}`, { method: "POST", headers: kvHeaders });
  if (!r.ok) throw new Error(`KV del ${r.status}`);
}

// Keep only the fields the app actually uses — imports can't smuggle junk in.
const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
function sanitizeRow(r) {
  if (!r || typeof r !== "object") return null;
  const phones = (Array.isArray(r.phones) ? r.phones : []).slice(0, 10).map((p) => ({
    number: clean(p && p.number), type: clean(p && p.type).slice(0, 20), dnc: !!(p && p.dnc),
  })).filter((p) => p.number.replace(/\D/g, "").length >= 10);
  const emails = (Array.isArray(r.emails) ? r.emails : []).slice(0, 6).map((e) => clean(e).toLowerCase()).filter((e) => /.+@.+\..+/.test(e));
  if (!phones.length && !emails.length) return null;
  const row = {
    address: clean(r.address).slice(0, 160), owner: clean(r.owner).slice(0, 160), contact: clean(r.contact).slice(0, 160),
    phones, emails,
    addrKey: clean(r.addrKey).slice(0, 160), ownerKey: clean(r.ownerKey).slice(0, 160), contactKey: clean(r.contactKey).slice(0, 160),
  };
  if (!row.addrKey && !row.ownerKey && !row.contactKey) return null;
  return row;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, action, rows } = req.body || {};
    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    if (!KV_URL || !KV_TOKEN) {
      // Shared store not provisioned yet — tell the frontend so it can stay local-only.
      return res.status(200).json({ noStore: true, shared: false, rows: [], howTo: "Vercel dashboard → Storage → Create → Upstash for Redis (free) → connect to this project → redeploy." });
    }

    if (action === "get") {
      const store = (await kvGet()) || { rows: [], imported: null };
      return res.status(200).json({ shared: true, rows: store.rows || [], imported: store.imported || null });
    }

    if (action === "put") {
      const incoming = (Array.isArray(rows) ? rows : []).map(sanitizeRow).filter(Boolean);
      if (!incoming.length) return res.status(400).json({ error: "No usable contact rows in the import." });
      const cur = (await kvGet()) || { rows: [] };
      const byKey = new Map((cur.rows || []).map((r) => [`${r.addrKey}|${r.ownerKey}`, r]));
      for (const r of incoming) byKey.set(`${r.addrKey}|${r.ownerKey}`, r);
      const merged = [...byKey.values()].slice(-MAX_ROWS);
      const next = { rows: merged, imported: new Date().toISOString().slice(0, 10) };
      await kvSet(next);
      return res.status(200).json({ shared: true, added: incoming.length, count: merged.length, imported: next.imported });
    }

    if (action === "clear") {
      await kvDel();
      return res.status(200).json({ shared: true, cleared: true });
    }

    return res.status(400).json({ error: "Unknown action — use get | put | clear." });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "contacts" });
  }
}
