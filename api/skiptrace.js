// FRONTAGE — verified owner contact (skip trace).
//
// On-demand, single-owner contact lookup behind a "reveal" click in the property
// dossier. Returns phone numbers + emails for the owner of record so the team can
// reach the decision-maker directly — the CoStar-style contact, but in-house and
// pay-per-click. Password-gated; the provider key stays server-side.
//
// PROVIDER-PLUGGABLE (the agreed "waterfall" design): pick the lane with the
// SKIPTRACE_PROVIDER env var ("tracerfy" default, "batchdata" alt). Tracerfy is
// implemented as the live lane (cheapest, pay-only-on-hit, documented synchronous
// endpoint); BatchData is wired with its documented shape so it can be promoted to
// primary after the bake-off. Each lane only needs its own key set in Vercel env.
//
// COST SAFETY: this endpoint is ONLY hit when the user clicks "reveal" on one
// property. The frontend dedupes by owner and caches every result, so a given owner
// is paid for at most once. Providers bill per successful match (~$0.10 Tracerfy /
// $0.07–0.18 BatchData); a miss is free. No automatic/bulk calls anywhere.
//
// NOTE ON EXACT CONTRACTS: provider request/response field names and base URLs that
// aren't on the public docs are marked CONFIRM below — the first real call (or the
// {debug:true} probe) verifies them; the response parser is intentionally tolerant
// of shape so a key rename doesn't break the reveal.

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const isCompany = (name, entityType) =>
  entityType === "company" ||
  /\b(LLC|INC|CORP|CO|COMPANY|LP|LLP|TRUST|ASSOCIATES|REALTY|PARTNERS|HOLDINGS|GROUP|MANAGEMENT|PROPERTIES|HDFC|FUND|BANK)\b/i.test(name || "");

// Split a person's "LAST, FIRST" or "FIRST LAST" name into first/last for providers
// that want them separately.
function splitName(name) {
  const n = clean(name);
  if (n.includes(",")) { const [last, first] = n.split(","); return { first: clean(first), last: clean(last) }; }
  const parts = n.split(" ");
  if (parts.length === 1) return { first: "", last: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

// ── tolerant response normalizer ─────────────────────────────────────────────
// Pulls phones/emails out of whatever shape a provider returns (array of strings,
// array of {number,type}, nested under data/result/person, etc.).
const PHONE_KEYS = ["phone", "phones", "phone_numbers", "phoneNumbers", "mobile", "mobiles", "mobile_phones", "landline", "landlines", "dids", "tns"];
const EMAIL_KEYS = ["email", "emails", "email_addresses", "emailAddresses"];

function collect(node, keys, out, depth) {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) { for (const x of node) collect(x, keys, out, depth + 1); return; }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (keys.includes(k)) harvest(v, out);
      else collect(v, keys, out, depth + 1);
    }
  }
}
function harvest(v, out) {
  if (v == null) return;
  if (Array.isArray(v)) { for (const x of v) harvest(x, out); return; }
  if (typeof v === "object") {
    const num = v.number || v.phoneNumber || v.phone || v.value || v.address || v.email;
    const type = v.type || v.phoneType || v.lineType || v.line_type || "";
    const dnc = v.dnc || v.doNotCall || v.do_not_call || false;
    if (num) out.push({ value: clean(num), type: clean(type).toLowerCase(), dnc: !!dnc });
    return;
  }
  out.push({ value: clean(v), type: "", dnc: false });
}
function normalizeContacts(json) {
  const phonesRaw = [], emailsRaw = [];
  collect(json, PHONE_KEYS, phonesRaw, 0);
  collect(json, EMAIL_KEYS, emailsRaw, 0);
  // de-dupe, keep order, drop obvious junk
  const seen = new Set();
  const phones = [];
  for (const p of phonesRaw) {
    const digits = p.value.replace(/\D/g, "");
    if (digits.length < 10 || seen.has(digits)) continue;
    seen.add(digits);
    phones.push({ number: p.value, type: p.type || "", dnc: p.dnc });
  }
  const eseen = new Set();
  const emails = [];
  for (const e of emailsRaw) {
    const val = e.value.toLowerCase();
    if (!/.+@.+\..+/.test(val) || eseen.has(val)) continue;
    eseen.add(val);
    emails.push(val);
  }
  return { phones: phones.slice(0, 8), emails: emails.slice(0, 5) };
}

// Group contacts BY PERSON. Tracerfy/BatchData return a `persons` array, each with a
// name + their own phones/emails — so the UI can show WHO each number belongs to,
// instead of one anonymous pile. Falls back to the flat list when no grouping exists.
function findPersonsArray(json, depth) {
  if (!json || typeof json !== "object" || depth > 6) return null;
  if (Array.isArray(json.persons) && json.persons.length) return json.persons;
  for (const v of Object.values(json)) {
    if (v && typeof v === "object") { const f = findPersonsArray(v, (depth || 0) + 1); if (f) return f; }
  }
  return null;
}
function personName(p) {
  const full = clean(p.full_name || p.fullName || p.name_full);
  if (full) return full;
  const nm = p.name && typeof p.name === "object" ? p.name : p;
  const first = clean(nm.first || nm.first_name || nm.firstName);
  const last = clean(nm.last || nm.last_name || nm.lastName);
  return clean([first, last].filter(Boolean).join(" "));
}
// Grade how callable a number is, 0–100 → BEST / GOOD / LOW. A mobile you can dial
// reaches the person directly; a landline is more likely an office/voicemail; DNC and
// low provider rank/reachability drag it down. Gives the team a call-order at a glance.
function phoneGrade(p, provScore) {
  let s = 55;
  if (/mobile|wireless|cell/.test(p.type)) s += 22;
  else if (/land/.test(p.type)) s += 4;
  if (p.rank != null && Number.isFinite(p.rank)) s += Math.max(0, 14 - (p.rank - 1) * 4); // rank 1 best
  if (p.reachable) s += 12;
  if (provScore != null) s = Math.round((s + provScore) / 2); // blend a provider's own score
  if (p.dnc) s -= 38; // legally riskier to cold-call
  s = Math.max(0, Math.min(100, Math.round(s)));
  // DNC numbers are capped at LOW — high reachability doesn't make a number you
  // shouldn't cold-call a good call. (The DNC badge says why; prefer email there.)
  const tier = p.dnc ? "LOW" : s >= 72 ? "BEST" : s >= 50 ? "GOOD" : "LOW";
  return { score: s, tier };
}
function personPhones(p) {
  const arr = Array.isArray(p.phones) ? p.phones : Array.isArray(p.phoneNumbers) ? p.phoneNumbers : [];
  const seen = new Set(), out = [];
  for (const x of arr) {
    const isObj = x && typeof x === "object";
    const number = isObj ? clean(x.number || x.phone || x.value) : clean(x);
    const d = number.replace(/\D/g, "");
    if (d.length < 10 || seen.has(d)) continue;
    seen.add(d);
    const type = isObj ? clean(x.type || x.phoneType || x.lineType || x.line_type || "").toLowerCase() : "";
    const dnc = isObj ? !!(x.dnc || x.doNotCall || x.do_not_call) : false;
    const rank = isObj && x.rank != null ? Number(x.rank) : null;
    const reachable = isObj ? (x.reachable === true || x.connected === true || /reachable|connected/i.test(clean(x.reachability))) : false;
    const provScore = isObj && x.score != null && Number.isFinite(Number(x.score)) ? Number(x.score) : null;
    const ph = { number, type, dnc, rank, reachable };
    ph.grade = phoneGrade(ph, provScore);
    out.push(ph);
  }
  out.sort((a, b) => b.grade.score - a.grade.score); // most callable first
  return out;
}
function personEmails(p) {
  const arr = Array.isArray(p.emails) ? p.emails : Array.isArray(p.email_addresses) ? p.email_addresses : [];
  const seen = new Set(), out = [];
  for (const x of arr) {
    const email = (typeof x === "string" ? clean(x) : clean(x.email || x.address || x.value)).toLowerCase();
    if (!/.+@.+\..+/.test(email) || seen.has(email)) continue;
    seen.add(email); out.push(email);
  }
  return out;
}
function nameTokens(s) {
  return clean(s).toUpperCase().replace(/[^A-Z\s]/g, " ").split(/\s+/)
    .filter((t) => t.length > 1 && !["LLC", "INC", "CORP", "THE", "AND", "CO", "LP"].includes(t));
}

// Relatives / associates. Providers that expose them use varying keys (relatives,
// associates, related_persons, possible_relatives, associatedPeople, household…), each
// typically { name/first/last, relationship?, age?, and sometimes their own phones/emails }.
// Tolerant like the rest of this file: pull them wherever they appear, and it's a no-op
// when the provider (e.g. Tracerfy's base /trace/lookup) doesn't return any.
const RELATIVE_KEYS = ["relatives", "relative", "associates", "associate", "related_persons", "relatedPersons", "possible_relatives", "possibleRelatives", "associated_people", "associatedPeople", "associatedPersons", "household", "household_members", "familyMembers", "family_members"];
function personRelatives(p) {
  const out = [], seen = new Set();
  for (const k of RELATIVE_KEYS) {
    const arr = p[k];
    if (!Array.isArray(arr)) continue;
    for (const x of arr) {
      const name = typeof x === "string" ? clean(x) : personName(x || {});
      if (!name) continue;
      const key = name.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (seen.has(key)) continue;
      seen.add(key);
      const rel = typeof x === "object" ? clean(x.relationship || x.relation || x.type || "") : "";
      const age = typeof x === "object" && x.age != null ? clean(x.age) : "";
      out.push({ name, relationship: rel, age, phones: typeof x === "object" ? personPhones(x) : [], emails: typeof x === "object" ? personEmails(x) : [] });
    }
  }
  return out.slice(0, 8);
}
function extractPersons(json, ownerName) {
  const arr = findPersonsArray(json, 0) || [];
  const ownerToks = nameTokens(ownerName);
  const seen = new Set(), out = [];
  for (const p of arr) {
    const name = personName(p);
    const phones = personPhones(p);
    const emails = personEmails(p);
    const relatives = personRelatives(p);
    if (!phones.length && !emails.length && !relatives.length) continue;
    const key = name.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (key && seen.has(key)) continue; // drop duplicate rows (brokers echo the same entity)
    if (key) seen.add(key);
    // A "person" whose name reads as a company is the data broker echoing the owner's
    // corporate web (common for institutional owners like Thor/REITs), NOT a real person.
    const isEntity = isCompany(name, "");
    // Does this person's name overlap the OWNER's name? Only meaningful for an individual
    // owner — tells the user WHICH returned person is actually the owner vs. an occupant.
    const ptoks = nameTokens(name);
    const overlap = ownerToks.filter((t) => ptoks.includes(t)).length;
    const matchesOwner = !isEntity && ownerToks.length >= 2 && overlap >= 2;
    out.push({ name, isEntity, matchesOwner, phones, emails, relatives });
  }
  // Owner-name matches first, then individuals, then entities.
  out.sort((a, b) => (b.matchesOwner ? 1 : 0) - (a.matchesOwner ? 1 : 0) || (a.isEntity ? 1 : 0) - (b.isEntity ? 1 : 0));
  return out.slice(0, 8);
}

// ── provider lanes ───────────────────────────────────────────────────────────
const PROVIDERS = {
  tracerfy: {
    label: "Tracerfy",
    keyEnv: "TRACERFY_API_KEY",
    estCost: () => 0.1, // 5 credits/hit × ~$0.02; 0 on miss
    async lookup(key, input) {
      // Verified contract (tracerfy.com/skip-tracing-api-documentation):
      //   POST {base}/trace/lookup/  ·  Authorization: Bearer <key>  ·  address/city/state (+zip)
      //   resp: { hit, persons:[{ phones:[{number,type,dnc}], emails:[{email}] }] }
      // find_owner=true → resolve the owner at this address. (The name-based find_owner=false
      // path was too strict and returned nothing.) The HANDLER controls which address we hit:
      // the owner's mailing address first, falling back to the property.
      const base = process.env.TRACERFY_BASE || "https://tracerfy.com/v1/api";
      const body = { address: input.street, city: input.city, state: input.state, find_owner: true };
      if (input.zip) body.zip = input.zip;
      const r = await fetch(base + "/trace/lookup/", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`Tracerfy ${r.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    },
  },
  batchdata: {
    label: "BatchData",
    keyEnv: "BATCHDATA_API_KEY",
    estCost: () => 0.12, // pay-as-you-go ~$0.07–0.18 per match
    async lookup(key, input) {
      // Verified contract (developer.batchdata.com + a public example notebook):
      //   POST {base}/property/skip-trace  ·  Authorization: Bearer <key>
      //   body  { requests: [ { propertyAddress: { street, city, state, zip } } ] }
      //   resp  results.persons[].phoneNumbers[].number  /  results.persons[].emails[].email
      // We trace the owner's MAILING address (input.street already prefers it), so for an
      // absentee owner this resolves the person where they actually live, not a tenant.
      const base = process.env.BATCHDATA_BASE || "https://api.batchdata.io/api/v1";
      const body = {
        requests: [{
          propertyAddress: { street: input.street, city: input.city, state: input.state, zip: input.zip },
        }],
      };
      const r = await fetch(base + "/property/skip-trace", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`BatchData ${r.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    },
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, name, entity_type, contact_address, city, state, zip, address, borough } = req.body || {};

    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }

    // Default lane is Tracerfy (self-serve pay-on-hit; user's choice to start). Override
    // with SKIPTRACE_PROVIDER=batchdata to switch lanes (e.g. for a bake-off).
    const providerId = (process.env.SKIPTRACE_PROVIDER || "tracerfy").toLowerCase();
    const provider = PROVIDERS[providerId] || PROVIDERS.tracerfy;
    const key = process.env[provider.keyEnv];

    // Zero-cost deploy/config probe — confirms which lane is live and whether the key
    // is set, WITHOUT spending a credit. Call with { debug: true }.
    if (req.body && req.body.debug) {
      return res.status(200).json({
        ok: true, provider: provider.label, providerId,
        keyConfigured: !!key, keyEnv: provider.keyEnv, build: "skiptrace-v3-llc",
      });
    }

    // No key yet → tell the frontend so it can show "not configured" instead of erroring.
    if (!key) {
      return res.status(200).json({ noKey: true, provider: provider.label, keyEnv: provider.keyEnv });
    }

    if (!name) return res.status(400).json({ error: "Need an owner name to trace." });

    // Anchor on the OWNER's MAILING address — where the owner actually is — NOT the
    // property address. Skip-tracing a building returns its OCCUPANTS/tenants (the
    // "random numbers" problem), not who owns it. The mailing address (derived from the
    // deed grantee) is the owner's home/office, so it resolves the real owner. Use it as
    // a coherent unit (its own city/state/zip). Fall back to the property only when no
    // mailing address is known (borough → postal city, state NY).
    const NYC_CITY = { manhattan: "New York", bronx: "Bronx", brooklyn: "Brooklyn", queens: "Queens", "staten island": "Staten Island" };
    const mailStreet = clean(contact_address);
    const propStreet = clean(address);
    if (!mailStreet && !propStreet) return res.status(400).json({ error: "Need a mailing or property address to trace." });
    const ownerName = clean(name);

    // The PROPERTY's own city/state — needed for the fallback so a non-NYC market (Nashville,
    // Greenwich, the Hamptons) isn't forced to "NY". `borough` carries the market label, which
    // for assessor markets ends in a state code ("Nashville, TN" → TN); NYC borough names map
    // to New York. Falls back to the mailing state only if the label has no code.
    const boroughStr = clean(borough);
    const isNycBorough = !!NYC_CITY[boroughStr.toLowerCase()];
    const labelState = (boroughStr.match(/\b([A-Z]{2})\b\s*$/) || [])[1];
    const propState = isNycBorough ? "NY" : (labelState || clean(state) || "NY");
    const propCity = isNycBorough
      ? NYC_CITY[boroughStr.toLowerCase()]
      : (boroughStr.replace(/,?\s*[A-Z]{2}\s*$/, "").trim() || clean(city));

    // Owner's MAILING address (their home/office — resolves the actual OWNER), as a coherent
    // unit. The PROPERTY address is the fallback (may return building occupants).
    const mailingInput = mailStreet ? {
      name: ownerName, street: mailStreet, city: clean(city) || clean(borough), state: clean(state) || "NY", zip: clean(zip),
    } : null;
    const propertyInput = propStreet ? {
      name: ownerName, street: propStreet, city: propCity || clean(city), state: propState, zip: "",
    } : null;

    const business = isCompany(name, entity_type);
    const attempt = async (inp) => {
      const raw = await provider.lookup(key, inp);
      return { persons: extractPersons(raw, ownerName), ...normalizeContacts(raw) };
    };

    // Try the mailing address (the owner) first; only if it finds NOTHING fall back to the
    // property address. A Tracerfy miss is free, so the fallback costs at most one hit.
    //
    // CRITICAL: never fall back to the property for a COMPANY/LLC. An LLC has no phone, and
    // tracing the building it OWNS returns that building's tenants/occupants — a confident
    // WRONG-PARTY number (the classic "the numbers are so wrong" for LLCs). For an entity we
    // only trust its own mailing/registered address; if that whiffs we return no match and
    // signal the caller to unmask the LLC and trace the named principal instead. Individuals
    // can still fall back to the property (owner-occupant is plausible there).
    let tracedAddress = null, result = null;
    if (mailingInput) { result = await attempt(mailingInput); tracedAddress = "owner mailing"; }
    const empty = !result || (!result.phones.length && !result.emails.length);
    if (empty && !business && propertyInput && (!mailingInput || propStreet.toLowerCase() !== mailStreet.toLowerCase())) {
      result = await attempt(propertyInput); tracedAddress = "property";
    }
    const { persons = [], phones = [], emails = [] } = result || {};
    // An entity trace that returns only NON-owner-matched individuals is very likely the
    // registered agent / office staff / a shared-suite neighbor, not the principal — flag it
    // so the UI can warn instead of presenting a confident wrong number.
    const entityLowConfidence = business && phones.length + emails.length > 0 && !persons.some((p) => p.matchesOwner);

    return res.status(200).json({
      provider: provider.label,
      business,
      tracedAddress,
      persons,
      phones,
      emails,
      entityLowConfidence,
      matched: phones.length > 0 || emails.length > 0,
      // est. cost only when something matched (providers bill per hit)
      cost: phones.length || emails.length ? provider.estCost(business) : 0,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "skiptrace" });
  }
}
