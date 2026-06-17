// FRONTAGE — FREE owner-contact finder (the first lane of the contact waterfall).
//
// Looks up an owner's PUBLICLY-PUBLISHED contact info — company website, leasing
// line, office phone, email, principals — by running a fast web search ourselves
// (Brave Search API, ~2s) and then having Claude extract only the contacts that
// actually appear in the results. This deliberately avoids Anthropic's slow server-
// side web_search tool (which blew past Vercel's 60s limit); fetching results
// ourselves + a quick synthesis pass fits comfortably under the limit.
//
// This is the cheap first pass: if it finds a usable business contact, great ($0).
// If it whiffs (an anonymous single-asset LLC with no web presence), the frontend
// falls back to the paid skip trace (/api/skiptrace). Password-gated; keys server-side.
//
// Needs BRAVE_API_KEY to search. ANTHROPIC_API_KEY is optional — with it, Claude
// cleans/dedupes the contacts; without it, we still return regex-extracted hits +
// the raw results. Returns { noKey:true } gracefully when Brave isn't configured.

const SYNTH_MODEL = "claude-sonnet-4-6"; // fast + cheap; only summarizes provided snippets

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const isCompany = (name, entityType) =>
  entityType === "company" ||
  /\b(LLC|INC|CORP|CO|COMPANY|LP|LLP|TRUST|ASSOCIATES|REALTY|PARTNERS|HOLDINGS|GROUP|MANAGEMENT|PROPERTIES|HDFC|FUND|BANK)\b/i.test(name || "");

const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

function extractFromText(text) {
  const phones = [], emails = [];
  for (const m of String(text).matchAll(PHONE_RE)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length === 10 || (digits.length === 11 && digits[0] === "1")) phones.push(m[0].trim());
  }
  for (const m of String(text).matchAll(EMAIL_RE)) emails.push(m[0].toLowerCase());
  return { phones, emails };
}
const uniq = (a) => [...new Set(a.filter(Boolean))];
const dedupePhones = (a) => {
  const seen = new Set(), out = [];
  for (const p of a) { const d = p.replace(/\D/g, "").slice(-10); if (d.length === 10 && !seen.has(d)) { seen.add(d); out.push(p); } }
  return out;
};

async function braveSearch(key, query) {
  const base = process.env.BRAVE_BASE || "https://api.search.brave.com/res/v1/web/search";
  const url = `${base}?q=${encodeURIComponent(query)}&count=10`;
  const r = await fetch(url, { headers: { Accept: "application/json", "X-Subscription-Token": key } });
  if (!r.ok) throw new Error(`Brave ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const j = await r.json().catch(() => ({}));
  return (j.web && j.web.results ? j.web.results : []).map((x) => ({
    title: clean(x.title), url: clean(x.url), description: clean(x.description),
  }));
}

// Optional Claude pass — extract ONLY contacts that literally appear in the snippets.
async function synthesize(apiKey, owner, results) {
  const blob = results.map((x, i) => `[${i + 1}] ${x.title}\n${x.url}\n${x.description}`).join("\n\n");
  const sys = `You extract real, publicly-listed business contact info from web search results for a real-estate sourcing team trying to reach a property owner. You are given the owner/entity name and a list of search results (title, url, snippet).

Return ONLY a JSON object (no prose, no code fence) with this shape:
{"phones":[],"emails":[],"website":"","principals":[],"summary":""}

RULES:
- Include ONLY phone numbers and emails that LITERALLY appear in the provided snippets. NEVER invent or guess a number/email, and never construct an email from a name pattern.
- "website": the owner's or its management company's official site if clearly present, else "".
- "principals": names of people clearly associated with the owner/entity that appear in the results (else []).
- "summary": one sentence on who this owner appears to be and the best way to reach them. If the results don't clearly correspond to THIS owner (common for generic LLC names), say so and return empty arrays.`;
  const body = {
    model: SYNTH_MODEL, max_tokens: 700,
    system: sys,
    messages: [{ role: "user", content: `Owner/entity: ${owner}\n\nSearch results:\n${blob}` }],
  };
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}`);
  const j = await r.json();
  const text = (j.content || []).map((b) => b.text || "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, name, entity_type, contact_address, city, state, borough } = req.body || {};
    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }

    const braveKey = process.env.BRAVE_API_KEY;
    if (req.body && req.body.debug) {
      return res.status(200).json({ ok: true, braveConfigured: !!braveKey, synthConfigured: !!process.env.ANTHROPIC_API_KEY, build: "findcontact-v1" });
    }
    if (!braveKey) return res.status(200).json({ noKey: true, keyEnv: "BRAVE_API_KEY", provider: "Brave Search" });
    if (!name) return res.status(400).json({ error: "Need an owner name to look up." });

    const owner = clean(name);
    const place = clean(city) || clean(borough) || "New York";
    const region = clean(state) || "NY";
    // One focused query — entity name + place + contact intent.
    const company = isCompany(name, entity_type);
    const query = company
      ? `"${owner}" ${place} ${region} (contact OR phone OR email OR leasing OR office)`
      : `"${owner}" ${place} ${region} phone`;

    const results = await braveSearch(braveKey, query);

    // Regex sweep over the snippets as a floor (works even with no Anthropic key).
    const swept = extractFromText(results.map((x) => `${x.title} ${x.description}`).join(" \n "));
    let phones = dedupePhones(swept.phones);
    let emails = uniq(swept.emails);
    let website = "", principals = [], summary = "";

    if (process.env.ANTHROPIC_API_KEY && results.length) {
      const s = await synthesize(process.env.ANTHROPIC_API_KEY, owner, results).catch(() => null);
      if (s) {
        phones = dedupePhones([...(s.phones || []), ...phones]);
        emails = uniq([...(s.emails || []), ...emails]);
        website = clean(s.website);
        principals = (s.principals || []).map(clean).filter(Boolean).slice(0, 6);
        summary = clean(s.summary);
      }
    }

    return res.status(200).json({
      provider: process.env.ANTHROPIC_API_KEY ? "Brave + Claude" : "Brave Search",
      source: "web",
      phones: phones.slice(0, 6).map((number) => ({ number, type: "", dnc: false })),
      emails: emails.slice(0, 5),
      website,
      principals,
      summary,
      matched: phones.length > 0 || emails.length > 0,
      results: results.slice(0, 6), // surface the sources so the user can verify/click through
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "findcontact" });
  }
}
