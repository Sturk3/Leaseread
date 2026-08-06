// FRONTAGE — corridor: NoMad / Midtown South OFFICE (23rd–34th).
// The boutique / value-add office belt above Flatiron: Broadway, Fifth, Madison,
// Park Ave South and the loft blocks off Sixth.

/** @type {import("./index.js").Corridor} */
export default {
  id: "nomad-midtown-south-office",
  name: "NoMad / Midtown South Office",
  market: "nyc",
  connector: "nyc",
  asset_class: "office",

  geometry: [
    { street: "5 Ave", from_cross: "23 St", to_cross: "34 St", side: "both", tier: "flagship" },
    { street: "Broadway", from_cross: "23 St", to_cross: "34 St", side: "both", tier: "luxury" },
    { street: "Madison Ave", from_cross: "23 St", to_cross: "34 St", side: "both", tier: "luxury" },
    { street: "Park Ave S", from_cross: "23 St", to_cross: "32 St", side: "both", tier: "luxury" },
    { street: "6 Ave", from_cross: "23 St", to_cross: "34 St", side: "both", tier: "boutique" },
  ],

  buy_box: {
    frontage_ft_min: null,
    gla_range: [25000, 120000],
    ceiling_ht_min: 11,
    asking_psf_max: null,
    corner_pref: false,
    divisible: true,
    use_restrictions: [],
  },

  scoring_weights: { availability_probability: 0.35, corridor_tier: 0.20, frontage_fit: 0.10, gla_fit: 0.35 },
  target_filters: {},
};
