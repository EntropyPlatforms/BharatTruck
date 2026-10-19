-- 0042_alerts.sql
--
-- One row per open problem. The rules in bt-booking-service/src/lib/alerts decide WHAT is
-- wrong, on a schedule (POST /internal/alerts/sweep, called by Cloud Scheduler); this table
-- is only where the answer lives, so the Home feed and email reach people when nobody has
-- the dashboard open.
--
-- dedupe_key makes "the same problem" ONE row: a sweep refreshes it, resolves it when the
-- condition clears, and reopens the same row if it comes back. Severity may escalate in
-- place (an unpaid trip goes warning -> critical at 7 days).
--
-- Additive and forward-safe: a new table nothing else depends on. The service treats a
-- missing table as "no alerts" for reads and refuses the sweep with a clear 503 until this
-- is applied. Service-only (RLS on, no policies) like every table here.

create table if not exists public.alerts (
  id               uuid primary key default gen_random_uuid(),
  audience_user_id uuid not null references public.users(id) on delete cascade,
  persona          text not null check (persona in ('fleet', 'carrier', 'driver', 'shipper')),
  kind             text not null,
  severity         text not null check (severity in ('critical', 'warning', 'info')),
  subject_type     text not null check (subject_type in ('booking', 'vehicle', 'driver')),
  subject_id       uuid not null,
  title            text not null,
  detail           jsonb not null default '{}'::jsonb,
  dedupe_key       text not null unique,
  opened_at        timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  acknowledged_at  timestamptz,
  resolved_at      timestamptz
);

-- The two reads: "my open alerts" (feed, dashboard) and "open alerts of these kinds" (the
-- sweep's resolve pass). Partial, so resolved history never slows either.
create index if not exists alerts_open_by_audience
  on public.alerts (audience_user_id, severity)
  where resolved_at is null;

create index if not exists alerts_open_by_kind
  on public.alerts (kind)
  where resolved_at is null;

alter table public.alerts enable row level security;
