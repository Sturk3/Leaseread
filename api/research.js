// FRONTAGE — Engine 2: AI web-research agent.
// Given a property + owner, runs Claude with the web_search server tool to compile a
// concise off-market acquisitions intelligence brief (who's behind the LLC, portfolio,
// recent news/distress signals, the asset, and whether it's worth pursuing).
// Key stays server-side; password-gated like every other endpoint.

// Model for the research brief. Defaults to Sonnet 4.6 (fast; finishes web search well
// within Vercel Pro's 300s budget). Override RESEARCH_MODEL=claude-opus-4-8 for maximum
// research depth/quality once on Pro. (Env-configurable so no code change is needed.)
const RESEARCH_MODEL = process.env.RESEARCH_MODEL || "claude-sonnet-4-6";
// How many web_search rounds the agent may run. Vercel Hobby (60s) only fits ~1; Vercel
// Pro (300s) can go deeper for a richer brief — default 5, override RESEARCH_MAX_SEARCHES.
// Only used in WEB mode (knowledge mode runs no searches), so this is inert until the
// frontend is flipped to mode:"web" (which only makes sense on Pro's higher timeout).
const MAX_SEARCHES = Number(process.env.RESEARCH_MAX_SEARCHES) || 5;

function buildSystem() {
  return `You are an off-market real estate acquisitions research analyst for a firm that buys trophy / high-street RETAIL property (primarily NYC, expanding nationwide). You are given a PROPERTY (an address, and often — but not always — its owner of record). Use the web_search tool to find WHO owns it, their PORTFOLIO, and HOW TO REACH them, then write a tight intelligence brief.

WORK THE CHAIN with multiple searches as needed (don't narrate them — output ONLY the final brief):
1. If the owner isn't given, IDENTIFY it from the web first: property/assessor records, the building's own site, news, listings, business registries. Name the owning entity (often an LLC).
2. UNMASK it: the parent company or management/operating firm behind the LLC, and the actual principals / decision-makers.
3. PORTFOLIO: pull their other holdings and how active they are (look at the company's own website "portfolio/properties" pages, press, deal news).
4. CONTACTS: dig the owner's / management company's OFFICIAL WEBSITE and reputable listings for PUBLICLY-LISTED institutional contacts — main/leasing/acquisitions phone lines, info@/leasing@ emails, the contact or team page. These published business numbers are exactly what you should surface; personal cell numbers generally are NOT on the open web (those need skip tracing).

Format in markdown (omit a section only if you truly found nothing):
- **Owner** — the entity of record and how you determined it (source).
- **Who's behind it** — parent/management firm + named principals/decision-makers.
- **Contacts found** — every PUBLICLY-LISTED phone/email/website that literally appeared in results, each on its own line WITH its source (e.g. "Leasing 212-555-0100 — thorequities.com/contact"). This is the most valuable section — prioritize the company website's own contact/team page.
- **Portfolio & track record** — other holdings, activity, buy/sell history.
- **Signals** — news, financing/maturing debt, litigation, distress, redevelopment plans — anything hinting at motivation to sell.
- **Bottom line** — 1–2 sentences: plausible motivated seller? worth the team's time?

Rules: Ground every claim in what you found and name the source inline. For "Contacts found": include ONLY phone numbers, emails, or sites you LITERALLY saw in a result, each with its source — NEVER guess or pattern-construct an email/number (no firstname@company.com), and never present an unconfirmed contact as real. If something is thin or unconfirmed, say so plainly — never fabricate. Concise (aim under ~450 words). This is for professional real-estate sourcing.`;
}

// Knowledge-only brief (no web). Fast, but the model only knows public, well-known
// entities — so it must refuse to invent anything for owners it doesn't recognize.
function buildSystemKnowledge() {
  return `You are a real estate acquisitions analyst at a firm buying trophy / high-street RETAIL. Using ONLY your own knowledge (you have no web access), write a short brief about this property's owner — focused on WHO they are and HOW TO REACH the decision-maker.

CRITICAL HONESTY RULE: Only state facts you actually know about THIS specific entity. Most owners are small, private single-asset LLCs you will NOT recognize — if so, say exactly that in one line ("I don't recognize this owner; it appears to be a private single-asset entity — use skip tracing for a direct contact") and stop. NEVER invent principals, phone numbers, emails, portfolios, or history, and never fabricate or pattern-guess a contact.

If it IS a recognizable company / REIT / institutional owner / well-known developer, give, in markdown (omit any section you don't actually know):
- **Who they are** — the firm, its parent, and key principals/executives.
- **How to reach them** — the realistic path to the decision-maker: the firm's corporate HQ city, the relevant team (acquisitions / dispositions / asset management / leasing), and whether they typically transact directly or through brokers. Name specific executives ONLY if you genuinely know them. Do NOT guess phone numbers or emails — say where to find the contact instead (e.g. "their website's acquisitions page", "LinkedIn").
- **Portfolio & posture** — what they hold, how active they are, and whether they're a plausible seller of this asset.

Keep it under 250 words. Your knowledge has a cutoff and may be out of date — flag uncertainty rather than assert.`;
}

// Free-form web research ("the scraper"): Scout passes an arbitrary query and we run
// live web search + synthesize. GENERAL-PURPOSE — Scout can look up anything, like a
// normal assistant with web access; it just happens to be expert at real estate too.
function buildSystemQuery() {
  return `You are a capable research assistant with live web access via the web_search tool. Answer the user's request by searching the web as needed, then synthesize a clear, well-organized answer — exactly like a knowledgeable assistant would.

Run focused searches (don't narrate them), then write ONLY the final answer in clean markdown. Ground factual claims in what you found and cite sources inline (publication/site, with the URL when useful). If results are thin or conflicting, say so. Never fabricate facts, numbers, quotes, or contacts — and when surfacing someone's contact details, include only what literally appeared in a result, with its source; never guess or pattern-construct an email or phone.

CONTEXT: the user works in commercial real estate (sourcing trophy / high-street retail and reaching property owners), so when a request is in that domain, lean in and be genuinely useful. But you are NOT limited to real estate — answer ANYTHING the user asks, on any topic. Be concise by default; go longer only when the request clearly needs it.`;
}
// Knowledge-only fallback for free-form queries (used until live web is enabled).
function buildSystemQueryKnowledge() {
  return `You are a capable research assistant, but right now you have NO web access. Answer the user's request from your own knowledge — useful and direct, on ANY topic (you are not limited to one subject). Be rigorously honest: flag that your knowledge has a cutoff and may be stale, and for anything needing current or specific live data (recent events, prices, a person/company's latest status, live contacts) say plainly that live web search is needed rather than guessing. Never fabricate facts, numbers, or contacts. Concise markdown.`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, query, name, entity_type, address, borough, contact_address, city, state, last_sale_date, last_sale_price, years_owned } = req.body || {};

    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    // Zero-cost deploy/version probe (no Anthropic call). liveWeb reflects the env gate.
    if (req.body && req.body.debug) {
      return res.status(200).json({ ok: true, model: RESEARCH_MODEL, maxSearches: MAX_SEARCHES, liveWeb: process.env.RESEARCH_LIVE_WEB !== "0", build: "v9-live" });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY" });
    }
    const freeQuery = typeof query === "string" ? query.trim() : "";
    if (!freeQuery && !name && !address) return res.status(400).json({ error: "Need a query, owner name, or address to research." });

    // Web mode is GATED behind the RESEARCH_LIVE_WEB env flag. Live web search needs
    // ~minutes, which only fits Vercel Pro's 300s timeout — so until that flag is set we
    // transparently fall back to knowledge mode and Hobby's 60s never times out.
    // ACTIVATION (once on Pro): set RESEARCH_LIVE_WEB=1 + raise research.js maxDuration to
    // 300 in vercel.json + redeploy. No other code change needed.
    // Live web is now ON by default (the project is on Vercel Pro, so research.js has the
    // 300s timeout web search needs). To turn it back OFF — e.g. if you downgrade to Hobby
    // — set env RESEARCH_LIVE_WEB=0 (and drop research.js maxDuration back to 60 in
    // vercel.json, which Hobby requires).
    const wantWeb = (req.body.mode || "web") !== "knowledge";
    const useWeb = wantWeb && process.env.RESEARCH_LIVE_WEB !== "0";

    let userText, systemPrompt;
    if (freeQuery) {
      // The "scraper": an arbitrary research request from Scout (or any caller).
      userText = freeQuery;
      systemPrompt = useWeb ? buildSystemQuery() : buildSystemQueryKnowledge();
    } else {
      const facts = [
        address ? `Property address: ${address}${borough ? `, ${borough}` : ""}, New York` : null,
        name ? `Owner of record: ${name}${entity_type ? ` (${entity_type})` : ""}` : null,
        contact_address ? `Owner mailing address: ${[contact_address, [city, state].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}` : null,
        last_sale_date ? `Last sale: ${String(last_sale_date).slice(0, 4)}${last_sale_price ? ` for $${Number(last_sale_price).toLocaleString()}` : ""}` : null,
        years_owned != null ? `Years owned: ~${years_owned}` : null,
      ].filter(Boolean).join("\n");
      userText = `Research this NYC retail property and its owner, then write the brief.\n\n${facts}`;
      systemPrompt = useWeb ? buildSystem() : buildSystemKnowledge();
    }

    let messages = [{ role: "user", content: [{ type: "text", text: userText }] }];
    const parts = [];
    let last = null;

    // The web_search server tool runs a search loop server-side; if it hits its
    // iteration cap the response comes back as stop_reason "pause_turn" and we
    // re-send to let it continue. Bounded so a runaway can't burn the budget — raised
    // to 6 so a deeper multi-search run (on Pro) can finish its continuation legs.
    for (let i = 0; i < 6; i++) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: RESEARCH_MODEL,
          max_tokens: freeQuery ? 3200 : 2600,
          system: systemPrompt,
          ...(useWeb ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES }] } : {}),
          messages,
        }),
      });
      const raw = await r.text();
      let data;
      try { data = JSON.parse(raw); } catch {
        return res.status(502).json({ error: "Anthropic returned a non-JSON response", anthropic_status: r.status, snippet: raw.slice(0, 300) });
      }
      if (!r.ok) return res.status(r.status).json(data);
      last = data;
      for (const block of data.content || []) {
        if (block.type === "text" && block.text) parts.push(block.text);
      }
      if (data.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: data.content });
    }

    const brief = parts.join("").trim();
    return res.status(200).json({
      brief: brief || "No usable web information was found for this property and owner.",
      model: RESEARCH_MODEL,
      stop_reason: last && last.stop_reason,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "research" });
  }
}
