// FRONTAGE — Connecticut business-entity lookup (the CT analog of the NY State registry).
//
// Given an entity/LLC name, searches CT's free public Business Registry and returns the
// entity's status + registration, its registered AGENT, and — unusually valuable — its
// PRINCIPALS with names and (business + residence) locations. CT discloses LLC principals,
// which NY does not, so this is a real "who's behind the LLC" tool for Greenwich/CT.
//
// Datasets (data.ct.gov, Socrata, no key):
//   Business Master  n7gp-d28j  (id, name, status, accountnumber, date_registration, mailing)
//   Principals       ka36-64k6  (business_id -> people + addresses)
//   Agents           qh2m-n44y  (business_id -> registered agent + address)
// Joined on Business Master `id` == business_id. Password-gated.

const CT_BASE = "https://data.ct.gov/resource";
const CT_BIZ = process.env.CT_BIZ_DATASET || "n7gp-d28j";
const CT_PRIN = process.env.CT_PRINCIPALS_DATASET || "ka36-64k6";
const CT_AGENT = process.env.CT_AGENTS_DATASET || "qh2m-n44y";

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const addr = (parts) => parts.map(clean).filter(Boolean).join(", ");
const sodaList = (vals) => [...new Set(vals)].map((v) => `'${String(v).replace(/'/g, "''")}'`).join(",");

// The assessor's owner name and the SOS registry name rarely match character-for-character:
// "COHEN M H REALTY LLC" (assessor) vs "M.H. COHEN REALTY, L.L.C" (registry) — different word
// order, punctuation, and entity-suffix spelling. So match on the SIGNIFICANT WORD TOKENS
// (drop punctuation, entity-type words, and bare initials) ANDed together, which survives all
// of that. `LIKE '%COHEN%' AND LIKE '%REALTY%'` finds the entity regardless of order/dots.
const STOPWORDS = new Set(["LLC", "L", "LC", "LLP", "LP", "INC", "CORP", "CORPORATION", "CO", "COMPANY", "LIMITED", "PARTNERSHIP", "PLLC", "LLLP", "THE", "AND", "OF", "A"]);
function sigTokens(name) {
  return clean(name).toUpperCase().replace(/[^A-Z0-9\s]/g, " ").split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t)); // drop punctuation, suffixes, single-letter initials
}
// Jaccard similarity of the query tokens vs a registry name's tokens (intersection / union),
// used to rank the best match first. Jaccard (not plain coverage) so a name with EXTRA tokens
// scores lower than an exact-length match: for query {COHEN,REALTY}, "M.H. COHEN REALTY"
// (union 2, score 1.0) beats "Cohen Realty Ventures" (union 3, score 0.67).
function tokenOverlap(queryToks, name) {
  if (!queryToks.length) return 0;
  const q = new Set(queryToks), n = new Set(sigTokens(name));
  let inter = 0; for (const t of q) if (n.has(t)) inter++;
  const union = q.size + n.size - inter;
  return union ? inter / union : 0;
}

async function fetchSocrata(dataset, params) {
  const token = process.env.SOCRATA_APP_TOKEN;
  const r = await fetch(`${CT_BASE}/${dataset}.json?${new URLSearchParams(params)}`, token ? { headers: { "X-App-Token": token } } : {});
  if (!r.ok) return [];
  return r.json().catch(() => []);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, name, businessId, check, debug } = req.body || {};
    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    if (check) return res.status(200).json({ ok: true });
    if (debug) return res.status(200).json({ ok: true, build: "ctentity-v2-tokenmatch" });

    const q = clean(name);
    if (!q && !businessId) return res.status(400).json({ error: "Provide an entity name to look up." });

    // 1. matching entities (or one by id). Token-AND match survives word-order/punctuation
    // differences; if the name has no usable tokens (or the token match whiffs), fall back to
    // the plain full-string LIKE.
    const toks = sigTokens(q);
    const tokWhere = toks.length
      ? toks.slice(0, 4).map((t) => `upper(name) like '%${t.replace(/'/g, "''")}%'`).join(" AND ")
      : `upper(name) like '%${q.toUpperCase().replace(/'/g, "''")}%'`;
    let entities = businessId
      ? await fetchSocrata(CT_BIZ, { $where: `id='${clean(businessId).replace(/'/g, "''")}'`, $limit: 1 })
      : await fetchSocrata(CT_BIZ, { $where: tokWhere, $order: "name", $limit: 25 });
    if (!entities.length && !businessId && toks.length) {
      entities = await fetchSocrata(CT_BIZ, { $where: `upper(name) like '%${q.toUpperCase().replace(/'/g, "''")}%'`, $order: "name", $limit: 25 });
    }
    if (!entities.length) return res.status(200).json({ count: 0, query: q, entities: [] });

    const ids = entities.map((e) => clean(e.id)).filter(Boolean);
    const inClause = sodaList(ids);

    // 2. principals + agents for those entities (parallel)
    const [prinRows, agentRows] = await Promise.all([
      fetchSocrata(CT_PRIN, { $where: `business_id in (${inClause})`, $limit: 500 }).catch(() => []),
      fetchSocrata(CT_AGENT, { $where: `business_id in (${inClause})`, $limit: 200 }).catch(() => []),
    ]);

    const prinBy = {}, agentBy = {};
    for (const p of prinRows) {
      const id = clean(p.business_id);
      (prinBy[id] = prinBy[id] || []).push({
        name: clean(p.name__c) || addr([p.firstname, p.lastname]),
        business_location: addr([p.business_city, p.business_state]),
        residence_location: addr([p.residence_city, p.residence_state]),
        residence_address: addr([p.residence_street_address_1, p.residence_city, p.residence_state, p.residence_zip_code]),
      });
    }
    for (const a of agentRows) {
      const id = clean(a.business_id);
      if (!agentBy[id]) agentBy[id] = {
        name: clean(a.name__c) || addr([a.firstname, a.lastname]),
        address: addr([a.business_street_address_1, a.business_city, a.business_state, a.business_zip_code]),
      };
    }

    const out = entities.map((e) => {
      const id = clean(e.id);
      const mailing = addr(clean(e.mailing_address).split(",")); // collapse ", , ," junk
      return {
        id, name: clean(e.name), status: clean(e.status),
        account_number: clean(e.accountnumber),
        registered: clean(e.date_registration).slice(0, 10).replace("0001-01-01", ""),
        mailing_address: mailing,
        agent: agentBy[id] || null,
        principals: prinBy[id] || [],
      };
    });
    // Rank: closest name match first (token overlap), then Active, then richer records. So the
    // one entity that actually IS this owner floats above same-token neighbors ("Cohen Realty
    // Ventures" etc.) that the loose token match also pulls in.
    for (const e of out) e._score = tokenOverlap(toks, e.name);
    out.sort((a, b) =>
      (b._score - a._score) ||
      ((a.status === "Active" ? 0 : 1) - (b.status === "Active" ? 0 : 1)) ||
      (b.principals.length - a.principals.length));
    for (const e of out) delete e._score;

    return res.status(200).json({ count: out.length, query: q, entities: out.slice(0, 12) });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "ctentity" });
  }
}
