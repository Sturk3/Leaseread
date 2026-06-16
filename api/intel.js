// Vercel serverless backend for FRONTAGE — consolidated public-records "intel".
// One call pulls, in parallel: NY State business registry (for LLC owners),
// DOB violations, ECB violations + outstanding penalties, and HPD violations —
// for a single property (borough/block/lot) + owner name. Loaded on demand when
// a property's details panel opens. Password-gated.

const NYC = "https://data.cityofnewyork.us/resource";
const NYS = "https://data.ny.gov/resource";
const DOB_VIOL = process.env.DOB_VIOL_DATASET || "3h2n-5cm9";
const ECB_VIOL = process.env.ECB_VIOL_DATASET || "6bgk-3dad";
const HPD_VIOL = process.env.HPD_VIOL_DATASET || "wvxf-dwi5";
const NY_CORP = process.env.NY_CORP_DATASET || "n9v6-gdp6";

const BORO_CODE = { manhattan: "1", bronx: "2", brooklyn: "3", queens: "4", "staten island": "5" };
const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const toNum = (v) => { const n = Number(String(v ?? "").replace(/[$,]/g, "")); return Number.isFinite(n) ? n : 0; };
const sodaQuote = (vals) => [...new Set(vals)].map((v) => `'${String(v).replace(/'/g, "''")}'`).join(",");

async function getJson(base, dataset, params, appToken) {
  const qs = new URLSearchParams(params).toString();
  const headers = appToken ? { "X-App-Token": appToken } : {};
  const r = await fetch(`${base}/${dataset}.json?${qs}`, { headers });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, borough, block, lot, name } = req.body || {};
    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    const appToken = process.env.SOCRATA_APP_TOKEN;
    const code = /^[1-5]$/.test(String(borough)) ? String(borough) : BORO_CODE[clean(borough).toLowerCase()];
    const b = Number(block);
    const l = Number(lot);
    const haveLot = code && Number.isFinite(b) && Number.isFinite(l);

    // Match padded + unpadded block/lot (datasets differ).
    const blk = haveLot ? sodaQuote([String(b), String(b).padStart(5, "0")]) : "";
    const lt = haveLot ? sodaQuote([String(l), String(l).padStart(4, "0"), String(l).padStart(5, "0")]) : "";
    const lotWhere = (boroField) => `${boroField}='${code}' AND block in (${blk}) AND lot in (${lt})`;

    const nm = clean(name).toUpperCase().replace(/'/g, "''");

    const [corp, dob, ecb, hpd] = await Promise.all([
      // NY State business registry — exact entity name (only meaningful for LLCs/corps)
      nm ? getJson(NYS, NY_CORP, {
        $limit: "1",
        $where: `upper(current_entity_name)='${nm}'`,
        $select: "current_entity_name,entity_type,initial_dos_filing_date,dos_process_name,dos_process_address_1,dos_process_city,dos_process_state,dos_process_zip",
      }, appToken) : Promise.resolve([]),
      // DOB violations — active
      haveLot ? getJson(NYC, DOB_VIOL, { $select: "count(*)", $where: `${lotWhere("boro")} AND violation_category like '%ACTIVE%'` }, appToken) : Promise.resolve([]),
      // ECB violations — active, with outstanding balance
      haveLot ? getJson(NYC, ECB_VIOL, { $select: "balance_due", $where: `${lotWhere("boro")} AND ecb_violation_status='ACTIVE'`, $limit: "500" }, appToken) : Promise.resolve([]),
      // HPD violations — open
      haveLot ? getJson(NYC, HPD_VIOL, { $select: "count(*)", $where: `${lotWhere("boroid")} AND violationstatus='Open'` }, appToken) : Promise.resolve([]),
    ]);

    const c = corp[0];
    const ny_corp = c ? {
      name: clean(c.current_entity_name),
      entity_type: clean(c.entity_type),
      filed: clean(c.initial_dos_filing_date).slice(0, 10),
      process_name: clean(c.dos_process_name),
      process_address: clean(`${c.dos_process_address_1 || ""}, ${c.dos_process_city || ""} ${c.dos_process_state || ""} ${c.dos_process_zip || ""}`).replace(/^,\s*/, ""),
    } : null;

    const ecb_balance = ecb.reduce((s, r) => s + Math.max(0, toNum(r.balance_due)), 0);

    return res.status(200).json({
      ny_corp,
      dob_violations: toNum(dob[0] && dob[0].count),
      ecb_violations: ecb.length,
      ecb_balance_due: Math.round(ecb_balance),
      hpd_violations: toNum(hpd[0] && hpd[0].count),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "intel" });
  }
}
