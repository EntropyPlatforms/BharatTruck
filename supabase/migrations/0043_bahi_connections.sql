-- 0043 — Bahi Khata link (2026-10-22).
--
-- A carrier or shipper who keeps their books in Bahi (EntropyPlatforms/Bahi-Khata) creates an
-- integration token there (Bahi → integrations → tokens, ADMIN only) and pastes it into
-- Settings. When a load is paid, bt-booking-service posts the freight into their books:
-- the carrier gets a paid sales invoice to the shipper, the shipper a paid purchase invoice
-- from the carrier. The token is AES-256-GCM encrypted under bt-booking-service's
-- BAHI_CREDENTIALS_KEY (falls back to EWB_CREDENTIALS_KEY) and never returned by any route.
--
-- bahi_postings records each attempt, one row per (booking, user, kind): it is how the app
-- shows "posted to Bahi as SINV-0042" and how a failed post is retried. Bahi itself is also
-- idempotent on the booking id, so a retry can never book the same load twice.

create table if not exists public.bahi_connections (
  user_id      uuid          primary key references public.users(id) on delete cascade,
  token_enc    text          not null,
  company_name text,
  gstin        text,
  gst_rate     numeric(4,2)  not null default 0,
  created_at   timestamptz   not null default now(),
  updated_at   timestamptz   not null default now(),
  constraint bahi_connections_gst_rate check (gst_rate in (0, 5, 12, 18, 28))
);

comment on table public.bahi_connections is
  'Bahi Khata integration token per account (AES-256-GCM encrypted), the Bahi company it reaches, and the GST rate applied to freight posted there. Never read back to a client.';

create table if not exists public.bahi_postings (
  id           uuid        primary key default gen_random_uuid(),
  booking_id   uuid        not null references public.bookings(id) on delete cascade,
  user_id      uuid        not null references public.users(id) on delete cascade,
  kind         text        not null,
  status       text        not null,
  bahi_txn_id  text,
  bahi_number  text,
  bahi_status  text,
  amount_inr   numeric(14,2),
  note         text,
  error        text,
  attempts     integer     not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint bahi_postings_kind check (kind in ('income', 'expense')),
  constraint bahi_postings_status check (status in ('posted', 'draft', 'failed')),
  constraint bahi_postings_one_per_side unique (booking_id, user_id, kind)
);

create index if not exists bahi_postings_user_recent on public.bahi_postings (user_id, updated_at desc);

comment on table public.bahi_postings is
  'One row per load per account per side (income for the carrier, expense for the shipper): what was posted to Bahi, or why it failed.';

-- Service-only tables (see README "Why 0033 exists"): RLS on, no policies.
alter table public.bahi_connections enable row level security;
alter table public.bahi_postings    enable row level security;
