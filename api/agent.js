// FRONTAGE — Engine 4: the orchestrating AI agent ("Scout").
//
// A thin, STATELESS Claude tool-use proxy. The browser holds the conversation and
// runs the agent loop; each call here is ONE Claude turn (plan a tool call, or write
// the final answer). That keeps every invocation well under Vercel's 60s limit even
// though a full agent run may chain many engines — the long-running data fetches are
// the existing endpoints the browser calls between turns, not this function.
//
// Why a proxy instead of a server-side loop: a server-side agent that called
// /api/source -> /api/intel -> ... in one request would blow the 60s budget and
// duplicate every engine's logic. Instead Claude names a tool, the browser executes
// it against the real endpoint (reusing all auth/shape/caching), and posts the result
// back as a tool_result. Claude reasons across the accumulated results — the "research
// brain" the engines alone don't provide.
//
// Cost safety: model defaults to Sonnet (cheap, capable); the PAID skip-trace tool is
// declared but the system prompt forbids using it without explicit user go-ahead, and
// the browser still gates it behind a confirm. Key + password stay server-side.

const AGENT_MODEL = process.env.AGENT_MODEL || "claude-sonnet-4-6";
// Deep Research runs on the strongest model for sharper reasoning/synthesis (opt-in; the
// token tracker costs it correctly). Routine Scout stays on the cheaper Sonnet.
const AGENT_MODEL_DEEP = process.env.AGENT_MODEL_DEEP || "claude-opus-4-8";
// Raised from 8000: adaptive thinking (below) spends tokens that count toward this cap, so a tight
// ceiling truncated the synthesis turn. 16000 is the skill's non-streaming default and stays within
// Vercel's 60s (one Claude turn per call). Env-overridable for cost tuning.
const MAX_TOKENS = Number(process.env.AGENT_MAX_TOKENS) || 16000;
// Adaptive thinking sharpens the JUDGEMENT part of the answer — ranking targets, weighing motivation
// signals, deciding which tool to call next — which is exactly where a flat no-thinking proxy was weakest.
// "adaptive" lets Claude self-moderate (little thinking on routine tool-planning turns, more on
// synthesis), so it's cost-aware by design, and it auto-enables interleaved thinking across tool calls
// (the browser loop already echoes the full `content` array back, so thinking blocks are preserved).
// Set AGENT_THINKING=0 to fall back to no-thinking if latency/cost ever bites.
const THINKING_ON = process.env.AGENT_THINKING !== "0";
// Effort governs thinking depth + overall token spend. Deep Research goes hard (high); routine Scout
// stays balanced (medium) to respect the cost discipline the system prompt preaches.
const EFFORT_DEEP = process.env.AGENT_EFFORT_DEEP || "high";
const EFFORT_ROUTINE = process.env.AGENT_EFFORT || "medium";

// Tool catalog. Each tool maps 1:1 to an existing FRONTAGE endpoint; the browser owns
// the name->endpoint routing (see TOOL_ROUTES in src/App.jsx) and injects the password.
// Input schemas mirror exactly what each endpoint's req.body already accepts.
const TOOLS = [
  {
    name: "search_properties",
    description:
      "Find NYC properties and their owners of record. This is the primary sourcing tool — start here. " +
      "Provide an address to anchor the search (e.g. '120 5 AVENUE, MANHATTAN'); with a radius it returns every " +
      "property in the circle (nearest first), without a radius it returns just that one lot. Without an address you " +
      "can filter citywide by asset type and the building filters. Returns owner name, mailing address, last sale, " +
      "years owned, absentee/tax-lien/air-rights signals, and borough/block/lot + lat/lon needed by the other tools.",
    input_schema: {
      type: "object",
      properties: {
        nearAddress: { type: "string", description: "NYC street address to anchor on. Numbered streets like '9 STREET', avenues spelled '5 AVENUE'. Include the borough." },
        radiusMiles: { type: "number", description: "Search radius in miles around the address (e.g. 0.1, 0.25, 0.5). Omit or 0 = only the one property at that address." },
        assetType: { type: "string", enum: ["any", "retail", "office", "multifamily", "mixed_use", "industrial", "hotel", "vacant", "one_two_family", "condo"], description: "Building type filter (PLUTO building class). Default 'retail' for trophy-retail sourcing." },
        minRetailSqft: { type: "number", description: "Minimum ground-floor retail square footage." },
        minSqft: { type: "number", description: "Minimum total building square footage." },
        minUnits: { type: "number", description: "Minimum number of units." },
        builtAfter: { type: "number", description: "Only buildings built on/after this year." },
        builtBefore: { type: "number", description: "Only buildings built on/before this year." },
        devOnly: { type: "boolean", description: "Only underbuilt development sites (meaningful unused air rights)." },
        minBuildable: { type: "number", description: "Minimum unused buildable square footage (air rights)." },
      },
    },
  },
  {
    name: "property_intel",
    description:
      "Pull consolidated public-records intel for ONE property: NY State business registry for the owning LLC, " +
      "DOB/ECB/HPD violations + penalties owed, 311, evictions, certificate of occupancy, storefront vacancy registry, " +
      "and named HPD officers. Use after search_properties to assess distress/motivation. Needs borough/block/lot + owner name from a search result.",
    input_schema: {
      type: "object",
      properties: {
        borough: { type: "string", description: "Borough name, e.g. 'Manhattan'." },
        block: { type: "string", description: "Tax block." },
        lot: { type: "string", description: "Tax lot." },
        name: { type: "string", description: "Owner name from the search result." },
      },
      required: ["borough", "block", "lot"],
    },
  },
  {
    name: "transaction_history",
    description: "ACRIS deed/mortgage/lease history for one property (dates, amounts, parties). Use to read sale history, recorded debt, or recorded leases. Needs borough/block/lot.",
    input_schema: {
      type: "object",
      properties: {
        borough: { type: "string" }, block: { type: "string" }, lot: { type: "string" },
      },
      required: ["borough", "block", "lot"],
    },
  },
  {
    name: "owner_portfolio",
    description: "Every NYC property held under an exact owner NAME in PLUTO. Good for management companies / REITs / reused entity names. Anonymous single-asset LLCs return only their own lot — use hidden_portfolio for those.",
    input_schema: { type: "object", properties: { name: { type: "string", description: "Exact owner name." } }, required: ["name"] },
  },
  {
    name: "hidden_portfolio",
    description: "Find every HPD-registered building tied to a PERSON's name (an officer/principal), surfacing an operator's holdings spread across SEPARATE single-asset LLCs. Use a human name (e.g. an HPD officer from property_intel), not an LLC.",
    input_schema: { type: "object", properties: { name: { type: "string", description: "A person's name." } }, required: ["name"] },
  },
  {
    name: "foot_traffic",
    description: "Trophy-retail quality signal for a location: nearest DOT pedestrian-count corridor + latest count, and nearest subway station + lines/distance. Needs the lot's lat/lon from a search result.",
    input_schema: { type: "object", properties: { lat: { type: "number" }, lon: { type: "number" } }, required: ["lat", "lon"] },
  },
  {
    name: "sales_comps",
    description: "Recent recorded sale comps near a property (ACRIS deeds with price) for underwriting context. Needs borough + block.",
    input_schema: { type: "object", properties: { borough: { type: "string" }, block: { type: "string" } }, required: ["borough", "block"] },
  },
  {
    name: "web_research",
    description:
      "Deep web research on a PROPERTY and/or its OWNER. Give it an address (and the owner name if you have it) and it works the " +
      "chain on the live web: identifies the owner if unknown, unmasks the parent/management firm and principals, pulls their " +
      "PORTFOLIO, and digs the company's own website for PUBLICLY-LISTED institutional contacts (main/leasing/acquisitions lines " +
      "and emails) — surfacing each with its source. Best for institutional / named owners (REITs, developers, management cos). " +
      "Won't return a private owner's cell (use reveal_contact for that). Provide a name OR an address.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Owner name to research, if known." },
        address: { type: "string", description: "Property address — enough on its own; research will find the owner from it." },
        borough: { type: "string" },
      },
    },
  },
  {
    name: "search_ct_properties",
    description:
      "Source properties in CONNECTICUT towns (default Greenwich) from CT's statewide Parcel + assessor (CAMA) data. Returns the " +
      "OWNER of record + mailing address (absentee owners flagged), property address, use, zoning, assessed value, building SF, " +
      "frontage, year built, and latest sale (price/date/grantee). Filter by type, assessed-value range, sold-since year, min SF, " +
      "and street. Use for Greenwich/CT sourcing (NYC tools don't apply outside the city). For an owner LLC, follow with " +
      "ct_entity_lookup (principals) and/or web_research (contacts).",
    input_schema: {
      type: "object",
      properties: {
        town: { type: "string", description: "CT town name, e.g. 'Greenwich' (default), 'Darien', 'Westport'." },
        propertyType: { type: "string", enum: ["any", "commercial", "apartments", "industrial", "single_family", "residential", "condo", "vacant"], description: "Use filter. 'commercial' covers retail/office." },
        minPrice: { type: "number", description: "Minimum ASSESSED value." },
        maxPrice: { type: "number", description: "Maximum ASSESSED value." },
        minSqft: { type: "number", description: "Minimum building square footage." },
        sinceYear: { type: "number", description: "Only properties whose latest sale was this year or later." },
        address: { type: "string", description: "Filter to a street, e.g. 'GREENWICH AVENUE'." },
      },
    },
  },
  {
    name: "search_hamptons_properties",
    description:
      "Source properties in the HAMPTONS / NY State outside NYC (default towns: East Hampton, Southampton, Shelter Island) " +
      "from NY State's assessment roll. Returns OWNER + mailing (absentee flagged), address, property class, frontage, and " +
      "assessment. Use for the Hamptons (NYC tools don't apply there). CAVEAT: NY town assessed values use varying ratios and " +
      "market value is often blank — lead with owner/address/class, treat $ as rough. Find contacts via web_research.",
    input_schema: {
      type: "object",
      properties: {
        town: { type: "string", description: "NY municipality, e.g. 'East Hampton', 'Southampton', 'Shelter Island', or 'all' for all three Hamptons towns (default)." },
        propertyType: { type: "string", enum: ["any", "commercial", "residential", "vacant", "industrial"], description: "Use filter. 'commercial' covers retail/office/apartments." },
        minValue: { type: "number", description: "Minimum assessment_total (rough — varying town ratios)." },
        address: { type: "string", description: "Filter to a street, e.g. 'NEWTOWN LANE' or 'MAIN ST'." },
      },
    },
  },
  {
    name: "ct_sales_comps",
    description:
      "Recent recorded SALE comps for a Connecticut town (default Greenwich) from CT's statewide Real Estate Sales data. " +
      "Returns each sale's address, sale amount + date, assessed value, and SALES RATIO (sale ÷ assessment — well above/below " +
      "CT's ~0.7 norm flags an over/under-market trade), plus property type. Filter by town, type, street, sold-since year, and " +
      "sale-amount range. Use for CT underwriting / pricing context (the CT analog of sales_comps; NYC tools don't apply there).",
    input_schema: {
      type: "object",
      properties: {
        town: { type: "string", description: "CT town, e.g. 'Greenwich' (default), 'Darien', 'Westport'." },
        propertyType: { type: "string", enum: ["any", "commercial", "apartments", "industrial", "condo", "residential", "single_family", "vacant"], description: "Property type filter. 'commercial' covers retail/office." },
        address: { type: "string", description: "Filter to a street, e.g. 'GREENWICH AVE'." },
        sinceYear: { type: "number", description: "Only sales in this grand-list year or later." },
        minAmount: { type: "number", description: "Minimum sale price." },
        maxAmount: { type: "number", description: "Maximum sale price." },
      },
    },
  },
  {
    name: "search_ma_properties",
    description:
      "Source properties in MASSACHUSETTS towns (default Boston) from MassGIS statewide assessor data. Returns the OWNER of " +
      "record + mailing address (absentee owners flagged), site address, use code/type, assessed value, building SF, year built, " +
      "units, zoning, and latest sale (price + date). Filter by town, type, assessed-value range, min SF, sold-since year, and " +
      "street. Use for MA sourcing — Boston trophy retail, or Nantucket / Martha's Vineyard luxury (NYC/CT tools don't apply " +
      "there). For an owner LLC, follow with web_research for principals/contacts.",
    input_schema: {
      type: "object",
      properties: {
        town: { type: "string", description: "MA town/city name, e.g. 'Boston' (default), 'Nantucket', 'Cambridge', 'Provincetown'." },
        propertyType: { type: "string", enum: ["any", "commercial", "office", "apartments", "industrial", "single_family", "condo", "residential", "vacant"], description: "Use filter. 'commercial' covers retail/office." },
        minValue: { type: "number", description: "Minimum assessed value." },
        maxValue: { type: "number", description: "Maximum assessed value." },
        minSqft: { type: "number", description: "Minimum building square footage." },
        sinceYear: { type: "number", description: "Only properties whose latest sale was this year or later." },
        address: { type: "string", description: "Filter to a street, e.g. 'NEWBURY ST' or 'MAIN ST'." },
      },
    },
  },
  {
    name: "search_nashville_properties",
    description:
      "Source properties in NASHVILLE / Davidson County, TN from Metro Nashville's daily parcel + ownership data. Returns the " +
      "OWNER of record + mailing address (absentee flagged), property address, land use, zoning, appraised/assessed value, last " +
      "SALE price + year (→ years owned), and acreage. Tennessee is an open-records state, so owners ARE public (a full sourcing " +
      "market like NYC/CT/MA). Filter by type, street, value range, min acreage, and sold-since year. For an owner LLC, follow " +
      "with web_research for principals/contacts. NOTE: this dataset has land acreage but no building square footage.",
    input_schema: {
      type: "object",
      properties: {
        propertyType: { type: "string", enum: ["any", "commercial", "retail", "office", "apartments", "industrial", "hotel", "vacant", "single_family", "residential"], description: "Land-use filter. 'commercial' covers retail/office/hotel; 'retail' is stores/restaurants/markets." },
        address: { type: "string", description: "Filter to a street, e.g. 'BROADWAY' or '5TH AVE'." },
        minValue: { type: "number", description: "Minimum total APPRAISED value." },
        maxValue: { type: "number", description: "Maximum total appraised value." },
        minAcres: { type: "number", description: "Minimum lot acreage." },
        sinceYear: { type: "number", description: "Only properties whose latest sale/ownership was this year or later." },
      },
    },
  },
  {
    name: "nashville_property_intel",
    description:
      "Consolidated public-records intel for ONE Nashville / Davidson County property (the TN analog of property_intel / " +
      "sf_property_intel). Pass the APN from search_nashville_properties (plus the address) and it fans out across Metro's data, " +
      "joining BUILDING-EXACT on the parcel number (TN is open-records, so this goes deep): BUILDING PERMITS (commercial new / " +
      "rehab / demolition / tenant finish-out / use-&-occupancy / sign — with cost + free-text purpose = active repositioning), " +
      "PENDING permit applications, TRADE permits (live renovation + contract value), BEER permits (names the operating bar/" +
      "restaurant + its owning entity — a real operator/tenant lead; a lapsed one = F&B vacancy), short-term-rental permits, 311 " +
      "codes/condition complaints (distress), ZONING OVERLAYS (historic / contextual / corridor = redevelopment constraints), the " +
      "FEMA FLOOD zone (diligence), and the Metro land-use POLICY / transect for the site. Use after search_nashville_properties to " +
      "assess motivation/distress and surface operator contacts. Needs the APN (preferred) and/or address.",
    input_schema: {
      type: "object",
      properties: {
        apn: { type: "string", description: "Parcel APN from a search_nashville_properties result (e.g. '09306201200'). Preferred — records join exactly on it." },
        address: { type: "string", description: "Property address (used for the 311 join and display)." },
      },
    },
  },
  {
    name: "search_sf_properties",
    description:
      "Source properties in SAN FRANCISCO from DataSF's assessor roll. Returns property characteristics (use, building/lot SF, " +
      "frontage, year built, units, zoning) + assessed value + block/lot, by neighborhood, street, type, value range, and min SF. " +
      "IMPORTANT: California does NOT publish owner names in open data, so this returns NO owner of record — find the owner with " +
      "web_research, and use sf_property_intel (block+lot) for the operating business's legal name, permits, evictions, and " +
      "complaints. Use for SF (NYC/CT/MA tools don't apply there).",
    input_schema: {
      type: "object",
      properties: {
        neighborhood: { type: "string", description: "SF analysis neighborhood, e.g. 'Financial District', 'Mission', 'Pacific Heights', 'Marina'." },
        address: { type: "string", description: "Filter to a street, e.g. 'GEARY' or 'UNION ST'." },
        propertyType: { type: "string", enum: ["any", "commercial", "retail", "office", "hotel", "apartments", "industrial", "mixed_use", "single_family", "residential"], description: "Use filter. 'commercial' covers retail/office/hotel/misc." },
        minValue: { type: "number", description: "Minimum total assessed value (land + improvement)." },
        maxValue: { type: "number", description: "Maximum total assessed value." },
        minSqft: { type: "number", description: "Minimum building square footage." },
      },
    },
  },
  {
    name: "sf_property_intel",
    description:
      "Consolidated San Francisco public-records intel for ONE property (pass block+lot from search_sf_properties, plus the " +
      "address): building permits (development activity, cost, use change), DBI building complaints, the active BUSINESS operators " +
      "at the address (legal name = a real contact lead) + recent closures (vacancy signal), nearby EVICTION notices with cause " +
      "flags (Ellis Act / owner move-in / demolition / capital improvement = landlord clearing the building = strong motivation), " +
      "open fire-code violations, 311 volume, PLANNING entitlement filings (the applicant — a named person/firm tied to the " +
      "property), and the DEVELOPMENT PIPELINE (project sponsor + a named contact and PHONE). Planning applicant + pipeline contact " +
      "are the closest thing to an owner contact in SF (often the owner's rep, but a warm lead). Also returns DTSC EnviroStor environmental/contamination sites (development diligence), the mandatory SOFT-STORY seismic-retrofit status (pending retrofit = compliance/cost pressure = motivation), and TRANSIT proximity (nearest Muni stop + stops within 0.25mi = a foot-traffic/retail-quality proxy). The SF analog of property_intel. Needs block + lot + address.",
    input_schema: {
      type: "object",
      properties: {
        block: { type: "string", description: "Assessor block from the search result." },
        lot: { type: "string", description: "Assessor lot from the search result." },
        address: { type: "string", description: "Property address (for the address-keyed sources: businesses, evictions, fire, 311)." },
      },
      required: ["address"],
    },
  },
  {
    name: "ca_entity_lookup",
    description:
      "Unmask a CALIFORNIA business entity / LLC (the SF analog of the NY/CT registry lookup). Given an LLC/Corp name, reads the " +
      "California Secretary of State business registry (bizfileOnline) and OpenCorporates and returns: exact entity name + number, " +
      "type, status (active/suspended/dissolved), registration date, the AGENT FOR SERVICE OF PROCESS (name + address — the key " +
      "contact for an anonymous LLC), the principal/mailing address, and any listed officers/managers. Use this for SF/California " +
      "owners (NYC/CT registry tools don't cover CA). NOTE: California gates its registry, so this is a live WEB lookup (metered " +
      "like web_research), not a free dataset — call it purposefully, once per entity.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "California entity / LLC name, e.g. '123 MAIN ST SF LLC'." } },
      required: ["name"],
    },
  },
  {
    name: "tn_entity_lookup",
    description:
      "Unmask a TENNESSEE business entity / LLC (the Nashville analog of the NY/CT/CA registry lookup). Given an LLC/Corp name, " +
      "reads the Tennessee Secretary of State business registry (TNBear) and OpenCorporates and returns: exact entity name + SOS " +
      "control number, type, status (active/inactive/dissolved), formation date, the REGISTERED AGENT (name + address — the key " +
      "contact for an anonymous LLC), the principal office address, and any listed officers/members. Use for Nashville/TN owners. " +
      "NOTE: Tennessee gates its registry (no open API), so this is a live WEB lookup (metered like web_research) — call it once per entity.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "Tennessee entity / LLC name, e.g. 'HT NASHVILLE LLC'." } },
      required: ["name"],
    },
  },
  {
    name: "ct_entity_lookup",
    description:
      "Look up a Connecticut business entity / LLC in CT's public Business Registry. Returns the entity's status + " +
      "registration, its registered agent, and — unlike NY — its PRINCIPALS with names and locations. Use this for " +
      "Greenwich/CT to unmask the real people behind an owner LLC once you know the entity name (FREE, no web search needed).",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "Entity / LLC name, e.g. 'THAGRAND CAPITAL LLC'." } },
      required: ["name"],
    },
  },
  {
    name: "brand_radar",
    description:
      "Scout the live web for NEW / trendy retail brands that are expanding into physical stores, opening flagships, or actively " +
      "seeking retail space — the DEMAND side for trophy retail (who you'd want as a tenant). Optionally filter by market/corridor " +
      "and category. Returns a brand list with what they sell, expansion status, any reported new locations or space requirements, " +
      "and sources. Great for matching an available space to brands that want it. (Live web — metered like web_research.)",
    input_schema: {
      type: "object",
      properties: {
        market: { type: "string", description: "Corridor/market context, e.g. 'SoHo', 'Greenwich Avenue', 'the Hamptons', 'Madison Ave'." },
        category: { type: "string", description: "Category, e.g. 'fashion', 'beauty', 'food & beverage', 'wellness', 'home'." },
      },
    },
  },
  {
    name: "web_search",
    description:
      "General web search — like a normal assistant with live web access. Pass ANY natural-language question or research " +
      "request, on ANY topic (real estate or not): current events, a person or company, prices, market news, how-tos, a " +
      "corridor's recent deals, what a tenant is doing — anything. Returns a synthesized, sourced answer from the live web. " +
      "Use it whenever the answer needs current or external info. (Until live web is enabled it falls back to model knowledge and says so.)",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The research request, as a clear natural-language question or instruction." },
      },
      required: ["query"],
    },
  },
  {
    name: "grade_offering_memo",
    description:
      "Underwrite & grade an OFFERING MEMORANDUM (OM) against the firm's buy-box mandate. Extracts the financials and tenant " +
      "roster, scores each criterion, and returns a Pursue / Watch / Pass read. Use when the user wants a deal screened or an OM " +
      "graded. The user can ATTACH the OM as a PDF (preferred) — if so you don't need memo_text; otherwise pass the pasted text.",
    input_schema: {
      type: "object",
      properties: {
        memo_text: { type: "string", description: "The offering memorandum text, if pasted. Omit when a PDF is attached." },
      },
    },
  },
  {
    name: "review_nda",
    description:
      "Redline an NDA against the firm's NDA playbook — flags each clause Keep / Revise / Cut / Flag with suggested language, " +
      "and lists missing protections. Use when the user wants an NDA reviewed/redlined. The user can ATTACH the NDA as a PDF " +
      "(preferred) — if so you don't need nda_text; otherwise pass the pasted text. (Sister tool to grade_offering_memo.)",
    input_schema: {
      type: "object",
      properties: {
        nda_text: { type: "string", description: "The NDA text, if pasted. Omit when a PDF is attached." },
      },
    },
  },
  {
    name: "reveal_contact",
    description:
      "PAID skip trace (~$0.10 per match, billed only on a hit) — returns the owner's phone numbers + emails. " +
      "Use this ONLY when the user has explicitly asked to get an owner's contact / phone number for a specific property. " +
      "Never call it speculatively or in bulk. Prefer the owner's mailing address (from the search result) so an absentee " +
      "owner resolves to the real person. State clearly in your reply that this is a paid lookup.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Owner name of record." },
        entity_type: { type: "string", enum: ["person", "company"], description: "Whether the owner is a person or an LLC/company." },
        contact_address: { type: "string", description: "Owner's mailing street address (preferred anchor)." },
        city: { type: "string" }, state: { type: "string" }, zip: { type: "string" },
        address: { type: "string", description: "Property address (fallback anchor)." },
        borough: { type: "string" },
      },
      required: ["name"],
    },
  },
];

function buildSystem(deepResearch) {
  return `You are **Scout**, the in-house agent inside FRONTAGE for a firm ("Crown") that buys trophy / high-street RETAIL property in New York City. Be sharp, concise, and operational — you are talking to working deal-makers.

You are a FULLY CAPABLE GENERAL ASSISTANT with live web access — you can search the web and answer ANY question the user asks, on ANY topic, exactly like normal Claude. You are not limited to real estate. On TOP of that, you have a set of specialized FRONTAGE engines (below) for property sourcing and owner research. Reach for those engines when the task is about sourcing/deals/owners; for anything else, just help directly (use the web_search tool for anything current or external). Never refuse or deflect a request just because it isn't about real estate.

WHAT YOU DO
- Turn a plain-English request into the right sequence of tool calls, then SYNTHESIZE — don't just dump rows. Rank, flag the motivated owners, and explain the read.
- BATCH INDEPENDENT LOOKUPS: when several tools on the same property don't depend on each other's output (e.g. property_intel + transaction_history + foot_traffic on one lot, or sales_comps + owner_portfolio), request them TOGETHER in a single turn rather than one at a time. This is faster and far cheaper. Only go one-at-a-time when a later call genuinely needs an earlier call's result (e.g. you need block/lot from search_properties before you can pull its intel).
- Default thesis when unspecified: trophy / high-street RETAIL. If the user names another asset type or neighborhood, follow that.
- Always begin a sourcing task with search_properties. Use its borough/block/lot, owner name, mailing address, and lat/lon to drive the follow-on tools (property_intel, transaction_history, foot_traffic, owner/hidden portfolio, web_research).
- DEMAND side: when the user asks who would want/lease a space, or about trendy/expanding brands, use brand_radar — it scouts the web for new retail brands opening flagships or seeking space (optionally by market + category). Good for matching an available space to brands that want it.

"MARKETS — NYC vs CONNECTICUT
- NEW YORK CITY: use the full structured stack (search_properties + property_intel + transaction_history + portfolios + foot_traffic + sales_comps). Owners come straight from the public records.
- GREENWICH / CONNECTICUT (and other CT towns): the NYC datasets DON'T exist there, but CT's statewide parcel+assessor data does. Use search_ct_properties — it returns the OWNER of record + mailing (absentee flagged), building SF, value, and latest sale. For an owner LLC, use ct_entity_lookup (FREE) — CT discloses LLC PRINCIPALS (names + locations) — then web_research for contacts. For pricing/underwriting context use ct_sales_comps (FREE) — recent recorded sales with sale amount + sales ratio. The data has owners, so you rarely need paid web research just to find who owns it. CT commercial inventory is modest, so keep filters loose. CT open data has NO deeds/mortgages/liens — for those in Greenwich, point the user to the official land-records portal greenwich.ct.publicsearch.us (a gated site you can't query, but they can search it by owner/address).
- HAMPTONS (East Hampton / Southampton / Shelter Island, Suffolk County NY — outside NYC): use search_hamptons_properties (NY State assessment roll) for OWNER + mailing (absentee flagged) + class. NY assessed $ are rough (varying town ratios), so lead with owner/address/class and use web_research for value/contacts.
- MASSACHUSETTS (Boston trophy retail, Nantucket / Martha's Vineyard / Cape luxury, any MA town): use search_ma_properties (MassGIS assessor data) for OWNER + mailing (absentee flagged), use/value, building SF, year, and latest sale. MA keeps owners public and its assessed values track market reasonably. For an owner LLC, use web_research for principals/contacts.
- NASHVILLE / DAVIDSON COUNTY, TN: use search_nashville_properties (Metro Nashville parcel data, updated daily). FULL owner market — OWNER of record + mailing (absentee flagged), land use, value, last sale + years owned. TN is open-records so owners are public; treat it like NYC/CT/MA. Then run nashville_property_intel (pass the APN + address) — the TN analog of property_intel/sf_property_intel: it joins BUILDING-EXACT on the parcel number across building permits (commercial new/rehab/DEMOLITION/tenant finish-out/use-&-occupancy/sign + cost + purpose = active repositioning), pending applications, trade permits (live renovation), BEER permits (names the operating bar/restaurant + its owning entity — a real operator/tenant contact lead; lapsed = F&B vacancy), STR permits, 311 codes/condition complaints (distress), zoning OVERLAYS (historic/contextual/corridor = redevelopment constraints), the FEMA FLOOD zone, and the Metro land-use POLICY/transect. For an owner LLC, use tn_entity_lookup to unmask it — TN SOS registered agent + principals (the Nashville analog of the NY/CT/CA entity lookup; metered web lookup, since TN gates its registry). (The parcel data has acreage + FRONTAGE but no building SF.)
- SAN FRANCISCO: use search_sf_properties (DataSF assessor roll) for property characteristics + assessed value + block/lot, then sf_property_intel (block+lot+address) for permits, DBI complaints, the active business operator (a real contact lead), eviction notices (Ellis Act / owner move-in / demolition / capital improvement = landlord clearing the building = strong motivation), fire violations, and 311. IMPORTANT: California open data has NO owner-of-record name, so SF is a characteristics+distress market — get the actual OWNER via web_research (from the address), and use the operating business's legal name as a contact lead. Eviction addresses are masked to the block (street/corridor signal, not building-exact). Once you have the owning LLC's name, use ca_entity_lookup to unmask it — the CA SOS registry agent for service of process + principals (the CA analog of the NY/CT entity lookup; it's a metered web lookup because California gates its registry).
- ANY OTHER US MARKET (no structured connector — most of the country): you can still source there. NEVER say a market is unsupported. For a specific address, web_research works the whole chain from the address alone — it identifies the owner of record, unmasks the parent/firm + principals, maps the portfolio, and pulls published contacts. For a "find me owners in <city>" ask where there's no structured feed, use web_research / web_search to surface candidates (recent trades, known local owners/landlords, brokers), and be upfront: outside NYC/CT/the Hamptons you don't have a parcel database to filter on, so results come from the live web and you can't guarantee completeness — but you can absolutely work any specific property or owner they name. Offer to go deep on the ones that look best.

"WHO OWNS THIS + HOW TO REACH THEM" (a top use case — given an address, find the owner, their portfolio, and institutional contacts on the web)
- NYC address: get the owner of record cheaply first via search_properties (free public records), then web_research to unmask the parent/management firm + principals, map the portfolio, and pull publicly-listed institutional contacts (main/leasing/acquisitions lines and emails) from the company's own website. Add owner_portfolio / hidden_portfolio to widen the holdings picture.
- Non-NYC address: web_research alone works the whole chain — it will identify the owner FROM the address, then portfolio + contacts.
- Surface every institutional contact you find WITH its source. Be clear these are published business numbers; a private owner's personal cell is not on the open web and needs reveal_contact (paid skip trace).

HOW TO REASON ABOUT MOTIVATION (the firm's wedge = finding off-market motivated owners)
- Strong seller signals: long hold (15+ years owned), absentee / out-of-state owner, tax lien or ECB penalties owed, maturing/old mortgage, underbuilt lot with air rights, storefront vacancy. Call these out explicitly when you see them.
- For INSTITUTIONAL / named owners (REITs, developers, management cos): use web_research to identify the decision-maker and acquisitions/dispositions contact.
- For anonymous single-asset LLCs: use property_intel to surface named HPD officers, then hidden_portfolio to map the human's other buildings.

DOCUMENT REVIEW (offering memos & NDAs)
- If the user attaches an offering memorandum PDF (or pastes one) and wants it underwritten/graded, call grade_offering_memo. It scores the deal against the firm's saved buy-box and returns extracted financials, the tenant roster, per-criterion scores, and a Pursue/Watch/Pass recommendation. Lead with the recommendation and the few drivers that moved it; flag any missing/low-confidence figures.
- If the user attaches/pastes an NDA and wants it reviewed/redlined, call review_nda. It flags each clause Keep/Revise/Cut/Flag against the firm's NDA playbook with suggested language + missing protections. Lead with the overall risk read and the clauses that need attention. (It's a drafting aid — remind them counsel should confirm.)
- A PDF attachment could be either — pick the tool from what the user asks for.

COST DISCIPLINE (important — the team is cost-conscious; this is where the money actually goes)
- The FREE structured tools (search_properties, property_intel, transaction_history, portfolios, foot_traffic, sales_comps, the CT/MA/Hamptons/SF searches + sf_property_intel) cost NOTHING. They are now very rich — sf_property_intel alone returns ~11 layers — so they answer most questions on their own. ALWAYS exhaust them first; detail is free here, so go deep.
- web_research / web_search / ca_entity_lookup / brand_radar hit the live web and cost real money (~$0.10–0.20 each) — this is the ONLY expensive part of an answer. Reach for them only when the free structured data genuinely can't answer (owner-behind-an-LLC, a private/CA owner's contact, news/distress narrative, non-NYC markets). Make AT MOST ONE focused web call, batch everything you need into that single query, and NEVER repeat a call you've already made this conversation. A thorough, detailed answer should come mostly from the free engines — depth does not require spending.
- reveal_contact is a PAID skip trace (~$0.10 per match). Call it ONLY when the user explicitly asks for an owner's phone/contact for a specific property, one at a time — never speculatively. Say plainly it's a paid lookup. For institutional owners prefer web_research first.
- Don't pad: answer in as few tool calls as the task honestly needs.

ANSWER WITH DEPTH (the user wants thorough, decision-grade answers — and you already paid to fetch the data, so USE ALL OF IT)
- Never drop signals you gathered. If you pulled intel, surface every relevant field — distress flags, contacts, permits, transit, environmental, retrofit status — don't summarize 11 signals down to 3.
- Structure: (1) LEAD with the bottom-line read / recommendation in 1-2 sentences; (2) then the detailed breakdown.
  • For ONE property: write a full dossier — property facts; owner/operator + how to reach them (with the source of each contact); then a MOTIVATION synthesis that explicitly weighs EVERY distress/intent signal you found (long hold, absentee/out-of-state, tax lien / violations / penalties owed, maturing debt, eviction intent incl. Ellis-Act/owner-move-in, soft-story retrofit pending, environmental/contamination, storefront vacancy, unused air rights, permits or use-change); finish with a recommended approach.
  • For a LIST: rank candidates best-first, each with a substantive 2-4 line "why" (the specific signals that move it + the contact path), not a one-liner.
- Tight markdown (short bold headers, bullets, **bold** addresses) but THOROUGH — depth over brevity. Don't pad with filler, but never omit a real signal just to be short.
- Be honest about data limits and confidence, and attribute every contact/claim to its source (NYC has no public lease-expiration feed; CA/SF publish no owner name or sale price; SF eviction addresses are masked to the block; skip traces on big commercial addresses can return occupants not owners; PLUTO owner names are often per-building LLCs). Never invent owners, numbers, or contacts.
- CITE THE WEB: when a fact came from web research, cite it inline as a markdown link [source](url) using the \`sources\` the research tools return, so the user can verify it. Name the dataset/engine for public-record facts.
- If a request is ambiguous (which borough? radius? asset type?), make a sensible default, state the assumption in one line, and proceed — don't stall with questions unless truly necessary.${deepResearch ? `

═══════════ DEEP RESEARCH MODE — ON (the user explicitly enabled it; be exhaustive) ═══════════
You are now operating as a DEEP RESEARCHER. The user wants a thorough, comprehensive, fully-sourced investigation — not a quick answer. Take the steps you need and work the problem to the end.

1) PLAN FIRST. Open with a brief research plan: restate the objective in one line, then list the threads you'll pursue (e.g. ownership & entity, principals & portfolio, distress/motivation, contacts, comps & market, risks/diligence). A few bullets, then start working.
2) INVESTIGATE EXHAUSTIVELY. Work every thread methodically and EXHAUST the FREE structured engines first — they're unlimited, so go deep. Chase the full chain: property → owner of record → the entity → its principals (property_intel officers / ca_entity_lookup / ct_entity_lookup) → their other holdings (owner_portfolio + hidden_portfolio) → EVERY distress/intent signal (intel, transaction_history for debt + recorded leases, evictions, soft-story, environmental, vacancy, air rights) → comps → market context. Follow the leads the data opens up; never stop at the first result.
3) USE THE WEB PURPOSEFULLY (still cost-aware). In deep mode you MAY make SEVERAL focused web calls (web_research / ca_entity_lookup / web_search) where the free data genuinely can't answer — to unmask an LLC, find principals/contacts, or pull news/distress narrative — but make each count and NEVER repeat one you've already run.
4) SELF-CHECK before writing the report (do this EVERY time): re-read your draft findings against the tool results you actually received. For every claim you're about to make, confirm a tool result or a cited web source supports it — if not, either go verify it with another tool/search or label it explicitly as "unverified / assumption", and drop anything you can't stand behind. Briefly note what you could not confirm.
5) DELIVER A FULL CITED REPORT, structured:
   • **Bottom line** — the verdict / recommendation in 2-3 sentences.
   • **Property & ownership** — facts + owner of record + the entity behind it.
   • **Who's behind it & how to reach them** — principals / decision-makers + every contact found, EACH with its source.
   • **Motivation / distress analysis** — weigh every signal and what it implies.
   • **Portfolio** — their other holdings.
   • **Comps & market** — pricing and corridor context.
   • **Risks & diligence** — environmental, violations, retrofit, and explicit DATA GAPS.
   • **Recommended approach & next steps** — concrete moves, incl. any paid step (skip trace) worth taking.
   • **Sources** — list the web sources you used as markdown links [title](url) (take them from the \`sources\` array the research tools return). For public-record facts, name the engine/dataset (ACRIS, PLUTO, DataSF, EnviroStor, etc.).
   Cite every web-derived fact INLINE as a markdown link to its source, state your confidence, and be explicit about what you could NOT determine. Never invent.` : ""}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, messages, check, debug, deepResearch } = req.body || {};

    if (process.env.SITE_PASSWORD) {
      if (password !== process.env.SITE_PASSWORD) {
        return res.status(401).json({ error: "Incorrect password." });
      }
    }
    if (check) return res.status(200).json({ ok: true });
    if (debug) {
      return res.status(200).json({ ok: true, model: AGENT_MODEL, deepModel: AGENT_MODEL_DEEP, thinking: THINKING_ON, effort: { routine: EFFORT_ROUTINE, deep: EFFORT_DEEP }, maxTokens: MAX_TOKENS, tools: TOOLS.map((t) => t.name), build: "agent-v25-thinking" });
    }

    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: "messages array required" });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY" });
    }

    // PROMPT CACHING — the big cost lever for a multi-turn agent loop. The (large, static)
    // system prompt + tool definitions are re-sent every turn; caching them means each turn
    // pays ~10% on those instead of full price. We also cache the growing message prefix so
    // accumulated tool results aren't re-billed at full rate on later turns.
    const cachedTools = TOOLS.map((t, i) => (i === TOOLS.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t));
    const cachedMessages = messages.slice();
    const lastM = cachedMessages[cachedMessages.length - 1];
    if (lastM && Array.isArray(lastM.content) && lastM.content.length) {
      cachedMessages[cachedMessages.length - 1] = {
        ...lastM,
        content: lastM.content.map((b, i) => (i === lastM.content.length - 1 && b && typeof b === "object" ? { ...b, cache_control: { type: "ephemeral" } } : b)),
      };
    }

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: deepResearch ? AGENT_MODEL_DEEP : AGENT_MODEL,
        max_tokens: MAX_TOKENS,
        // Adaptive thinking + effort. NOTE for future edits: with thinking on, temperature/top_p/top_k
        // are not allowed (they 400 on Opus 4.8 / Sonnet 4.6) — none are set, keep it that way.
        ...(THINKING_ON ? { thinking: { type: "adaptive" } } : {}),
        output_config: { effort: deepResearch ? EFFORT_DEEP : EFFORT_ROUTINE },
        system: [{ type: "text", text: buildSystem(deepResearch), cache_control: { type: "ephemeral" } }],
        tools: cachedTools,
        messages: cachedMessages,
      }),
    });
    const raw = await r.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(502).json({ error: "Anthropic returned a non-JSON response", anthropic_status: r.status, snippet: raw.slice(0, 300) });
    }
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "handler" });
  }
}
