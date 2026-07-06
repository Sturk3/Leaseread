// FRONTAGE — integration health / config report.
//
// One password-gated, ZERO-COST call that answers "what's wired and what key do I still
// need to set?" — the handoff & ops view. It reads the single source of truth in
// api/_lib/providers.js, so it can never drift from reality. No values are ever returned,
// only booleans (whether each key is present).
//
// POST { password } → { ok, summary, integrations: [...] }
//   summary: quick counts + a `needsAttention` list (required capabilities missing a key).
//
// Add a provider once, in api/_lib/providers.js, and it shows up here automatically.

import { providerReport } from "./_lib/providers.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password } = req.body || {};
    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }

    const integrations = providerReport(process.env);
    const ready = integrations.filter((i) => i.status === "ready");
    const planned = integrations.filter((i) => i.status === "planned");
    const needsAttention = integrations
      .filter((i) => i.status === "MISSING KEY")
      .map((i) => ({ capability: i.capability, title: i.title, set: i.lanes.find((l) => l.active)?.keys }));

    return res.status(200).json({
      ok: true,
      build: "health-v1",
      generatedAt: new Date().toISOString(),
      summary: {
        total: integrations.length,
        ready: ready.length,
        planned: planned.length,
        needsAttention: needsAttention.length,
        // Required capabilities whose active lane has no key set — these block real use.
        blocking: needsAttention,
      },
      integrations,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "health" });
  }
}
