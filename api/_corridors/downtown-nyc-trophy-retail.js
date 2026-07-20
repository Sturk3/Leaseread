// FRONTAGE — seed corridor: Downtown NYC trophy retail (SoHo prime draft).
//
// ⚠️ EDIT BEFORE PRODUCTION USE: geometry (confirm/extend the SoHo-prime streets) and
// buy_box (the numbers below are placeholders, not the firm's final definitions).
// scoring_weights should be tuned after the first validation run.
//
// See api/_corridors/index.js for the Corridor type this must satisfy.

/** @type {import("./index.js").Corridor} */
export default {
  id: "downtown-nyc-trophy-retail",
  name: "Downtown NYC Trophy Retail",
  market: "nyc",
  connector: "nyc", // PLUTO / ACRIS / storefront registry / DOB / DCWP

  asset_class: "retail",

  // EDIT: SoHo-prime draft streets — confirm/extend.
  geometry: [
    { street: "Broadway",      from_cross: "Houston St", to_cross: "Canal St", side: "both", tier: "flagship" },
    { street: "Prince St",     from_cross: "Broadway",   to_cross: "6th Ave",  side: "both", tier: "luxury" },
    { street: "Spring St",     from_cross: "Broadway",   to_cross: "6th Ave",  side: "both", tier: "luxury" },
    { street: "West Broadway", from_cross: "Houston St", to_cross: "Canal St", side: "both", tier: "luxury" },
    { street: "Greene St",     from_cross: "Houston St", to_cross: "Canal St", side: "both", tier: "luxury" },
    { street: "Wooster St",    from_cross: "Houston St", to_cross: "Canal St", side: "both", tier: "boutique" },
    { street: "Mercer St",     from_cross: "Houston St", to_cross: "Canal St", side: "both", tier: "boutique" },
  ],

  // EDIT: placeholder numbers — replace with the firm's real buy box.
  buy_box: {
    frontage_ft_min: 20,
    gla_range: [1500, 15000],
    ceiling_ht_min: 12,     // not in any public NYC dataset — evaluated at OM stage
    asking_psf_max: null,   // no public asking-rent feed — evaluated at OM stage
    corner_pref: true,
    divisible: true,        // OM-stage criterion
    use_restrictions: [],   // OM-stage criterion
  },

  // EDIT: tune after the first run. Normalized at score time, so they need not sum to 1.
  scoring_weights: {
    availability_probability: 0.40,
    corridor_tier: 0.25,
    frontage_fit: 0.20,
    gla_fit: 0.15,
  },

  target_filters: {}, // connector defaults (NYC connector assumes Manhattan when unset)
};
