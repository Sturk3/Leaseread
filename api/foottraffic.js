// FRONTAGE — foot-traffic proxy for a property (the trophy-retail QUALITY signal).
// Given the lot's lat/lon, returns:
//   • the nearest NYC DOT bi-annual pedestrian-count location + its latest count, and
//   • the nearest subway station + its lines.
// Both are geospatial nearest-neighbor lookups (no BBL join). DOT only counts ~114
// retail-corridor locations, so the pedestrian count is a bonus when the lot is near one;
// the subway proximity applies everywhere. Password-gated.

const NYC = "https://data.cityofnewyork.us/resource";
const MTA = "https://data.ny.gov/resource";
const PED = process.env.PED_COUNT_DATASET || "cqsj-cfgu";
const STATIONS = process.env.SUBWAY_STATIONS_DATASET || "39hk-dx4f";

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
// null/"" guard first: Number(null) and Number("") are 0, which turned a missing lat/lon
// into coordinates at latitude 0 instead of the 400 below.
const toNum = (v) => { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
function haversine(lat1, lon1, lat2, lon2) {
  const R = 3958.8, d = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * d / 2) ** 2 +
    Math.cos(lat1 * d) * Math.cos(lat2 * d) * Math.sin((lon2 - lon1) * d / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}
async function getJson(base, dataset, params) {
  const token = process.env.SOCRATA_APP_TOKEN;
  const r = await fetch(`${base}/${dataset}.json?${new URLSearchParams(params)}`, token ? { headers: { "X-App-Token": token } } : {});
  if (!r.ok) return [];
  return r.json().catch(() => []);
}

// Most recent pedestrian count column on a row (DOT adds a new May/Oct pair each year).
// PM is the peak walk-by interval. Try newest → older; return { count, period }.
const PED_COLS = [
  ["oct25_pm", "Oct 2025 PM"], ["may25_pm", "May 2025 PM"], ["oct24_pm", "Oct 2024 PM"],
  ["june_24_pm", "Jun 2024 PM"], ["oct_23_pm", "Oct 2023 PM"], ["may_23_p_m", "May 2023 PM"],
];
function latestPedCount(row) {
  for (const [col, period] of PED_COLS) {
    const n = toNum(row[col]);
    if (n != null && n > 0) return { count: n, period };
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, lat, lon } = req.body || {};
    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    const la = toNum(lat), lo = toNum(lon);
    if (la == null || lo == null) return res.status(400).json({ error: "Need lat/lon." });

    const pedSelect = "loc,borough,street_nam,from_stree,to_street,the_geom," + PED_COLS.map((c) => c[0]).join(",");
    const [peds, stations] = await Promise.all([
      getJson(NYC, PED, { $select: pedSelect, $limit: "500" }),
      getJson(MTA, STATIONS, { $select: "stop_name,daytime_routes,borough,gtfs_latitude,gtfs_longitude", $limit: "1000" }),
    ]);

    // Nearest pedestrian-count location (geometry is a GeoJSON Point [lon, lat]).
    let ped = null, pedDist = Infinity;
    for (const row of peds) {
      const g = row.the_geom;
      const c = g && g.coordinates;
      if (!c || c.length < 2) continue;
      const dist = haversine(la, lo, toNum(c[1]), toNum(c[0]));
      if (dist < pedDist) {
        const cnt = latestPedCount(row);
        ped = {
          on: clean(row.street_nam),
          between: [clean(row.from_stree), clean(row.to_street)].filter(Boolean).join(" & "),
          borough: clean(row.borough),
          count: cnt ? cnt.count : null, period: cnt ? cnt.period : null,
          distance_mi: Math.round(dist * 100) / 100,
        };
        pedDist = dist;
      }
    }

    // Nearest subway station.
    let subway = null, subDist = Infinity;
    for (const s of stations) {
      const slat = toNum(s.gtfs_latitude), slon = toNum(s.gtfs_longitude);
      if (slat == null || slon == null) continue;
      const dist = haversine(la, lo, slat, slon);
      if (dist < subDist) {
        subway = { station: clean(s.stop_name), routes: clean(s.daytime_routes), distance_mi: Math.round(dist * 100) / 100 };
        subDist = dist;
      }
    }

    return res.status(200).json({ ped, subway });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "foottraffic" });
  }
}
