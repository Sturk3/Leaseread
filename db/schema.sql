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
