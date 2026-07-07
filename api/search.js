// FRONTAGE — unified property search: ONE serverless endpoint for every market.
//
//   POST /api/search  { password, market, ...filters }
//
// Markets: nyc | hamptons | ct | ma | sf | nashville | charleston — each
// implemented as a module in api/_markets/ (underscore folders are not
// deployed as functions).
// Unified filter vocabulary, honored by every market where the data allows:
//   town, propertyType, address, owner, minValue, maxValue, minSqft, sinceYear,
//   limit, centerLat, centerLon, radiusMiles
// Market-specific extras pass straight through (e.g. NYC's sources/borough/
// assetType/street/BBL stack, SF's neighborhood, Nashville's minAcres), and the
// pre-consolidation aliases still work (CT's minPrice/maxPrice).
//
// Response shape: { properties: [...] } for the assessor markets; NYC returns
// its deal-flow shape { deals, leads } (the NYC UI is built around leads).

import * as nyc from "./_markets/nyc.js";
import * as hamptons from "./_markets/hamptons.js";
import * as ct from "./_markets/ct.js";
import * as ma from "./_markets/ma.js";
import * as sf from "./_markets/sf.js";
import * as nashville from "./_markets/nashville.js";
import * as charleston from "./_markets/charleston.js";
import * as savannah from "./_markets/savannah.js";

const MARKETS = { nyc, hamptons, ct, ma, sf, nashville, charleston, sc: charleston, savannah, ga: savannah };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const marketKey = String((req.body || {}).market || "").trim().toLowerCase();
  try {
    const { password, check, debug } = req.body || {};

    // Shared-password gate (enforced before any data call).
    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    if (check) return res.status(200).json({ ok: true, markets: Object.keys(MARKETS), dbConfigured: !!process.env.DATABASE_URL });

    const mod = MARKETS[marketKey];
    if (!mod) {
      return res.status(400).json({ error: `Unknown market "${marketKey || "(none)"}". Pass market: ${Object.keys(MARKETS).join(" | ")}.` });
    }
    if (debug) return res.status(200).json({ ok: true, build: "search-v1", market: marketKey, module: mod.BUILD });

    const payload = await mod.search(req.body || {});
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ error: e.message, where: `search:${marketKey || "?"}` });
  }
}
