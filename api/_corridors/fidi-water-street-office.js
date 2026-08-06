// FRONTAGE — corridor: Financial District OFFICE.
// Downtown's office core — Broadway, Water, Wall, Broad and Maiden Lane. Older stock
// with the city's highest office-to-residential conversion activity, so vacancy and
// permit signals here often mean a repositioning play rather than a leasing one.

/** @type {import("./index.js").Corridor} */
export default {
  id: "fidi-water-street-office",
  name: "Financial District Office",
  market: "nyc",
  connector: "nyc",
  asset_class: "office",

  geometry: [
    { street: "Broadway", from_cross: "Battery Pl", to_cross: "Chambers St", side: "both", tier: "flagship" },
    { street: "Water St", from_cross: "Whitehall St", to_cross: "Fulton St", side: "both", tier: "luxury" },
    { street: "Wall St", from_cross: "Broadway", to_cross: "Water St", side: "both", tier: "flagship" },
    { street: "Broad St", from_cross: "Wall St", to_cross: "Water St", side: "both", tier: "luxury" },
    { street: "Maiden Ln", from_cross: "Broadway", to_cross: "Water St", side: "both", tier: "boutique" },
  ],

  buy_box: {
    frontage_ft_min: null,
    gla_range: [30000, 400000],
    ceiling_ht_min: 10,
    asking_psf_max: null,
    corner_pref: false,
    divisible: true,
    use_restrictions: [],
  },

  scoring_weights: { availability_probability: 0.42, corridor_tier: 0.18, frontage_fit: 0.05, gla_fit: 0.35 },
  target_filters: {},
};
