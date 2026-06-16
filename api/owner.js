// Vercel serverless backend for FRONTAGE — citywide owner portfolio.
// Given an exact owner name, returns every NYC property under that name in PLUTO.
// Loaded on demand when a row's "▸ portfolio" is expanded. Password-gated.
// Note: NYC owners often use a separate LLC per building, so single-LLC owners
// return just their own lot(s); reused names (people, mgmt cos, REITs) return the
// whole portfolio.

const SOCRATA_BASE = "https://data.cityofnewyork.us/resource";
const PLUTO = process.env.PLUTO_DATASET || "64uk-42ks";
const PLUTO_BOROUGH_NAME = { MN: "Manhattan", BX: "Bronx", BK: "Brooklyn", QN: "Queens", SI: "Staten Island" };

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const toNum = (v) => {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[$,]/g, "").trim());
  return Number.isFinite(n) ? n : null;
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, name } = req.body || {};
    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    const nm = clean(name).toUpperCase();
    if (!nm) return res.status(400).json({ error: "Need an owner name." });

    const appToken = null; // NYC account/token disconnected — anonymous requests only
    const params = new URLSearchParams({
      $limit: "500",
      $where: `upper(ownername)='${nm.replace(/'/g, "''")}'`,
      $select: "address,borough,bldgclass,assesstot,block,lot,latitude,longitude",
      $order: "assesstot DESC",
    });
    const headers = appToken ? { "X-App-Token": appToken } : {};
    const r = await fetch(`${SOCRATA_BASE}/${PLUTO}.json?${params.toString()}`, { headers });
    if (!r.ok) throw new Error(`PLUTO ${r.status}`);
    const rows = await r.json();

    let total = 0;
    const properties = rows.map((row) => {
      const assessed = toNum(row.assesstot);
      if (assessed) total += assessed;
      return {
        address: clean(row.address),
        borough: PLUTO_BOROUGH_NAME[clean(row.borough)] || clean(row.borough),
        bldgclass: clean(row.bldgclass),
        assessed,
        block: clean(row.block),
        lot: clean(row.lot),
        lat: toNum(row.latitude),
        lon: toNum(row.longitude),
      };
    });

    return res.status(200).json({ count: properties.length, total_assessed: total, properties });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "owner" });
  }
}
