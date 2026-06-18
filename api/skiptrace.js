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

// ── provider lanes ───────────────────────────────────────────────────────────
const PROVIDERS = {
  tracerfy: {
    label: "Tracerfy",
    keyEnv: "TRACERFY_API_KEY",
    estCost: () => 0.1, // 5 credits/hit × ~$0.02; 0 on miss
    async lookup(key, input) {
      // Verified contract (tracerfy.com/skip-tracing-api-documentation):
      //   POST {base}/trace/lookup/  ·  Authorization: Bearer <key>
      //   required: address, city, state  (+ zip optional)
      //   resp: { hit, persons:[{ phones:[{number,type,dnc}], emails:[{email}] }] }
      // ALWAYS find_owner=true: resolve the owner OF the property at this address. Robust
      // for both LLC and individual owners — the name-based path (find_owner=false) was
      // too strict and missed real owners. We anchor on the subject property address.
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
        keyConfigured: !!key, keyEnv: provider.keyEnv, build: "skiptrace-v1",
      });
    }

    // No key yet → tell the frontend so it can show "not configured" instead of erroring.
    if (!key) {
      return res.status(200).json({ noKey: true, provider: provider.label, keyEnv: provider.keyEnv });
    }

    if (!name) return res.status(400).json({ error: "Need an owner name to trace." });

    // Anchor the trace on the PROPERTY address. Tracerfy/BatchData resolve the OWNER of
    // the property at the given address, so the subject address is the right anchor — the
    // owner's mailing address points at a DIFFERENT property and frequently misses. Fall
    // back to the mailing address only when no property address is present.
    const NYC_CITY = { manhattan: "New York", bronx: "Bronx", brooklyn: "Brooklyn", queens: "Queens", "staten island": "Staten Island" };
    const propStreet = clean(address);
    const onProperty = !!propStreet;
    const street = propStreet || clean(contact_address);
    if (!street) return res.status(400).json({ error: "Need a property or mailing address to trace." });
    const input = {
      name: clean(name),
      street,
      // Borough → a postal city the providers accept (Manhattan's USPS city is "New York").
      city: onProperty ? (NYC_CITY[clean(borough).toLowerCase()] || clean(borough) || clean(city)) : (clean(city) || clean(borough)),
      state: clean(state) || "NY",
      // The mailing ZIP belongs to a different address than the property — only send a ZIP
      // when we're actually tracing the mailing address.
      zip: onProperty ? "" : clean(zip),
    };

    const business = isCompany(name, entity_type);
    const raw = await provider.lookup(key, input, business);
    const { phones, emails } = normalizeContacts(raw);

    return res.status(200).json({
      provider: provider.label,
      business,
      phones,
      emails,
      matched: phones.length > 0 || emails.length > 0,
      // est. cost only when something matched (providers bill per hit)
      cost: phones.length || emails.length ? provider.estCost(business) : 0,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "skiptrace" });
  }
}
