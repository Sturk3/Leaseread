// Vercel serverless backend for FRONTAGE.
// Holds the Anthropic API key (server-side only) and calls the Messages API.
// The browser POSTs { mode, pdfData, memoText, password, config } here; we build
// the grading prompt from the firm's custom buy-box config, call Claude, and
// return Anthropic's JSON response straight back.

// Default trophy-retail buy box, used when the client sends no custom config.
const DEFAULT_CRITERIA = [
  { id: "location", label: "Location", desc: "High-street / prime corridor / dense high-barrier gateway market" },
  { id: "tenancy_credit", label: "Tenant credit", desc: "Strength and durability of tenant credit" },
  { id: "asset_quality", label: "Asset quality", desc: "Trophy / irreplaceable vs commodity" },
  { id: "lease_durability", label: "Lease durability", desc: "Weighted lease term and rollover risk" },
  { id: "value_add", label: "Value-add", desc: "Mark-to-market, lease-up, or repositioning upside" },
];

// Build the system prompt from the firm's criteria + free-text commands so the
// grading reflects their mandate, not a fixed trophy-retail thesis.
function buildSystem(config) {
  let criteria = DEFAULT_CRITERIA;
  if (config && Array.isArray(config.criteria) && config.criteria.length) {
    const cleaned = config.criteria
      .filter((c) => c && c.id && c.label)
      .map((c) => ({ id: String(c.id), label: String(c.label), desc: String(c.desc || c.label) }));
    if (cleaned.length) criteria = cleaned;
  }
  const critLines = criteria.map((c) => `- ${c.id}: ${c.label} — ${c.desc}`).join("\n");
  const critSchema = criteria.map((c) => `"${c.id}": {"score": num, "note": str}`).join(", ");
  const commands = config && typeof config.commands === "string" ? config.commands.trim() : "";
  const commandsBlock = commands
    ? `\n\nADDITIONAL GRADING DIRECTIVES FROM THE FIRM. Apply these strictly; they reflect this firm's mandate and override the generic guidance where they conflict:\n${commands}`
    : "";

  return `You are a retail real estate acquisitions analyst at a principal investment firm. You read offering memoranda and return ONLY a single valid JSON object (no markdown, no code fences, no preamble).

Extract conservatively. If a value is not explicitly stated, return null — never guess or infer a number. For every key financial, also return a numeric version (digits only, no symbols/commas) so it can be recomputed. Assign each extracted field a confidence of "high", "medium", or "low".

Classify each tenant's credit tier as one of: "investment-grade" (large national/global rated or flagship brand), "national" (recognized national chain, unrated), "regional", or "local" (independent/single-operator). Note vacancy as a roster line with tenant "VACANT".

Then score the deal against THIS FIRM'S buy box. Score each criterion 0-100 with a one-line note grounded in the memo:
${critLines}${commandsBlock}

Also provide an overall_score (0-100), a recommendation of "Pursue", "Watch", or "Pass", and a 2-4 sentence rationale that references the firm's criteria and any directives above.

Return JSON with EXACTLY this shape:
{
 "property_name": str|null, "address": str|null, "asset_type": str|null,
 "submarket": str|null, "year_built": str|null,
 "asking_price": str|null, "asking_price_num": num|null,
 "square_footage": str|null, "square_footage_num": num|null,
 "price_per_sf": str|null, "price_per_sf_num": num|null,
 "in_place_noi": str|null, "in_place_noi_num": num|null,
 "cap_rate": str|null, "cap_rate_num": num|null,
 "occupancy": str|null, "occupancy_num": num|null,
 "confidence": { "asking_price": str, "square_footage": str, "in_place_noi": str, "cap_rate": str, "occupancy": str },
 "tenants": [ { "name": str, "sf": num|null, "pct_gla": num|null, "lease_expiration": str|null, "expiration_year": num|null, "credit_tier": str, "note": str|null } ],
 "value_add": [ str ],
 "buy_box": {
   "overall_score": num,
   "recommendation": "Pursue"|"Watch"|"Pass",
   "rationale": str,
   "criteria": { ${critSchema} }
 }
}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { mode, pdfData, memoText, password, check, config } = req.body || {};

    // Shared-password gate (enforced before any Anthropic call).
    if (process.env.SITE_PASSWORD) {
      if (password !== process.env.SITE_PASSWORD) {
        return res.status(401).json({ error: "Incorrect password." });
      }
    }
    if (check) return res.status(200).json({ ok: true });

    const content = [];
    if (mode === "pdf") {
      if (!pdfData) return res.status(400).json({ error: "No PDF provided" });
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfData } });
    } else {
      if (!memoText) return res.status(400).json({ error: "No text provided" });
      content.push({ type: "text", text: "OFFERING MEMORANDUM:\n\n" + memoText });
    }
    content.push({ type: "text", text: "Extract, structure, and score this deal. Return ONLY the JSON object." });

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
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: buildSystem(config),
        messages: [{ role: "user", content }],
      }),
    });
    const raw = await r.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(502).json({
        error: "Anthropic returned a non-JSON response",
        anthropic_status: r.status,
        snippet: raw.slice(0, 300),
      });
    }
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "handler" });
  }
}
