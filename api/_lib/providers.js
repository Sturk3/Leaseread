// FRONTAGE — single source of truth for every external integration.
//
// This file is DOCUMENTATION THAT RUNS. It lists every pluggable provider lane in the
// owner-contact / enrichment workflow, the env keys each needs, what it powers, and the
// exact place to add a new provider. `api/health.js` reads it to report, in one call,
// what's wired and what still needs a key — so handing the code off (or adding an API)
// is "set the key the report asks for," not "grep 19 files."
//
// Files under api/_lib/ are shared helpers — Vercel does NOT deploy them as functions.
//
// ── The pluggable pattern (all contact-workflow lanes follow it) ──────────────
//   1. A `<CAPABILITY>_PROVIDER` env selects the active lane (has a sensible default).
//   2. Each lane reads its OWN key(s) from env, server-side only.
//   3. The endpoint parses the provider response with a TOLERANT parser (walks for
//      fields by name) so a vendor's key rename doesn't break the UI.
//   4. No key → the endpoint returns `{ noKey: true }` and the UI shows "not configured"
//      instead of erroring. Adding the key later activates the lane with NO code change.
//   5. A zero-cost `{ debug: true }` probe confirms which lane is live + whether its key
//      is set, without spending a credit.
// To add a provider: add a lane entry below, implement it in the named endpoint following
// that endpoint's existing lane shape, done. The frontend never changes.

export const INTEGRATIONS = [
  // ── Core (required to run) ───────────────────────────────────────────────────
  {
    capability: "ai",
    title: "Anthropic (Claude) — the research/reasoning brain",
    powers: "Scout agent, AI Quick Take, LLC unmask + relatives/associates lookups, acquisition memos, outreach drafts, OM & NDA grading",
    required: true,
    lanes: [{ id: "anthropic", keys: ["ANTHROPIC_API_KEY"], implemented: true }],
    endpoints: ["research.js", "agent.js", "screen.js", "nda.js"],
    addProvider: "Single-vendor by design (Claude). Model per-surface via AGENT_MODEL / AGENT_MODEL_DEEP / RESEARCH_MODEL.",
  },
  {
    capability: "auth",
    title: "Shared-password gate",
    powers: "Every API endpoint checks this before doing work",
    required: true,
    lanes: [{ id: "site_password", keys: ["SITE_PASSWORD"], implemented: true }],
    endpoints: ["(all)"],
    addProvider: "Swap for per-user auth (OAuth / tokens) when the team hub lands; the gate check is one line at the top of each handler.",
  },
  {
    capability: "shared_pipeline",
    title: "Shared saved-list / pipeline database",
    powers: "Team-shared Saved List + outreach state (Postgres). Without it the pipeline is device-local (localStorage) and still works.",
    required: false,
    lanes: [{ id: "postgres", keys: ["DATABASE_URL"], implemented: true, note: "Vercel → Storage → Neon; table auto-creates on first use" }],
    endpoints: ["pipeline.js"],
    addProvider: "Any Postgres connection string. Swapping the localStorage-first client to a different backend = change /api/pipeline only.",
  },

  // ── Owner-contact workflow (the pluggable lanes that matter most for extension) ─
  {
    capability: "skiptrace",
    title: "Owner skip trace — phone + email (+ relatives when the provider returns them)",
    powers: "The 'find owner contact' reveal in every dossier, and the relatives/associates the tracer returns",
    required: false,
    select: { env: "SKIPTRACE_PROVIDER", default: "tracerfy" },
    lanes: [
      { id: "tracerfy", keys: ["TRACERFY_API_KEY"], optionalKeys: ["TRACERFY_BASE"], implemented: true, note: "pay-on-hit ~$0.10; self-serve" },
      { id: "batchdata", keys: ["BATCHDATA_API_KEY"], optionalKeys: ["BATCHDATA_BASE"], implemented: true, note: "PAYG ~$0.07–0.18; stronger nationwide right-party rate" },
    ],
    endpoints: ["skiptrace.js"],
    addProvider: "api/skiptrace.js → PROVIDERS map: add `{ label, keyEnv, estCost, async lookup(key,input){…} }` returning the vendor's raw JSON. The tolerant normalizeContacts/extractPersons/personRelatives already parse phones, emails, and relatives regardless of exact field names.",
  },
  {
    capability: "phone_verify",
    title: "Phone verification — live line-status / carrier before you dial",
    powers: "(PLANNED) Filters disconnected/reassigned numbers out of skip-trace results and ranks by reachable, raising accuracy under any tracer",
    required: false,
    select: { env: "PHONE_VERIFY_PROVIDER", default: "twilio" },
    lanes: [
      { id: "twilio", keys: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"], implemented: false, note: "Twilio Lookup v2 line-status; ~$0.01–0.05/number" },
    ],
    endpoints: ["skiptrace.js (annotation step — insertion point documented in INTEGRATIONS.md)"],
    addProvider: "Documented drop-in: a verify(number) lane that returns { live, lineType, carrier }; skiptrace tags each phone before returning so the UI can drop dead lines. No-ops without a key.",
  },
  {
    capability: "entity",
    title: "LLC / entity unmasking — registered agent + principals",
    powers: "The '👥 Who's behind this LLC' lookup. Runs on AI web research today (works everywhere); a structured registry API can slot in as the primary lane where owner data is gated.",
    required: false,
    select: { env: "ENTITY_PROVIDER", default: "web" },
    lanes: [
      { id: "web", keys: [], implemented: true, note: "AI web research over SOS registries + OpenCorporates + press; needs ANTHROPIC_API_KEY (already required). Always available." },
      { id: "opensosdata", keys: ["OPENSOSDATA_API_KEY"], implemented: false, note: "(PLANNED) all-50-state structured registry; self-serve ~$0.03–0.10/lookup, 10 free" },
    ],
    endpoints: ["research.js (web lane)", "agent.js (Scout *_entity_lookup tools)"],
    addProvider: "Documented drop-in: an /api/entity resolve(name,state) lane returning { status, registeredAgent, principals[] }; OwnerPeople prefers it when ENTITY_PROVIDER is set and falls back to the web lane otherwise.",
  },
  {
    capability: "property_data",
    title: "Nationwide property + owner data (beyond the free per-market parcel feeds)",
    powers: "(PARKED) A paid aggregator to cover markets with no free open-data portal",
    required: false,
    select: { env: "PROPERTY_PROVIDER", default: "attom" },
    lanes: [
      { id: "attom", keys: ["ATTOM_API_KEY"], implemented: false, note: "(PARKED on branch) nationwide assessor/deeds/owner" },
      { id: "regrid", keys: ["REGRID_API_TOKEN"], implemented: false, note: "(PARKED) nationwide parcels" },
    ],
    endpoints: ["(parked — pro-data-connectors branch)"],
    addProvider: "See the parked api/property.js on the pro-data-connectors branch; tolerant harvest() parser already written.",
  },

  // ── Web + data-portal knobs ──────────────────────────────────────────────────
  {
    capability: "web_search",
    title: "Live web search for research lanes",
    powers: "Deep/live web for research.js (unmask, relatives, memos, market/comp colour). Off → knowledge-only.",
    required: false,
    lanes: [{ id: "anthropic_web", keys: [], gateEnv: "RESEARCH_LIVE_WEB", implemented: true, note: "flag, not a key: RESEARCH_LIVE_WEB!=0 enables live web (needs the 300s function limit)" }],
    endpoints: ["research.js"],
    addProvider: "Uses Claude's server-side web_search tool — no separate search key.",
  },
  {
    capability: "socrata",
    title: "Socrata app token (open-data rate limits)",
    powers: "Higher rate limits on the free NYC/CT/etc. open-data pulls. Everything works without it; just more 429-prone under load.",
    required: false,
    lanes: [{ id: "socrata", keys: ["SOCRATA_APP_TOKEN"], implemented: true, optional: true }],
    endpoints: ["intel.js", "comps.js", "foottraffic.js", "portfolio.js", "ctentity.js", "ctcomps.js", "leasecomps.js", "search.js (some markets)"],
    addProvider: "Free token at any Socrata data portal → set SOCRATA_APP_TOKEN.",
  },
];

// Walk the registry against the current env → a plain, JSON-safe status report.
// `keyConfigured` never leaks values, only booleans.
export function providerReport(env = process.env) {
  const has = (k) => !!(env[k] && String(env[k]).trim());
  return INTEGRATIONS.map((it) => {
    const selected = it.select ? (env[it.select.env] || it.select.default) : null;
    const lanes = (it.lanes || []).map((l) => {
      const keys = l.keys || [];
      const configured = keys.length === 0 ? true : keys.every(has);
      return {
        id: l.id,
        implemented: l.implemented !== false,
        keys,
        keyConfigured: keys.length ? keys.map((k) => ({ [k]: has(k) })).reduce((a, b) => ({ ...a, ...b }), {}) : {},
        configured,
        active: it.select ? selected === l.id : true,
        optional: !!l.optional,
        gateEnv: l.gateEnv ? { [l.gateEnv]: env[l.gateEnv] ?? null } : undefined,
        note: l.note,
      };
    });
    const activeLane = it.select ? lanes.find((l) => l.active) : lanes[0];
    const ready = it.required
      ? !!(activeLane && activeLane.configured && activeLane.implemented)
      : !!(activeLane && activeLane.configured && activeLane.implemented);
    return {
      capability: it.capability,
      title: it.title,
      required: !!it.required,
      selected,
      ready,
      status: !activeLane ? "none"
        : !activeLane.implemented ? "planned"
        : !activeLane.configured ? (it.required ? "MISSING KEY" : "not configured")
        : "ready",
      lanes,
      powers: it.powers,
      endpoints: it.endpoints,
      addProvider: it.addProvider,
    };
  });
}
