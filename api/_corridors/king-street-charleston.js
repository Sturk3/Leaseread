// FRONTAGE — corridor: King Street, Charleston SC. The peninsula's spine, tiered the
// way the market actually reads it: Middle King (Market → Calhoun) is the prime
// national-fashion stretch; Lower King (Broad → Market) is the antiques/design
// district; Upper King (Calhoun → Spring) is the dining/entertainment corridor; the
// blocks above Spring to Line St are the emerging edge.
//
// ⚠️ buy_box numbers are placeholders, not the firm's final definitions — Charleston
// publishes no frontage/building-SF, so frontage/GLA are OM-stage there regardless.
// scoring_weights should be tuned after the first validation run.
//
// See api/_corridors/index.js for the Corridor type this must satisfy.

/** @type {import("./index.js").Corridor} */
export default {
  id: "king-street-charleston",
  name: "King Street Charleston",
  market: "charleston",
  connector: "charleston", // county parcels / city+county address points / city permits / hotel entitlements

  asset_class: "retail",

  geometry: [
    { street: "King St", from_cross: "Broad St",   to_cross: "Market St",  side: "both", tier: "luxury" },   // Lower King — antiques/design
    { street: "King St", from_cross: "Market St",  to_cross: "Calhoun St", side: "both", tier: "flagship" }, // Middle King — prime fashion retail
    { street: "King St", from_cross: "Calhoun St", to_cross: "Spring St",  side: "both", tier: "luxury" },   // Upper King — dining/entertainment
    { street: "King St", from_cross: "Spring St",  to_cross: "Line St",    side: "both", tier: "boutique" }, // upper Upper King — emerging edge
  ],

  // EDIT: placeholder numbers — replace with the firm's real buy box. frontage/GLA
  // have no public Charleston dataset, so they score neutral until the OM stage.
  buy_box: {
    frontage_ft_min: 20,
    gla_range: [1000, 12000],
    ceiling_ht_min: null,
    asking_psf_max: null,   // no public asking-rent feed — evaluated at OM stage
    corner_pref: true,      // corners ARE detected (cross-street address points)
    divisible: true,        // OM-stage criterion
    use_restrictions: [],   // OM-stage criterion
  },

  // EDIT: tune after the first run. Normalized at score time, so they need not sum to 1.
  scoring_weights: {
    availability_probability: 0.40,
    corridor_tier: 0.30,
    frontage_fit: 0.15, // corner bump only, until frontage data exists
    gla_fit: 0.15,      // neutral for now — kept so NYC/Charleston weights stay comparable
  },

  target_filters: {}, // King St is entirely City of Charleston — no filter needed
};
