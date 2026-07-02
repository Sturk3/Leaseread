// FRONTAGE — Connecticut search (Greenwich + any CT town), on the STATEWIDE
// PARCEL + CAMA dataset (data.ct.gov) — Connecticut's equivalent of NYC's PLUTO.
//
// Unlike the sales-only feed, CAMA gives, per parcel: OWNER of record + mailing address
// (so absentee owners surface), property address, use/zoning, assessed value, building
// square footage, frontage, year built, units, and the most recent sale (price + date +
// grantee). That's near-NYC parity for sourcing. Free, no key.

import { clean, toNum, addr, socrata } from "../_lib/util.js";

const CT_BASE = "https://data.ct.gov";
const CT_CAMA = process.env.CT_CAMA_DATASET || "rny9-6ak2"; // 2025 CT Parcel + CAMA

export const BUILD = "ct-v2-cama";

// Friendly type -> a token to LIKE-match against CAMA's state_use_description.
const USE_PATTERN = {
  any: null, commercial: "COMMERCIAL", retail: "RETAIL", office: "OFFICE",
  apartments: "APARTMENT", multifamily: "APARTMENT", industrial: "INDUSTRIAL",
  condo: "CONDOMINIUM", single_family: "SINGLE", residential: "RESIDENTIAL", vacant: "VACANT",
};

export async function search(q) {
  const { town, propertyType, sinceYear, address, minSqft, limit } = q;
  // Unified names first; the pre-consolidation CT names still work as aliases.
  const minValue = q.minValue ?? q.minPrice;
  const maxValue = q.maxValue ?? q.maxPrice;

  const townName = clean(town) || "Greenwich";
  const where = [`upper(property_city)='${townName.toUpperCase().replace(/'/g, "''")}'`];

  const typeKey = clean(propertyType).toLowerCase().replace(/[\s/-]+/g, "_");
  const pat = typeKey in USE_PATTERN ? USE_PATTERN[typeKey] : (propertyType ? clean(propertyType).toUpperCase() : null);
  if (pat) where.push(`upper(state_use_description) like '%${pat.replace(/'/g, "''")}%'`);
  if (address) where.push(`upper(location) like '%${clean(address).toUpperCase().replace(/'/g, "''")}%'`);

  // Biggest assessed value first (trophy-friendly); price/SF/year filtered in JS since
  // CAMA stores numbers as text and dates as M/D/YYYY strings.
  const rows = await socrata(CT_BASE + "/resource", CT_CAMA, {
    $where: where.join(" AND "),
    $order: "assessed_total DESC",
    $limit: 2000,
  });

  const lo = toNum(minValue), hi = toNum(maxValue), minSf = toNum(minSqft);
  const yr = toNum(sinceYear);
  const cap = Math.min(Number(limit) || 100, 500);
  const out = [];
  for (const r of rows) {
    const assessed = toNum(r.assessed_total);
    if (lo != null && (assessed == null || assessed < lo)) continue;
    if (hi != null && (assessed == null || assessed > hi)) continue;
    const sqft = toNum(r.gross_area_of_primary_building);
    if (minSf != null && (sqft == null || sqft < minSf)) continue;
    const saleYear = toNum(String(r.sale_date || "").split("/").pop());
    if (yr != null && (saleYear == null || saleYear < yr)) continue;

    const mState = clean(r.mailing_state).toUpperCase();
    const mCity = clean(r.mailing_city).toUpperCase();
    const absentee = mState && mState !== "CT" ? "out-of-state" : (mCity && mCity !== townName.toUpperCase() ? "out-of-area" : null);
    const property = clean(r.location);
    out.push({
      owner: clean(r.owner), co_owner: clean(r.co_owner),
      mailing: addr([r.mailing_address, r.mailing_city, r.mailing_state, r.mailing_zip]),
      mailing_city: clean(r.mailing_city), mailing_state: mState, absentee,
      address: property, town: clean(r.property_city) || townName,
      use: clean(r.state_use_description), zone: clean(r.zone_description) || clean(r.zone),
      assessed_value: assessed, appraised_value: toNum(r.appraised_total),
      building_sqft: sqft, land_acres: toNum(r.land_acres), frontage_ft: toNum(r.parcel_frontage),
      year_built: toNum(r.ayb), eff_year: toNum(r.eyb), stories: toNum(r.stories), units: toNum(r.number_of_units),
      living_area: toNum(r.living_area), condition: clean(r.condition_description), grade: clean(r.grade_desc),
      sale_price: toNum(r.sale_price), sale_date: clean(r.sale_date), sale_grantee: clean(r.sale_grantee_name),
      prior_sale_price: toNum(r.prior_sale_price), prior_sale_date: clean(r.prior_sale_date),
      cama_link: clean(r.cama_site_link) || null, photo: clean(r.building_photo) || null,
      maps_url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(property + ", " + townName + " CT")}`,
    });
    if (out.length >= cap) break;
  }

  return {
    market: "ct", count: out.length, town: townName,
    note: "Connecticut Parcel + CAMA assessor data (data.ct.gov) — owner of record, mailing, building SF, value, and latest sale. Owner LLCs can be unmasked with the CT entity lookup; reach the decision-maker via the AI deep dive.",
    properties: out,
  };
}
