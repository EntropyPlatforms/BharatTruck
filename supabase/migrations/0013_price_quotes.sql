-- migration 013: price quote-lock (feat/pricing-quote-lock)
-- The price SHOWN at quote time is the price CHARGED at booking (PRD 5.4).
-- Written by bt-pricing-service (service-role). NEW table 'price_quotes' — the
-- shipper price-lock. NOT 'quotes' (that is the driver-auction bid table).
-- Forward-only; APPLY gated on live-Supabase access.
--
-- The priced route (source/dest coords) + derived distance + cargo are persisted
-- so booking-create can BIND the booking to exactly what was priced (a shipper
-- cannot quote a 1 km / 1 kg trip then book a 1400 km / 20 t trip on the lock).
-- consumed_at is the immutable replay guard: it has NO FK, so deleting a booking
-- (compensation on a lost consume reply) SET NULLs consumed_by_booking_id but
-- leaves consumed_at set → the quote can never be reopened/replayed.

create table if not exists public.price_quotes (
  id                     uuid primary key default gen_random_uuid(),
  shipper_id             uuid not null references public.users(id),
  source_lat             numeric(9,6) not null,
  source_lng             numeric(9,6) not null,
  dest_lat               numeric(9,6) not null,
  dest_lng               numeric(9,6) not null,
  distance_km            numeric(10,2) not null check (distance_km > 0),
  vehicle_type           text not null,
  vehicle_class          text not null,
  load_type              text not null,
  weight_kg              numeric(12,2) not null check (weight_kg > 0),
  breakdown_json         jsonb not null,
  quoted_price           numeric(12,2) not null check (quoted_price > 0),
  currency               text not null default 'INR',
  expires_at             timestamptz not null,
  consumed_at            timestamptz,
  consumed_by_booking_id uuid references public.bookings(id) on delete set null,
  created_at             timestamptz not null default now()
);

create index if not exists price_quotes_shipper_idx on public.price_quotes (shipper_id);

comment on table public.price_quotes is
  'Shipper price-lock: quote SHOWN == price CHARGED (PRD 5.4). Priced route (source/dest coords) + derived distance + cargo are bound to the booking at create time. Written by bt-pricing-service. consumed_at stamped once when a booking locks this quote (immutable replay guard; survives a booking hard-delete). NOT the driver-auction quotes table.';

-- RLS: service-role only (pricing/booking use service-role); no public policies (all authz is app-code — locked decision).
alter table public.price_quotes enable row level security;
