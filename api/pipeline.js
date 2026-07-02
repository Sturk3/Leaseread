// FRONTAGE — shared Pipeline store (the Saved List), backed by Postgres.
//
// The browser keeps localStorage as its synchronous read-through cache and syncs
// here: pull-merge when the Pipeline tab opens, background push on every save /
// status change / note / remove. Last-write-wins by the client's updatedAt (ms).
// Removes are TOMBSTONES (deleted=true) so a teammate's delete doesn't get
// resurrected by another browser's stale local copy.
//
// Without DATABASE_URL every action answers { dbConfigured: false } and the
// client quietly stays device-local — the pre-DB behavior, nothing breaks.
// The table is auto-created on first use, so connecting a Postgres (Vercel →
// Storage → Neon) and setting DATABASE_URL is the ONLY setup step.
//
// POST { password, ... }:
//   { check: true }                      → { ok, dbConfigured }
//   { action: "list" }                   → { dbConfigured, leads: [...], deleted: [{ id, updatedAt }] }
//   { action: "upsert", leads: [lead] }  → { dbConfigured, saved }
//   { action: "remove", id }             → { dbConfigured, removed }

const CREATE_SQL = `create table if not exists pipeline (
  id         text primary key,
  lead       jsonb not null,
  status     text not null default 'watching',
  deleted    boolean not null default false,
  updated_at bigint not null default 0,
  created_at timestamptz not null default now()
)`;

async function connect() {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  return client;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, check, action, leads, id } = req.body || {};

    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    const dbConfigured = !!process.env.DATABASE_URL;
    if (check) return res.status(200).json({ ok: true, dbConfigured });
    if (!dbConfigured) return res.status(200).json({ dbConfigured: false, leads: [], deleted: [], saved: 0, removed: 0 });

    const client = await connect();
    try {
      await client.query(CREATE_SQL);

      if (action === "list") {
        const r = await client.query("select lead, deleted, updated_at from pipeline order by updated_at desc limit 2000");
        const out = { dbConfigured: true, leads: [], deleted: [] };
        for (const row of r.rows) {
          if (row.deleted) out.deleted.push({ id: row.lead.id, updatedAt: Number(row.updated_at) || 0 });
          else out.leads.push(row.lead);
        }
        return res.status(200).json(out);
      }

      if (action === "upsert") {
        const arr = (Array.isArray(leads) ? leads : []).filter((l) => l && typeof l.id === "string" && l.id);
        let saved = 0;
        for (const l of arr.slice(0, 500)) {
          const r = await client.query(
            `insert into pipeline (id, lead, status, deleted, updated_at)
             values ($1, $2, $3, false, $4)
             on conflict (id) do update
               set lead = excluded.lead, status = excluded.status, deleted = false, updated_at = excluded.updated_at
               where pipeline.updated_at <= excluded.updated_at`,
            [l.id, JSON.stringify(l), String(l.status || "watching"), Number(l.updatedAt) || Date.now()],
          );
          saved += r.rowCount || 0;
        }
        return res.status(200).json({ dbConfigured: true, saved });
      }

      if (action === "remove") {
        const key = String(id || "");
        if (!key) return res.status(400).json({ error: "remove needs an id" });
        // Tombstone, not a hard delete — keeps the removal authoritative across devices.
        const r = await client.query(
          `insert into pipeline (id, lead, status, deleted, updated_at)
           values ($1, $2, 'watching', true, $3)
           on conflict (id) do update set deleted = true, updated_at = $3`,
          [key, JSON.stringify({ id: key }), Date.now()],
        );
        return res.status(200).json({ dbConfigured: true, removed: r.rowCount || 0 });
      }

      return res.status(400).json({ error: `Unknown action "${action || "(none)"}". Use list | upsert | remove.` });
    } finally {
      await client.end();
    }
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "pipeline" });
  }
}
