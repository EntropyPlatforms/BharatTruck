-- migration 011: cash-recorded payment + driver payout (T-BE-4, CTO-verified 17+9)
-- Matches bt-payment-service PaymentStore writer + booking-service completed->paid transition on
-- feat/cash-payment@5f9baae. NO escrow (OUT of MVP). Forward-only; APPLY gated on live-Supabase access.
-- UNIQUE(booking_id) on BOTH tables is the idempotency anchor: a booking settles/pays out at most once.

-- (1) extend the lifecycle: add the 'paid' status (state machine flips completed -> paid).
alter type booking_status add value if not exists 'paid';

-- (2) payments — the recorded cash/UPI/direct settlement (shipper pays).
create table if not exists public.payments (
  id           uuid primary key default gen_random_uuid(),
  booking_id   uuid not null unique references public.bookings(id) on delete cascade,
  amount       numeric(12,2) not null check (amount > 0),
  mode         text not null check (mode in ('cash','upi','direct')),
  reference    text,
  recorded_by  uuid not null references public.users(id),
  status       text not null default 'recorded',
  created_at   timestamptz not null default now()
);

-- (3) payouts — the driver payout RECORD (pilot: no real bank transfer; amount = settled amount).
create table if not exists public.payouts (
  id           uuid primary key default gen_random_uuid(),
  booking_id   uuid not null unique references public.bookings(id) on delete cascade,
  driver_id    uuid references public.drivers(id),
  amount       numeric(12,2) not null,
  mode         text check (mode in ('cash','upi','direct')),
  status       text not null default 'pending' check (status in ('pending','recorded')),
  recorded_by  uuid references public.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists payments_booking_idx on public.payments (booking_id);
create index if not exists payouts_booking_idx  on public.payouts  (booking_id);
create index if not exists payouts_driver_idx   on public.payouts  (driver_id);

comment on table public.payments is 'Cash-recorded settlements (one per booking). No escrow (OUT of MVP).';
comment on table public.payouts  is 'Driver payout records (one per booking). Pilot: recorded, not transferred.';

-- RLS: service-role only (payment/booking services use service-role); no public policies.
alter table public.payments enable row level security;
alter table public.payouts  enable row level security;
