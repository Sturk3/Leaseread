// Vercel serverless backend for FRONTAGE — NDA REVIEW workflow.
// Holds the Anthropic API key (server-side only) and calls the Messages API.
// The browser POSTs { mode, pdfData, ndaText, password, config } here; we build
// a redline prompt from the firm's NDA playbook, call Claude, and return the
// structured JSON straight back. Same key-never-in-browser pattern as screen.js.

// Default NDA playbook for a real estate acquisitions principal. Each position
// has a stance the firm wants taken toward that kind of clause:
//   include = the firm wants this protection present
//   remove  = the firm wants this kind of clause struck
//   limit   = acceptable only if narrowed to the stated bounds
const DEFAULT_POSITIONS = [
  { id: "mutual", label: "Mutuality", desc: "Obligations should run both ways (mutual NDA), not bind only us as Receiving Party", want: "include" },
  { id: "term", label: "Confidentiality term", desc: "Confidentiality period should be finite and capped — prefer 2 years from disclosure, 3 max", want: "limit" },
  { id: "carveouts", label: "Standard carve-outs", desc: "Exclude info that is public, already known, independently developed, or rightfully received from a third party", want: "include" },
  { id: "reps", label: "Permitted disclosures", desc: "Allow sharing with affiliates, employees, lenders, advisors, and other representatives on a need-to-know basis", want: "include" },
  { id: "compelled", label: "Compelled disclosure", desc: "Permit disclosure required by law/subpoena/regulator with notice, without breach", want: "include" },
  { id: "noncompete", label: "Non-compete / no-investment", desc: "Strike clauses barring us from pursuing the asset, the market, or competing deals", want: "remove" },
  { id: "noncircumvent", label: "Non-circumvention / exclusivity", desc: "Strike broad non-circumvention, exclusivity, or no-contact terms that block normal market activity", want: "remove" },
  { id: "nonsolicit", label: "Non-solicitation", desc: "No-hire / non-solicit of the counterparty's employees acceptable only if narrow and short (≤1yr, no general ads)", want: "limit" },
  { id: "standstill", label: "Standstill", desc: "Strike standstill provisions restricting our ability to transact, bid, or acquire", want: "remove" },
  { id: "defn", label: "Definition scope", desc: "Definition of Confidential Information should be bounded (marked/identified or reasonably understood), not everything ever exchanged", want: "limit" },
  { id: "return", label: "Return / destruction", desc: "Return-or-destroy on request is fine, but preserve a retention carve-out for legal/archival and auto-backup copies", want: "limit" },
  { id: "remedies", label: "Remedies & liability", desc: "Strike indemnification, liquidated damages, and fee-shifting; injunctive relief acceptable, no admission of irreparable harm by us", want: "remove" },
  { id: "residuals", label: "Residuals", desc: "Acceptable to keep a residuals clause protecting unaided memory / general knowledge", want: "include" },
  { id: "law", label: "Governing law / venue", desc: "Prefer New York law and NY venue; flag anything else for review", want: "limit" },
  { id: "term_assign", label: "Assignment & survival", desc: "Flag broad assignment rights and perpetual survival of obligations", want: "limit" },
];

function buildSystem(config) {
  let positions = DEFAULT_POSITIONS;
  if (config && Array.isArray(config.positions) && config.positions.length) {
    const cleaned = config.positions
      .filter((p) => p && p.id && p.label)
      .map((p) => ({
        id: String(p.id),
        label: String(p.label),
        desc: String(p.desc || p.label),
        want: ["include", "remove", "limit"].includes(p.want) ? p.want : "limit",
      }));
    if (cleaned.length) positions = cleaned;
  }
  const wantWord = { include: "WANT PRESENT", remove: "WANT STRUCK", limit: "ACCEPT ONLY IF LIMITED" };
  const posLines = positions.map((p) => `- ${p.label} [${wantWord[p.want]}]: ${p.desc}`).join("\n");

  const perspective =
    config && typeof config.perspective === "string" && config.perspective.trim()
      ? config.perspective.trim()
      : "Receiving Party (we are receiving the counterparty's confidential information and reviewing their draft)";

  const commands = config && typeof config.commands === "string" ? config.commands.trim() : "";
  const commandsBlock = commands
    ? `\n\nADDITIONAL DIRECTIVES FROM THE FIRM. Apply these strictly; they override the generic guidance where they conflict:\n${commands}`
    : "";

  return `You are an experienced transactional attorney reviewing a non-disclosure / confidentiality agreement on behalf of a real estate acquisitions firm. You return ONLY a single valid JSON object (no markdown, no code fences, no preamble).

OUR ROLE / PERSPECTIVE in this agreement: ${perspective}

Read the agreement clause by clause. For EACH substantive clause, decide what should happen to it given the firm's playbook below, and assign a verdict:
- "Keep" — the clause is acceptable or favorable to us as drafted; leave it in.
- "Revise" — the clause is acceptable only if narrowed/modified; provide concrete suggested replacement language.
- "Cut" — the clause should be struck entirely; explain why and (if useful) what would replace it.
- "Flag" — ambiguous, unusual, or business/legal-judgment call that a human should decide; explain the tradeoff.

THE FIRM'S NDA PLAYBOOK (the criteria — what to leave in vs. take out):
${posLines}${commandsBlock}

Also identify protections the firm WANTS PRESENT that are MISSING from the agreement (e.g., a needed carve-out or permitted-disclosure right that the draft omits), and list them separately with suggested language to add.

Quote or tightly paraphrase the actual clause text in "excerpt" so the reader can find it. Ground every rationale in the playbook and the document; do not invent clauses that are not there. Keep suggested_language as drop-in redline wording.

Return JSON with EXACTLY this shape:
{
 "doc_type": str|null,
 "parties": str|null,
 "mutual": bool|null,
 "term": str|null,
 "governing_law": str|null,
 "risk_level": "Low"|"Medium"|"High",
 "overall_assessment": str,
 "counts": { "keep": num, "revise": num, "cut": num, "flag": num },
 "clauses": [
   {
     "title": str,
     "excerpt": str,
     "verdict": "Keep"|"Revise"|"Cut"|"Flag",
     "risk": "Low"|"Medium"|"High",
     "playbook_ref": str|null,
     "rationale": str,
     "suggested_language": str|null
   }
 ],
 "missing": [
   { "title": str, "why": str, "suggested_language": str|null }
 ]
}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { mode, pdfData, ndaText, password, check, config } = req.body || {};

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
      if (!ndaText) return res.status(400).json({ error: "No text provided" });
      content.push({ type: "text", text: "NON-DISCLOSURE AGREEMENT:\n\n" + ndaText });
    }
    content.push({ type: "text", text: "Review this NDA against the firm's playbook. Return ONLY the JSON object." });

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
        max_tokens: 8192,
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
