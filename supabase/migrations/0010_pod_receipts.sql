-- migration 010: receiver-OTP POD support (receiver_email + pod_receipts)
-- Matches bt-cargo-ledger POD writer + bt-booking-service getPodContext on feat/pod-receiver-otp@9aa5bbc
-- (T-BE-2, CTO-verified 27/27). Forward-only + idempotent. APPLY is gated on live-Supabase access.
-- The OTP hash itself is NEVER in Postgres (ephemeral in Redis); pod_receipts is the delivery PROOF only.

-- Consignee inbox the receiver-OTP is emailed to; shipper sets it at/after booking creation.
alter table public.bookings add column if not exists receiver_email text;

create table if not exists public.pod_receipts (
  id            uuid primary key default gen_random_uuid(),
  booking_id    uuid not null unique references public.bookings(id) on delete cascade,
  receiver_email text not null,
  verified_via  text not null default 'receiver_otp',
  verified_at   timestamptz not null,
  created_at    timestamptz not null default now()
);

create index if not exists pod_receipts_booking_idx on public.pod_receipts (booking_id);

comment on table public.pod_receipts is
  'Proof-of-delivery receipts (one per booking; receiver-OTP verified). Written by bt-cargo-ledger POD flow.';

-- RLS: service-role only (booking/cargo services use service-role); no public policies.
alter table public.pod_receipts enable row level security;
