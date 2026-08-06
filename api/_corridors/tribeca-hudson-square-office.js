// FRONTAGE — corridor: Tribeca / Hudson Square OFFICE.
// Loft-office and creative-tenant stock west of SoHo: Hudson, Varick, Greenwich,
// Canal and West Broadway between Chambers and Houston.

/** @type {import("./index.js").Corridor} */
export default {
  id: "tribeca-hudson-square-office",
  name: "Tribeca / Hudson Square Office",
  market: "nyc",
  connector: "nyc",
  asset_class: "office",

  geometry: [
    { street: "Hudson St", from_cross: "Canal St", to_cross: "Houston St", side: "both", tier: "flagship" },
    { street: "Varick St", from_cross: "Canal St", to_cross: "Houston St", side: "both", tier: "luxury" },
    { street: "Greenwich St", from_cross: "Chambers St", to_cross: "Canal St", side: "both", tier: "luxury" },
    { street: "West Broadway", from_cross: "Chambers St", to_cross: "Canal St", side: "both", tier: "boutique" },
    { street: "Canal St", from_cross: "6 Ave", to_cross: "West St", side: "both", tier: "boutique" },
  ],

  buy_box: {
    frontage_ft_min: null,
    gla_range: [20000, 150000],
    ceiling_ht_min: 11,
    asking_psf_max: null,
    corner_pref: false,
    divisible: true,
    use_restrictions: [],
  },

  scoring_weights: { availability_probability: 0.38, corridor_tier: 0.20, frontage_fit: 0.07, gla_fit: 0.35 },
  target_filters: {},
};
