// FRONTAGE — market-agnostic corridor segment geometry, shared by the
// RetailAvailability connectors (NYC lots, Charleston address points, whatever
// comes next). No centerline dataset is needed: each cross street's own point
// cloud locates the intersection. The corner is estimated as the main-street
// point closest to the cross street's cloud; main-street points are then kept
// if they project between the two corners (with a ~100 ft overshoot buffer so
// the corner points themselves survive).

const R_LAT = 69; // miles per degree latitude

function xy(lat, lon, lat0) { return { x: lon * Math.cos((lat0 * Math.PI) / 180) * R_LAT, y: lat * R_LAT }; }

function nearestMainToCross(mainPts, crossPts) {
  let best = null, bestD = Infinity;
  for (const m of mainPts) {
    for (const c of crossPts) {
      const d = (m.x - c.x) ** 2 + (m.y - c.y) ** 2;
      if (d < bestD) { bestD = d; best = m; }
    }
  }
  return best;
}

/**
 * Clip a main-street point cloud to the stretch between two cross streets.
 * Every point is { lat, lon, ref } — ref is whatever the caller wants back
 * (a PLUTO row, an address point, …). Returns { kept: ref[], note } where a
 * non-null note explains why the segment could NOT be clipped (the whole
 * street is kept in that case, so a bad cross-street name degrades loudly
 * in coverage instead of silently emptying the screen).
 */
export function clipToSegment(main, crossA, crossB) {
  if (!main.length) return { kept: [], note: null };
  const lat0 = main.reduce((s, p) => s + p.lat, 0) / main.length; // mean = order-independent
  const mainXY = main.map((p) => ({ ...xy(p.lat, p.lon, lat0), ref: p.ref }));
  const aXY = crossA.map((p) => xy(p.lat, p.lon, lat0));
  const bXY = crossB.map((p) => xy(p.lat, p.lon, lat0));
  if (!aXY.length || !bXY.length) {
    return { kept: mainXY.map((m) => m.ref), note: `cross street unresolved (${!aXY.length ? "from_cross" : "to_cross"} has no mapped points) — segment NOT clipped, whole street kept` };
  }
  const A = nearestMainToCross(mainXY, aXY);
  const B = nearestMainToCross(mainXY, bXY);
  const dx = B.x - A.x, dy = B.y - A.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-8) {
    return { kept: mainXY.map((m) => m.ref), note: "cross streets resolve to the same point — segment NOT clipped, whole street kept" };
  }
  const buf = 0.02 / Math.sqrt(len2); // ~100 ft overshoot each end, as a t-fraction
  const kept = mainXY
    .filter((m) => { const t = ((m.x - A.x) * dx + (m.y - A.y) * dy) / len2; return t >= -buf && t <= 1 + buf; })
    .map((m) => m.ref);
  return { kept, note: null };
}
