-- FRONTAGE sourcing — shared leads store.
-- Run once against your Postgres (Neon / Vercel Postgres / Supabase):
--   psql "$DATABASE_URL" -f db/schema.sql
-- or paste into the provider's SQL editor.

create table if not exists leads (
  id              bigserial primary key,

  -- deal (denormalized onto each contact row so a lead is self-contained)
  source          text not null,           -- acris | dob | local
  deal_id         text not null,           -- ACRIS document_id or DOB job number
  doc_type        text,                    -- DEED, MORTGAGE, A1, ...
  borough         text,
  address         text,
  block           text,
  lot             text,
  amount          numeric,
  deal_date       text,

  -- contact (the lead)
  name            text not null,
  role            text,                    -- grantor/grantee/owner/...
  entity_type     text,                    -- person | company | unknown
  first_name      text,
  last_name       text,
  contact_address text,
  city            text,
  state           text,
  zip             text,

  -- team workflow
  status          text not null default 'new',  -- new | working | contacted | dead
  notes           text,
  created_at      timestamptz not null default now(),

  -- dedupe: the same party on the same document/job is one lead
  unique (source, deal_id, name, role)
);

create index if not exists leads_status_idx  on leads (status);
create index if not exists leads_borough_idx on leads (borough);
create index if not exists leads_created_idx on leads (created_at desc);

-- ── Pipeline (the Saved List) ─────────────────────────────────────────────────
-- The shared team pipeline behind /api/pipeline. The endpoint AUTO-CREATES this
-- table on first use, so running this file is optional — it's here as reference.
-- One row per saved property; `lead` is the full client-side lead object
-- (denormalized display fields + status + notes + the raw sourcing row), keyed
-- by the client's ADDRESS|OWNER id. Removes are tombstones (deleted=true) so a
-- delete on one device wins over another device's stale local copy; updated_at
-- is the client's Date.now() ms and drives last-write-wins merging.

create table if not exists pipeline (
  id         text primary key,
  lead       jsonb not null,
  status     text not null default 'watching',
  deleted    boolean not null default false,
  updated_at bigint not null default 0,
  created_at timestamptz not null default now()
);
