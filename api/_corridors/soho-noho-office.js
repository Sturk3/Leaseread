// FRONTAGE — corridor: SoHo / NoHo boutique OFFICE.
// The loft-office spine the firm's 30–80K SF searches keep landing on: Broadway,
// Lafayette, Mercer, Greene, Crosby between Houston and Canal.
/** @type {import("./index.js").Corridor} */
export default {
  id: "soho-noho-office",
  name: "SoHo / NoHo Boutique Office",
  market: "nyc",
  connector: "nyc",
  asset_class: "office",
  geometry: [
    { street: "Broadway",    from_cross: "Houston St", to_cross: "Canal St",  side: "both", tier: "flagship" },
    { street: "Lafayette St", from_cross: "Astor Pl",  to_cross: "Canal St",  side: "both", tier: "luxury" },
    { street: "Mercer St",   from_cross: "Houston St", to_cross: "Canal St",  side: "both", tier: "luxury" },
    { street: "Greene St",   from_cross: "Houston St", to_cross: "Canal St",  side: "both", tier: "boutique" },
    { street: "Crosby St",   from_cross: "Houston St", to_cross: "Canal St",  side: "both", tier: "boutique" },
  ],
  buy_box: {
    frontage_ft_min: null,
    gla_range: [20000, 90000],
    ceiling_ht_min: 11,
    asking_psf_max: null,
    corner_pref: false,
    divisible: true,
    use_restrictions: [],
  },
  scoring_weights: { availability_probability: 0.35, corridor_tier: 0.25, frontage_fit: 0.10, gla_fit: 0.30 },
  target_filters: {},
};
