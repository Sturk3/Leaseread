# FRONTAGE Sourcing

The **Sourcing** tab (next to Screener) sources NYC real-estate deals and the
people/companies attached to them, and exports a **clean CSV**. It runs in the
existing FRONTAGE Vercel app, behind the same password. No database, no saving —
each run produces a CSV you download.

## Sources

| Source | What it finds | Lead it gives you |
| --- | --- | --- |
| **ACRIS** | Recently recorded deeds/mortgages | The parties — sellers (grantors) and buyers (grantees) |
| **DOB** | Building job filings | The property owner on each filing |
| **PLUTO** | Tax lots by **asset type** (retail, office, multifamily, …) | The owner of each matching property |

## Filters

- **Sources** — toggle ACRIS / DOB / PLUTO.
- **Borough** — Manhattan / Bronx / Brooklyn / Queens / Staten Island.
- **Asset type** — Retail, Office, Multifamily, Mixed-use, Industrial, Hotel,
  Development site, 1–2 family, Condo. Applies to **PLUTO** (the only dataset
  with building class). Turn PLUTO on to use it.
- **Block from / to** — a tax-block region within the borough. Drives PLUTO
  server-side and refines ACRIS/DOB results.
- **Doc type** (ACRIS only, e.g. `DEED`), **Since** date, **Max per source**.

## Output

Hit **Source deals & contacts**, review the table, and **Export CSV**. The file
is named for your filters, e.g. `frontage_leads_brooklyn_retail_2026-06-15.csv`,
with columns: name, type (person/company), role, property address, borough,
building class, amount, date, source, and contact address.

## Nothing to set up

Live sourcing + CSV export work on the free tier with no database and no extra
config. Just deploy and use it.

## Cost

$0. NYC Open Data is free, the sourcing tab makes no Claude calls, and Vercel's
free tier covers it. (Vercel's free tier is technically non-commercial — revisit
Pro only once it's a real team workflow.)

## Parked for later (optional)

If this becomes a team workflow and you want a shared, persisted lead list
instead of per-run CSVs, the groundwork is already in the repo but **not wired
into the UI**: `api/leads.js` (Postgres read/update) and `db/schema.sql` (the
`leads` table). To turn it on you'd add a Neon `DATABASE_URL` and re-expose the
"shared list" UI — ask and I'll light it up. Until then, ignore it.

## Standalone Python agent

`nyc-sourcing-agent/` is the same connectors as a local CLI (offline `--selftest`,
optional Claude name-cleanup via `--enrich`) for bulk/offline runs.
