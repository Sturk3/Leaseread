# NYC Sourcing Agent

Sources NYC real-estate **deals** and the **contacts** (people/companies) attached
to them, from public NYC Open Data plus your own local files. It gathers and
structures records — it does **no** scoring or ranking.

## Sources

| Source | What it pulls | Contacts it yields |
| ------ | ------------- | ------------------ |
| **ACRIS** | Recorded deeds/mortgages (Real Property Master + Legals) | Parties on each document — grantors/sellers, grantees/buyers, lenders |
| **DOB** | Job application filings | Property owners (name + address) |
| **local** | Any CSV/JSON/TSV you point it at | Owner/contact column you provide |

ACRIS and DOB are read through the Socrata SODA API at `data.cityofnewyork.us`.
An app token is optional but lifts the rate limit.

## Setup

```bash
pip install -r requirements.txt
cp .env.example .env        # paste your ANTHROPIC_API_KEY into .env (only needed for --enrich)
python nyc_sourcing_agent.py --selftest
```

`--selftest` runs fully offline — no network, no API key, and it works before
`pip install` (the third-party deps are imported lazily).

## Usage

```bash
# Recently recorded Brooklyn deeds + DOB filings -> CSV in ./out
python nyc_sourcing_agent.py --source acris,dob --borough Brooklyn --doc-type DEED \
    --since 2026-01-01 --limit 200 --out ./out

# Just ACRIS, both CSV and JSON
python nyc_sourcing_agent.py --source acris --format both

# Pull in a local off-market list alongside the live sources
python nyc_sourcing_agent.py --source acris,dob,local --local sample_data/leads.csv

# Normalize contact names with Claude (person vs. company, first/last split)
python nyc_sourcing_agent.py --source acris --enrich
```

### Options

| Flag | Meaning |
| ---- | ------- |
| `--source` | `acris,dob,local` (comma list; default `acris,dob`) |
| `--borough` | `Manhattan` / `Bronx` / `Brooklyn` / `Queens` / `Staten Island` |
| `--doc-type` | ACRIS doc type filter, e.g. `DEED`, `MORTGAGE` |
| `--since` | Only records on/after `YYYY-MM-DD` |
| `--limit` | Max primary records per source (default 200) |
| `--local` | Path to a local CSV/JSON/TSV file |
| `--out` | Output directory (default `./out`) |
| `--format` | `csv` / `json` / `both` (default `csv`) |
| `--enrich` | Use Claude to normalize contact names (needs `ANTHROPIC_API_KEY`) |
| `--selftest` | Run offline self-checks and exit |

## Output

- `out/deals.csv` — one row per sourced deal
- `out/contacts.csv` — one row per party/owner (your leads)
- `out/sourced.json` — both, combined (with `--format json`/`both`)

## Notes

- Without `--enrich`, contact names are normalized with built-in heuristics
  (LLC/Corp detection, `LAST FIRST` → first/last split). `--enrich` hands the
  same job to Claude for better accuracy and gracefully falls back to heuristics
  if the API call fails.
- Dataset IDs are the standard NYC Open Data ones and can be overridden via env
  vars (see `.env.example`) if they ever change.
