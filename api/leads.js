// Vercel serverless backend for FRONTAGE — shared leads store (Postgres).
// Read and update the team's accumulated, deduped lead list. Password-gated.
// Requires DATABASE_URL; if it's unset, every action returns dbConfigured:false
// so the UI can show a "connect a database" notice instead of erroring.

async function withClient(fn) {
  if (!process.env.DATABASE_URL) return { dbConfigured: false };
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    return { dbConfigured: true, ...(await fn(client)) };
  } finally {
    await client.end();
  }
}

const ALLOWED_STATUS = new Set(["new", "working", "contacted", "dead"]);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, action, filters, id, status, notes } = req.body || {};

    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }

    if (action === "list") {
      const f = filters || {};
      const out = await withClient(async (client) => {
        const where = [];
        const vals = [];
        if (f.status && ALLOWED_STATUS.has(f.status)) { vals.push(f.status); where.push(`status = $${vals.length}`); }
        if (f.source) { vals.push(f.source); where.push(`source = $${vals.length}`); }
        if (f.borough) { vals.push(f.borough); where.push(`borough = $${vals.length}`); }
        if (f.entity_type) { vals.push(f.entity_type); where.push(`entity_type = $${vals.length}`); }
        if (f.q) { vals.push(`%${f.q}%`); where.push(`(name ilike $${vals.length} or address ilike $${vals.length})`); }
        const lim = Math.max(1, Math.min(Number(f.limit) || 500, 2000));
        const sql = `select * from leads ${where.length ? "where " + where.join(" and ") : ""}
                     order by created_at desc limit ${lim}`;
        const rows = (await client.query(sql, vals)).rows;
        const stats = (await client.query(
          `select status, count(*)::int as n from leads group by status`,
        )).rows;
        return { rows, stats };
      });
      if (!out.dbConfigured) return res.status(200).json({ dbConfigured: false, rows: [], stats: [] });
      return res.status(200).json(out);
    }

    if (action === "update") {
      if (!id) return res.status(400).json({ error: "Missing id" });
      if (status && !ALLOWED_STATUS.has(status)) return res.status(400).json({ error: "Bad status" });
      const out = await withClient(async (client) => {
        const sets = [];
        const vals = [];
        if (status) { vals.push(status); sets.push(`status = $${vals.length}`); }
        if (notes !== undefined) { vals.push(notes); sets.push(`notes = $${vals.length}`); }
        if (!sets.length) return { updated: 0 };
        vals.push(id);
        const r = await client.query(`update leads set ${sets.join(", ")} where id = $${vals.length}`, vals);
        return { updated: r.rowCount || 0 };
      });
      if (!out.dbConfigured) return res.status(200).json({ dbConfigured: false });
      return res.status(200).json(out);
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "leads" });
  }
}
