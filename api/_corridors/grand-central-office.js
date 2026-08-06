// FRONTAGE — corridor: Grand Central / Terminal City OFFICE.
// The 42nd St spine and its Vanderbilt / Lexington / Third flanks — the deepest office
// inventory in the city, including older stock ripe for repositioning.

/** @type {import("./index.js").Corridor} */
export default {
  id: "grand-central-office",
  name: "Grand Central / Terminal City Office",
  market: "nyc",
  connector: "nyc",
  asset_class: "office",

  geometry: [
    { street: "42 St", from_cross: "5 Ave", to_cross: "3 Ave", side: "both", tier: "flagship" },
    { street: "Vanderbilt Ave", from_cross: "42 St", to_cross: "47 St", side: "both", tier: "flagship" },
    { street: "Lexington Ave", from_cross: "40 St", to_cross: "48 St", side: "both", tier: "luxury" },
    { street: "3 Ave", from_cross: "40 St", to_cross: "50 St", side: "both", tier: "luxury" },
    { street: "Madison Ave", from_cross: "40 St", to_cross: "45 St", side: "both", tier: "boutique" },
  ],

  buy_box: {
    frontage_ft_min: null,
    gla_range: [40000, 400000],
    ceiling_ht_min: 11,
    asking_psf_max: null,
    corner_pref: false,
    divisible: true,
    use_restrictions: [],
  },

  scoring_weights: { availability_probability: 0.38, corridor_tier: 0.22, frontage_fit: 0.05, gla_fit: 0.35 },
  target_filters: {},
};
