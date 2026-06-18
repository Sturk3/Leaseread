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
const DCWP_BIZ = process.env.DCWP_BIZ_DATASET || "w7w3-xahh"; // licensed businesses (storefront occupants), has bbl + dba + phone
const C311 = "erm2-nwe9";       // 311 service requests (bbl)
const EVICT = "6z8x-wfk4";      // marshal evictions (bbl)
const RESTAURANT = "43nn-pn8j"; // restaurant inspections — food tenants (bbl, has phone)
const COFO = "bs8b-p36w";       // certificate of occupancy (bbl)
const DOB_PERMIT = "ipu4-2q9a"; // DOB permit issuance (bbl)
const STOREFRONT = process.env.STOREFRONT_DATASET || "92iy-9c3n"; // LL157 storefront registry (bbl) — vacancy + business activity + lease expiry
const HPD_REG = process.env.HPD_REG_DATASET || "tesw-yqqr";         // HPD registrations (bbl -> registrationid)
const HPD_CONTACTS = process.env.HPD_CONTACTS_DATASET || "feu5-w2e2"; // registration contacts — named officers/owners/agents

const BORO_CODE = { manhattan: "1", bronx: "2", brooklyn: "3", queens: "4", "staten island": "5" };
const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const toNum = (v) => { const n = Number(String(v ?? "").replace(/[$,]/g, "")); return Number.isFinite(n) ? n : 0; };
const sodaQuote = (vals) => [...new Set(vals)].map((v) => `'${String(v).replace(/'/g, "''")}'`).join(",");

// PLUTO owner names rarely match NY DOS entity names byte-for-byte (INC vs INC.,
// LLC vs L.L.C., comma before the suffix, &/AND, optional THE). Generate the common
// variants so the registry lookup actually hits instead of silently missing.
function entityVariants(name) {
  const base = clean(name).toUpperCase().replace(/\s+/g, " ").trim();
  if (!base) return [];
  const set = new Set([base]);
  const add = (s) => { const v = clean(s).toUpperCase(); if (v) set.add(v); };
  add(base.replace(/\b(INC|CORP|CO|LTD|LP|LLP)\b\.?/g, "$1."));     // add trailing period
  add(base.replace(/\b(INC|CORP|CO|LTD|LP|LLP)\.\b/g, "$1"));        // remove trailing period
  add(base.replace(/\bLLC\b/g, "L.L.C."));
  add(base.replace(/\bL\.L\.C\.?\b/g, "LLC"));
  add(base.replace(/&/g, "AND"));
  add(base.replace(/\bAND\b/g, "&"));
  add(base.replace(/\s+(INC|LLC|CORP|CO|LTD)\b\.?/g, ", $1."));      // comma before suffix
  if (/^THE\s+/.test(base)) add(base.replace(/^THE\s+/, "")); else add("THE " + base);
  return [...set].slice(0, 14);
}

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
    // Anonymous by default; set a free SOCRATA_APP_TOKEN env var to avoid rate limits
    // now that the dossier fans out to many datasets at once.
    const appToken = process.env.SOCRATA_APP_TOKEN || null;
    const code = /^[1-5]$/.test(String(borough)) ? String(borough) : BORO_CODE[clean(borough).toLowerCase()];
    const b = Number(block);
    const l = Number(lot);
    const haveLot = code && Number.isFinite(b) && Number.isFinite(l);

    // Match padded + unpadded block/lot (datasets differ).
    const blk = haveLot ? sodaQuote([String(b), String(b).padStart(5, "0")]) : "";
    const lt = haveLot ? sodaQuote([String(l), String(l).padStart(4, "0"), String(l).padStart(5, "0")]) : "";
    const lotWhere = (boroField) => `${boroField}='${code}' AND block in (${blk}) AND lot in (${lt})`;
    const bbl10 = haveLot ? `${code}${String(b).padStart(5, "0")}${String(l).padStart(4, "0")}` : "";

    const variants = entityVariants(name);

    const [corp, dob, ecb, hpd, biz, c311, evict, rest, cofo, permits, store, reg] = await Promise.all([
      // NY State business registry — match the owner entity across common name variants
      variants.length ? getJson(NYS, NY_CORP, {
        $limit: "1",
        $where: `upper(current_entity_name) in (${sodaQuote(variants)})`,
        $select: "dos_id,current_entity_name,entity_type,initial_dos_filing_date,dos_process_name,dos_process_address_1,dos_process_city,dos_process_state,dos_process_zip",
      }, appToken) : Promise.resolve([]),
      // DOB violations — active
      haveLot ? getJson(NYC, DOB_VIOL, { $select: "count(*)", $where: `${lotWhere("boro")} AND violation_category like '%ACTIVE%'` }, appToken) : Promise.resolve([]),
      // ECB violations — active, with outstanding balance
      haveLot ? getJson(NYC, ECB_VIOL, { $select: "balance_due", $where: `${lotWhere("boro")} AND ecb_violation_status='ACTIVE'`, $limit: "500" }, appToken) : Promise.resolve([]),
      // HPD violations — open
      haveLot ? getJson(NYC, HPD_VIOL, { $select: "count(*)", $where: `${lotWhere("boroid")} AND violationstatus='Open'` }, appToken) : Promise.resolve([]),
      // Storefront occupants — licensed businesses at this tax lot (the actual tenant/DBA)
      bbl10 ? getJson(NYC, DCWP_BIZ, {
        $where: `bbl='${bbl10}'`,
        $select: "business_name,dba_trade_name,business_category,license_status,contact_phone,license_creation_date",
        $order: "license_creation_date DESC", $limit: "40",
      }, appToken) : Promise.resolve([]),
      // 311 — recent complaint volume (last ~2 years)
      bbl10 ? getJson(NYC, C311, { $select: "count(*)", $where: `bbl='${bbl10}' AND created_date > '2024-06-01T00:00:00'` }, appToken) : Promise.resolve([]),
      // Evictions at this lot (commercial = strong turnover/distress signal)
      bbl10 ? getJson(NYC, EVICT, { $select: "executed_date,residential_commercial_ind", $where: `bbl='${bbl10}'`, $order: "executed_date DESC", $limit: "50" }, appToken) : Promise.resolve([]),
      // Food tenants — restaurant inspections give the DBA + cuisine + grade + phone
      bbl10 ? getJson(NYC, RESTAURANT, { $select: "dba,cuisine_description,grade,phone,inspection_date", $where: `bbl='${bbl10}'`, $order: "inspection_date DESC", $limit: "50" }, appToken) : Promise.resolve([]),
      // Latest certificate of occupancy
      bbl10 ? getJson(NYC, COFO, { $select: "c_o_issue_date,application_status_raw,job_type", $where: `bbl='${bbl10}' AND c_o_issue_date IS NOT NULL`, $order: "c_o_issue_date DESC", $limit: "1" }, appToken) : Promise.resolve([]),
      // DOB permit activity (count)
      bbl10 ? getJson(NYC, DOB_PERMIT, { $select: "count(*)", $where: `bbl='${bbl10}'` }, appToken) : Promise.resolve([]),
      // Storefront registry (LL157) — ground/2nd-floor commercial premises: vacancy on
      // Dec 31, the business activity, and the owner-reported most-recent lease expiry.
      bbl10 ? getJson(NYC, STOREFRONT, {
        $where: `bbl='${bbl10}'`,
        $select: "reporting_year,vacant_on_12_31,primary_business_activity,expir_dt_of_most_recent_lease",
        $order: "reporting_year DESC", $limit: "30",
      }, appToken) : Promise.resolve([]),
      // HPD registration for this lot (bbl -> registrationid); officer names come from the
      // Registration Contacts join below. Only residential / mixed-use buildings register.
      haveLot ? getJson(NYC, HPD_REG, { $select: "registrationid,lastregistrationdate", $where: lotWhere("boroid"), $order: "lastregistrationdate DESC", $limit: "5" }, appToken) : Promise.resolve([]),
    ]);

    const c = corp[0];
    const ny_corp = c ? {
      dos_id: clean(c.dos_id),
      name: clean(c.current_entity_name),
      entity_type: clean(c.entity_type),
      filed: clean(c.initial_dos_filing_date).slice(0, 10),
      process_name: clean(c.dos_process_name),
      process_address: clean(`${c.dos_process_address_1 || ""}, ${c.dos_process_city || ""} ${c.dos_process_state || ""} ${c.dos_process_zip || ""}`).replace(/^,\s*/, ""),
    } : null;

    const ecb_balance = ecb.reduce((s, r) => s + Math.max(0, toNum(r.balance_due)), 0);

    // Storefront occupants — licensed businesses (DCWP) + food tenants (restaurant
    // inspections). Dedupe by name, active first, keep the top few.
    const fromDcwp = (biz || []).map((x) => ({
      name: clean(x.dba_trade_name) || clean(x.business_name),
      category: clean(x.business_category),
      status: clean(x.license_status),
      phone: clean(x.contact_phone),
    }));
    const fromFood = (rest || []).map((x) => ({
      name: clean(x.dba),
      category: [clean(x.cuisine_description), clean(x.grade) ? `grade ${clean(x.grade)}` : ""].filter(Boolean).join(" · "),
      status: "Active",
      phone: clean(x.phone),
    }));
    const seenBiz = new Set();
    const businesses = [...fromDcwp, ...fromFood]
      .filter((x) => {
        if (!x.name) return false;
        const k = x.name.toUpperCase();
        if (seenBiz.has(k)) return false;
        seenBiz.add(k);
        return true;
      })
      .sort((a, b) => (a.status === "Active" ? 0 : 1) - (b.status === "Active" ? 0 : 1))
      .slice(0, 10);

    const evictions = {
      count: (evict || []).length,
      latest: evict && evict[0] ? clean(evict[0].executed_date).slice(0, 10) : "",
      commercial: (evict || []).some((e) => /comm/i.test(clean(e.residential_commercial_ind))),
    };
    const co = cofo && cofo[0] ? { date: clean(cofo[0].c_o_issue_date).slice(0, 10), status: clean(cofo[0].application_status_raw) } : null;

    // Storefront registry — keep the most recent reporting year's filings for this lot
    // (a lot can have several ground-floor units). Surface vacancy + activity + lease end.
    let storefront = null;
    if (store && store.length) {
      const latestYear = store.reduce((y, r) => Math.max(y, toNum(r.reporting_year)), 0);
      const latest = store.filter((r) => toNum(r.reporting_year) === latestYear);
      const isVacant = (r) => /^y/i.test(clean(r.vacant_on_12_31));
      const units = latest.map((r) => ({
        vacant: isVacant(r),
        activity: clean(r.primary_business_activity),
        lease_expiry: clean(r.expir_dt_of_most_recent_lease).slice(0, 10),
      }));
      storefront = {
        reporting_year: String(latestYear),
        count: units.length,
        any_vacant: units.some((u) => u.vacant),
        units,
      };
    }

    // HPD registration CONTACTS — the named officers/owners/agents behind the building's
    // HPD registration. A real source of the PEOPLE behind the entity (head officer,
    // owner, managing agent), when the building is registered (residential / mixed-use;
    // pure-commercial lots usually aren't). Join the registrationid(s) -> contacts.
    let officers = [];
    if (reg && reg.length) {
      const regIds = [...new Set(reg.map((x) => clean(x.registrationid)).filter(Boolean))];
      if (regIds.length) {
        const contacts = await getJson(NYC, HPD_CONTACTS, {
          $where: `registrationid in (${sodaQuote(regIds)})`,
          $select: "type,firstname,lastname,corporationname,businesshousenumber,businessstreetname,businesscity,businessstate,businesszip",
          $limit: "100",
        }, appToken).catch(() => []);
        const ROLE = { HeadOfficer: "Head officer", Officer: "Officer", IndividualOwner: "Individual owner", JointOwner: "Joint owner", Agent: "Managing agent", Shareholder: "Shareholder", SiteManager: "Site manager", CorporateOwner: "Corporate owner", Lessee: "Lessee" };
        const seen = new Set();
        for (const x of contacts) {
          const person = [clean(x.firstname), clean(x.lastname)].filter(Boolean).join(" ");
          const name = person || clean(x.corporationname);
          if (!name) continue;
          const role = ROLE[clean(x.type)] || clean(x.type) || "Contact";
          const key = `${name}|${role}`.toUpperCase();
          if (seen.has(key)) continue;
          seen.add(key);
          const addr = clean(`${clean(x.businesshousenumber)} ${clean(x.businessstreetname)}`);
          const tail = [clean(x.businesscity), clean(x.businessstate), clean(x.businesszip)].filter(Boolean).join(" ");
          officers.push({ role, name, isPerson: !!person, address: [addr, tail].filter(Boolean).join(", ") });
        }
        const rank = (o) => (/head/i.test(o.role) ? 0 : /owner/i.test(o.role) ? 1 : o.role === "Officer" ? 2 : /agent/i.test(o.role) ? 3 : o.isPerson ? 4 : 6);
        officers.sort((a, b) => rank(a) - rank(b));
        officers = officers.slice(0, 12);
      }
    }

    return res.status(200).json({
      ny_corp,
      officers,
      businesses,
      storefront,
      dob_violations: toNum(dob[0] && dob[0].count),
      ecb_violations: ecb.length,
      ecb_balance_due: Math.round(ecb_balance),
      hpd_violations: toNum(hpd[0] && hpd[0].count),
      complaints_311: toNum(c311[0] && c311[0].count),
      evictions,
      cofo: co,
      dob_permits: toNum(permits[0] && permits[0].count),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "intel" });
  }
}
