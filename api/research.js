// FRONTAGE — Engine 2: AI web-research agent.
// Given a property + owner, runs Claude with the web_search server tool to compile a
// concise off-market acquisitions intelligence brief (who's behind the LLC, portfolio,
// recent news/distress signals, the asset, and whether it's worth pursuing).
// Key stays server-side; password-gated like every other endpoint.

// Model for the research brief. Claude Opus 5 — Anthropic's best Opus for research and
// synthesis, at Opus 4.8's price ($5/$25 per MTok). Accuracy is the priority for these
// briefs; env-override RESEARCH_MODEL if it ever needs to drop back.
const RESEARCH_MODEL = process.env.RESEARCH_MODEL || "claude-opus-5";
// How many web_search rounds the agent may run. Raised 8 → 12 for deeper owner/portfolio/
// contact digging (accuracy over cost); Vercel Pro's 300s budget still fits this. Override
// RESEARCH_MAX_SEARCHES; if briefs start timing out, drop back toward 8.
const MAX_SEARCHES = Number(process.env.RESEARCH_MAX_SEARCHES) || 12;

function buildSystem() {
  return `You are an off-market real estate acquisitions research analyst for a firm that buys trophy / high-street RETAIL property. Its two primary hunting grounds are NEW YORK CITY (Manhattan high-street corridors — Fifth Ave, Madison, SoHo, Meatpacking) and CHARLESTON, SC — above all KING STREET, Charleston's premier retail corridor (Upper/Lower King), plus the surrounding downtown/peninsula. Treat properties on or near these as high priority and lean in hard. You are given a PROPERTY (an address, and often — but not always — its owner of record). Use the web_search tool to find WHO owns it, their PORTFOLIO, and HOW TO REACH them, then write a DEEP, exhaustive intelligence brief.

WORK THE CHAIN with multiple searches as needed (don't narrate them — output ONLY the final brief):
1. If the owner isn't given, IDENTIFY it from the web first: property/assessor records, the building's own site, news, listings, business registries. Name the owning entity (often an LLC).
2. UNMASK it: the parent company or management/operating firm behind the LLC, and the actual principals / decision-makers.
3. PORTFOLIO: pull their other holdings and how active they are (look at the company's own website "portfolio/properties" pages, press, deal news).
4. CONTACTS: dig the owner's / management company's OFFICIAL WEBSITE and reputable listings for PUBLICLY-LISTED institutional contacts — main/leasing/acquisitions phone lines, info@/leasing@ emails, the contact or team page. These published business numbers are exactly what you should surface; personal cell numbers generally are NOT on the open web (those need skip tracing).
5. READ THE PAGES: when a search surfaces a promising URL — the company's contact/team/portfolio page, a registry entry, a news piece — use web_fetch to OPEN it and read the full page rather than relying on the snippet. Contact pages especially: fetch them so you capture every phone/email actually published there.

Format in markdown (omit a section only if you truly found nothing):
- **Owner** — the entity of record and how you determined it (source).
- **Who's behind it** — parent/management firm + named principals/decision-makers.
- **Contacts found** — every PUBLICLY-LISTED phone/email/website that literally appeared in results, each on its own line WITH its source (e.g. "Leasing 212-555-0100 — thorequities.com/contact"). This is the most valuable section — prioritize the company website's own contact/team page.
- **Portfolio & track record** — other holdings, activity, buy/sell history.
- **Signals** — news, financing/maturing debt, litigation, distress, redevelopment plans — anything hinting at motivation to sell.
- **Bottom line** — 1–2 sentences: plausible motivated seller? worth the team's time?

Rules: Ground every claim in what you found and name the source inline. For "Contacts found": include ONLY phone numbers, emails, or sites you LITERALLY saw in a result, each with its source — NEVER guess or pattern-construct an email/number (no firstname@company.com), and never present an unconfirmed contact as real. If something is thin or unconfirmed, say so plainly — never fabricate. Be MAXIMALLY thorough and decision-grade — run as many searches as it takes and surface EVERY owner detail, principal, related entity, portfolio property, contact, and signal you actually found; err toward completeness over brevity (a long, fully-sourced brief is the goal — but detail must come from real findings, never padding or repetition). This is for professional real-estate sourcing.`;
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

Run focused searches (don't narrate them), and when a result looks load-bearing use web_fetch to open the page and read it in full rather than trusting the snippet. Then write ONLY the final answer in clean markdown. Ground factual claims in what you found and cite sources inline (publication/site, with the URL when useful). If results are thin or conflicting, say so. Never fabricate facts, numbers, quotes, or contacts — and when surfacing someone's contact details, include only what literally appeared in a result, with its source; never guess or pattern-construct an email or phone.

CONTEXT: the user works in commercial real estate (sourcing trophy / high-street retail and reaching property owners), with two primary focuses — NEW YORK CITY high-street corridors and CHARLESTON, SC (above all KING STREET). When a request is in that domain, lean in HARD and be exhaustive: run as many searches as it takes and surface every owner, principal, registered agent, related entity, portfolio property, contact, and signal you actually find — err toward a long, fully-sourced answer over a short one. But you are NOT limited to real estate — answer ANYTHING the user asks, on any topic; for those, match the length to the request (concise when that's all it needs). Detail must always come from real findings, never padding.`;
}
// Knowledge-only fallback for free-form queries (used until live web is enabled).
function buildSystemQueryKnowledge() {
  return `You are a capable research assistant, but right now you have NO web access. Answer the user's request from your own knowledge — useful and direct, on ANY topic (you are not limited to one subject). Be rigorously honest: flag that your knowledge has a cutoff and may be stale, and for anything needing current or specific live data (recent events, prices, a person/company's latest status, live contacts) say plainly that live web search is needed rather than guessing. Never fabricate facts, numbers, or contacts. Concise markdown.`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, query, name, entity_type, address, borough, contact_address, city, state, last_sale_date, last_sale_price, years_owned, anthropicKey } = req.body || {};
    // BYOK: a user-supplied key (kept in their browser, sent per-request) wins over the
    // server env key, so usage bills the user's Anthropic account, not the site owner's.
    const AI_KEY = String(anthropicKey || "").trim() || process.env.ANTHROPIC_API_KEY;

    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    // Zero-cost deploy/version probe (no Anthropic call). liveWeb reflects the env gate.
    if (req.body && req.body.debug) {
      return res.status(200).json({ ok: true, model: RESEARCH_MODEL, maxSearches: MAX_SEARCHES, liveWeb: process.env.RESEARCH_LIVE_WEB !== "0", build: "v11-opus5" });
    }
    if (!AI_KEY) {
      return res.status(500).json({ error: "No AI key. Click 🔑 API KEY in the top bar and paste your Anthropic key (console.anthropic.com) — it stays in your browser and usage bills to your account." });
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

    // Optional "build on top": a prior answer from an earlier lookup. When present we ask
    // the model to extend/update it rather than start cold — so saved answers compound.
    const prior = typeof req.body.prior === "string" ? req.body.prior.trim() : "";
    if (prior) {
      userText += `\n\nPRIOR FINDINGS FROM AN EARLIER LOOKUP — build ON TOP of this: confirm or correct what's here, ADD anything new you can find, and note what changed. Do not simply repeat it.\n"""\n${prior.slice(0, 6000)}\n"""`;
    }

    let messages = [{ role: "user", content: [{ type: "text", text: userText }] }];
    const parts = [];
    let last = null;

    // The web_search server tool runs a search loop server-side; if it hits its
    // iteration cap the response comes back as stop_reason "pause_turn" and we
    // re-send to let it continue. Bounded so a runaway can't burn the budget — 16 legs
    // so a deeper multi-search run (MAX_SEARCHES up to 12, on Pro) can finish all its
    // continuation legs without being cut off mid-brief.
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, web_search_requests: 0 };
    const sources = []; const seenSrc = new Set(); // verifiable citations from the web-search results
    for (let i = 0; i < 16; i++) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": AI_KEY,
          "anthropic-version": "2023-06-01",
          // Server-side refusal fallback: rare classifier false-positives on owner/contact
          // research get re-run on the recommended fallback model instead of failing.
          "anthropic-beta": "server-side-fallback-2026-07-01",
        },
        body: JSON.stringify({
          model: RESEARCH_MODEL,
          fallbacks: "default",
          // Roomy ceiling so a deep, fully-sourced brief isn't cut off. On Opus 5 thinking
          // is ON by default and counts toward max_tokens, so this includes thinking
          // headroom. A cap, not a target — a thin lookup still returns short.
          max_tokens: 16000,
          system: systemPrompt,
          // web_search_20260209: the current tool version with dynamic filtering — Claude
          // filters search results in code before they hit context, so more of the budget
          // goes to relevant sources. web_fetch lets it then OPEN the promising results
          // (a company's contact/team page, a registry entry, a news piece) and read the
          // full page instead of just the search snippet — the "scrape" upgrade.
          ...(useWeb ? { tools: [
            { type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES },
            { type: "web_fetch_20260209", name: "web_fetch", max_uses: 8, max_content_tokens: 25000 },
          ] } : {}),
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
      const u = data.usage || {};
      usage.input_tokens += u.input_tokens || 0;
      usage.output_tokens += u.output_tokens || 0;
      usage.cache_read_input_tokens += u.cache_read_input_tokens || 0;
      usage.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
      usage.web_search_requests += (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
      for (const block of data.content || []) {
        if (block.type === "text" && block.text) parts.push(block.text);
        // Collect the actual web sources the search returned, so the brief is verifiable.
        if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
          for (const r of block.content) {
            const url = r && r.url;
            if (!url || seenSrc.has(url)) continue;
            seenSrc.add(url);
            sources.push({ url, title: String(r.title || url).replace(/\s+/g, " ").trim().slice(0, 160) });
          }
        }
        // Pages the model opened with web_fetch are sources too (often THE source for contacts).
        if (block.type === "web_fetch_tool_result" && block.content && block.content.url && !seenSrc.has(block.content.url)) {
          seenSrc.add(block.content.url);
          sources.push({ url: block.content.url, title: String((block.content.document && block.content.document.title) || block.content.url).replace(/\s+/g, " ").trim().slice(0, 160) });
        }
      }
      if (data.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: data.content });
    }

    const brief = parts.join("").trim();
    return res.status(200).json({
      brief: brief || "No usable web information was found for this property and owner.",
      model: RESEARCH_MODEL,
      stop_reason: last && last.stop_reason,
      usage,
      sources: sources.slice(0, 20),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "research" });
  }
}
