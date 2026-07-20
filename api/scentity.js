// FRONTAGE — structured SC Secretary of State entity lookup (the "real registry" lane).
//
// South Carolina captcha-gates its registry search (businessfilings.sc.gov) and
// publishes no open data or API — verified live — so the STRUCTURED path runs through
// a commercial SOS-data provider that maintains its own lawful, real-time access to
// the state record: Cobalt Intelligence (cobaltintelligence.com — Secretary of State
// API, all 50 states incl. SC; entity name, status, filing date, registered agent,
// officers, as JSON).
//
// PROVIDER-PLUGGABLE like api/skiptrace.js: set COBALT_API_KEY in Vercel env and this
// lane lights up; with NO key it returns { noKey: true } and the client falls back to
// the AI web-research unmask (the old path — still the only way to put a human
// PRINCIPAL behind an SC LLC, since SC filings name the registered agent + organizer,
// not the members). The two are complements: registry = exact record; AI = the people.
//
// NOTE ON EXACT CONTRACT: request/response field names marked CONFIRM below — Cobalt's
// documented flow is a GET with x-api-key and, for slower states, an async retryId to
// poll; the response parser is deliberately tolerant of shape (same philosophy as
// skiptrace.js) so a field rename degrades to nulls, not a crash. {debug:true} probes
// the config without spending a lookup.
//
//   POST /api/scentity { password, name }         → { entities: [...], people: [...] } | { noKey: true }
//   POST /api/scentity { password, check|debug }  → health / config probe
//
// Password-gated like the rest of the API.

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

const COBALT_BASE = process.env.COBALT_BASE_URL || "https://apigateway.cobaltintelligence.com/v1"; // CONFIRM
const POLL_TRIES = 8;       // async states: poll retryId up to ~32s (fits the 60s budget)
const POLL_DELAY_MS = 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pull the first non-empty string found under any of these keys (tolerant reader).
const pick = (obj, keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && typeof v !== "object" && clean(v)) return clean(v);
  }
  return "";
};

// A registered-agent SERVICE isn't a person to trace — the AI unmask handles humans.
const AGENT_SERVICE_RE = /registered agent|corporation service|ct corporation|cogency|incorp|legalinc|northwest|zenbusiness|legalzoom|harbor compliance|paracorp|capitol services|urs agents|agents inc/i;

// Normalize one Cobalt result into FRONTAGE's entity shape. All field names CONFIRM —
// every read is fallback-chained so a rename yields null, never a throw.
function normalizeEntity(r) {
  const agentObj = r.agent || r.registeredAgent || r.registered_agent || {};
  const agentName = pick(r, ["agentName", "registeredAgentName"]) || pick(agentObj, ["name", "fullName", "agentName"]);
  const agentAddr = pick(r, ["agentAddress", "registeredAgentAddress"]) || pick(agentObj, ["address", "fullAddress", "street", "physicalAddress"]);
  const officersRaw = r.officers || r.officerList || r.people || [];
  const officers = (Array.isArray(officersRaw) ? officersRaw : []).map((o) => ({
    name: pick(o, ["name", "fullName", "officerName"]) || clean(typeof o === "string" ? o : ""),
    title: pick(o, ["title", "role", "position", "officerTitle"]),
  })).filter((o) => o.name);
  return {
    name: pick(r, ["title", "name", "businessName", "companyName", "entityName"]),
    sos_id: pick(r, ["sosId", "filingNumber", "documentNumber", "entityNumber", "businessId", "id"]),
    status: pick(r, ["status", "businessStatus", "entityStatus"]),
    entity_type: pick(r, ["entityType", "businessType", "type", "structure"]),
    filing_date: pick(r, ["filingDate", "registrationDate", "formationDate", "dateFiled", "startDate"]),
    registered_agent: agentName || null,
    agent_address: agentAddr || null,
    principal_address: pick(r, ["physicalAddress", "principalAddress", "address", "mailingAddress"]) || null,
    officers,
  };
}

// Flatten the traceable PEOPLE out of the normalized entities (for the UI's one-click
// skip-trace chips): officers first, then an agent who looks like an individual.
function tracePeople(entities) {
  const out = [], seen = new Set();
  const push = (name, street) => {
    const key = name.toUpperCase();
    if (!name || seen.has(key)) return;
    seen.add(key);
    // Street stays with the person; city/state parsing is the UI's job (SC default).
    out.push({ name, street: street || "", city: "", state: "SC", zip: "" });
  };
  for (const e of entities) {
    for (const o of e.officers) push(o.name, "");
    if (e.registered_agent && !AGENT_SERVICE_RE.test(e.registered_agent) && /\s/.test(e.registered_agent) && !/\b(LLC|INC|CORP|CO|COMPANY|LP|LLP)\b/i.test(e.registered_agent)) {
      push(e.registered_agent, (e.agent_address || "").split(",")[0]);
    }
  }
  return out.slice(0, 8);
}

async function cobaltSearch(name, key) {
  const headers = { "x-api-key": key }; // CONFIRM header name
  let url = `${COBALT_BASE}/search?${new URLSearchParams({ searchQuery: name, state: "sc" })}`; // CONFIRM params
  for (let attempt = 0; attempt <= POLL_TRIES; attempt++) {
    const r = await fetch(url, { headers });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* non-JSON error page */ }
    if (!r.ok) {
      const msg = clean(j?.message || j?.error || text).slice(0, 200);
      throw new Error(`Cobalt HTTP ${r.status}${msg ? `: ${msg}` : ""}`);
    }
    // Async states (SC scrapes in real time): a retryId means "poll me". CONFIRM key.
    const retryId = clean(j?.retryId || j?.retry_id || "");
    const results = j?.results || j?.data || j?.businesses || (Array.isArray(j) ? j : null);
    if (Array.isArray(results) && results.length) return results;
    if (retryId && attempt < POLL_TRIES) {
      url = `${COBALT_BASE}/search?${new URLSearchParams({ retryId })}`; // CONFIRM param
      await sleep(POLL_DELAY_MS);
      continue;
    }
    return Array.isArray(results) ? results : [];
  }
  return [];
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, name, check, debug } = req.body || {};
    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    const key = process.env.COBALT_API_KEY;
    if (check || debug) {
      return res.status(200).json({
        ok: true, build: "scentity-v1-cobalt",
        provider: "Cobalt Intelligence (Secretary of State API)",
        keyConfigured: !!key, keyEnv: "COBALT_API_KEY", base: COBALT_BASE,
      });
    }
    const q = clean(name);
    if (!q) return res.status(200).json({ error: "Pass name: the SC entity / LLC name to look up." });
    if (!key) {
      // No key = lane off. NOT an `error` field (the client's postJSON throws on error);
      // the client sees noKey and falls back to the AI web unmask.
      return res.status(200).json({
        noKey: true, keyEnv: "COBALT_API_KEY",
        note: "Structured SC SOS lane is off (no COBALT_API_KEY set in Vercel env) — falling back to AI web research. Sign up at cobaltintelligence.com to light up real-time registry records.",
      });
    }

    const raw = await cobaltSearch(q, key);
    const entities = raw.map(normalizeEntity).filter((e) => e.name).slice(0, 8);
    return res.status(200).json({
      query: q,
      count: entities.length,
      entities,
      people: tracePeople(entities),
      note: entities.length
        ? "Live SC Secretary of State record via Cobalt Intelligence. SC filings name the REGISTERED AGENT (and officers where filed) — LLC members usually aren't in the state record, so pair this with the AI unmask to put a human principal behind the entity."
        : `No SC registry match for "${q}" via the structured lane — the AI web unmask may still find it (name variations, DBAs).`,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "scentity" });
  }
}
