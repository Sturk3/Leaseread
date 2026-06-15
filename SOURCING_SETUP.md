# FRONTAGE Sourcing — going live for the team

The **Sourcing** tab (next to Screener) sources NYC real-estate deals and the
people/companies attached to them (ACRIS deeds + DOB filings), shows them in a
table, exports CSV, and — once a database is connected — saves them to a shared,
deduped list the whole team can work and track.

Everything runs in the existing FRONTAGE Vercel app, behind the same password.

## What works with no extra setup

After deploying this code, the **Source live** tab and **CSV export** work
immediately — no database needed. The serverless function `api/source.js` calls
NYC Open Data directly.

## Turning on the shared list (one-time, ~10 min)

The **Shared list** tab and the "Save to the shared list" checkbox need Postgres.

1. **Create a database.** In the Vercel dashboard for this project:
   **Storage → Create Database → Neon (Postgres)** (free tier is fine).
   Vercel will add a `DATABASE_URL` env var to the project automatically.
   (Supabase or any Postgres also works — just set `DATABASE_URL` yourself.)

2. **Create the table.** Open the database's SQL editor (Neon console, or
   `psql "$DATABASE_URL"`) and run the contents of [`db/schema.sql`](db/schema.sql).

3. **Confirm env vars** (Vercel → Settings → Environment Variables):
   | Var | Needed for | Notes |
   | --- | --- | --- |
   | `SITE_PASSWORD` | the password gate | you already have this |
   | `ANTHROPIC_API_KEY` | the Screener | you already have this |
   | `DATABASE_URL` | the shared list | added by Neon in step 1 |
   | `SOCRATA_APP_TOKEN` | higher rate limits | optional — [get one free](https://data.cityofnewyork.us/profile/edit/developer_settings) |

4. **Redeploy** (push to the branch Vercel tracks, or hit Redeploy). Done — the
   Shared list tab now loads, and "Save to the shared list" persists leads.

## Deploy

```bash
npm install        # picks up the new `pg` dependency
git add -A && git commit -m "Add NYC sourcing tab + shared leads store"
git push           # Vercel auto-deploys
```

## How the team uses it

- **Source live** — pick sources (ACRIS/DOB), borough, doc type, date, and a max
  count; hit Source. Review the table, export CSV, or check **Save to the shared
  list** to push deduped leads into the database.
- **Shared list** — everyone sees the same accumulated leads. Filter by status /
  source, search names/addresses, and set each lead's status
  (`new → working → contacted → dead`). Changes are saved for the whole team.

## Notes

- Dedupe key is `(source, deal_id, name, role)` — re-sourcing the same records
  won't create duplicates; the saved count reflects only genuinely new leads.
- The standalone Python agent in `nyc-sourcing-agent/` still exists for offline /
  bulk runs and the optional Claude name-normalization (`--enrich`). The web tool
  uses the same connectors and heuristic normalization, ported to JS.
- `api/source.js` is capped at 250 records per source per run to stay within the
  serverless time limit. For larger pulls, use the Python agent.
