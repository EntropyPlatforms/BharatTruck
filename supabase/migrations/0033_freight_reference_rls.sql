-- migration 0033: enable RLS on the three freight market-reference tables.
--
-- WHY THIS EXISTS (a real production hole, confirmed exploitable before the fix):
-- migration 0029 created freight_market_rate_by_class, freight_cities and freight_lane_rates
-- WITHOUT `enable row level security`, breaking the pattern every other table-creating migration
-- follows (0009-0025 enable RLS on every table they create). Supabase grants anon/authenticated
-- full DML on every public table by default and relies on RLS as the only gate, so with RLS off
-- these three were world-readable AND world-writable through the project's public PostgREST
-- endpoint using the (public-by-design) anon key. Verified on 2026-08-28 against production:
-- an anonymous SELECT returned live lane rates, and an anonymous INSERT returned HTTP 201.
-- Corrupting these tables would skew the market reference behind every quote the platform gives.
--
-- THE FIX: enable RLS with NO policies. That is deny-all for anon/authenticated, while
-- service_role (which every bt-* service uses) bypasses RLS entirely — so the pricing and fleet
-- engines are unaffected. This is exactly the state the other 67 public tables are already in.
-- Verified after applying: anonymous read returns [], anonymous insert returns 42501, and a live
-- quote still resolves its market reference (market_ref read from freight_lane_rates).
--
-- NOTE: the 4th "RLS disabled in public" error the Supabase advisor reports is public.spatial_ref_sys,
-- a PostGIS extension-owned table. It cannot be altered by the project owner and is a known
-- false positive; it holds no application data.
--
-- Idempotent: enabling RLS twice is a no-op.

alter table public.freight_cities               enable row level security;
alter table public.freight_lane_rates           enable row level security;
alter table public.freight_market_rate_by_class enable row level security;
