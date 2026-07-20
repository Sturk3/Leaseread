// FRONTAGE — corridor config layer. A Corridor is a static, typed description of a
// retail corridor (streets + tiers + the firm's buy box + scoring weights) that the
// RetailAvailability engine screens deterministically. Corridors are CONFIG, not code:
// add a corridor by dropping a file in this folder and registering it below — never by
// editing the engine. Underscore-prefixed folders inside api/ are NOT deployed as
// serverless functions by Vercel, so this is plain shared code, not an endpoint.

/**
 * @typedef {Object} CorridorSegment  One stretch of one street.
 * @property {string} street      Street name as commonly written ("Prince St", "West Broadway").
 *                                The connector normalizes it (St→STREET, 6th→6, known aliases).
 * @property {string} from_cross  Cross street bounding one end of the segment.
 * @property {string} to_cross    Cross street bounding the other end.
 * @property {"both"|"north"|"south"|"east"|"west"} side  Which side(s) of the street count.
 * @property {"flagship"|"luxury"|"boutique"} tier  Corridor quality tier (feeds scoring).
 *
 * @typedef {Object} CorridorBuyBox  The firm's physical/deal criteria for this corridor.
 * @property {number|null} frontage_ft_min   Minimum street frontage in feet.
 * @property {[number,number]|null} gla_range  [min, max] gross leasable area (sqft).
 * @property {number|null} ceiling_ht_min    Minimum ceiling height (ft) — no public NYC
 *                                           dataset carries this; kept for OM-stage use.
 * @property {number|null} asking_psf_max    Max asking rent $/SF — no public feed; OM-stage.
 * @property {boolean} corner_pref           Prefer corner lots (PLUTO lot type).
 * @property {boolean} divisible             Space should be divisible — OM-stage criterion.
 * @property {string[]} use_restrictions     Disallowed uses — OM-stage criterion.
 *
 * @typedef {Object} Corridor
 * @property {string} id            Stable slug, e.g. "downtown-nyc-trophy-retail".
 * @property {string} name          Display name.
 * @property {string} market        Market key ("nyc" — matches api/_markets).
 * @property {string} connector     Data connector the engine uses ("nyc" = PLUTO / ACRIS /
 *                                  storefront registry / DOB / DCWP).
 * @property {CorridorSegment[]} geometry
 * @property {string} asset_class   e.g. "retail".
 * @property {CorridorBuyBox} buy_box
 * @property {Object<string,number>} scoring_weights  Weights over the engine's fit
 *                                  components (availability_probability, corridor_tier,
 *                                  frontage_fit, gla_fit). Normalized at score time.
 * @property {Object} target_filters  Optional universe filters the connector honors
 *                                  (e.g. { borough: "Manhattan" }). Empty = connector defaults.
 */

import downtownNycTrophyRetail from "./downtown-nyc-trophy-retail.js";
import kingStreetCharleston from "./king-street-charleston.js";

const TIERS = new Set(["flagship", "luxury", "boutique"]);
const SIDES = new Set(["both", "north", "south", "east", "west"]);

// Fail fast at module load on a malformed config — a bad corridor should break the
// deploy loudly, not screen the wrong streets quietly.
function validateCorridor(c) {
  const fail = (msg) => { throw new Error(`corridor config "${(c && c.id) || "?"}": ${msg}`); };
  if (!c || typeof c !== "object") fail("not an object");
  for (const k of ["id", "name", "market", "connector", "asset_class"]) {
    if (!c[k] || typeof c[k] !== "string") fail(`missing/invalid "${k}"`);
  }
  if (!Array.isArray(c.geometry) || !c.geometry.length) fail("geometry must be a non-empty array");
  for (const g of c.geometry) {
    for (const k of ["street", "from_cross", "to_cross"]) {
      if (!g[k] || typeof g[k] !== "string") fail(`segment missing "${k}"`);
    }
    if (!SIDES.has(g.side)) fail(`segment "${g.street}": side must be one of ${[...SIDES].join("/")}`);
    if (!TIERS.has(g.tier)) fail(`segment "${g.street}": tier must be one of ${[...TIERS].join("/")}`);
  }
  if (!c.buy_box || typeof c.buy_box !== "object") fail('missing "buy_box"');
  if (!c.scoring_weights || typeof c.scoring_weights !== "object" || !Object.keys(c.scoring_weights).length) fail('missing "scoring_weights"');
  for (const [k, v] of Object.entries(c.scoring_weights)) {
    if (!Number.isFinite(v) || v < 0) fail(`scoring_weights.${k} must be a non-negative number`);
  }
  if (!c.target_filters || typeof c.target_filters !== "object") fail('missing "target_filters" (use {})');
  return c;
}

// King Street first — it's the primary focus and screens in ~3s (the NYC SoHo pass is
// slower), so it's the right default to auto-load on the Corridors page.
const CORRIDORS = [kingStreetCharleston, downtownNycTrophyRetail].map(validateCorridor);
{
  const ids = new Set();
  for (const c of CORRIDORS) {
    if (ids.has(c.id)) throw new Error(`duplicate corridor id "${c.id}"`);
    ids.add(c.id);
  }
}

export function listCorridors() {
  return CORRIDORS.map((c) => ({
    id: c.id, name: c.name, market: c.market, connector: c.connector, asset_class: c.asset_class,
    segments: c.geometry.length,
    streets: [...new Set(c.geometry.map((g) => g.street))],
  }));
}

const tokens = (s) => String(s || "").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);

// Resolve a user/agent phrase ("downtown nyc trophy retail", "soho corridor", the exact
// id) to a configured corridor. Exact id first, then name, then token overlap (the same
// Jaccard idea the CT entity ranking uses) so close-but-not-exact phrasing still lands.
export function resolveCorridor(query) {
  const q = String(query || "").trim();
  if (!q) return null;
  const qLower = q.toLowerCase();
  const exact = CORRIDORS.find((c) => c.id.toLowerCase() === qLower || c.name.toLowerCase() === qLower);
  if (exact) return exact;
  const qTok = new Set(tokens(q));
  if (!qTok.size) return null;
  let best = null, bestScore = 0;
  for (const c of CORRIDORS) {
    const cTok = new Set([...tokens(c.id), ...tokens(c.name), ...tokens(c.market)]);
    let inter = 0;
    for (const t of qTok) if (cTok.has(t)) inter++;
    const score = inter / new Set([...qTok, ...cTok]).size; // Jaccard
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore >= 0.2 ? best : null;
}
