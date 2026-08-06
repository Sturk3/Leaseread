// FRONTAGE — corridor: Flatiron / Union Square OFFICE.
// Midtown-South boutique office: Fifth Ave, Broadway, Park Ave South and the
// cross streets between 14th and 23rd — the band the firm screened by hand.
/** @type {import("./index.js").Corridor} */
export default {
  id: "flatiron-union-square-office",
  name: "Flatiron / Union Square Office",
  market: "nyc",
  connector: "nyc",
  asset_class: "office",
  geometry: [
    { street: "5 Ave",        from_cross: "14 St", to_cross: "23 St", side: "both", tier: "flagship" },
    { street: "Broadway",     from_cross: "14 St", to_cross: "23 St", side: "both", tier: "flagship" },
    { street: "Park Ave S",   from_cross: "14 St", to_cross: "23 St", side: "both", tier: "luxury" },
    { street: "6 Ave",        from_cross: "14 St", to_cross: "23 St", side: "both", tier: "luxury" },
    { street: "18 St",        from_cross: "5 Ave", to_cross: "6 Ave", side: "both", tier: "boutique" },
    { street: "20 St",        from_cross: "5 Ave", to_cross: "6 Ave", side: "both", tier: "boutique" },
  ],
  buy_box: {
    frontage_ft_min: null,
    gla_range: [30000, 80000],
    ceiling_ht_min: 11,
    asking_psf_max: null,
    corner_pref: false,
    divisible: true,
    use_restrictions: [],
  },
  scoring_weights: { availability_probability: 0.35, corridor_tier: 0.20, frontage_fit: 0.10, gla_fit: 0.35 },
  target_filters: {},
};
