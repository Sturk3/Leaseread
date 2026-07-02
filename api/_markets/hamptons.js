// FRONTAGE — Hamptons / NY-State (ex-NYC) search.
//
// The Hamptons (Suffolk County: East Hampton, Southampton, Shelter Island) are in NY
// State but OUTSIDE NYC, so ACRIS/PLUTO don't reach them. Source instead from NY State's
// statewide assessment roll (data.ny.gov 7vem-aaz7) — owner of record + mailing, property
// address, property class, frontage, assessment, and market value (where the town reports
// it). Defaults to the three Hamptons towns; any NY municipality works via `town`.
//
// CAVEAT carried to the UI: NY towns assess at very different ratios and many leave
// full_market_value blank, so assessment_total is NOT a clean dollar value across towns —
// owner/address/class are the reliable fields.

import { clean, socrata } from "../_lib/util.js";

const NY_BASE = "https://data.ny.gov";
const NY_ROLL = process.env.NY_ROLL_DATASET || "7vem-aaz7";

const HAMPTONS_TOWNS = ["East Hampton", "Southampton", "Shelter Island"];

export const BUILD = "hamptons-v1";

// NY assessment rolls report 0 for "not assessed / unknown" — treat that as null.
const toNum = (v) => { if (v == null || v === "") return null; const n = Number(String(v).replace(/[$,]/g, "")); return Number.isFinite(n) && n !== 0 ? n : null; };
// Roll address parts join with plain spaces ("123 MAIN ST"), unlike mailing blocks.
const joinParts = (parts) => parts.map(clean).filter(Boolean).join(" ");

// Friendly type -> NY property-class code range (first digit: 2=residential, 3=vacant,
// 4=commercial[incl retail/office/apartments], 7=industrial).
const CLASS_RANGE = {
  any: null, commercial: ["400", "499"], retail: ["400", "499"], office: ["400", "499"],
  apartments: ["400", "499"], residential: ["200", "299"], single_family: ["200", "299"],
  vacant: ["300", "399"], industrial: ["700", "799"],
};

export async function search(q) {
  const { town, propertyType, minValue, maxValue, address, limit } = q;

  const where = ["roll_section='1'"]; // taxable parcels
  const t = clean(town);
  if (t && t.toLowerCase() !== "all" && t.toLowerCase() !== "all hamptons") {
    where.push(`upper(municipality_name)='${t.toUpperCase().replace(/'/g, "''")}'`);
  } else {
    where.push(`municipality_name in (${HAMPTONS_TOWNS.map((x) => `'${x}'`).join(",")})`);
  }

  const typeKey = clean(propertyType).toLowerCase().replace(/[\s/-]+/g, "_");
  const rng = typeKey in CLASS_RANGE ? CLASS_RANGE[typeKey] : (propertyType ? null : CLASS_RANGE.commercial);
  if (rng) where.push(`property_class between '${rng[0]}' and '${rng[1]}'`);
  if (address) where.push(`upper(parcel_address_street) like '%${clean(address).toUpperCase().replace(/'/g, "''")}%'`);

  const rows = await socrata(NY_BASE + "/resource", NY_ROLL, {
    $where: where.join(" AND "),
    $order: "assessment_total DESC",
    $limit: 2000,
  });

  const lo = toNum(minValue), hi = toNum(maxValue);
  const cap = Math.min(Number(limit) || 100, 500);
  const out = [];
  for (const r of rows) {
    const assessed = toNum(r.assessment_total);
    if (lo != null && (assessed == null || assessed < lo)) continue;
    if (hi != null && (assessed == null || assessed > hi)) continue;

    const owner = joinParts([r.primary_owner_first_name, r.primary_owner_last_name]) || clean(r.primary_owner_last_name);
    const property = joinParts([r.parcel_address_number, r.parcel_address_street, r.parcel_address_suff]);
    const mailing = joinParts([r.mailing_address_number, r.mailing_address_street, r.mailing_address_suff, r.mailing_address_city, r.mailing_address_state, r.mailing_address_zip]);
    const mState = clean(r.mailing_address_state).toUpperCase();
    const mCity = clean(r.mailing_address_city).toUpperCase();
    const town2 = clean(r.municipality_name);
    const absentee = mState && mState !== "NY" ? "out-of-state" : (mCity && !mCity.includes(town2.toUpperCase()) ? "out-of-area" : null);

    out.push({
      owner, co_owner: joinParts([r.additional_owner_1_first, r.additional_owner_1_last_name]),
      mailing, mailing_city: clean(r.mailing_address_city), mailing_state: mState, absentee,
      address: property, town: town2, county: clean(r.county_name),
      use: clean(r.property_class_description), property_class: clean(r.property_class),
      assessed_value: assessed, market_value: toNum(r.full_market_value),
      frontage_ft: toNum(r.front), depth_ft: toNum(r.depth), school_district: clean(r.school_district_name),
      maps_url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(property + ", " + town2 + " NY")}`,
    });
    if (out.length >= cap) break;
  }

  return {
    market: "hamptons", count: out.length, town: t || "Hamptons",
    note: "NY State assessment roll (data.ny.gov) — owner of record, mailing, property class, assessment. NOTE: NY town assessed values use varying ratios and market value is often blank, so treat $ figures as rough; owner/address/class are reliable. Unmask LLCs / find contacts via the AI deep dive.",
    properties: out,
  };
}
