#!/usr/bin/env python3
"""NYC real-estate deal & contact sourcing agent.

Pulls property records and the people / companies attached to them from public
NYC Open Data (ACRIS + DOB) and from local CSV/JSON files, normalizes them into
``Deal`` and ``Contact`` rows, and writes CSV/JSON. This is a *sourcing* tool —
it gathers and structures records. It does no scoring or ranking.

Sources
-------
- **ACRIS** (Automated City Register Information System) — recorded real-property
  documents (deeds, mortgages) plus the parties on each document. The parties are
  the leads: grantors/sellers, grantees/buyers, lenders, etc.
- **DOB** (Department of Buildings) — job application filings, which carry the
  owner's name and contact info.
- **local** — any CSV/JSON you drop in (off-market lists, scraped leads, etc.).

The network connectors hit the Socrata SODA API; an app token is optional but
raises the rate limit. Claude (optional, ``--enrich``) is used purely to clean up
party names into structured contacts (person vs. company, first/last split).

Run ``python nyc_sourcing_agent.py --selftest`` for an offline self-check that
needs no network, no API key, and no third-party packages installed.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import tempfile
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Iterable, Optional

# Third-party packages (requests / python-dotenv / anthropic) are imported lazily
# inside the functions that need them, so --selftest works on a bare checkout.

SOCRATA_BASE = "https://data.cityofnewyork.us/resource"

# NYC Open Data dataset IDs (Socrata). Override via env if these ever change.
ACRIS_MASTER = os.environ.get("ACRIS_MASTER_DATASET", "bnx9-e6tj")   # Real Property Master
ACRIS_LEGALS = os.environ.get("ACRIS_LEGALS_DATASET", "8h5j-fqxa")   # Real Property Legals
ACRIS_PARTIES = os.environ.get("ACRIS_PARTIES_DATASET", "636b-3b5g")  # Real Property Parties
DOB_JOBS = os.environ.get("DOB_JOBS_DATASET", "ic3t-wcy2")           # DOB Job Application Filings

BOROUGH_CODE = {
    "1": "Manhattan",
    "2": "Bronx",
    "3": "Brooklyn",
    "4": "Queens",
    "5": "Staten Island",
}
BOROUGH_NAME_TO_CODE = {v.lower(): k for k, v in BOROUGH_CODE.items()}

# ACRIS party_type → role. Type 1 is the first party (grantor/seller on a deed),
# type 2 the second (grantee/buyer). Higher types vary by doc; label generically.
ACRIS_PARTY_ROLE = {"1": "grantor", "2": "grantee", "3": "party-3"}

# Tokens that signal an organization rather than a natural person.
COMPANY_TOKENS = {
    "LLC", "L.L.C", "INC", "INCORPORATED", "CORP", "CORPORATION", "CO", "COMPANY",
    "LP", "L.P", "LLP", "TRUST", "ASSOCIATES", "REALTY", "PARTNERS", "HOLDINGS",
    "GROUP", "FUND", "BANK", "NA", "N.A", "MANAGEMENT", "MGMT", "PROPERTIES",
    "PROPERTY", "DEVELOPMENT", "VENTURES", "CAPITAL", "ENTERPRISES", "FOUNDATION",
    "CHURCH", "HOUSING", "HDFC", "CONDOMINIUM", "CONDO", "TENANTS", "ESTATE",
    "EQUITIES", "GROUP", "PARTNERSHIP", "SERVICES", "INVESTORS", "INVESTMENT",
}


# --------------------------------------------------------------------------- #
# Data models
# --------------------------------------------------------------------------- #
@dataclass
class Deal:
    source: str                     # "acris" | "dob" | "local"
    deal_id: str                    # document_id / job number / local id
    doc_type: str                   # DEED, MORTGAGE, NB, A1, ...
    borough: str = ""
    address: str = ""
    block: str = ""
    lot: str = ""
    amount: Optional[float] = None
    date: str = ""
    raw: dict = field(default_factory=dict, repr=False)


@dataclass
class Contact:
    name: str
    role: str = "party"             # seller/buyer/owner/applicant/lender/...
    entity_type: str = "unknown"    # person | company | unknown
    first_name: str = ""
    last_name: str = ""
    address: str = ""
    city: str = ""
    state: str = ""
    zip: str = ""
    source: str = ""
    deal_id: str = ""


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #
def to_float(value: Any) -> Optional[float]:
    if value in (None, "", "0"):
        return None
    try:
        return float(str(value).replace(",", "").replace("$", "").strip())
    except (TypeError, ValueError):
        return None


def clean(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def borough_to_name(value: Any) -> str:
    v = clean(value)
    if v in BOROUGH_CODE:
        return BOROUGH_CODE[v]
    return v.title() if v else ""


def looks_like_company(name: str) -> bool:
    tokens = re.split(r"[\s,.\-]+", name.upper())
    return any(tok in COMPANY_TOKENS for tok in tokens if tok)


def split_person_name(name: str) -> tuple[str, str]:
    """Best-effort first/last split for a natural-person name.

    ACRIS records people as ``LAST FIRST MIDDLE`` (sometimes ``LAST, FIRST``).
    This heuristic is intentionally simple; ``--enrich`` improves on it.
    """
    n = clean(name)
    if "," in n:
        last, _, rest = n.partition(",")
        first = clean(rest).split(" ")[0] if rest.strip() else ""
        return clean(first).title(), clean(last).title()
    parts = [p for p in n.split(" ") if p]
    if len(parts) == 1:
        return "", parts[0].title()
    return parts[1].title(), parts[0].title()  # assume LAST FIRST ...


def heuristic_normalize(contact: Contact) -> Contact:
    """Fill entity_type / first_name / last_name without an LLM."""
    if looks_like_company(contact.name):
        contact.entity_type = "company"
        contact.first_name = ""
        contact.last_name = ""
    else:
        contact.entity_type = "person"
        contact.first_name, contact.last_name = split_person_name(contact.name)
    return contact


def chunked(seq: list, size: int) -> Iterable[list]:
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


# --------------------------------------------------------------------------- #
# Socrata fetch
# --------------------------------------------------------------------------- #
def fetch_socrata(
    dataset_id: str,
    *,
    where: Optional[str] = None,
    select: Optional[str] = None,
    order: Optional[str] = None,
    limit: int = 1000,
    app_token: Optional[str] = None,
) -> list[dict]:
    import requests  # lazy: only needed for live sourcing

    params: dict[str, Any] = {"$limit": limit}
    if where:
        params["$where"] = where
    if select:
        params["$select"] = select
    if order:
        params["$order"] = order
    headers = {"X-App-Token": app_token} if app_token else {}
    url = f"{SOCRATA_BASE}/{dataset_id}.json"
    resp = requests.get(url, params=params, headers=headers, timeout=60)
    resp.raise_for_status()
    return resp.json()


def _sodaquote(values: Iterable[str]) -> str:
    return ", ".join("'" + v.replace("'", "''") + "'" for v in values)


# --------------------------------------------------------------------------- #
# Parsers (pure functions — unit-testable without network)
# --------------------------------------------------------------------------- #
def parse_acris(
    master: list[dict],
    legals: list[dict],
    parties: list[dict],
) -> tuple[list[Deal], list[Contact]]:
    legals_by_doc: dict[str, dict] = {}
    for row in legals:
        legals_by_doc.setdefault(clean(row.get("document_id")), row)

    deals: list[Deal] = []
    for row in master:
        doc_id = clean(row.get("document_id"))
        if not doc_id:
            continue
        legal = legals_by_doc.get(doc_id, {})
        street = clean(f"{legal.get('street_number', '')} {legal.get('street_name', '')}")
        unit = clean(legal.get("unit") or legal.get("addr_unit") or "")
        address = clean(f"{street} {('Unit ' + unit) if unit else ''}")
        deals.append(Deal(
            source="acris",
            deal_id=doc_id,
            doc_type=clean(row.get("doc_type")),
            borough=borough_to_name(row.get("recorded_borough") or legal.get("borough")),
            address=address,
            block=clean(legal.get("block")),
            lot=clean(legal.get("lot")),
            amount=to_float(row.get("document_amt")),
            date=clean(row.get("document_date") or row.get("recorded_datetime")),
            raw=row,
        ))

    contacts: list[Contact] = []
    for row in parties:
        name = clean(row.get("name"))
        if not name:
            continue
        addr = clean(f"{row.get('address_1', '')} {row.get('address_2', '')}")
        contacts.append(Contact(
            name=name,
            role=ACRIS_PARTY_ROLE.get(clean(row.get("party_type")), "party"),
            address=addr,
            city=clean(row.get("city")),
            state=clean(row.get("state")),
            zip=clean(row.get("zip")),
            source="acris",
            deal_id=clean(row.get("document_id")),
        ))
    return deals, contacts


def parse_dob(rows: list[dict]) -> tuple[list[Deal], list[Contact]]:
    deals: list[Deal] = []
    contacts: list[Contact] = []
    for row in rows:
        job = clean(row.get("job__") or row.get("job") or row.get("job_number"))
        if not job:
            continue
        address = clean(f"{row.get('house__', '')} {row.get('street_name', '')}")
        deals.append(Deal(
            source="dob",
            deal_id=job,
            doc_type=clean(row.get("job_type") or "DOB-JOB"),
            borough=borough_to_name(row.get("borough")),
            address=address,
            block=clean(row.get("block")),
            lot=clean(row.get("lot")),
            amount=to_float(row.get("initial_cost")),
            date=clean(row.get("pre__filing_date") or row.get("latest_action_date")),
            raw=row,
        ))
        owner_name = clean(
            row.get("owner_s_business_name")
            or f"{row.get('owner_s_last_name', '')} {row.get('owner_s_first_name', '')}"
        )
        if owner_name:
            owner_addr = clean(
                f"{row.get('owner_s_house__', '')} {row.get('owner_s_house_street_name', '')}"
            )
            contacts.append(Contact(
                name=owner_name,
                role="owner",
                address=owner_addr,
                city=clean(row.get("city")),
                state=clean(row.get("state")),
                zip=clean(row.get("owner_s_zip_code") or row.get("zip")),
                source="dob",
                deal_id=job,
            ))
    return deals, contacts


def parse_local(rows: list[dict], source_label: str = "local") -> tuple[list[Deal], list[Contact]]:
    """Map flexible local rows into deals + contacts.

    Recognized columns (case-insensitive, all optional except an id/address):
      id, doc_type, borough, address, block, lot, amount, date,
      owner_name / contact_name, owner_address, city, state, zip, role
    """
    deals: list[Deal] = []
    contacts: list[Contact] = []
    for i, raw in enumerate(rows):
        row = {clean(k).lower(): v for k, v in raw.items()}
        deal_id = clean(row.get("id") or row.get("deal_id") or f"{source_label}-{i + 1}")
        deals.append(Deal(
            source=source_label,
            deal_id=deal_id,
            doc_type=clean(row.get("doc_type") or "LOCAL"),
            borough=borough_to_name(row.get("borough")),
            address=clean(row.get("address")),
            block=clean(row.get("block")),
            lot=clean(row.get("lot")),
            amount=to_float(row.get("amount") or row.get("price")),
            date=clean(row.get("date")),
            raw=raw,
        ))
        name = clean(row.get("owner_name") or row.get("contact_name") or row.get("owner"))
        if name:
            contacts.append(Contact(
                name=name,
                role=clean(row.get("role") or "owner"),
                address=clean(row.get("owner_address") or row.get("contact_address")),
                city=clean(row.get("city")),
                state=clean(row.get("state")),
                zip=clean(row.get("zip") or row.get("zipcode")),
                source=source_label,
                deal_id=deal_id,
            ))
    return deals, contacts


# --------------------------------------------------------------------------- #
# Live sourcing connectors
# --------------------------------------------------------------------------- #
def source_acris(
    *,
    borough: Optional[str] = None,
    doc_type: Optional[str] = None,
    since: Optional[str] = None,
    limit: int = 200,
    app_token: Optional[str] = None,
) -> tuple[list[Deal], list[Contact]]:
    where_parts = []
    if borough:
        code = BOROUGH_NAME_TO_CODE.get(borough.lower(), borough)
        where_parts.append(f"recorded_borough='{code}'")
    if doc_type:
        where_parts.append(f"upper(doc_type)='{doc_type.upper()}'")
    if since:
        where_parts.append(f"document_date>='{since}'")
    where = " AND ".join(where_parts) or None

    master = fetch_socrata(
        ACRIS_MASTER, where=where, order="recorded_datetime DESC",
        limit=limit, app_token=app_token,
    )
    doc_ids = [clean(r.get("document_id")) for r in master if r.get("document_id")]
    if not doc_ids:
        return [], []

    legals: list[dict] = []
    parties: list[dict] = []
    for batch in chunked(doc_ids, 75):  # keep $where under URL limits
        in_clause = f"document_id in ({_sodaquote(batch)})"
        legals += fetch_socrata(ACRIS_LEGALS, where=in_clause, limit=2000, app_token=app_token)
        parties += fetch_socrata(ACRIS_PARTIES, where=in_clause, limit=4000, app_token=app_token)
    return parse_acris(master, legals, parties)


def source_dob(
    *,
    borough: Optional[str] = None,
    since: Optional[str] = None,
    limit: int = 200,
    app_token: Optional[str] = None,
) -> tuple[list[Deal], list[Contact]]:
    where_parts = []
    if borough:
        # DOB stores the borough name in upper case.
        where_parts.append(f"upper(borough)='{borough.upper()}'")
    if since:
        where_parts.append(f"pre__filing_date>='{since}'")
    where = " AND ".join(where_parts) or None
    rows = fetch_socrata(
        DOB_JOBS, where=where, order="pre__filing_date DESC",
        limit=limit, app_token=app_token,
    )
    return parse_dob(rows)


def load_local(path: str | Path) -> tuple[list[Deal], list[Contact]]:
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"local source not found: {p}")
    if p.suffix.lower() == ".json":
        data = json.loads(p.read_text(encoding="utf-8"))
        rows = data if isinstance(data, list) else data.get("rows") or data.get("data") or []
    else:  # CSV / TSV
        delim = "\t" if p.suffix.lower() == ".tsv" else ","
        with p.open(newline="", encoding="utf-8-sig") as fh:
            rows = list(csv.DictReader(fh, delimiter=delim))
    return parse_local(rows, source_label=f"local:{p.name}")


# --------------------------------------------------------------------------- #
# Normalization / dedup
# --------------------------------------------------------------------------- #
def dedup_contacts(contacts: list[Contact]) -> list[Contact]:
    seen: set[tuple[str, str, str]] = set()
    out: list[Contact] = []
    for c in contacts:
        key = (clean(c.name).upper(), clean(c.deal_id).upper(), clean(c.role).lower())
        if key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out


def dedup_deals(deals: list[Deal]) -> list[Deal]:
    seen: set[tuple[str, str]] = set()
    out: list[Deal] = []
    for d in deals:
        key = (d.source.split(":")[0], clean(d.deal_id).upper())
        if key in seen:
            continue
        seen.add(key)
        out.append(d)
    return out


def normalize_contacts(contacts: list[Contact], *, use_llm: bool) -> list[Contact]:
    if use_llm:
        try:
            return enrich_contacts_with_claude(contacts)
        except Exception as exc:  # noqa: BLE001 — degrade gracefully, never crash sourcing
            print(f"  ! Claude enrichment failed ({exc}); falling back to heuristics.",
                  file=sys.stderr)
    return [heuristic_normalize(c) for c in contacts]


def enrich_contacts_with_claude(
    contacts: list[Contact],
    *,
    model: str = "claude-opus-4-8",
    batch_size: int = 40,
) -> list[Contact]:
    """Use Claude to structure raw party names into clean contacts.

    Purely normalization: classify person vs. company and split person names.
    No scoring or ranking. Falls back to heuristics per-batch on any error.
    """
    from anthropic import Anthropic  # lazy

    client = Anthropic()  # reads ANTHROPIC_API_KEY from env
    schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "contacts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "index": {"type": "integer"},
                        "entity_type": {"type": "string", "enum": ["person", "company"]},
                        "first_name": {"type": "string"},
                        "last_name": {"type": "string"},
                    },
                    "required": ["index", "entity_type", "first_name", "last_name"],
                },
            }
        },
        "required": ["contacts"],
    }

    for batch in chunked(contacts, batch_size):
        listing = "\n".join(f"{i}: {c.name}" for i, c in enumerate(batch))
        prompt = (
            "Normalize these raw property-record party names. For each, decide if it "
            "is a natural person or a company/organization/trust. For persons, split "
            "into first_name and last_name (records are often formatted LAST FIRST). "
            "For companies, leave first_name and last_name empty. Return every index.\n\n"
            f"{listing}"
        )
        try:
            resp = client.messages.create(
                model=model,
                max_tokens=4000,
                output_config={"format": {"type": "json_schema", "schema": schema}},
                messages=[{"role": "user", "content": prompt}],
            )
            text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
            parsed = json.loads(text)
            by_index = {item["index"]: item for item in parsed.get("contacts", [])}
        except Exception as exc:  # noqa: BLE001
            print(f"  ! batch enrichment error ({exc}); heuristics for this batch.",
                  file=sys.stderr)
            by_index = {}
        for i, c in enumerate(batch):
            item = by_index.get(i)
            if item:
                c.entity_type = item.get("entity_type", "unknown")
                c.first_name = clean(item.get("first_name"))
                c.last_name = clean(item.get("last_name"))
            else:
                heuristic_normalize(c)
    return contacts


# --------------------------------------------------------------------------- #
# Output
# --------------------------------------------------------------------------- #
DEAL_FIELDS = ["source", "deal_id", "doc_type", "borough", "address",
               "block", "lot", "amount", "date"]
CONTACT_FIELDS = ["name", "entity_type", "first_name", "last_name", "role",
                  "address", "city", "state", "zip", "source", "deal_id"]


def write_outputs(
    deals: list[Deal],
    contacts: list[Contact],
    out_dir: str | Path,
    fmt: str = "csv",
) -> list[Path]:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []

    if fmt in ("csv", "both"):
        dp = out / "deals.csv"
        with dp.open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=DEAL_FIELDS)
            w.writeheader()
            for d in deals:
                w.writerow({k: getattr(d, k) for k in DEAL_FIELDS})
        written.append(dp)

        cp = out / "contacts.csv"
        with cp.open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=CONTACT_FIELDS)
            w.writeheader()
            for c in contacts:
                w.writerow({k: getattr(c, k) for k in CONTACT_FIELDS})
        written.append(cp)

    if fmt in ("json", "both"):
        jp = out / "sourced.json"
        payload = {
            "deals": [{k: getattr(d, k) for k in DEAL_FIELDS} for d in deals],
            "contacts": [asdict(c) for c in contacts],
        }
        jp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        written.append(jp)

    return written


# --------------------------------------------------------------------------- #
# Self-test (offline; no network, no API key, no third-party deps)
# --------------------------------------------------------------------------- #
def selftest() -> int:
    failures: list[str] = []

    def check(name: str, cond: bool) -> None:
        status = "ok  " if cond else "FAIL"
        print(f"  [{status}] {name}")
        if not cond:
            failures.append(name)

    print("nyc_sourcing_agent self-test")

    # 1. Company detection
    check("company detection: 'PARK AVE HOLDINGS LLC'", looks_like_company("PARK AVE HOLDINGS LLC"))
    check("company detection: '123 REALTY CORP'", looks_like_company("123 REALTY CORP"))
    check("person not flagged: 'SMITH JOHN'", not looks_like_company("SMITH JOHN"))

    # 2. Person name split (LAST FIRST and LAST, FIRST)
    first, last = split_person_name("SMITH JOHN")
    check("split 'SMITH JOHN' -> John / Smith", (first, last) == ("John", "Smith"))
    first, last = split_person_name("DOE, JANE A")
    check("split 'DOE, JANE A' -> Jane / Doe", (first, last) == ("Jane", "Doe"))

    # 3. ACRIS parse from fixtures
    master = [{"document_id": "DOC1", "doc_type": "DEED", "document_amt": "1,250,000",
               "document_date": "2026-05-01", "recorded_borough": "3"}]
    legals = [{"document_id": "DOC1", "borough": "3", "block": "100", "lot": "5",
               "street_number": "123", "street_name": "MAIN ST", "unit": "2A"}]
    parties = [
        {"document_id": "DOC1", "party_type": "1", "name": "SELLER HOLDINGS LLC",
         "address_1": "1 WALL ST", "city": "NEW YORK", "state": "NY", "zip": "10005"},
        {"document_id": "DOC1", "party_type": "2", "name": "BUYER MARIA",
         "address_1": "123 MAIN ST", "city": "BROOKLYN", "state": "NY", "zip": "11201"},
    ]
    deals, contacts = parse_acris(master, legals, parties)
    check("acris: 1 deal parsed", len(deals) == 1)
    check("acris: deal amount = 1,250,000", deals and deals[0].amount == 1250000.0)
    check("acris: borough resolved to Brooklyn", deals and deals[0].borough == "Brooklyn")
    check("acris: address includes '123 Main St'", deals and "123 MAIN ST" in deals[0].address.upper())
    check("acris: 2 contacts parsed", len(contacts) == 2)
    check("acris: roles grantor/grantee",
          [c.role for c in contacts] == ["grantor", "grantee"])

    # 4. DOB parse
    dob_rows = [{"job__": "J123", "job_type": "A1", "borough": "MANHATTAN",
                 "house__": "55", "street_name": "BROADWAY", "block": "10", "lot": "1",
                 "owner_s_business_name": "ACME DEVELOPMENT LLC",
                 "pre__filing_date": "2026-04-15"}]
    d_deals, d_contacts = parse_dob(dob_rows)
    check("dob: 1 deal parsed", len(d_deals) == 1 and d_deals[0].deal_id == "J123")
    check("dob: owner contact captured",
          len(d_contacts) == 1 and d_contacts[0].name == "ACME DEVELOPMENT LLC")

    # 5. Heuristic normalization
    normed = [heuristic_normalize(c) for c in contacts]
    check("normalize: LLC -> company", normed[0].entity_type == "company")
    check("normalize: person split", normed[1].entity_type == "person" and normed[1].last_name == "Buyer")

    # 6. Dedup
    dupes = contacts + [contacts[0]]
    check("dedup contacts removes duplicate", len(dedup_contacts(dupes)) == 2)
    check("dedup deals removes duplicate", len(dedup_deals(deals + deals)) == 1)

    # 7. Local loader round-trip (CSV)
    with tempfile.TemporaryDirectory() as td:
        csv_path = Path(td) / "leads.csv"
        csv_path.write_text(
            "id,doc_type,borough,address,owner_name,amount,date\n"
            "L1,OFF-MARKET,Queens,\"99 Test Rd\",\"JONES BOB\",500000,2026-03-01\n",
            encoding="utf-8",
        )
        l_deals, l_contacts = load_local(csv_path)
        check("local: deal loaded", len(l_deals) == 1 and l_deals[0].borough == "Queens")
        check("local: contact loaded", len(l_contacts) == 1 and l_contacts[0].name == "JONES BOB")

        # 8. Output round-trip
        paths = write_outputs(deals, normed, Path(td) / "out", fmt="both")
        check("write: 3 files produced", len(paths) == 3)
        payload = json.loads((Path(td) / "out" / "sourced.json").read_text(encoding="utf-8"))
        check("write: json has deals + contacts",
              len(payload["deals"]) == 1 and len(payload["contacts"]) == 2)

    print()
    if failures:
        print(f"SELFTEST FAILED: {len(failures)} check(s) failed.")
        return 1
    print("SELFTEST PASSED: all checks ok.")
    return 0


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="nyc_sourcing_agent",
        description="Source NYC real-estate deals and contacts from ACRIS, DOB, and local files.",
    )
    p.add_argument("--source", default="acris,dob",
                   help="Comma list of sources: acris,dob,local (default: acris,dob).")
    p.add_argument("--borough", help="Filter: Manhattan|Bronx|Brooklyn|Queens|Staten Island.")
    p.add_argument("--doc-type", help="ACRIS doc type filter, e.g. DEED, MORTGAGE.")
    p.add_argument("--since", help="Only records on/after this date (YYYY-MM-DD).")
    p.add_argument("--limit", type=int, default=200, help="Max primary records per source.")
    p.add_argument("--local", help="Path to a local CSV/JSON/TSV source file.")
    p.add_argument("--out", default="./out", help="Output directory (default ./out).")
    p.add_argument("--format", choices=["csv", "json", "both"], default="csv",
                   help="Output format (default csv).")
    p.add_argument("--enrich", action="store_true",
                   help="Use Claude to normalize contact names (needs ANTHROPIC_API_KEY).")
    p.add_argument("--selftest", action="store_true",
                   help="Run offline self-checks and exit.")
    return p


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)

    if args.selftest:
        return selftest()

    # Load .env if python-dotenv is available (optional convenience).
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except Exception:  # noqa: BLE001
        pass

    app_token = os.environ.get("SOCRATA_APP_TOKEN")
    sources = [s.strip().lower() for s in args.source.split(",") if s.strip()]

    all_deals: list[Deal] = []
    all_contacts: list[Contact] = []

    if "acris" in sources:
        print("Sourcing ACRIS (deeds/mortgages + parties)...")
        d, c = source_acris(borough=args.borough, doc_type=args.doc_type,
                            since=args.since, limit=args.limit, app_token=app_token)
        print(f"  -> {len(d)} deals, {len(c)} contacts")
        all_deals += d
        all_contacts += c

    if "dob" in sources:
        print("Sourcing DOB (job filings + owners)...")
        d, c = source_dob(borough=args.borough, since=args.since,
                         limit=args.limit, app_token=app_token)
        print(f"  -> {len(d)} deals, {len(c)} contacts")
        all_deals += d
        all_contacts += c

    if "local" in sources or args.local:
        if not args.local:
            print("  ! --source local given but no --local PATH provided; skipping.",
                  file=sys.stderr)
        else:
            print(f"Loading local source {args.local}...")
            d, c = load_local(args.local)
            print(f"  -> {len(d)} deals, {len(c)} contacts")
            all_deals += d
            all_contacts += c

    all_deals = dedup_deals(all_deals)
    all_contacts = dedup_contacts(all_contacts)

    if not all_deals and not all_contacts:
        print("No records sourced. Check filters / network / dataset IDs.", file=sys.stderr)
        return 1

    print(f"Normalizing {len(all_contacts)} contacts "
          f"({'Claude' if args.enrich else 'heuristics'})...")
    all_contacts = normalize_contacts(all_contacts, use_llm=args.enrich)

    paths = write_outputs(all_deals, all_contacts, args.out, fmt=args.format)
    print(f"\nDone. {len(all_deals)} deals, {len(all_contacts)} contacts.")
    for path in paths:
        print(f"  wrote {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
