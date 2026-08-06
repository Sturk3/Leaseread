// FRONTAGE — corridor: Chelsea / Penn District OFFICE.
// West-side office: the Sixth / Seventh / Eighth Ave blocks through Chelsea up into the
// Penn District, plus the West Chelsea loft stock near the High Line.

/** @type {import("./index.js").Corridor} */
export default {
  id: "chelsea-penn-office",
  name: "Chelsea / Penn District Office",
  market: "nyc",
  connector: "nyc",
  asset_class: "office",

  geometry: [
    { street: "7 Ave", from_cross: "23 St", to_cross: "34 St", side: "both", tier: "flagship" },
    { street: "8 Ave", from_cross: "23 St", to_cross: "34 St", side: "both", tier: "luxury" },
    { street: "6 Ave", from_cross: "14 St", to_cross: "23 St", side: "both", tier: "luxury" },
    { street: "10 Ave", from_cross: "14 St", to_cross: "23 St", side: "both", tier: "boutique" },
    { street: "11 Ave", from_cross: "14 St", to_cross: "26 St", side: "both", tier: "boutique" },
  ],

  buy_box: {
    frontage_ft_min: null,
    gla_range: [20000, 200000],
    ceiling_ht_min: 11,
    asking_psf_max: null,
    corner_pref: false,
    divisible: true,
    use_restrictions: [],
  },

  scoring_weights: { availability_probability: 0.38, corridor_tier: 0.18, frontage_fit: 0.07, gla_fit: 0.37 },
  target_filters: {},
};
