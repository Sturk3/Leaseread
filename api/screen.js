// Vercel serverless backend for FRONTAGE.
// Holds the Anthropic API key (server-side only) and calls the Messages API.
// The browser POSTs { mode, pdfData, memoText } here; we build the content
// array, call Claude, and return Anthropic's JSON response straight back.

// SYSTEM_EXTRACT — copied verbatim from frontage_deal_screener.jsx so the
// long system prompt lives server-side, never shipped to the client bundle.
const SYSTEM_EXTRACT = `You are a retail real estate acquisitions analyst at a principal investment firm that specializes in trophy, high-street retail in dense gateway markets. You read offering memoranda and return ONLY a single valid JSON object (no markdown, no code fences, no preamble).

Extract conservatively. If a value is not explicitly stated, return null — never guess or infer a number. For every key financial, also return a numeric version (digits only, no symbols/commas) so it can be recomputed. Assign each extracted field a confidence of "high", "medium", or "low".

Classify each tenant's credit tier as one of: "investment-grade" (large national/global rated or flagship brand), "national" (recognized national chain, unrated), "regional", or "local" (independent/single-operator). Note vacancy as a roster line with tenant "VACANT".

Then score the deal against this trophy-retail buy box, each criterion 0-100 with a one-line note:
- location: high-street / prime corridor / dense high-barrier gateway market (highest weight)
- tenancy_credit: strength and durability of tenant credit
- asset_quality: trophy / irreplaceable vs commodity
- lease_durability: weighted lease term and rollover risk
- value_add: mark-to-market, lease-up, or repositioning upside

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
   "criteria": { "location": {"score": num, "note": str}, "tenancy_credit": {"score": num, "note": str}, "asset_quality": {"score": num, "note": str}, "lease_durability": {"score": num, "note": str}, "value_add": {"score": num, "note": str} }
 }
}`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { mode, pdfData, memoText } = req.body || {};
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
        system: SYSTEM_EXTRACT,
        messages: [{ role: "user", content }],
      }),
    });
    const data = await r.json();
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
