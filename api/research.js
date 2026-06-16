// FRONTAGE — Engine 2: AI web-research agent.
// Given a property + owner, runs Claude with the web_search server tool to compile a
// concise off-market acquisitions intelligence brief (who's behind the LLC, portfolio,
// recent news/distress signals, the asset, and whether it's worth pursuing).
// Key stays server-side; password-gated like every other endpoint.

// Model for the research brief. Sonnet 4.6 — fast + cheap enough to finish a
// web-search run inside Vercel's 60s function limit (Opus 4.8 was timing out and
// burning tokens without returning). Bump to "claude-opus-4-8" for max quality only
// if you also raise the function timeout (needs a Vercel Pro plan).
const RESEARCH_MODEL = "claude-sonnet-4-6";
// Each web_search round is a slow round-trip; >1 was blowing past Vercel's hard 60s
// function limit. One focused search reliably fits and still grounds the brief.
const MAX_SEARCHES = 1;

function buildSystem() {
  return `You are an off-market real estate acquisitions research analyst for a firm that buys trophy / high-street RETAIL property in New York City. You are given one property and its owner of record (often an LLC). Use the web_search tool to compile a tight intelligence brief that helps the deal team decide whether to pursue the owner and how to reach the decision-maker.

Be fast: run ONE focused web search (the owner/entity name + address or "New York"), then immediately write the brief from those results. Do NOT narrate your searching — output ONLY the final brief.

Format the brief in markdown with these sections (omit a section only if you truly found nothing for it):
- **Who's behind it** — the real principals/decision-makers behind the entity, any parent company or management firm, and any contact clues (names, affiliated firms).
- **Contacts found** — any PUBLICLY-LISTED phone number, email, or website for the owner, its management company, or the principals that actually appeared in your search results. Put each on its own line with its source (e.g. "Leasing line 212-555-0100 — via the firm's website"). This is the most valuable section when present.
- **Portfolio & track record** — other holdings, how active they are, buy/sell history.
- **Signals** — recent news, financing/maturing debt, litigation, distress, redevelopment plans, or anything suggesting motivation to sell.
- **The asset** — current tenant(s)/occupancy, any listing or availability, redevelopment or air-rights angle.
- **Bottom line** — 1–2 sentences: is this plausibly a motivated seller and is it worth the team's time?

Rules: Be concise (under ~400 words). Ground every claim in what you found and name the source inline (publication or site). For "Contacts found": include ONLY phone numbers, emails, or sites you literally saw in a search result, each with its source — NEVER guess or construct an email from a name/pattern (e.g. do not invent firstname@company.com), and never present an unconfirmed contact as real. If information is thin or you cannot confirm something, say so plainly — never fabricate names, numbers, or contacts. These will be business/office contacts; personal cell numbers are generally not on the open web. This is for professional real-estate sourcing.`;
}

// Knowledge-only brief (no web). Fast, but the model only knows public, well-known
// entities — so it must refuse to invent anything for owners it doesn't recognize.
function buildSystemKnowledge() {
  return `You are a real estate acquisitions analyst at a firm buying trophy/high-street RETAIL in NYC. Using ONLY your own knowledge (you have no web access), write a short brief about this property's owner.

CRITICAL HONESTY RULE: Only state facts you actually know about THIS specific entity. Most NYC owners are small, private single-asset LLCs you will NOT recognize — if so, say exactly that in one line ("I have no specific information on this owner; it appears to be a private single-asset entity — use the web research mode or skip tracing") and stop. Do NOT invent principals, phone numbers, portfolios, or history. Never fabricate a contact.

If it IS a recognizable company / REIT / well-known developer, give: who they are, parent/principals, the kind of portfolio they hold, reputation, and whether they're plausibly a seller. Keep it under 250 words, markdown. Note that your knowledge has a cutoff and may be out of date.`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, name, entity_type, address, borough, contact_address, city, state, last_sale_date, last_sale_price, years_owned } = req.body || {};

    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    // Zero-cost deploy/version probe (no Anthropic call).
    if (req.body && req.body.debug) {
      return res.status(200).json({ ok: true, model: RESEARCH_MODEL, maxSearches: MAX_SEARCHES, build: "v5-lite-search" });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY" });
    }
    if (!name && !address) return res.status(400).json({ error: "Need an owner name or address to research." });

    const facts = [
      address ? `Property address: ${address}${borough ? `, ${borough}` : ""}, New York` : null,
      name ? `Owner of record: ${name}${entity_type ? ` (${entity_type})` : ""}` : null,
      contact_address ? `Owner mailing address: ${[contact_address, [city, state].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}` : null,
      last_sale_date ? `Last sale: ${String(last_sale_date).slice(0, 4)}${last_sale_price ? ` for $${Number(last_sale_price).toLocaleString()}` : ""}` : null,
      years_owned != null ? `Years owned: ~${years_owned}` : null,
    ].filter(Boolean).join("\n");

    const userText = `Research this NYC retail property and its owner, then write the brief.\n\n${facts}`;

    // mode "web" (default) = live web search; "knowledge" = Sonnet's own knowledge only
    // (instant, but only reliable for well-known owners — see buildSystemKnowledge).
    const useWeb = (req.body.mode || "web") !== "knowledge";

    let messages = [{ role: "user", content: [{ type: "text", text: userText }] }];
    const parts = [];
    let last = null;

    // The web_search server tool runs a search loop server-side; if it hits its
    // iteration cap the response comes back as stop_reason "pause_turn" and we
    // re-send to let it continue. Bounded so a runaway can't burn the budget.
    for (let i = 0; i < 2; i++) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: RESEARCH_MODEL,
          max_tokens: 1500,
          system: useWeb ? buildSystem() : buildSystemKnowledge(),
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
