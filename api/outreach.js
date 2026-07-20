// FRONTAGE — AI Outreach Studio. Turns ONE property + owner into a ready-to-send
// outreach kit: a cold-call opener, a voicemail script, an email, and a text — each
// personalized from the property's REAL signals (corridor, availability read, tenure,
// last trade, the LLC). The "cheaper-Terrakotta" wow: their signature personalized-
// voicemail move, minus the auto-dialer (a human still sends/dials — no telephony,
// no TCPA exposure from automated calling).
//
// One short Claude call, no web search — grounded entirely in the facts passed in, so
// it's fast (~2s) and cheap (~$0.02). Password-gated; key stays server-side.
//
//   POST /api/outreach { password, owner, address, ...signals } → { kit: {...} }

const OUTREACH_MODEL = process.env.OUTREACH_MODEL || "claude-sonnet-4-6";

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

function buildSystem() {
  return `You are an elite acquisitions outreach copywriter for a firm that quietly BUYS trophy / high-street RETAIL real estate (primary focus: King Street Charleston and Manhattan high-street corridors). Your job: given ONE property and its owner, write a short, sharp outreach kit the acquisitions lead will use to open a conversation with that owner about a possible OFF-MARKET purchase.

You will get a set of FACTS about the property (address, corridor, an availability/turnover read with the reasons behind it, how long the owner has held it, last sale, the owning entity). Use them to make every message feel specific and researched — NOT a mass blast.

Return ONLY a JSON object (no prose, no markdown fences) with exactly these keys:
{
  "hook": "one sentence — the single sharpest, true personalization angle you'd lead with",
  "call_opener": "a cold-call opening script, ~70-90 words, natural and spoken, warm and low-pressure — introduce, give the specific reason for the call tied to THIS property, ask an open question. Not salesy.",
  "voicemail": "a ~20-second voicemail (~55-70 words) to leave if they don't pick up — friendly, references the property, gives a concrete reason to call back, ends with a callback ask.",
  "email_subject": "a short, specific, non-spammy subject line (no ALL CAPS, no clickbait)",
  "email_body": "a concise professional email, 90-140 words, personalized to the property and owner, single clear ask (a brief call), warm sign-off.",
  "sms": "a compliant 1-2 sentence text: identify the sender, reference the property, soft ask, easy out. Under 320 characters."
}

HARD RULES:
- Ground every specific in the FACTS given. NEVER invent a price, a plan, a name, a relationship, or a detail you weren't given. If a fact isn't provided, don't reference it.
- The owner is often a single-asset LLC; address the human reading it respectfully without pretending to know their name if it wasn't given.
- Use square-bracket placeholders for the SENDER's own details the caller fills in: [Your name], [Your firm], [Your phone], [Your email]. Never fabricate those.
- Tone: a credible principal buyer reaching out directly — respectful, specific, no hype, no pressure, no fake urgency. These owners get pitched constantly; sound different by being precise and low-key.
- This is a genuine off-market acquisition inquiry, not a trick. No misrepresentation.
- Output strictly the JSON object and nothing else.`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const b = req.body || {};
    if (process.env.SITE_PASSWORD && b.password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    if (b.debug) return res.status(200).json({ ok: true, model: OUTREACH_MODEL, build: "outreach-v1" });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY" });

    const owner = clean(b.owner);
    const address = clean(b.address);
    if (!owner && !address) return res.status(400).json({ error: "Need at least an owner or an address to draft outreach." });

    const reasons = Array.isArray(b.availability_reasons) ? b.availability_reasons.map(clean).filter(Boolean) : [];
    const pct = b.availability_probability != null ? Math.round(Number(b.availability_probability) * 100) : null;
    const facts = [
      address ? `Property: ${address}` : null,
      b.corridor_name ? `Corridor: ${b.corridor_name}${b.tier ? ` (${clean(b.tier)} stretch)` : ""}` : null,
      b.market ? `Market: ${clean(b.market)}` : null,
      owner ? `Owner of record: ${owner}${b.principal ? ` — named principal: ${clean(b.principal)}` : ""}` : null,
      b.use ? `Use / class: ${clean(b.use)}` : null,
      b.years_owned != null && b.years_owned !== "" ? `Held for ~${clean(b.years_owned)} years` : null,
      b.last_sale_date ? `Last sale: ${String(b.last_sale_date).slice(0, 4)}${b.last_sale_price ? ` for $${Number(b.last_sale_price).toLocaleString("en-US")}` : ""}` : null,
      pct != null ? `Availability/turnover read: ${pct}% likelihood, based on public-records signals` : null,
      reasons.length ? `Turnover signals: ${reasons.join("; ")}` : null,
      b.mailing ? `Owner mailing address on file: ${clean(b.mailing)}` : null,
    ].filter(Boolean).join("\n");

    const userText = `Write the outreach kit for this property and owner. Lead with the strongest TRUE angle from these facts.\n\n${facts}`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: OUTREACH_MODEL,
        max_tokens: 1600,
        system: buildSystem(),
        messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
      }),
    });
    const rawTxt = await r.text();
    let data;
    try { data = JSON.parse(rawTxt); } catch { return res.status(502).json({ error: "Anthropic returned non-JSON", snippet: rawTxt.slice(0, 200) }); }
    if (!r.ok) return res.status(r.status).json(data);

    const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
    // The model was told to emit bare JSON; be tolerant of stray fences/prose around it.
    let kit = null;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      kit = JSON.parse(m ? m[0] : text);
    } catch {
      return res.status(200).json({ error: "Could not parse the outreach kit — try again.", raw: text.slice(0, 500) });
    }

    return res.status(200).json({
      kit: {
        hook: clean(kit.hook),
        call_opener: clean(kit.call_opener),
        voicemail: clean(kit.voicemail),
        email_subject: clean(kit.email_subject),
        email_body: String(kit.email_body || "").trim(),
        sms: clean(kit.sms),
      },
      model: OUTREACH_MODEL,
      usage: data.usage || null,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "outreach" });
  }
}
