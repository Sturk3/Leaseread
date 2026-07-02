// FRONTAGE — shared helpers for the market search modules (api/_markets/*).
// Underscore-prefixed folders inside api/ are NOT deployed as serverless
// functions by Vercel, so this is plain shared code, not an endpoint.

export const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
export const toNum = (v) => { if (v == null || v === "") return null; const n = Number(String(v).replace(/[$,]/g, "")); return Number.isFinite(n) ? n : null; };
export const addr = (parts) => parts.map(clean).filter(Boolean).join(", ");
export const sqlStr = (s) => clean(s).toUpperCase().replace(/'/g, "''");
export const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

// Socrata (data.*.gov) fetch used by the state open-data markets: params object in,
// array of rows out, and any failure just yields [] (a dead dataset = no results).
export async function socrata(base, dataset, params) {
  const token = process.env.SOCRATA_APP_TOKEN;
  const r = await fetch(`${base}/${dataset}.json?${new URLSearchParams(params)}`, token ? { headers: { "X-App-Token": token } } : {});
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
