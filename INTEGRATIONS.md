# FRONTAGE — Integrations & how to add an API

This is the handoff map for every external service FRONTAGE talks to, and the recipe for
adding a new one. The goal: **adding an API is "set the key the health check asks for,"
not "read 19 files."**

## Check what's wired (one call)

`POST /api/health` with `{ "password": "<SITE_PASSWORD>" }` returns, for every integration:
its status (`ready` / `not configured` / `planned` / `MISSING KEY`), the active provider,
which env keys it needs, and whether each is set (booleans only — no values are returned).
`summary.blocking` lists any **required** capability missing a key.

The single source of truth behind that report is [`api/_lib/providers.js`](api/_lib/providers.js).
Add a provider there and it shows up in the health check automatically.

## The pluggable pattern (every contact-workflow lane follows it)

1. A `<CAPABILITY>_PROVIDER` env selects the active lane, with a sensible default.
2. Each lane reads its **own** key(s) from `process.env`, server-side only.
3. The endpoint parses the vendor response with a **tolerant parser** that walks for fields
   by name — so a vendor renaming a field doesn't break the UI.
4. No key → the endpoint returns `{ noKey: true }` and the UI shows "not configured"
   instead of erroring. **Adding the key later activates the lane with no code change.**
5. A zero-cost `{ "debug": true }` probe on the endpoint confirms the live lane + key state
   without spending a credit.

## Environment variables

### Required to run
| Var | Powers |
|---|---|
| `ANTHROPIC_API_KEY` | Scout, AI Quick Take, LLC unmask, relatives/associates, memos, outreach, OM/NDA grading |
| `SITE_PASSWORD` | Shared-password gate on every endpoint |

### Owner-contact workflow (the pluggable lanes)
| Capability | Select env (default) | Lane keys | Status |
|---|---|---|---|
| Skip trace | `SKIPTRACE_PROVIDER` (`tracerfy`) | `TRACERFY_API_KEY` · `BATCHDATA_API_KEY` | **active** |
| Phone verify | `PHONE_VERIFY_PROVIDER` (`twilio`) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | planned (drop-in) |
| Entity unmask | `ENTITY_PROVIDER` (`web`) | web lane needs no key · `OPENSOSDATA_API_KEY` | web active; structured planned |
| SC SOS registry (structured) | — (`/api/scentity`) | `COBALT_API_KEY` (cobaltintelligence.com) | **wired** — lane off until key set; Charleston tab falls back to web unmask |
| Property data | `PROPERTY_PROVIDER` (`attom`) | `ATTOM_API_KEY` · `REGRID_API_TOKEN` | parked (branch) |

### Optional
| Var | Effect |
|---|---|
| `DATABASE_URL` | Turns the Saved List / Pipeline into a **shared** team list (Postgres/Neon). Without it, pipeline is device-local and still works. |
| `RESEARCH_LIVE_WEB` | `!=0` enables live web search in research lanes (needs the 300s function limit). Off → knowledge-only. |
| `SOCRATA_APP_TOKEN` | Higher rate limits on free open-data pulls. Everything works without it. |
| `RESEARCH_MODEL` / `AGENT_MODEL` / `AGENT_MODEL_DEEP` | Model overrides per surface. |
| `*_DATASET` / `*_URL` | Dataset/endpoint ID overrides for the per-market open-data connectors (rarely changed). |

Every var above is also enumerated with its meaning in `api/_lib/providers.js`.

## Recipes — add a provider

### A better skip tracer (phones/emails/relatives)
Edit [`api/skiptrace.js`](api/skiptrace.js) → the `PROVIDERS` map. Add:
```js
myprovider: {
  label: "MyProvider",
  keyEnv: "MYPROVIDER_API_KEY",
  estCost: () => 0.1,
  async lookup(key, input) {           // input: { name, street, city, state, zip }
    const r = await fetch(BASE + "/lookup", { method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: JSON.stringify({ /* map input to the vendor's shape */ }) });
    return r.json();                   // return the RAW vendor JSON
  },
},
```
The tolerant `normalizeContacts` / `extractPersons` / `personRelatives` already pull phones,
emails, and **relatives** out of arbitrary field names — you usually don't touch the parser.
Then set `SKIPTRACE_PROVIDER=myprovider` + `MYPROVIDER_API_KEY`. Add a lane entry to
`api/_lib/providers.js` so it appears in `/api/health`.

### Phone verification (raise number accuracy) — documented insertion point
In [`api/skiptrace.js`](api/skiptrace.js), after `extractPersons` builds `persons`, and before
the response is returned, add a verify step gated on a key:
```js
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  for (const p of persons)
    for (const ph of p.phones) {
      const v = await verifyLine(ph.number);      // Twilio Lookup v2 line_status
      ph.live = v.live; ph.lineType = v.lineType; ph.carrier = v.carrier;
    }
  // then drop dead lines / re-rank by `live` in phoneGrade
}
```
No key → this block is skipped and behaviour is unchanged. Flip the `phone_verify` lane's
`implemented: false` → `true` in `api/_lib/providers.js` once wired.

### Structured entity registry (instead of AI web unmask)
DONE for South Carolina: `api/scentity.js` hits the live SC SOS record via Cobalt
Intelligence's Secretary of State API (set `COBALT_API_KEY`; field names marked CONFIRM
are verified by the first real call / `{debug:true}`). The Charleston tab's SC entity box
is registry-first and falls back to the web unmask on `noKey` / no match. SC filings name
the registered agent + officers, NOT LLC members — the web unmask stays the route to a human
principal. To generalize to other states, follow the same pattern (Cobalt covers all 50):
create the state's endpoint or extend scentity with a `state` param, keep the web fallback.

## Deploy notes
- Vercel env vars must have **Production** checked, and a change needs a fresh deploy to take effect.
- Deploys happen on **git push** only; confirm via the GitHub commit-status API or `/api/health`.
- The build SHA shows in the app sidebar (from `VERCEL_GIT_COMMIT_SHA`).
