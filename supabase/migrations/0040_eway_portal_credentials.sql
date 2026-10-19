-- 0040 — e-way bill portal API credentials (per user).
--
-- A taxpayer who wants the app to generate e-way bills creates an "API user" on
-- ewaybillgst.gov.in (username + password, separate from their portal login) with Quicko Infosoft
-- Pvt. Ltd. (Sandbox) registered as the GSP. We keep that pair so bills can be generated in their name:
-- the password AES-256-GCM encrypted under bt-booking-service's EWB_CREDENTIALS_KEY and never
-- returned by any route. One row per user; the GSTIN is the one the bills are generated under.

create table if not exists public.eway_portal_credentials (
  user_id      uuid        primary key references public.users(id) on delete cascade,
  gstin        text        not null,
  username     text        not null,
  password_enc text        not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint eway_portal_credentials_gstin_format
    check (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$')
);

comment on table public.eway_portal_credentials is
  'E-way bill portal API user per account: username + AES-256-GCM encrypted password used to generate NIC e-way bills through the GSP (Sandbox). Never read back to a client.';

alter table public.eway_portal_credentials enable row level security;
