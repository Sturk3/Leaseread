// FRONTAGE — corridor: Meatpacking / West Village retail.
// Cobblestone flagship blocks (14th, Washington, 9th Ave) plus the Bleecker St
// luxury stretch — smaller footprints, high rents, frequent turnover.
/** @type {import("./index.js").Corridor} */
export default {
  id: "meatpacking-west-village-retail",
  name: "Meatpacking & West Village Retail",
  market: "nyc",
  connector: "nyc",
  asset_class: "retail",
  geometry: [
    { street: "14 St",       from_cross: "9 Ave",         to_cross: "Washington St", side: "both", tier: "flagship" },
    { street: "Washington St", from_cross: "Gansevoort St", to_cross: "14 St",       side: "both", tier: "flagship" },
    { street: "9 Ave",       from_cross: "Gansevoort St",  to_cross: "16 St",        side: "both", tier: "luxury" },
    { street: "Gansevoort St", from_cross: "Hudson St",    to_cross: "Washington St", side: "both", tier: "luxury" },
    { street: "Bleecker St", from_cross: "Bank St",        to_cross: "7 Ave S",      side: "both", tier: "boutique" },
  ],
  buy_box: {
    frontage_ft_min: 15,
    gla_range: [1000, 12000],
    ceiling_ht_min: 12,
    asking_psf_max: null,
    corner_pref: true,
    divisible: true,
    use_restrictions: [],
  },
  scoring_weights: { availability_probability: 0.42, corridor_tier: 0.25, frontage_fit: 0.20, gla_fit: 0.13 },
  target_filters: {},
};
