-- migration 012: ops override audit trail (T-BE-6, CTO-verified 16/16)
-- Matches bt-booking-service AuditStore writer (lib/audit.ts) on feat/ops-override-endpoints@89b7b11.
-- Forward-only; APPLY gated on live-Supabase access. Audit writes are best-effort in code (never block
-- an override), so this landing is safe before/after apply.

-- Prerequisite backend flagged: the ops/admin console + seed need 'admin' in the user_role enum, which
-- may lag the code (per AGENT_HANDOFF). Add it idempotently. NOTE: in Postgres, ALTER TYPE ... ADD VALUE
-- cannot run inside a transaction block with other statements on some versions — if your migration runner
-- wraps everything in one tx and errors here, split this line into its own migration step.
alter type user_role add value if not exists 'admin';

create table if not exists public.ops_overrides (
  id             uuid primary key default gen_random_uuid(),
  booking_id     uuid not null references public.bookings(id) on delete cascade,
  action         text not null check (action in ('force_complete','reassign')),
  actor_user_id  uuid not null references public.users(id),
  from_status    text,
  to_status      text,
  from_driver_id uuid references public.drivers(id),
  to_driver_id   uuid references public.drivers(id),
  created_at     timestamptz not null default now()
);

create index if not exists ops_overrides_booking_created_idx
  on public.ops_overrides (booking_id, created_at desc);

comment on table public.ops_overrides is
  'Audit trail of ops/admin manual overrides (force-complete, reassign). Written best-effort by bt-booking-service.';

-- RLS: service-role only; no public policies.
alter table public.ops_overrides enable row level security;
