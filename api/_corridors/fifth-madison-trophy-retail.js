// FRONTAGE — corridor: Fifth & Madison trophy retail (uptown flagship).
// The other half of Manhattan trophy retail from SoHo: the Fifth Ave flagship blocks
// and the Madison Ave luxury stretch, plus 57th St's flagship corner.
/** @type {import("./index.js").Corridor} */
export default {
  id: "fifth-madison-trophy-retail",
  name: "Fifth & Madison Trophy Retail",
  market: "nyc",
  connector: "nyc",
  asset_class: "retail",
  geometry: [
    { street: "5 Ave",     from_cross: "49 St", to_cross: "60 St", side: "both", tier: "flagship" },
    { street: "Madison Ave", from_cross: "57 St", to_cross: "72 St", side: "both", tier: "luxury" },
    { street: "57 St",     from_cross: "5 Ave",  to_cross: "Park Ave", side: "both", tier: "flagship" },
    { street: "Madison Ave", from_cross: "72 St", to_cross: "79 St", side: "both", tier: "boutique" },
  ],
  buy_box: {
    frontage_ft_min: 20,
    gla_range: [2000, 25000],
    ceiling_ht_min: 14,
    asking_psf_max: null,
    corner_pref: true,
    divisible: false,
    use_restrictions: [],
  },
  scoring_weights: { availability_probability: 0.40, corridor_tier: 0.30, frontage_fit: 0.18, gla_fit: 0.12 },
  target_filters: {},
};
