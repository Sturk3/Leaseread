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
const KB_KEY = "frontage:kb_v1"; // shared research memory: AI answers + paid traces, team-wide
const MAX_ROWS = 25000; // plenty of runway (500 PropertyShark exports/mo for years)

const kvHeaders = { Authorization: `Bearer ${KV_TOKEN}` };

async function kvGetK(key) {
  const r = await fetch(`${KV_URL}/get/${key}`, { headers: kvHeaders });
  if (!r.ok) throw new Error(`KV get ${r.status}`);
  const j = await r.json();
  if (!j || j.result == null) return null;
  try { return JSON.parse(j.result); } catch { return null; }
}
async function kvSetK(key, obj) {
  // Upstash REST: POST /set/<key> stores the raw request body as the value.
  const r = await fetch(`${KV_URL}/set/${key}`, { method: "POST", headers: kvHeaders, body: JSON.stringify(obj) });
  if (!r.ok) throw new Error(`KV set ${r.status}`);
}
async function kvDelK(key) {
  const r = await fetch(`${KV_URL}/del/${key}`, { method: "POST", headers: kvHeaders });
  if (!r.ok) throw new Error(`KV del ${r.status}`);
}
const kvGet = () => kvGetK(KEY);
const kvSet = (obj) => kvSetK(KEY, obj);
const kvDel = () => kvDelK(KEY);

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

    // ── Shared research memory ("the site learns") ──────────────────────────
    // Every AI answer (research brief / quick take / outreach) and every PAID
    // skip-trace result is pushed here and pulled by every browser — the team's
    // research compounds instead of living and dying in one person's tab.
    if (action === "kb_get") {
      const kb = (await kvGetK(KB_KEY)) || { ai: {}, traces: [] };
      return res.status(200).json({ shared: true, ai: kb.ai || {}, traces: kb.traces || [] });
    }

    if (action === "kb_put") {
      const kb = (await kvGetK(KB_KEY)) || { ai: {}, traces: [] };
      const { ai, trace } = req.body || {};
      if (ai && typeof ai.id === "string" && ai.id && typeof ai.kind === "string" && ai.entry && typeof ai.entry.text === "string") {
        kb.ai[ai.id.slice(0, 200)] = kb.ai[ai.id.slice(0, 200)] || {};
        const slot = kb.ai[ai.id.slice(0, 200)];
        const cur = slot[ai.kind.slice(0, 30)];
        if (!cur || (Number(ai.entry.savedAt) || 0) >= (cur.savedAt || 0)) {
          slot[ai.kind.slice(0, 30)] = { text: String(ai.entry.text).slice(0, 20000), savedAt: Number(ai.entry.savedAt) || Date.now(), mode: String(ai.entry.mode || "").slice(0, 20) };
        }
      }
      if (Array.isArray(trace) && trace.length === 2 && typeof trace[0] === "string" && trace[0] && trace[1] && typeof trace[1] === "object") {
        kb.traces = (kb.traces || []).filter((t) => Array.isArray(t) && t[0] !== trace[0]);
        kb.traces.push([trace[0].slice(0, 200), trace[1]]);
        if (kb.traces.length > 500) kb.traces = kb.traces.slice(-500);
      }
      // Size guard: stay well under the KV value limit — drop oldest AI entries first.
      let json = JSON.stringify(kb);
      while (json.length > 700000) {
        const ids = Object.keys(kb.ai);
        if (ids.length) {
          const newest = (e) => Math.max(0, ...Object.values(e).map((v) => v.savedAt || 0));
          ids.sort((a, b) => newest(kb.ai[a]) - newest(kb.ai[b]));
          delete kb.ai[ids[0]];
        } else if (kb.traces.length) {
          kb.traces = kb.traces.slice(-Math.floor(kb.traces.length / 2));
        } else break;
        json = JSON.stringify(kb);
      }
      await kvSetK(KB_KEY, kb);
      return res.status(200).json({ shared: true, ok: true });
    }

    return res.status(400).json({ error: "Unknown action — use get | put | clear." });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "contacts" });
  }
}
