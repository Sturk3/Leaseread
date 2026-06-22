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
const MAX_TOKENS = Number(process.env.AGENT_MAX_TOKENS) || 4096;

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
      "AI quick take on an owner: who's behind the entity, portfolio, motivation signals, and how to reach the decision-maker. " +
      "BEST for INSTITUTIONAL / named owners (REITs, developers, management companies) where there's public info. For anonymous " +
      "single-asset LLCs it will honestly report little is public — prefer hidden_portfolio + reveal_contact for those.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Owner name to research." },
        address: { type: "string", description: "Property address for context." },
        borough: { type: "string" },
      },
      required: ["name"],
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

function buildSystem() {
  return `You are **Scout**, the in-house acquisitions agent for a firm ("Crown") that buys trophy / high-street RETAIL property in New York City. You drive FRONTAGE's data engines on the team's behalf so they don't have to learn the filters or hop between tabs. Be sharp, concise, and operational — you are talking to working deal-makers.

WHAT YOU DO
- Turn a plain-English request into the right sequence of tool calls, then SYNTHESIZE — don't just dump rows. Rank, flag the motivated owners, and explain the read.
- Default thesis when unspecified: trophy / high-street RETAIL. If the user names another asset type or neighborhood, follow that.
- Always begin a sourcing task with search_properties. Use its borough/block/lot, owner name, mailing address, and lat/lon to drive the follow-on tools (property_intel, transaction_history, foot_traffic, owner/hidden portfolio, web_research).

HOW TO REASON ABOUT MOTIVATION (the firm's wedge = finding off-market motivated owners)
- Strong seller signals: long hold (15+ years owned), absentee / out-of-state owner, tax lien or ECB penalties owed, maturing/old mortgage, underbuilt lot with air rights, storefront vacancy. Call these out explicitly when you see them.
- For INSTITUTIONAL / named owners (REITs, developers, management cos): use web_research to identify the decision-maker and acquisitions/dispositions contact.
- For anonymous single-asset LLCs: use property_intel to surface named HPD officers, then hidden_portfolio to map the human's other buildings.

CONTACTS — COST DISCIPLINE
- reveal_contact is a PAID skip trace (~$0.10 per match). Call it ONLY when the user explicitly asks to get an owner's phone/contact for a specific property, and one at a time — never speculatively or across a whole list. When you do, say plainly it's a paid lookup. For institutional owners prefer web_research (free) first.

STYLE
- Lead with the answer. Use tight markdown: short bold headers, bullets, and a property's address in **bold**. When you list candidates, order them by how worth-pursuing they are and give a one-line "why" each.
- Be honest about data limits (NYC has no public lease-expiration feed; skip traces on big commercial addresses can return occupants not owners; PLUTO owner names are often per-building LLCs). Never invent owners, numbers, or contacts.
- If a request is ambiguous (which borough? radius? asset type?), make a sensible default, state the assumption in one line, and proceed — don't stall with questions unless truly necessary.`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, messages, check, debug } = req.body || {};

    if (process.env.SITE_PASSWORD) {
      if (password !== process.env.SITE_PASSWORD) {
        return res.status(401).json({ error: "Incorrect password." });
      }
    }
    if (check) return res.status(200).json({ ok: true });
    if (debug) {
      return res.status(200).json({ ok: true, model: AGENT_MODEL, tools: TOOLS.map((t) => t.name), build: "agent-v1" });
    }

    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: "messages array required" });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY" });
    }

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: AGENT_MODEL,
        max_tokens: MAX_TOKENS,
        system: buildSystem(),
        tools: TOOLS,
        messages,
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
