// FRONTAGE — corridor retail-availability screen (the RetailAvailability engine's
// HTTP surface). Scout is the SOLE consumer: the browser's agent loop routes the
// retail_availability tool here (TOOL_ROUTES in src/App.jsx); no UI tab calls it
// directly. The engines live in api/_engines/ (one per connector: NYC, Charleston)
// and the corridors they screen are config in api/_corridors/. Password-gated.
//
//   POST /api/availability  { password, corridor }            → ranked screen
//   POST /api/availability  { password, list: true }          → configured corridors
//   POST /api/availability  { password, corridor, limit: N }  → top-N rows only

import { listCorridors, resolveCorridor } from "./_corridors/index.js";
import { runRetailAvailability, BUILD } from "./_engines/retailavailability.js";
import { runRetailAvailabilityCharleston, BUILD as CHS_BUILD } from "./_engines/retailavailability-charleston.js";

// connector key (on the corridor config) → engine. Add a market by dropping a
// connector engine in _engines/ and registering it here — availability.js stays dumb.
const ENGINES = {
  nyc: runRetailAvailability,
  charleston: runRetailAvailabilityCharleston,
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, check, debug, list, corridor, limit } = req.body || {};

    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    if (check) return res.status(200).json({ ok: true, corridors: listCorridors().map((c) => c.id) });
    if (debug) return res.status(200).json({ ok: true, build: `${BUILD} / ${CHS_BUILD}`, corridors: listCorridors() });

    if (list || !corridor) {
      return res.status(200).json({
        corridors: listCorridors(),
        note: corridor ? undefined : "Pass corridor: <id or name> to run a screen.",
      });
    }

    const resolved = resolveCorridor(corridor);
    if (!resolved) {
      // NOT an `error` field: the client's postJSON throws on error and would discard the
      // corridors list — this payload exists so Scout can see what IS configured and retry.
      return res.status(200).json({
        no_match: corridor,
        note: `No configured corridor matches "${corridor}" — pick one of the configured corridors below (by id or name).`,
        corridors: listCorridors(),
      });
    }

    const engine = ENGINES[resolved.connector];
    if (!engine) throw new Error(`no "${resolved.connector}" engine registered for corridor "${resolved.id}"`);
    const payload = await engine(resolved, { limit });
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "availability" });
  }
}
