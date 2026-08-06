// FRONTAGE — corridor: Plaza District / Midtown East OFFICE.
// Manhattan's trophy office core — Park, Madison, Fifth and 57th St between 45th and
// 60th. Institutional ownership dominates; screen for the rare boutique building and
// for entity / control changes.

/** @type {import("./index.js").Corridor} */
export default {
  id: "plaza-district-office",
  name: "Plaza District / Midtown East Office",
  market: "nyc",
  connector: "nyc",
  asset_class: "office",

  geometry: [
    { street: "Park Ave", from_cross: "45 St", to_cross: "59 St", side: "both", tier: "flagship" },
    { street: "Madison Ave", from_cross: "45 St", to_cross: "59 St", side: "both", tier: "flagship" },
    { street: "5 Ave", from_cross: "49 St", to_cross: "59 St", side: "both", tier: "flagship" },
    { street: "57 St", from_cross: "Park Ave", to_cross: "6 Ave", side: "both", tier: "luxury" },
    { street: "Lexington Ave", from_cross: "45 St", to_cross: "57 St", side: "both", tier: "luxury" },
  ],

  buy_box: {
    frontage_ft_min: null,
    gla_range: [40000, 400000],
    ceiling_ht_min: 12,
    asking_psf_max: null,
    corner_pref: false,
    divisible: true,
    use_restrictions: [],
  },

  scoring_weights: { availability_probability: 0.35, corridor_tier: 0.30, frontage_fit: 0.05, gla_fit: 0.30 },
  target_filters: {},
};
