# BharatTruck — backend capability + review brief

> ⚠️ **POINT-IN-TIME FINDINGS REGISTER — verify before acting (banner added 2026-08-07).** This is a
> snapshot of a since-merged branch, not a description of `main` today. Some findings have landed:
> the `[CRITICAL] canFleetAccessBooking` cross-tenant read is **fixed** — clause 4 is now guarded by
> `!booking.fleet_owner_id` (`packages/shared/src/fleet.ts`). Others (e.g. the unpruned
> `fleet:{id}:drivers` Redis set) still look open. It is kept because no live doc carries these
> findings, but **re-verify every item against the code before you act on it**, and the `file:line`
> citations have drifted. Nothing here overrides `docs/BIBLE.md §5` on current state.
>
> Produced 2026-07-26 by a 31-agent parallel sweep over `feat/fleet-owner`, then an adversarial
> verification pass. Only findings that survived refutation are listed in the two review sections.
> Every claim is cited as `file:line`. Where verification corrected a claim, the corrected form is
> what appears and the correction is called out inline.
>
> Commissioned to answer three founder questions: what does the pricing service actually do, what
> driver analytics already exist that a fleet dashboard could roll up, and how far does the backend
> reach today.


Repo root: `/Users/adityaroshanjoshi/Desktop/VS_Code/StartUps/WIP` (branch `feat/fleet-owner`). All `file:line` citations below are relative to that root.

Only defects that survived adversarial refutation are listed in the two review sections. Where the verification pass corrected a claim, the corrected form is what appears here and the correction is called out.

---

## 1. Pricing service — review

### [HIGH] `POST /pricing/quote` has no role gate and returns the full cost model + margin to any authenticated caller
`bt-pricing-service/src/routes/pricing.ts:46`

The auth plugin verifies the JWT and populates `req.user.role` (`bt-pricing-service/src/plugins/auth.ts:38`) but no route reads it. `grep role` across `bt-pricing-service/src` returns only `auth.ts:10,20,38` — there is no `requireRole`, no `preHandler`, no guard clause in `routes/pricing.ts:46-106`. The response spreads the entire `QuoteResult` plus `cost_breakdown` (`routes/pricing.ts:92-102`), so `base_price`, `weight_surcharge`, `platform_fee`, `driver_receives`, `mileage_kmpl`, `diesel_price_inr`, `per_km_operating_cost` and `handling` all reach the caller (`bt-pricing-service/src/lib/pricing.ts:22-32`, `bt-pricing-service/src/lib/cto-cost.ts:56-66`). `bt-auth-service/src/routes/auth.ts:143` lets any account self-assign `driver` or `fleet_owner`, and the route is internet-reachable through `bt-gateway/nginx.conf.template:200-205` with no gateway-level auth (`nginx.conf.template:191` states each service does its own JWT+RBAC).

**Failure scenario.** `bt-booking-service` deliberately strips `quoted_price`, `final_price` and `min_acceptable` from every payload sent to a fleet-affiliated driver (`bt-booking-service/src/lib/fleet.ts:206-215`, applied at `bt-booking-service/src/lib/service.ts:189-191` and `:210-211`, rationale at `service.ts:151-163`). The masked payload still contains `source_lat/lng`, `dest_lat/lng`, `load_type` and `weight_kg` (`bt-booking-service/src/lib/types.ts:33-39`) — everything `/pricing/quote` needs, since distance is derived server-side from those same coords (`routes/pricing.ts:53-56`). The driver replays their own assigned trip and recovers the exact `base_price`, `platform_fee` (10%, `lib/pricing.ts:12`) and `driver_receives`. `vehicle_type` is not on the booking row but is a 4-value enum (`lib/pricing.ts:16`), i.e. at most 4 requests. Any authenticated competitor can enumerate the whole rate card lane by lane.

**Side effect.** `routes/pricing.ts:75-76` writes `shipper_id: req.user.userId`, and `supabase/migrations/0013_price_quotes.sql:16` constrains that column only as `uuid not null references public.users(id)` — no role CHECK — so a driver or fleet-owner token mints rows labelled as shipper price-locks, and the endpoint doubles as an unthrottled DB write amplifier behind only nginx rate limiting.

---

### [HIGH] ASSUMPTION cost constants are load-bearing and already contradicted by migration 0018
`bt-pricing-service/src/lib/cto-cost.ts:21`

`MILEAGE_KMPL` (`cto-cost.ts:21-26`, read at `:71`), `OPEX_PER_KM` (`:30`, read at `:76`), `HANDLING_BASE` (`:33`, read at `:77`), `DRIVER_WAGE_PER_DAY`/`AVG_KM_PER_DAY` (`:36-37`, read at `:75`) and `VEHICLE_TYPE_TO_CLASS` (`:49-54`) are all marked ASSUMPTION and all feed the breakdown rendered to the shipper at `shipper/src/app/bookings/new/page.tsx:323-328`. `supabase/migrations/0018_vehicle_cost_norms.sql:8-9` states outright that these constants are replaced, and seeds founder-sourced kmpl: SCV 14.92 (`0018:61`), LCV 7.31 (`:67`), ICV 6.23 (`:70`), MCV 4.98 (`:73`), HCV 4.03/3.22/3.36 (`:76/:79/:82`) and 2.54 for HCV Cargo 49-55T (`:85`) — against hardcoded SCV 12.0 / LCV 9.0 / MCV 6.0 / HCV 3.5 (`cto-cost.ts:21-26`). `grep vehicle_cost_norms` across `bt-pricing-service` returns only comments: the pricing service never reads the founder cost table.

**Failure scenario (arithmetic verified by execution).** A 1,000 km HCV trip: pricing shows fuel `ceil(1000/3.5*90)` = ₹25,715 (`cto-cost.ts:74`); the fleet's `trip_economics` row for the same trip computes `1000/2.54*90` = ₹35,433 (`bt-fleet-service/src/lib/economics.ts:190-191`, norms loaded at `economics.ts:271-277`). 37.8% apart, one shown to the customer and one used for the owner's P&L. The divergence is not confined to the heaviest class — the same `HCV` quote class also covers HCV Cargo 25-31T at 4.03 kmpl, where pricing is 15% too **high**. Every HCV booking diverges; only the sign changes.

**Scoping correction from verification.** These constants do **not** change the money charged. `shipper_pays`/`total_price` derive solely from `RATE_PER_KM` and `LOAD_MULT` (`lib/pricing.ts:37-39,:49`); `cost_breakdown` is a transparency panel. This is a customer-facing cost-disclosure defect, not a mispricing. Note before fixing: HCV 3.5 and MCV 6.0 are deliberately aligned to FROZEN tracking decision D-009 (`cto-cost.ts:11-12`, `docs/BIBLE.md:789-791`), so correcting them touches a frozen contract.

---

### [HIGH] `weight_kg` is unbounded, so shipper input reaches `numeric(12,2)` as an overflow and returns 500
`bt-pricing-service/src/lib/pricing.ts:18`

`weight_kg: z.number().positive()` with no `.max()` and no `.finite()`. The route schema only omits `distance_km` and adds bounded lat/lng (`routes/pricing.ts:25-32`), so the field passes through unchanged; the bounded lat/lng right beside it prove this is an isolated gap. Value flows into `Math.ceil((weight_kg - 5000)/1000) * 500` (`lib/pricing.ts:38`) then into `price_quotes.weight_kg` and `quoted_price`, both `numeric(12,2)` (`supabase/migrations/0013_price_quotes.sql:25,27`, max 9999999999.99). `insertPriceQuote` throws a bare `Error` on any PostgREST failure (`bt-pricing-service/src/lib/price-quote-store.ts:81`), which `handleError` converts to 500 `INTERNAL_ERROR` (`routes/pricing.ts:38-41,103-105`). The only client guard is `min="1"` with no max (`shipper/src/app/bookings/new/page.tsx:285-287`).

**Failure scenario.** `weight_kg = 1e30` → surcharge `5e+29` → `JSON.stringify` emits `5e+29`, a valid numeric literal Postgres parses then rejects (22003 numeric field overflow) → shipper gets 500 `INTERNAL_ERROR` instead of 400 `VALIDATION_ERROR`, logged as an unhandled fault. Anything above roughly 6e9 overflows on the surcharge alone. The codebase treats this class as a bug elsewhere: `routes/pricing.ts:57-65` adds an explicit pre-DB guard for degenerate distance precisely so it does not "leak a 500."

**Correction from verification.** The `Infinity` half of the original claim is unreachable over HTTP — `Infinity` is not a JSON literal, so Fastify's parser rejects it before Zod. Zod 3.25.76 accepting `Infinity` is a latent hazard for internal callers only. The reachable failure is the finite-but-huge value.

---

### [MEDIUM] No weight-vs-vehicle-capacity validation anywhere: a 40 t load can be priced as a `mini_truck`
`bt-pricing-service/src/lib/pricing.ts:37`

`computeQuote` (`lib/pricing.ts:34-55`) accepts any `(vehicle_type, weight_kg)` pair and reads no capacity constant; the only weight term (`:38`) is class-independent. `bt-booking-service` explicitly declines to own the check and points here: "Weight-vs-vehicle-capacity validation … is a deliberate follow-up in the pricing constant-harvest PR, which owns the capacity constants; it is intentionally NOT done here" (`bt-booking-service/src/lib/service.ts:86-88`). No downstream gate exists — the quote-bind block (`service.ts:94-111`) enforces only equality with the quote, `acceptBooking` (`service.ts:220-261`) has no capacity condition, `drivers.truck_capacity_kg` is selected for display only (`bt-booking-service/src/lib/repository.ts:102`), and the DB constraint is `check (weight_kg > 0)` alone (`0013_price_quotes.sql:25`). The capacity data now exists as `vehicle_cost_norms.payload_tons_typical` (`0018_vehicle_cost_norms.sql:25`) but is consumed only by fleet economics (`bt-fleet-service/src/lib/economics.ts:261,459`).

**Failure scenario.** 1,000 km / 40,000 kg / `vehicle_type='mini_truck'`: base `1000*12` = ₹12,000 + surcharge `ceil(35000/1000)*500` = ₹17,500 → **₹29,500 locked** with an SCV cost anchor (₹300 handling, 12 kmpl). Booking-create binds `vehicle_type` to the quote, so the class is committed at booking time. **Correction from verification:** the originally claimed "HCV modeled cost ₹52,400" is wrong — `costBreakdown('HCV', 1000)` yields ₹37,715 (25,715 fuel + 3,000 driver + 8,000 opex + 1,000 handling); the HCV rate-card price would be ₹39,500 and trailer ₹52,500. The magnitude was overstated; the missing validation stands.

---

### [MEDIUM] The only test file never runs in CI and does not exercise the real `/pricing/quote` route
`bt-pricing-service/package.json:6`

`package.json:6-10` defines only `dev`/`build`/`start` — no `test` script — while CI runs `npm test --if-present` (`.github/workflows/ci.yml:110-111`), which exits 0 silently. `bt-fleet-service` is the only service in the monorepo with a `test` script. `tsconfig.json` sets `"include": ["src"]`, so `npm run build` never typechecks `test/`, and a signature change produces no compile error. The test itself builds its own Fastify app and re-registers `authed.post('/quote', …)` over `QuoteBody` with a **client-supplied** `distance_km` (`bt-pricing-service/test/pricing.e2e.mts:49-57,64-70`) — the exact shape production removed in favour of server-derived distance (`routes/pricing.ts:27-32,53-56`). The `Makefile` helper is also stale: `Makefile:356-366` POSTs `{"distance_km":150,…}` to `localhost:3003/quote` with no JWT and no `/pricing` prefix.

Uncovered and registered in production: `roadDistanceKm` (`lib/geo.ts:36-39`), the zero-distance 400 guard (`routes/pricing.ts:59-65`), `price_quotes` persistence (`lib/price-quote-store.ts:59-83`), `GET /internal/quote/:id` (`routes/internal.ts:24-38`), and the replay/expiry guard `consumePriceQuote` (`lib/price-quote-store.ts:105-117`) that `bt-booking-service` depends on over HTTP (`bt-booking-service/src/lib/pricing-client.ts:71,87`).

**Failure scenario.** A regression to `QuoteRequestBody`, `roadDistanceKm` or `consumePriceQuote` — the guard protecting the price lock — merges on a green pipeline. Note the CI hole is not pricing-specific: five other services carry e2e files CI likewise never runs.

---

### [MEDIUM] Service is deployable with no JWT/Supabase/internal secrets while `/health` still reports `ok`
`bt-pricing-service/src/index.ts:20`

`app.get('/health', …)` is registered on the root instance at `index.ts:20`, before both encapsulated scopes (`index.ts:24-27` auth + pricing, `:31-34` internal), and asserts `status: 'ok'` unconditionally. `bootstrap()` (`index.ts:16-37`) reads only `process.env.PORT` — no env assertion, no fail-fast. Every secret is read lazily per request: `auth.ts:31` (`jwt.verify` with `undefined` → `JsonWebTokenError` → swallowed into 401 at `auth.ts:32-33`), `lib/supabase.ts:10-14` (throws → 500 via `routes/pricing.ts:103-105`), `plugins/internal-auth.ts:13-17` (503). `docker-compose.yml:133-152` gives the service only `NODE_ENV` (`:143`) and `PORT` (`:144`) with no `env_file`, while `bt-auth-service` gets `SUPABASE_URL`/`JWT_SECRET` at `docker-compose.yml:86-88` and `bt-booking-service` at `:116-118` — pricing is the anomaly. The compose healthcheck polls the always-ok endpoint (`docker-compose.yml:147-152`), as does the deploy script's own gate (`scripts/deploy/deploy-all.sh:112-116`).

**Failure scenario.** The stack reports healthy; every `POST /pricing/quote` returns 401 (undefined JWT secret) or 500 (`SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set`). No alarm fires. **Caveat:** `scripts/deploy/deploy-all.sh:84` *does* wire all four on a full run; what keeps the gap alive is `.github/workflows/deploy.yml:143-151`, which deploys with `--source` and no `--set-env-vars`. the former `bt-pricing-service/HANDOFF_NOTE.md` (deleted 2026-08-07) recorded all four still blank on Cloud Run as of 2026-07-19 — a document assertion, never verified against the live service. Fix is a boot-time env assertion in `bootstrap()` before `app.listen`.

---

### [MEDIUM] `Math.ceil` over IEEE-754 products overcharges ₹1 on a small deterministic set of quotes
`bt-pricing-service/src/lib/pricing.ts:37`

`Math.ceil(distance_km * RATE_PER_KM[…] * LOAD_MULT[…])` applied to a float product of a 2-dp derived distance (`lib/geo.ts:36-39` returns `Math.round(km*100)/100`) and a 2-dp multiplier. Reproduced in node: `16.6*15*1.0 === 249.00000000000003` → `Math.ceil` → 250 for an exact price of 249. `distance_km = 16.6` is reachable: the route derives it server-side and the only guard is `if (!(distance_km > 0))` (`routes/pricing.ts:59`); the column is `numeric(10,2)` (`0013_price_quotes.sql:21`) and stores it faithfully. `result.shipper_pays` is persisted as `quoted_price` (`routes/pricing.ts:87`) and consumed as the locked price by booking-service (`routes/internal.ts:45-59`); nothing downstream re-rounds. No test covers it — `test/pricing.e2e.mts` uses only integral distances 100/50/200 (lines 64,77,79).

**Corrections from verification — the claim's headline was overstated and should be filed in this narrowed form:**
- Incidence is **0.005%**, not "whenever the exact price is an integer": sweeping all 2-dp distances 0.01–2000 km × 20 (vehicle, load) pairs, 64,000 combinations have an exactly-integral price and only **200** (0.31% of those; 200/4,000,000 overall) misfire. All 200 are `lcv` (134 general, 66 hazardous).
- The `platform_fee` generalization is **false**: `Math.ceil(total * 0.10)` with an always-integral `total` (`lib/pricing.ts:37-39`) has zero epsilon failures across every integral total 1..1,000,000. The platform-favouring rounding at `:40,:50` is deliberate design, not float drift.
- The "different multiplication order yields ₹249" scenario is hypothetical: `computeQuote` has exactly one call site repo-wide (`routes/pricing.ts:67`), so quotes are deterministic with a fixed ₹1 bias.
- The `cto-cost.ts` half **is** real and larger: fuel `Math.ceil((distanceKm/mileage)*diesel)` (`cto-cost.ts:74`) misfires in 4,363 cases over the same sweep, driver (`:75`) in 123, opex (`:76`) in 0 — but these feed only the informational breakdown, not `shipper_pays`.

---

## 2. Driver analytics — what exists today

**Headline: there is no driver-facing analytics surface at all.** `driver/src/components/app-shell.tsx:8-36` defines exactly three tabs (Browse / My Quotes / Profile). `driver/src/lib/api.ts` (529 lines) contains zero calls to `/api/tracking/*`, `/api/payments/*` or `/api/fleet/*`. Every number the driver sees is a single-booking scalar reprinted from the booking or quote row. There is no chart library and no component that renders a computed aggregate.

There are **zero SQL views, materialized views or RPCs** — `grep -niE "create (or replace )?(view|materialized view|function)" supabase/migrations/*.sql` returns nothing across all ten migrations (0009–0018); the only DDL beyond tables is `CREATE INDEX`. 100% of aggregation is TypeScript over PostgREST selects. The only precomputed layer is the application-written `trip_economics` table.

### Driver-facing endpoints

| Endpoint / metric | File | Source table / store | Grain | Status |
|---|---|---|---|---|
| `GET /api/bookings` (driver list) | `bt-booking-service/src/lib/repository.ts:129-150` | `bookings` | per-trip | **broken** — solo driver query is `.eq('status','pending')` (`:143`), i.e. an open load board; their own accepted/in_transit/completed/paid trips are never returned. Fleet-affiliated driver gets `.eq('driver_id', …)` (`:142`) with money fields stripped (`service.ts:211`, `fleet.ts:206-215`). No pagination, no date filter. |
| `GET /api/bookings/:id` | `bt-booking-service/src/lib/repository.ts:93-117` | `bookings` + `drivers` + `users` embed | per-trip | implemented; embeds `truck_number`, `truck_capacity_kg`, `average_rating`, `total_trips` (`:98-110`) |
| `GET /api/bookings/:bookingId/quotes` | `bt-booking-service/src/routes/quotes.ts:53-63` | `quotes` | per-trip | implemented — bid amount + status + `submitted_at`. **Nothing aggregates these**: no win-rate, no average bid, no bids-per-period anywhere in the codebase. |
| `GET …/quotes/:quoteId/history` | `bt-booking-service/src/routes/quotes.ts:134-146` | `negotiations` | per-trip | implemented |
| `POST /api/location/update` | `bt-booking-service/src/routes/location.ts:53-152` | Redis `loc:driver:*` (30 s TTL) + `location_history` | per-point, ~1 row/12 s | implemented. Sole telemetry source. Breadcrumb write is gated by an atomic `SET NX EX 12s` (`lib/redis.ts:17`) and failures are logged and swallowed (`:142`) — silent loss is possible. |
| `GET /api/location/driver/:id`, `/booking/:id` | `bt-booking-service/src/routes/location.ts:155-223` | Redis last-known fix | point-in-time | implemented; no history variant |
| `GET /api/onboarding/status` | `bt-auth-service/src/routes/onboarding.ts:387-463` | `users`, `drivers`, `driver_licenses`, `vehicles`, `driver_insurance`, `bank_accounts` | per-driver, point-in-time | implemented. 7-boolean checklist + badge; the only exact COUNT head-queries in the backend (`:422-426`). `driverOnly`-gated (`:388`), so an owner cannot read their roster's compliance through it. |
| `GET /api/payments/status/:booking_id` | `bt-payment-service/src/routes/payments.ts:64-82` | `payments`, `payouts` | per-trip | implemented but **drivers are 403'd** at `:71-73` (`admin`/`shipper` only). There is no earnings, payout or settlement endpoint any driver token can call, anywhere. |
| `GET /api/tracking/track/:bookingId` | `bt-tracking-service/src/routes/tracking.ts:179-220` | Redis `loc:*`/`trk:*`, `bookings`, `route_alerts`, Google Routes | per-trip, point-in-time | implemented; driver role is permitted (`:46-75`) but the driver PWA never calls it |
| `GET /api/tracking/eta/:bookingId` | `bt-tracking-service/src/routes/tracking.ts:161-176` | Redis + Google Routes TRAFFIC_AWARE | per-trip | implemented; traffic buckets hardcoded at `bt-tracking-service/src/lib/google.ts:108` |
| `GET\|POST /api/tracking/route/:bookingId` | `bt-tracking-service/src/routes/tracking.ts:139-158` | `trk:route:*` (6 h), `trip_routes` | per-trip | implemented. `distance_m` here is the platform's **only** real road distance. |
| `POST /api/cargo/pod/request-otp` / `verify-otp` | `bt-cargo-ledger/src/routes/pod.ts:41-71` | Redis `pod:otp:*` | per-trip | implemented; produces no metric but is what stamps completion |
| `GET /api/tracking/history/:bookingId` | spec at `docs/MAPS_TRACKING_PLAN.md:68,470-514` | `location_history` | per-trip | **planned** — not implemented; `location_history` is indexed for exactly this read (`supabase/migrations/0009_location_history.sql:21-26`) but tracking never reads the table |
| `GET /api/tracking/fuel/:bookingId` | spec at `docs/MAPS_TRACKING_PLAN.md:70` | — | per-trip | **planned**; equivalent arithmetic already exists twice with different constants (`bt-pricing-service/src/lib/cto-cost.ts:74` vs `bt-fleet-service/src/lib/economics.ts:190-192`) |
| `GET /api/tracking/alerts/:bookingId`, `/pumps/:bookingId` | `docs/MAPS_TRACKING_PLAN.md:69,71,86` | — | per-trip | **planned**; dead scaffolding left behind — `pumpsKey`/`PUMPS_TTL_SECONDS` at `bt-tracking-service/src/lib/redis.ts:19,24` are imported nowhere |

### Driver-facing metrics and UI surfaces

| Metric / surface | File | Source | Status |
|---|---|---|---|
| `drivers.total_trips` | read at `bt-booking-service/src/lib/repository.ts:104`, `bt-fleet-service/src/lib/fleet-repo.ts:154,183` | `drivers` | **broken — fake.** No UPDATE, no increment, no trigger, no migration writes it. Only values in the repo are seed literals 24/12/40 (`scripts/seed/demo-scenario.sql:46-48`). |
| `drivers.average_rating` | same read sites, plus `fleet-repo.ts:168,210` | `drivers` | **broken — fake.** No rating-submission endpoint exists in any of the 7 services. Seeds 4.6/4.3/4.8 (`scripts/seed/demo-scenario.sql:46-48`). |
| `driver_receives` | `bt-pricing-service/src/lib/pricing.ts:50` | computed | **broken — contradicted downstream.** Not persisted to `bookings`; the actual payout is `amount: args.amount` with the comment "pilot: no platform fee — payout = settled amount" (`bt-payment-service/src/lib/payment-service.ts:92`). |
| CTO breakdown constants | `bt-pricing-service/src/lib/cto-cost.ts:21-37` | hardcoded | implemented but self-declared ASSUMPTION; incompatible with the fleet model (see §1) |
| `distance_km` (quoted) | `bt-pricing-service/src/lib/geo.ts:36-39` | haversine × 1.3 | implemented; the same 1.3 factor is duplicated at `bt-fleet-service/src/lib/economics.ts:366-379` |
| Driver Browse card | `driver/src/app/(app)/available/page.tsx:82-152` | booking row | implemented; raw scalars only (`quoted_price` `:125`, `weight_kg` `:119`, auction countdown `:83-93`) |
| Driver My Quotes | `driver/src/app/(app)/my-quotes/page.tsx:17-140` | `listBookings` + N+1 `getQuotes` per booking (`:24-38`) | **broken** — depends on `listBookings`, which returns only `pending` for solo drivers, so quotes on awarded/completed trips vanish. No count, no win rate, no earned total. |
| Elapsed-trip timer | `driver/src/app/(app)/bookings/[id]/page.tsx:837-850` | client-only | **broken** — start instant is `booking.updated_at` (`:838`), so any row update resets the clock; the effect's dep array is `[booking.in_transit_at]` (`:850`), a phantom field the backend never sends (`driver/src/lib/types.ts:29-30`) |
| `formatPrice` on stripped payloads | `driver/src/lib/utils.ts:9-11` | — | **broken** — no guard; a fleet-affiliated driver's Browse tab calls `.toLocaleString()` on `undefined` (`available/page.tsx:125`, `bookings/[id]/page.tsx:165,240,353,364,669`) |
| Onboarding progress % | `driver/src/app/onboarding/review/page.tsx:64-100` | `GET /onboarding/status` | implemented — the one genuine computed percentage in the driver app |
| GPS capture loop | `driver/src/app/(app)/bookings/[id]/page.tsx:787-834` | `watchPosition` → `pushLocation` | implemented; push failures silently swallowed (`:815-817`) |
| Ops dashboard tiles | `bt-ops-web/app/ops/dashboard/page.tsx:36-44` | unpaginated `GET /bookings` | implemented — **the anti-pattern**: all-time, client-side aggregation over the whole table |

### Fleet roll-up layer (where per-driver analytics actually exist)

| Endpoint / metric | File | Source table | Grain | Status |
|---|---|---|---|---|
| `GET /api/fleet/analytics/drivers` | `bt-fleet-service/src/lib/analytics.ts:352-381` | `trip_economics` | per-driver, per-period | implemented — trips, distance, revenue, running cost, net profit, wage allocated, profit/km, sorted by profit (`:380`) |
| `GET /api/fleet/analytics/summary` | `bt-fleet-service/src/lib/analytics.ts:283-337` | `trip_economics` + `vehicles` + `vehicle_finance` + `vehicle_cost_norms` | per-period | implemented; fixed 4 queries regardless of trip volume |
| `GET /api/fleet/analytics/vehicles[/:id]` | `bt-fleet-service/src/lib/analytics.ts:211-269` | `trip_economics` | per-asset, per-period | implemented |
| `GET /api/fleet/analytics/fuel` | `bt-fleet-service/src/lib/analytics.ts:405-448` | `trip_economics` ← `trip_expenses` | per-period | **broken — permanently zero.** `trip_expenses` has no writer anywhere: one SELECT (`economics.ts:554`), the migration that extends it (`0017:78-94`), comments. `withActuals` is always empty. |
| `POST /internal/trip-economics/:bookingId` | `bt-fleet-service/src/lib/economics.ts:395-483` | writes `trip_economics` | per-trip, once at completed→paid | implemented; **skips silently** with `{skipped:true}` when `fleet_owner_id` or `vehicle_id` is absent (`:407-409`) |
| `computeTripEconomics` | `bt-fleet-service/src/lib/economics.ts:184-231` | pure | per-trip | implemented. Note `toll_cost_inr` and `other_cost_inr` are recorded but **excluded from** `running_cost` (`:211-214`), so `net_profit` ignores real cash outflows. |
| `allocateDriverWage` / `reallocateDriverWageForMonth` | `bt-fleet-service/src/lib/economics.ts:237-252`, `:592-672` | `fleet_drivers.monthly_salary_inr` | **per calendar month** | implemented — see the period trap below |
| `computeUtilization` | `bt-fleet-service/src/lib/analytics.ts:85-120` | `trip_economics` | per-period | implemented; `volume_pct` is null for most bookings because `dimensions_json` is free-form (`economics.ts:576-585`) |
| `scoreRunningCost` / `covered` | `bt-fleet-service/src/lib/analytics.ts:122-155` | `trip_economics` + finance | per-period | implemented; **`emi_inr` is already inside `fixed_cost_inr`** via `monthlyFixedForVehicle` (`:206`) — summing both double-counts |
| `GET /api/fleet/live` | `bt-fleet-service/src/routes/assignment.ts:74-129` | Redis `fleet:{id}:drivers` + `loc:driver:*` | point-in-time | implemented — one SMEMBERS + one MGET; the pattern to copy at 1000 trucks |

### Source tables

| Table | Migration | Role |
|---|---|---|
| `trip_economics` | `supabase/migrations/0017_fleet_asset_economics.sql:96-142` | The only precomputed analytics artefact. PK `booking_id`. Three indexes on `(fleet_owner_id\|vehicle_id\|driver_id, completed_at desc)` (`:137-139`). |
| `location_history` | `supabase/migrations/0009_location_history.sql` (+ `vehicle_id` at `0016:105`) | One reader in the whole monorepo: `resolveDistances` (`economics.ts:510-534`). `speed_kmh` and `accuracy_m` are stored and never read. |
| `trip_expenses` | extended by `0017:78-94` | **No writer.** Highest-value missing driver write path — unblocks fuel variance, true cost/km and toll analytics at once. |
| `route_alerts` | **no migration creates it** | Read at `bt-tracking-service/src/lib/repository.ts:75-95`, errors swallowed → always `[]` (`:93`) |
| `payments` / `payouts` | `supabase/migrations/0011_payments_payouts.sql` (+ `0016:93`) | One row per booking. No `payout_batches` — "paid out this week" has no schema. |
| `vehicle_cost_norms`, `vehicle_service_cost_by_age`, `fleet_cost_settings` | `supabase/migrations/0018_vehicle_cost_norms.sql` | Reference data. **Caching trap:** `normsCache` and `serviceCurveCache` are process-lifetime with no invalidation (`economics.ts:269,294`) — editing a norm needs a restart. |

### What rolls up cleanly to a fleet of 100–1000, and what does not

**Rolls up cleanly:**
- `GET /fleet/analytics/drivers`, `/summary`, `/vehicles` — bounded query count independent of trip volume (`analytics.ts:314-315`), reading one indexed roll-up table with `(driver_id, completed_at desc)` already in place (`0017:137-139`).
- `GET /fleet/live` — one SMEMBERS + one MGET (`assignment.ts:80,93`) instead of a per-driver fan-out that would be ~100 req/s at 1000 trucks on a 10 s poll.
- Onboarding compliance (`GET /onboarding/status`) — the most directly aggregatable per-driver signal that has real data, though it needs a new fleet-scoped variant because the current route is `driverOnly` (`onboarding.ts:388`).

**Does not roll up:**
1. **Solo-driver trips produce no economics.** `rollUpTripEconomics` returns `{skipped:true}` for any booking lacking both `fleet_owner_id` and `vehicle_id` (`economics.ts:407-409`). Every solo trip is invisible to every analytics endpoint. There is no per-driver P&L outside a fleet, and `fleet_owner_id` is the mandatory analytics scope everywhere (`analytics.ts:74`) — there is no column or index supporting "all trips for driver X across all fleets".
2. **Drivers cannot see their own trip history.** `GET /bookings` for a solo driver filters `status='pending'` (`repository.ts:143`). "My trips this month" has no data source.
3. **Drivers are 403'd from their own money** (`bt-payment-service/src/routes/payments.ts:71-73`), and no earnings endpoint exists in any service.
4. **Period semantics collide.** `driver_wage_alloc_inr` is allocated over a UTC **calendar month** (`economics.ts:599-600`) but every analytics endpoint slices an arbitrary `from`/`to` defaulting to a trailing 30 days (`analytics.ts:35-39`). `wage_allocated_inr`, `running_cost_inr` and `net_profit_inr` summed over anything that is not a whole calendar month are partial-month fragments. This is the single most important trap.
5. **`loadTripEconomics` has no limit and no pagination** (`analytics.ts:66-83`) — at 1000 drivers × a 90-day window it pulls every trip row into Node before grouping.
6. **The two per-driver lifetime KPIs are dead** (`total_trips`, `average_rating`) — a leaderboard requires building rating capture end to end first.
7. **Fuel variance is structurally zero** until `trip_expenses` gets a writer.
8. **Mixed measurement bases:** analytics prefers `distance_km_actual` and falls back to `distance_km_quoted` (`analytics.ts:107,366`), silently summing breadcrumb-derived distances (no circuity factor, `economics.ts:522-523`) alongside haversine×1.3 estimates.

---

## 3. bt-fleet-service — review

### Tenant-isolation status (explicit)

**bt-fleet-service's own tenancy is clean.** Every owner-scoped read and write carries an explicit `.eq('fleet_owner_id', owner.id)` or routes through `requireFleetVehicle` / `getFleetDriverById` / `getFleetBooking`; Zod strips unknown body keys so a client-supplied `fleet_owner_id` cannot exist; `fleet_owners.user_id` is written once from the JWT and is deliberately not patchable (`bt-fleet-service/src/routes/owners.ts:34,54`); the `:id` analytics variant re-asserts ownership so a foreign id 404s instead of returning an empty-but-valid report (`bt-fleet-service/src/routes/analytics.ts:48-52`); and the assign step's insert-and-catch-23505 concurrency design is correct.

**The breach is not in this service — it is in the shared helper it shares with tracking.** See the critical finding below. Note also that all services use `SUPABASE_SERVICE_ROLE_KEY` (`bt-fleet-service/src/lib/supabase.ts:11`), so RLS is bypassed by design and **all** tenant isolation is application-layer.

---

### [CRITICAL] `canFleetAccessBooking` lets any fleet read another fleet's trips by hiring their ex-driver
`packages/shared/src/fleet.ts:155`

The fourth access clause (`fleet.ts:155-158`) returns true whenever the booking's `driver_id` currently holds a live affiliation with the *asking* fleet — with no reference to the booking's owner. Clause 1 (`fleet.ts:131`) grants on equality but never **denies** on inequality, so a booking owned by fleet X falls straight through; clauses 2 and 3 are scoped `.eq('fleet_owner_id', fleetOwnerId)` (`:133-142`, `:145-153`) and miss for fleet Y. The docstring at `fleet.ts:117-122` justifies the clause as covering "a booking awarded to a solo driver who has since joined a fleet", but the predicate is **not** narrowed to bookings with a NULL `fleet_owner_id`.

The state is reachable through shipped routes: `fleet_drivers_one_live_per_driver` is a *partial* unique index over `('pending','active')` (`supabase/migrations/0015_fleet_owner_core.sql:66-67`), `DELETE /fleet/drivers/:id` soft-sets `status='left'` (`bt-fleet-service/src/routes/drivers.ts:167`), and `inviteDriver` inserts a fresh row with no check for prior affiliations (`bt-fleet-service/src/lib/fleet-repo.ts:222-239`). `bookings.driver_id` is permanent history (`0016_fleet_assignment_and_auction.sql:36-40`).

`bt-tracking-service` is already wired to this helper (`bt-tracking-service/src/routes/tracking.ts:59-73`, call at `:69`) and gates all four endpoints on it: `POST /tracking/route/:id` (`:142`), `GET /tracking/route/:id` (`:152`), `GET /tracking/eta/:id` (`:164`), `GET /tracking/track/:id` (`:182`).

**Failure scenario.** Booking B is fleet X's (`fleet_owner_id=X`, `vehicle_id`=X's truck, `driver_id=D`). D leaves X and accepts an invite from fleet Y. Y's owner calls `GET /api/tracking/track/B`: `:131` false, `:133-142` no vehicle row, `:145-153` no assignment row, then `:155-158` resolves D's live affiliation to Y and returns true. **Corrections from verification:** the leaked payload is X's *trip geometry and state*, not X's live driver position — `tracking.ts:184` keys the location read on `booking.driver_id` (D), who is now Y's own employee. What actually leaks is the route polyline, distance and bounds computed from X's source/dest (`tracking.ts:101-109,214,216`), the booking status (`:204`), the alert list (`:198`) and a traffic ETA against X's destination (`:120-135`). Competitor destination coordinates are still a real breach. Also, the claimed `bt-tracking-service/src/lib/repository.ts:37` amplifier is real as code but does **not** amplify this leak — clauses 1 and 2 are grants, not denies, so nulling them cannot add access.

**Fix:** narrow clause 4 to bookings with `fleet_owner_id IS NULL`, which is what the docstring already promises.

---

### [HIGH] `fleet:{id}:drivers` Redis set is never pruned, so a departed driver's live GPS keeps flowing to the old fleet
`bt-fleet-service/src/routes/assignment.ts:81`

Removal is best-effort and swallowed: `syncFleetSet` catches every Redis error and logs a warning (`bt-fleet-service/src/routes/drivers.ts:183-188`, catch at `:186-187`) because the Postgres write already committed at `:167`; the endpoint returns 200 at `:169`. `removeDriverFromFleetSet` is a bare `srem` with no retry (`bt-fleet-service/src/lib/redis.ts:54-56`) on a client built with `maxRetriesPerRequest: 3` (`redis.ts:24`), so a reconnect window rejects the command. The advertised self-heal at `assignment.ts:80-84` is guarded by `if (driverIds.length === 0)` and only SADDs — it never diffs a non-empty set against `fleet_drivers`. `grep srem|fleetDriversKey|removeDriverFromFleetSet` finds only `lib/redis.ts`, `routes/drivers.ts:144,168` and `routes/assignment.ts:80-83`: no reconciler, no TTL, no other pruning path.

**Failure scenario.** Fleet X removes driver D while Redis is momentarily unreachable. `fleet:X:drivers` still contains D. D joins fleet Y; `bt-booking-service` keeps writing `loc:driver:D` on every ping based only on the caller's own drivers row with no fleet check (`bt-booking-service/src/routes/location.ts:68-71,105`). Fleet X's `GET /fleet/live` MGETs D's key (`assignment.ts:91-93`) and continues to emit lat, lng, heading, `speed_kmh`, `updated_at` (`:111-115`) plus **fleet Y's** booking id via the `assignment?.booking_id ?? position?.booking_id` fallback (`:109`), with a hydrated driver name (`fleet-repo.ts:176-201`, not fleet-scoped) — indefinitely, with no path that corrects it. Re-affiliation to Y is permitted because the unique index covers only `('pending','active')` (`0015:66-67`).

---

### [HIGH] `trip_economics` roll-up is at-most-once with no retry or reconciliation
`bt-payment-service/src/lib/fleet-emit.ts:22`

`emitTripEconomics` is a bare `void fetch`: non-2xx only logs (`:28`), transport error only logs (`:31`). No outbox, no re-queue, no throw. The single caller is unreachable on retry — `settle()` early-returns when `booking.status === 'paid' && existing` (`bt-payment-service/src/lib/payment-service.ts:56-58`), so re-POSTing the settlement never re-fires the hook (`:118`). A repo-wide search finds no cron, scheduler, backfill or replay job (`k8s/` holds only a namespace and one auth Deployment; `.github` has no scheduled job), and the only writer endpoint `POST /internal/trip-economics/:bookingId` (`bt-fleet-service/src/routes/internal.ts:22`) is not gateway-proxied (`bt-gateway/nginx.conf.template:224-228` maps only `/api/fleet/` → `/fleet/`), so there is no operator re-fire path either. The route's own comment claims safety because delivery is "at-least-once" (`internal.ts:11-13`) — nothing in the caller provides that.

Because `loadTripEconomics` reads `trip_economics` exclusively (`bt-fleet-service/src/lib/analytics.ts:66-83`) and is the single source for every report (`:217,285,353,407`), a lost roll-up silently deletes that trip's revenue, cost and utilization with no alert. Compounding it, `releaseAssignmentForBooking` is called from exactly one place — `bt-fleet-service/src/lib/economics.ts:473`, *after* every throw site — so the truck and driver stay pinned live until the opportunistic sweep at `assignment.ts:113` → `releaseFinishedAssignments` (`:175-199`) happens to run on a later assign attempt.

**Correction from verification — the trigger must be restated.** The originally claimed NULL `model_category` path is **refuted**: `bookings.vehicle_id` is written only at `bt-fleet-service/src/lib/assignment.ts:130` after `requireFleetVehicle`, the ops reassign override touches only `driver_id` (`bt-booking-service/src/lib/repository.ts:336-352`, `supabase/migrations/0012_ops_overrides.sql:19-21`), and every fleet-vehicle write validates the category (`routes/vehicles.ts:34,116,207`; `lib/bulk-import.ts:126,187`). The seeded curve covers all five super-categories (`0018:103-115`) and the global settings row exists (`0018:132`). The **real** trigger is the residual case: any transient PostgREST error across the 7+ Supabase round-trips in `rollUpTripEconomics` (`economics.ts:398-400,411-413,466-469,479-481,496-501,510-515,540-545,553-557`), each rethrown as a plain `Error` → 500 (`bt-fleet-service/src/index.ts:32-33`) → one warning and gone; or a Cloud Run cold-start timeout / 5xx on the POST itself landing at `fleet-emit.ts:31`. Both are routine production events.

---

### [HIGH] `PUT /permits` and `PUT /lanes` delete the existing set before inserting, with no transaction
`bt-fleet-service/src/lib/vehicles-repo.ts:168`

`replaceVehiclePermits` deletes every row for the vehicle (`vehicles-repo.ts:168`) then inserts (`:172-175`, error path throws at `:176`); `replaceVehicleLanes` does the same at `:203` and `:207-210`. Both go through a plain supabase-js PostgREST client (`bt-fleet-service/src/lib/supabase.ts:15`) as two independent HTTP calls; `grep '\.rpc('` across `bt-fleet-service/src` returns nothing, so there is no server-side transactional function, and there is no try/catch, re-insert or compensating write in either function. Because the client uses the service-role key, RLS cannot accidentally block the delete. Failure surfaces as an opaque 500 with no hint that data was destroyed (`vehicles-repo.ts:176` throws a bare `Error`, not a `FleetError`, so `index.ts:24-33` falls through to `500 'Internal server error'`). Both routes are live: `routes/vehicles.ts:239,251` under `/fleet/vehicles` (`index.ts:55,59`), exposed at `bt-gateway/nginx.conf:197-201`. No test covers them (`bt-fleet-service/test/` contains only `economics.test.mts`).

**Failure scenario.** `PUT /fleet/vehicles/{id}/permits` with three permits, one carrying `issued_on: "31/07/2026"`. `routes/vehicles.ts:84-85` declares `z.string().trim().nullable().optional()` — no regex, no `z.coerce.date()`, not even `.min(1)` — while `vehicle_permits.issued_on` is a `date` column (`supabase/migrations/0017_fleet_asset_economics.sql:50`). The delete commits, the insert fails 22007, and the truck's previously valid national and state permits are gone.

**Correction from verification.** The lanes example is largely unreachable in a single request: `LanesBody`'s `.refine` rejects a body with more than one `is_primary` (`routes/vehicles.ts:100-105`) and the index is scoped per `vehicle_id` whose rows were just deleted (`0017:73-74`) — that branch needs two concurrent PUTs. The permits path needs no race.

---

### [MEDIUM] Date-typed columns accept arbitrary strings, turning client mistakes into 500s
`bt-fleet-service/src/routes/vehicles.ts:69`

Five fields map to Postgres `date` but are validated as free-form strings: `FinanceBody.start_date`/`end_date` (`routes/vehicles.ts:69-70` → `0017:23-24`), `PermitsBody.issued_on`/`expiry_date` (`:83-84` → `0017:49-50`), and `CreateVehicleBody.rc_expiry` (`:46`). `routes/vehicles.ts:228-229` uses `?? null`, which preserves `""` and any garbage (nullish, not falsy). The repo rethrows as a plain `Error` (`vehicles-repo.ts:128`; same shape at `:54` and `:176`) — the only PostgREST code mapped in that file is `23505` (`types.ts:68`) — and `bt-fleet-service/src/index.ts:24-34` turns anything without a 4xx `statusCode` into 500 `INTERNAL_ERROR` (`:32-33`). This directly contradicts the service's own error contract at `index.ts:21-23`. The bulk path does normalize and is protected by a per-row try/catch (`bt-fleet-service/src/lib/bulk-import.ts:217,220-231`); the direct routes have neither.

**Correction from verification.** The example `"01-13-2025"` will most likely **not** fail — Postgres's default `DateStyle` is `ISO, MDY`, under which it parses as 13 Jan 2025 and silently succeeds. Reproduce with `""` (an empty date field from a form) or `"not-a-date"`.

---

### [MEDIUM] Driver wage allocation collapses to zero when the newest affiliation row carries no salary
`bt-fleet-service/src/lib/fleet-repo.ts:302`

`getLatestAffiliation` orders `invited_at desc limit 1` with no status filter (`fleet-repo.ts:296-307`) — deliberately, so a departed driver's salary still applies to months they worked (`:290-295`). But it returns the *newest* row, `monthly_salary_inr` is nullable (`0015_fleet_owner_core.sql:54`, no NOT NULL, no default, no trigger or backfill in any later migration), and `inviteDriver` inserts only `{fleet_owner_id, driver_id, invited_by, status:'pending'}` (`fleet-repo.ts:224`) — `InviteBody` accepts only `driver_phone` (`routes/drivers.ts:28-30`), so salary cannot even be set at invite time. Then `economics.ts:602-603` coerces to `0` via `??`, `allocateDriverWage`'s guard writes an explicit `0` for every trip (`economics.ts:246-249`), and the write loop's only skip is a `< 0.01` no-op check (`economics.ts:653-671`) which does not trigger going 40000 → 0, so `driver_wage_alloc_inr`, `running_cost_inr` and `net_profit_inr` are all rewritten.

**Failure scenario.** Driver D worked for fleet X at ₹40,000/month; that row is now `left` (freed from the partial unique index at `0015:66-67` by the soft-leave at `routes/drivers.ts:153-169`). X re-invites D → a `pending` row with NULL salary. A delayed settlement rolls up a March trip; `reallocateDriverWageForMonth` (called at `economics.ts:474-477`, keyed on the trip's own `completed_at`) reads the `pending` row, salary = 0, and rewrites every March trip — March profit jumps by ₹40,000 in `GET /fleet/analytics/drivers` and `/summary` (columns read at `analytics.ts:22-23`, summed at `:189,265,333,367,376-377`).

Safe variant: if D joins a *different* fleet Y, `getLatestAffiliation` is scoped by `fleet_owner_id` (`fleet-repo.ts:300-301`) so X's history is preserved. The failure needs the same fleet to hold a newer salary-less row.

---

### [MEDIUM] A full month's salary is charged to a partial month
`bt-fleet-service/src/lib/economics.ts:647`

`reallocateDriverWageForMonth` (`economics.ts:592-671`) passes the entire `monthly_salary_inr` undivided into `allocateDriverWage` (`:647`), which spreads it across the month's trips weighted by km × `wage_weight` (`:237-252`). The affiliation window is never consulted: `economics.ts:602-603` reads only `monthly_salary_inr` from the row, even though `AFFILIATION_COLUMNS` already selects `invited_at, responded_at, left_at` (`bt-fleet-service/src/lib/fleet-repo.ts:116-118`). The schema enforces only `monthly_salary_inr >= 0` (`0015:54`) and the API accepts any 0–10,000,000 with no proration hook (`routes/drivers.ts:34`). `reallocateDriverWageForMonth` is untested — `bt-fleet-service/test/economics.test.mts:163-178` exercises only the pure `allocateDriverWage` and never involves an affiliation row.

**Failure scenario.** Fleet X hires D on 28 March at ₹45,000/month. D runs one 600 km trip on 30 March, settled 31 March. One March row → `round2(salary * w/total)` = the whole ₹45,000 (`economics.ts:250`), folded into `running_cost` and `net_profit` (`:658-668`). `GET /fleet/analytics/vehicles` reports that truck carrying ₹75/km of wage alone and failing its EMI (`analytics.ts:142-153,189`, surfaced at `routes/analytics.ts:36-40`).

**Correction from verification.** The claim's *first* consequence — a trip settled on the 3rd temporarily absorbing 100% of the month — is the documented, self-correcting design (`economics.ts:587-591`), genuinely provisional, and should be struck. The defect stands on the affiliation-window ground alone, which never converges. A related aggravator: because `getLatestAffiliation` is `invited_at desc limit 1` unfiltered, a re-hire at a new salary retroactively re-prices every earlier month for that driver.

---

### [MEDIUM] No unassign/release endpoint exists, so a pre-departure crew change strands the load
`bt-fleet-service/src/lib/assignment.ts:116`

`assignment.ts:116-120` refuses a conflicting assign with "finish or release it before assigning again", but no route releases a live assignment. The complete route inventory — `assignment.ts:32,52,74`; `owners.ts:34,48,54`; `drivers.ts:56,70,84,91,113,153`; `vehicles.ts:111,123,136,169,175,203,214,239,251`; `analytics.ts:29,36,43,57,64`; `internal.ts:22` — contains no release. The only three callers of the release primitives are `assignment.ts:140` (internal compensation inside the same call), `assignment.ts:197` (the stale sweep) and `economics.ts:473` (inside the roll-up, reachable only via the internal-secret route that requires the booking to reach `paid`). `releaseFinishedAssignments` filters on `TERMINAL_BOOKING_STATUSES = ['completed','paid','cancelled']` (`assignment.ts:40,175-199`), so an `accepted` booking is never swept, while the three partial-unique indexes from `supabase/migrations/0016_fleet_assignment_and_auction.sql:63-69` pin the booking, the truck and the driver simultaneously.

**Failure scenario.** Owner assigns driver D and truck T to booking B (`accepted`, which is the sole member of `ASSIGNABLE_STATUSES`, `assignment.ts:37`). D calls in sick. Retrying with driver E: `getFleetBooking` passes, the insert hits `vehicle_assignments_one_live_per_booking` (`0016:63-64`, which fires regardless of which driver is submitted), the sweep finds nothing terminal, and `assignment.ts:116` returns 409 pointing at an action with no endpoint. Collaterally, `routes/drivers.ts:139` refuses to suspend D and `:163` refuses to let D leave, both on `hasLiveAssignmentForDriver` (`assignment.ts:222`) — two more messages pointing at the same missing action. The only escape is cancelling B, which destroys the load. Ops reassign is not a fix: it updates only `bookings.driver_id` (`bt-booking-service/src/lib/repository.ts:336-350`), requires role `admin` (`bt-booking-service/src/lib/service.ts:466-469`), and never touches `vehicle_assignments`. The out-of-scope note at `assignment.ts:35-36` covers mid-*trip* reassignment (Q13); this failure is pre-departure, inside the supported window.

---

### [MEDIUM] Any fleet owner can enumerate driver PII by phone number via the invite endpoint
`bt-fleet-service/src/routes/drivers.ts:61`

`POST /fleet/drivers/invite` takes a bare phone (`routes/drivers.ts:29-31`, only trimmed length 8-20), calls `findDriverByPhone` (`:60`) and spreads the result verbatim into the 201 body as `driver: { ...driver }` (`:65`), where `DriverIdentity` carries `full_name`, `phone_number`, `kyc_status`, `average_rating` and `total_trips` (`bt-fleet-service/src/lib/fleet-repo.ts:120-128`, populated `:162-170`). Nothing is field-picked between repo and reply. The attacker role is self-serve: `bt-auth-service/src/routes/auth.ts:143` lets anyone register as `fleet_owner`, `ensureRoleProfile` auto-inserts the `fleet_owners` row (`auth.ts:109-117`), and `is_active` defaults true (`0015_fleet_owner_core.sql:35`) so `requireFleetOwner` (`fleet-repo.ts:29-41`) is satisfied immediately. The service-role client (`bt-fleet-service/src/lib/supabase.ts:11`) bypasses RLS. The route is publicly proxied (`bt-gateway/nginx.conf:197-201`) behind only a per-IP `limit_req` (`nginx.conf:49`, 60 r/m) — a throttle, not a gate. No prior relationship with the target driver is checked anywhere.

The distinct error messages form an oracle even when the invite fails: "No BharatTruck account exists for that phone number" (`fleet-repo.ts:142-147`), "That account is not a driver account" (`:149`), "has not completed driver onboarding yet" (`:158`), "already has a pending or active fleet affiliation" (`:231-235`) — each returned verbatim with its code (`index.ts:24-27`).

**Corrections from verification.** Ordering is inverted in the original claim: the identity lookup happens *first* (`:60`), the insert second (`:61`), so a 409 short-circuits the disclosure. Consequently a driver *actively* affiliated with a competitor yields only the 409 fact, not the PII — full identity is returned for unaffiliated, suspended, left or rejected drivers. The four-state oracle still discriminates any arbitrary number. **Additional aggravator not in the original claim:** every successful probe commits a real `pending` row (`fleet-repo.ts:222-226`) which, via the one-live-per-driver index, blocks every other fleet from inviting that driver — enumeration doubles as a roster-locking DoS against rivals.

---

## 4. Backend capability map

7 Fastify/TypeScript services behind an Nginx gateway; 98 registered routes (91 functional + 7 `/health`). Auth is three-tier: **public** (no token), **JWT** (custom HS256, one shared `JWT_SECRET`, claims `{userId, role}` where role ∈ `shipper|driver|admin|fleet_owner` — `packages/shared/src/auth.ts:18`), and **internal** (`x-internal-secret` header, one shared `INTERNAL_SERVICE_SECRET`). The gateway exposes only `/api/*` and `/ws/`; every `/internal/*` route is unreachable from outside by design (`bt-gateway/nginx.conf.template:231-234`).

**Identity contract (the most likely integration mistake):** the JWT `userId` claim is `public.users.id` and nothing else. `drivers.id` is a separate row (referenced by `bookings.driver_id`, `quotes.driver_id`, `fleet_drivers.driver_id`, and the Redis `loc:*` keys); `fleet_owners.id` is a third. `POST /fleet/bookings/:id/assign` takes `drivers.id`, not `users.id` (`packages/shared/src/auth.ts:5`, restated at `bt-fleet-service/src/plugins/auth.ts:8`).

### bt-auth-service (port 3001)

| Method | Path | Auth | Status |
|---|---|---|---|
| POST | `/auth/send-otp` | public | **stubbed** — no SMS provider; falls through to `console.log` in prod (`routes/auth.ts:197`) |
| POST | `/auth/verify-otp` | public | implemented (`routes/auth.ts:205`); new accounts hardcoded `shipper` (`:229`), does **not** call `ensureRoleProfile` |
| POST | `/auth/email/register` | public | implemented (`:254`) — bcrypt 12, role ∈ shipper\|driver\|fleet_owner |
| POST | `/auth/email/verify` | public | implemented (`:309`) |
| POST | `/auth/email/login` | public | implemented (`:350`) |
| POST | `/auth/email/resend-otp` | public | implemented (`:400`), enumeration-safe (`:414`) |
| POST | `/auth/magic-link/send` | public | implemented (`:431`) — **creates the account** when the email is unknown |
| GET | `/auth/magic-link/verify` | public (token in query) | implemented (`:478`), single-use |
| POST | `/auth/google` | public | implemented (`:531`); 501 when `GOOGLE_CLIENT_ID` unset (`:538`) |
| POST | `/auth/refresh` | public (refresh token) | implemented (`:624`) — matched against Redis, so logout truly revokes |
| GET | `/auth/me` | JWT any | implemented (`:654`) |
| POST | `/auth/register` | JWT any | implemented (`:671`) — **any user can change their own role here** |
| POST | `/auth/logout` | JWT any | implemented (`:695`) |
| PUT/GET | `/onboarding/profile` | JWT driver | implemented (`routes/onboarding.ts:93,121`) |
| POST/PUT/GET | `/onboarding/vehicle`, `/vehicle/:id`, `/vehicles` | JWT driver | implemented (`:153,176,209`) |
| POST/PUT | `/onboarding/license` | JWT driver | implemented (`:225,252`); any edit resets status to pending (`:271`) |
| POST | `/onboarding/vehicle/:id/insurance` | JWT driver | implemented (`:278`) |
| POST/GET/DELETE | `/onboarding/bank-account[s][/:id]` | **JWT any role** (no driver gate) | implemented (`:309,349,361`) |
| GET | `/onboarding/status` | JWT driver | implemented (`:387`) |
| POST | `/kyc/verify/:type` | JWT | **stubbed** — returns 501 (`routes/kyc.ts:89,118`) |
| GET | `/kyc/status/:userId` | JWT | **stubbed** — 501 (`:110,127`); ownership assertion is a TODO at `:97` |

Routing quirk: `kycRoutes` is wrapped in `fastify-plugin`, which sets `skip-override`, so the `{ prefix: '/kyc' }` passed at `bt-auth-service/src/index.ts:24` is **ignored**. The routes land correctly only because the route strings already carry `/kyc` (`routes/kyc.ts:117`).

### bt-booking-service (port 3002)

| Method | Path | Auth | Status |
|---|---|---|---|
| POST | `/bookings/` | JWT shipper | implemented (`routes/bookings.ts:32`) — price-lock saga (`lib/service.ts:56`), binds coords ±1e-5, weight at 2dp, load+vehicle type exact (`service.ts:93-112`); `quoted_price` set server-side |
| GET | `/bookings/` | JWT | implemented (`:77`) — role-scoped at `lib/repository.ts:129` |
| GET | `/bookings/:id` | JWT | implemented (`:52`) |
| GET | `/bookings/:id/pod-context` | JWT driver, assigned, in_transit | implemented (`:65`, `lib/service.ts:349-379`) |
| PATCH | `/bookings/:id/accept` | JWT driver, not fleet-employed | implemented (`:87`); DB guard `WHERE status='pending'` (`repository.ts:171`) |
| PATCH | `/bookings/:id/start` | JWT assigned driver | implemented (`:99`); fleet bookings need a live assignment (`lib/state.ts:52`) |
| PATCH | `/bookings/:id/cancel` | JWT shipper-owner or assigned driver | implemented (`:116`); legal only from pending\|accepted (`repository.ts:555`) |
| POST | `/bookings/:id/force-complete` | JWT **admin** | implemented (`routes/ops.ts:33`) — the one legitimate state-machine bypass |
| POST | `/bookings/:id/reassign` | JWT **admin** | implemented (`routes/ops.ts:55`) |
| POST | `/bookings/:bookingId/quotes` | JWT driver \| fleet_owner | implemented (`routes/quotes.ts:32`); fleet-employed drivers 403 |
| GET | `/bookings/:bookingId/quotes` | JWT | implemented (`:53`) — blind auction (`lib/quote-repository.ts:136-144`) |
| PATCH | `…/quotes/:quoteId/counter` | JWT shipper-owner or owning bidder | implemented (`:66`) |
| PATCH | `…/quotes/:quoteId/accept` | JWT shipper-owner | implemented (`:89`); atomic award at `lib/quote-repository.ts:242` |
| PATCH | `…/quotes/:quoteId/reject` | JWT shipper-owner | implemented (`:104`) |
| PATCH | `…/quotes/:quoteId/withdraw` | JWT owning bidder | implemented (`:119`) |
| GET | `…/quotes/:quoteId/history` | JWT | implemented (`:134`) |
| POST | `/location/update` | JWT driver | implemented (`routes/location.ts:53`) |
| GET | `/location/driver/:driver_id` | JWT | implemented (`:155`) |
| GET | `/location/booking/:booking_id` | JWT | implemented (`:184`) |
| POST | `/internal/bookings/:id/complete-pod` | internal secret | implemented (`routes/internal.ts:27`) |
| POST | `/internal/bookings/:id/mark-paid` | internal secret | implemented (`routes/internal.ts:44`) |

There is deliberately **no** driver self-complete route (`routes/bookings.ts:110`). Security note: this service's internal-auth uses a plain string compare (`plugins/internal-auth.ts:21`) where `bt-fleet-service` uses `crypto.timingSafeEqual` (`bt-fleet-service/src/plugins/internal-auth.ts:24`).

### bt-pricing-service (port 3003)

| Method | Path | Auth | Status |
|---|---|---|---|
| POST | `/pricing/quote` | JWT **any role, no gate** | implemented (`routes/pricing.ts:46`) — see §1 |
| GET | `/internal/quote/:id` | internal secret | implemented (`routes/internal.ts:24`) |
| POST | `/internal/quote/:id/consume` | internal secret | implemented (`routes/internal.ts:45`) — atomic conditional UPDATE is the real replay/expiry guard |

### bt-payment-service (port 3004)

| Method | Path | Auth | Status |
|---|---|---|---|
| POST | `/payments/settle` | JWT admin \| shipper | implemented (`routes/payments.ts:44`, `lib/payment-service.ts:44-123`) — idempotent on `booking_id`; payout row written before payment row on purpose (`:80-88`); payee follows the bid, not the wheel (`resolvePayee`, `:34`) |
| GET | `/payments/status/:booking_id` | JWT admin \| shipper (**drivers 403**) | implemented (`routes/payments.ts:64`); authz delegated to booking-service with the caller's JWT (`:75`) |
| POST | `/internal/trip-completed` | internal secret | implemented (`routes/internal.ts:40`) |

Razorpay/escrow endpoints were deleted (`routes/payments.ts:8`); `docker-compose.yml:168-170` still passes `RAZORPAY_*` that nothing reads.

### bt-cargo-ledger (port 3005)

| Method | Path | Auth | Status |
|---|---|---|---|
| POST | `/cargo/shipments/` | **NONE** | **stubbed** (`routes/shipments.ts:42`) — returns a random UUID, persists nothing (`:46`) |
| POST | `/cargo/shipments/checkpoint` | **NONE** | **stubbed** (`:66`) — real SHA-256, never persisted; Merkle root over a one-element stub array (`:91`) |
| GET | `/cargo/shipments/:id/proof` | **NONE** | **stubbed** (`:115`) — hardcoded empty proof |
| GET | `/cargo/shipments/:id` | **NONE** | **stubbed** (`:136`) — `{status:'stub'}` |
| POST | `/cargo/pod/request-otp` | Bearer forwarded to booking-service | implemented (`routes/pod.ts:41`) |
| POST | `/cargo/pod/verify-otp` | **public by design** (consignee has no account) | implemented (`routes/pod.ts:60`) — TTL + attempt cap + constant-time compare; the **only** normal path to a completed trip |

`writeHashToChain` returns nulls when disabled and **throws** when `BLOCKCHAIN_ENABLED=true` (`lib/blockchain.ts:21,39`).

### bt-tracking-service (port 3006)

| Method | Path | Auth | Status |
|---|---|---|---|
| POST | `/tracking/route/:bookingId` | JWT + 4-way `assertCanAccess` | implemented (`routes/tracking.ts:139`) |
| GET | `/tracking/route/:bookingId` | same | implemented (`:149`) |
| GET | `/tracking/eta/:bookingId` | same | implemented (`:161`) |
| GET | `/tracking/track/:bookingId` | same | implemented (`:179`) |

`assertCanAccess` (`:46`) is closed by default: admin, the booking's shipper, its assigned driver, or the fleet — via the shared `canFleetAccessBooking` (`:59`), which is the critical defect in §3. `lib/google.ts:9` throws at **module load** if `GOOGLE_MAPS_SERVER_KEY` is unset, so the service cannot boot without it.

### bt-fleet-service (port 3007, NEW)

| Method | Path | Auth | Status |
|---|---|---|---|
| POST/GET/PATCH | `/fleet/owners`, `/owners/me` | JWT fleet_owner | implemented (`routes/owners.ts:34,48,54`) |
| POST | `/fleet/drivers/invite` | JWT fleet_owner | implemented (`routes/drivers.ts:56`) — PII oracle, §3 |
| GET | `/fleet/drivers` | JWT fleet_owner | implemented (`:70`) |
| GET | `/fleet/drivers/invites/mine` | JWT **driver** | implemented (`:84`) |
| POST | `/fleet/drivers/invites/:id/respond` | JWT **driver** | implemented (`:91`) |
| PATCH | `/fleet/drivers/:id` | JWT fleet_owner | implemented (`:113`); consent gate at `:129` — an owner cannot self-activate a pending invite |
| DELETE | `/fleet/drivers/:id` | JWT fleet_owner | implemented (`:153`) — soft delete to `left` |
| POST | `/fleet/vehicles` | JWT fleet_owner | implemented (`routes/vehicles.ts:111`) |
| POST | `/fleet/vehicles/bulk` | JWT fleet_owner | implemented CSV only (`:123`); xlsx/pdf/image return 501 |
| GET | `/fleet/vehicles` | JWT fleet_owner | implemented (`:136`) |
| GET | `/fleet/vehicles/model-categories` | JWT fleet_owner | implemented (`:169`) |
| GET/PATCH | `/fleet/vehicles/:id` | JWT fleet_owner | implemented (`:175,203`) |
| PUT | `/fleet/vehicles/:id/finance` | JWT fleet_owner | implemented (`:214`) |
| PUT | `/fleet/vehicles/:id/permits` | JWT fleet_owner | implemented (`:239`) — destructive, §3 |
| PUT | `/fleet/vehicles/:id/lanes` | JWT fleet_owner | implemented (`:251`) — destructive, §3 |
| POST | `/fleet/bookings/:id/assign` | JWT fleet_owner | implemented (`routes/assignment.ts:32`) |
| GET | `/fleet/bookings` | JWT fleet_owner | implemented (`:52`) |
| GET | `/fleet/live` | JWT fleet_owner | implemented (`:74`) — but keyed on drivers, not vehicles, so idle trucks never appear |
| GET | `/fleet/analytics/{summary,vehicles,vehicles/:id,drivers,fuel}` | JWT fleet_owner | implemented (`routes/analytics.ts:29,36,43,57,64`) |
| POST | `/internal/trip-economics/:bookingId` | internal secret (timing-safe) | implemented (`routes/internal.ts:22`) |

`GET /health` exists unauthenticated on all 7 services, registered outside every auth scope (`bt-auth-service/src/index.ts:25`, `bt-booking-service/src/index.ts:23`, `bt-pricing-service/src/index.ts:20`, `bt-payment-service/src/index.ts:20`, `bt-cargo-ledger/src/index.ts:18`, `bt-tracking-service/src/index.ts:29`, `bt-fleet-service/src/index.ts:44`).

### Gateway routing table
Source of truth is `bt-gateway/nginx.conf.template` (the committed `nginx.conf` is reference-only, `nginx.conf:1`, and has drifted). Upstreams are per-location `set $x_upstream ${VAR}` + `proxy_pass $x_upstream` so nginx resolves at request time via `resolver ${DNS_RESOLVER}` (`:26`) — required for Cloud Run URLs.

| Public path | Rewrite | Upstream | Rate zone | Status |
|---|---|---|---|---|
| `/health` | — | served inline by gateway | — | implemented (`:131-135`) |
| `/ws/` | — | `BOOKING_SERVICE_URL` | — | **BROKEN** (`:137-146`) — full WebSocket upgrade block, but a repo-wide grep for `websocket`/`@fastify/websocket` returns zero hits; no WS server exists |
| `/api/auth/` | `/auth/$1` | AUTH | `otp_zone` **5 r/m**, burst 10 | implemented (`:148-153`) — the OTP-grade limit also throttles login, refresh, `/me` and logout for everyone behind one NAT (`:55`) |
| `/api/kyc/` | `/kyc/$1` | AUTH | api, burst 20 | implemented (`:155-160`) |
| `/api/onboarding/` | `/onboarding/$1` | AUTH | api, burst 20 | implemented (`:162-167`) |
| `/api/bookings/` | `/bookings/$1` | BOOKING | api, burst 30 | implemented (`:169`) — carries all 16 booking/quote/ops routes |
| `/api/quotes/` | `/quotes/$1` | BOOKING | api | **BROKEN — dead path** (`:176`); no service registers a `/quotes` prefix (`bt-booking-service/src/index.ts:29`, routes are `/:bookingId/quotes`). Guaranteed 404. Both frontends already use the correct form. |
| `/api/location/` | `/location/$1` | BOOKING | api, burst **60** | implemented (`:183`) |
| `/api/tracking/` | `/tracking/$1` | TRACKING | api, burst 40 | implemented (`:193-198`) |
| `/api/pricing/` | `/pricing/$1` | PRICING | api, burst 30 | implemented (`:200-205`) |
| `/api/payments/` | `/payments/$1` | PAYMENT | api, burst 20 | implemented (`:207`) |
| `/api/cargo/` | `/cargo/$1` | CARGO | api, burst 20 | implemented (`:214`) — the prefix through which the 4 unauthenticated shipment stubs are publicly reachable |
| `/api/fleet/` | `/fleet/$1` | FLEET | api, burst 30 | implemented (`:224-229`) — all 27 fleet routes |
| `/` | — | 404 JSON | — | implemented (`:231-234`) — the only thing keeping `/internal/*` off the internet |

Two gateway defects: `TRACKING_SERVICE_URL` has **no Docker default** (`bt-gateway/Dockerfile:9-16` defaults every other upstream), so an unset value renders `set $tracking_upstream ;` — an nginx syntax error that takes the **whole** gateway down. And `CORS_ALLOWED_ORIGINS` is dead: it is defaulted, substituted and documented, but appears nowhere in the template — the real policy is a hardcoded regex map `^https://bt-(shipper|driver|ops-web)-[^/]+\.run\.app$` (`nginx.conf.template:50-53`, used at `:100`), which no env var can widen.

### Booking state machine

`VALID_TRANSITIONS` (`bt-booking-service/src/lib/state.ts:10`), enforced by the pure guard `assertValidTransition` (`:26`, throws 409 `INVALID_TRANSITION`):

```
pending      → accepted, cancelled, negotiating
negotiating  → accepted, cancelled
accepted     → in_transit, cancelled
in_transit   → completed
completed    → paid
paid         → (terminal)
cancelled    → (terminal)
```

`in_transit` cannot be cancelled by anyone. Enforcement sites:

| Transition | Site | Guard |
|---|---|---|
| pending → accepted (driver self-accept) | `lib/service.ts:220` | role + fleet-affiliation 403 + `assertValidTransition` + DB `WHERE status='pending'` (`repository.ts:171`) |
| pending\|negotiating → accepted (shipper awards) | `lib/quote-repository.ts:242` | **Does not call `assertValidTransition`** — enforces the rule directly in SQL: `.in('status',['pending','negotiating']).is('awarded_quote_id',null)` (`:263-264`), which is legality check and double-award guard in one atomic UPDATE. Second, parallel enforcement site; easy to miss. |
| accepted → in_transit | `lib/service.ts:283` | assigned-driver 403 + `assertValidTransition` + `assertFleetAssignmentReady` for fleet bookings (`lib/state.ts:52`) + DB guard on status **and** `driver_id` (`repository.ts:190`) |
| in_transit → completed (**only normal path**) | `lib/service.ts:392` | reached only via `POST /internal/bookings/:id/complete-pod` after a verified receiver OTP |
| accepted\|in_transit → completed (ops force) | `lib/service.ts:471` | admin only; `accepted→completed` is **not** in `VALID_TRANSITIONS`, so it validates against the explicit allowlist `OPS_FORCE_COMPLETE_SOURCES` (`:463`) |
| completed → paid | `lib/service.ts:426` | via `POST /internal/bookings/:id/mark-paid`; optimistic `WHERE status='completed'` means a replay 409s, which payment-service treats as success (`bt-payment-service/src/lib/payment-service.ts:112`) |
| pending\|accepted → cancelled | `lib/service.ts:533` | ownership + `assertValidTransition` + DB `.in('status',['pending','accepted'])` (`:555`) |

**`negotiating` is never written.** It is a declared status, a legal target, an accepted source for `awardBooking` (`quote-repository.ts:263`) and for accepting bids (`quote-service.ts:97`), and a member of `PRE_ACCEPTED_STATUSES` (`repository.ts:75`) — but no code path anywhere sets it. Bookings under active negotiation stay `pending`.

Quote machine (`lib/state.ts:75`, guard `:89`): `submitted → countered|accepted|rejected|withdrawn|expired`; `countered → countered|accepted|rejected|withdrawn|expired`; the last four are terminal. `acceptQuote` does **not** call the guard — it checks `status ∈ {submitted, countered}` inline (`quote-service.ts:246`) and `awardBooking` then bulk-expires the rest. `AuctionStatus` (`state.ts:67`) is a dead type referenced by nothing.

Fleet lifecycles: assignment is legal only from booking `accepted` (`bt-fleet-service/src/lib/assignment.ts:37`); a live assignment is `released_at IS NULL`; release happens on completed/paid/cancelled (`:40`). Affiliation `pending→active|rejected` is **driver-only**; `active↔suspended` and `→left` are owner-only and blocked while assigned; only `active` counts as fleet employment for the price-masking and no-load-board rules (`bt-booking-service/src/lib/fleet.ts:162`).

### Background work
`bt-booking-service/src/lib/jobs.ts` holds five **empty stubs**: `notifyDriver`/`notifyShipper`/`notifyNewQuote` (`:18`) are called on live paths (`quote-service.ts:142,207,209,264,305`) and do nothing — no bid, counter, award or rejection notification is ever sent. `anchorToBlockchain` (`:44`) does nothing. `expireAuction` (`:63`) is never called at all, so an auction deadline is enforced only lazily at bid time (`quote-service.ts:101`) and an expired auction sits in `pending` forever. There is **no queue, cron, scheduler or inbound webhook anywhere** (`jobs.ts:6`) — every async linkage is a fire-and-forget HTTP call made durable only by idempotent, self-healing consumers.

Schema caveat: only migrations 0009–0018 are committed. `supabase/migrations/README.md:11` states the live schema was never created through migrations — core tables (`users`, `drivers`, `bookings`, `quotes`, `negotiations`, `vehicles`) and the `booking_status`/`user_role` enums exist only in the live project. **A clean environment cannot be rebuilt from this repo today.**

---

## 5. Frontend design system

Stack: Next.js 16.2.6 + React 19.2.4 + Tailwind CSS v4.3.0, **CSS-first — there is no `tailwind.config.*` in either app**. The entire theme is one `@theme inline` block in `src/app/globals.css`, which is byte-identical between `driver/` and `shipper/` (154 lines each, verified by diff). shadcn is configured and five primitives are vendored per app — and are almost entirely unused.

### Config files

- `driver/postcss.config.mjs:1-5` — single plugin `@tailwindcss/postcss`. No autoprefixer. Identical in shipper.
- `driver/components.json` — style `"base-nova"` (`:3`), rsc true, tsx true, `tailwind.config: ""` (`:6`), css `src/app/globals.css`, baseColor `"neutral"`, cssVariables true, prefix `""` (`:6-12`); iconLibrary `"lucide"` (`:13`); aliases `@/components`, `@/lib/utils`, `@/components/ui`, `@/lib`, `@/hooks` (`:15-21`) — note `@/hooks` points at a directory that does not exist in either app.
- `driver/src/app/globals.css:1-5` — `@import "tailwindcss"; @import "tw-animate-css"; @import "shadcn/tailwind.css";` then `@custom-variant dark (&:is(.dark *));`

### Tokens

`@theme inline` (`globals.css:7-49`) maps: `--color-background/foreground`, `--color-card(+ -foreground)`, `--color-popover(+ -foreground)`, `--color-primary(+ -foreground)`, `--color-secondary(+ -foreground)`, `--color-muted(+ -foreground)`, `--color-accent(+ -foreground)`, `--color-destructive`, `--color-border`, `--color-input`, `--color-ring`, `--color-chart-1..5`, `--color-sidebar` + 7 sidebar sub-tokens; fonts `--font-sans`/`--font-mono`/`--font-heading` (`:10-12`); radii `--radius-sm..--radius-4xl` (`:42-48`).

**Light palette** (`globals.css:75-108`), all oklch, effectively pure grayscale + one red:

| Token | Value | ≈ hex |
|---|---|---|
| `--background`, `--card`, `--popover` | `oklch(1 0 0)` | `#ffffff` |
| `--foreground`, `--card-foreground`, `--popover-foreground` | `oklch(0.145 0 0)` | `#252525` |
| `--primary` | `oklch(0.205 0 0)` | `#343434` (near-black, **not** blue) |
| `--primary-foreground` | `oklch(0.985 0 0)` | `#fbfbfb` |
| `--secondary`, `--muted`, `--accent` | `oklch(0.97 0 0)` | `#f7f7f7` |
| `--muted-foreground` | `oklch(0.556 0 0)` | `#8e8e8e` |
| `--destructive` | `oklch(0.577 0.245 27.325)` | `#dc2626` |
| `--border`, `--input` | `oklch(0.922 0 0)` | `#e5e5e5` |
| `--ring` | `oklch(0.708 0 0)` | `#b4b4b4` |
| `--chart-1..5` | `oklch(0.87 / 0.556 / 0.439 / 0.371 / 0.269 0 0)` | grayscale ramp |
| `--radius` | `0.625rem` | 10px |
| `--sidebar` | `oklch(0.985 0 0)` | + 7 sidebar tokens |

The token layer contains **no brand blue and no success green** — those exist only as stock Tailwind utilities in page code.

**Dark palette** (`globals.css:110-142`) is fully defined (`--background oklch(0.145 0 0)`, `--card/--popover oklch(0.205 0 0)`, `--primary oklch(0.922 0 0)`, `--muted oklch(0.269 0 0)`, `--destructive oklch(0.704 0.191 22.216)`, `--border oklch(1 0 0 / 10%)`, `--input oklch(1 0 0 / 15%)`, `--sidebar-primary oklch(0.488 0.243 264.376)` — the one chromatic value) but **never activated**: nothing anywhere adds `.dark` to `<html>` or `<body>` (`driver/src/app/layout.tsx:36-37`, `shipper/src/app/layout.tsx:24-28`), and all page-level colors are hardcoded light, so toggling it would break the app.

Base resets (`globals.css:144-154`): `* { @apply border-border outline-ring/50 }`, `body { @apply bg-background text-foreground }`, `html { @apply font-sans }`, plus a raw body rule at `:51-54` with `-webkit-font-smoothing: antialiased`.

**Radius scale** — `--radius-sm` 6px, `-md` 8px, `-lg` 10px, `-xl` 14px, `-2xl` 18px, `-3xl` 22px, `-4xl` 26px (`globals.css:42-48`). Actual usage: `rounded-xl` 95, `rounded-lg` 76, `rounded-full` 44, `rounded-2xl` 33, `rounded-4xl` 2 (badge only). Convention: `rounded-2xl` mobile/driver cards and hero panels, `rounded-xl` desktop cards/buttons/inputs, `rounded-lg` compact desktop controls and chips, `rounded-full` status pills and dots.

**Shadows** — deliberately minimal: `shadow-sm` 25 uses (canonical card, `driver/src/app/(app)/available/page.tsx:98`), `shadow-lg` only the login card (`driver/src/app/login/page.tsx:56`), `shadow-xl` only modals (`shipper/src/components/CounterModal.tsx:34`), `shadow-md` only the shipper card hover (`shipper/src/app/dashboard/page.tsx:64`). Depth is carried by 1px borders.

### Fonts — with a real bug

`Geist` and `Geist_Mono` are loaded via `next/font/google` and exposed as `--font-geist-sans`/`--font-geist-mono`, applied on `<html>` (`driver/src/app/layout.tsx:2,8-16,36`; identical `shipper/src/app/layout.tsx:7-15,24`). But `globals.css:10` is `--font-sans: var(--font-sans);` — **self-referential** — while `:11` correctly wires `--font-mono: var(--font-geist-mono);`. `--font-geist-sans` is never consumed by any CSS. Net effect: the loaded Geist Sans is not applied and body text falls back to `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto` (`globals.css:52`). Mono does resolve. **A new app should write `--font-sans: var(--font-geist-sans);`.**

**Type scale in use:** `text-sm` 286 (body/default), `text-xs` 113 (metadata; canonical field label is `text-xs text-gray-400 uppercase tracking-wide`, `driver/src/app/(app)/bookings/[id]/page.tsx:135`), `text-lg` 27 (`text-lg font-bold` section headings), `text-base` 16, `text-xl` 8 (page titles, `shipper/src/app/dashboard/page.tsx:28`), `text-2xl` 5 (brand/hero numbers, `driver/src/app/login/page.tsx:64`), `text-[10px]` 4, `text-3xl` 2. Weights: `font-medium`, `font-semibold`, `font-bold`, `font-extrabold` (POD wordmark only). Tracking: `tracking-wide`/`wider` on uppercase micro-labels, `tracking-[0.5em]` on OTP inputs, `tracking-[0.4em]` on the POD code.

### Practical (non-token) palette — this is what pages actually use

**Brand blue `#2563eb`** = Tailwind blue-600. Declared as PWA `themeColor` (`driver/src/app/layout.tsx:27-32`), manifest `theme_color` (`driver/src/app/manifest.ts:15`, background `#ffffff`), and the app icon (`driver/public/icon.svg`, `rx=112 fill=#2563eb`, wheels `#1e3a8a`). In code: `bg-blue-600` 40, `text-blue-600` 37, `ring-blue-500` 27, `ring-blue-600` 25, `bg-blue-700` hover 15.

Semantics: success/pickup = green-500/600, `green-50` panel + `green-400` border + `green-800` text. Money-settled = emerald-600/50/100/200. Danger/drop-pin = red-500/600, `red-50`/`border-red-200`. Warning/auction/counter = orange-400/500/600, `orange-50/100`, `yellow-50/100` for waiting. In-transit = purple-400/600/800 (driver) and purple-100/700 (shipper pill). Stale-GPS = amber-100/400/600. Neutral counts: `text-gray-400` 81, `text-gray-900` 80, `text-gray-700` 73, `border-gray-200` 67, `text-gray-500` 65, `bg-white` 44, `bg-gray-50` 40.

**Canonical status maps:**
- `shipper/src/lib/status.ts:3-11` `bookingStatusConfig`: pending `bg-yellow-100 text-yellow-800`, accepted `bg-green-100 text-green-800`, negotiating `bg-blue-100 text-blue-800`, in_transit `bg-purple-100 text-purple-800`, completed `bg-gray-100 text-gray-600`, cancelled `bg-red-100 text-red-800`, paid `bg-emerald-100 text-emerald-800`.
- `shipper/src/lib/status.ts:13-20` `quoteStatusConfig`: submitted yellow-100/800, countered `bg-orange-100 text-orange-800`, accepted green-100/800, rejected red-100/800, withdrawn + expired `bg-gray-100 text-gray-500`. Duplicated at `driver/src/lib/status.ts:3-10`.
- `shipper/src/app/bookings/[id]/page.tsx:452-457` `TRIP_STATUS_BADGE`: accepted "Driver Assigned" `bg-blue-100 text-blue-700`, in_transit "In Transit" `bg-amber-100 text-amber-700`, completed "Delivered" `bg-green-100 text-green-700`, paid "Paid" `bg-emerald-100 text-emerald-700`.
- `driver/src/app/onboarding/review/page.tsx:24-28` `BADGE_CONFIG`: pending yellow-50/300/700, verified green-50/300/700, premium blue-50/300/700.

### Component inventory

**shadcn primitives** — five per app, byte-identical across apps, built on `@base-ui/react` + cva + tailwind-merge, and **almost entirely unused**. `grep 'components/ui'` outside `src/components/ui/` returns exactly two hits, both at `shipper/src/app/bookings/[id]/page.tsx:25-26` (Card, Badge, used in TripTrackingSection `:420-446`). Driver imports none.

| Primitive | File | Key classes |
|---|---|---|
| Button | `driver/src/components/ui/button.tsx:7` | base `rounded-lg border border-transparent bg-clip-padding text-sm font-medium … focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:opacity-50`; variants `default/outline/secondary/ghost/destructive/link` (`:10-21`); sizes default h-8 px-2.5, xs h-6, sm h-7, lg h-9, icon size-8/6/7/9 (`:22-34`) |
| Card | `driver/src/components/ui/card.tsx:15` | `rounded-xl bg-card py-(--card-spacing) text-sm ring-1 ring-foreground/10 [--card-spacing:--spacing(4)]`; Header `:28`, Title `:41` (`font-heading text-base leading-snug font-medium`), Description `:53`, Action `:64`, Content `:76`, Footer `:87` (`border-t bg-muted/50`) |
| Badge | `driver/src/components/ui/badge.tsx:8` | `h-5 rounded-4xl px-2 py-0.5 text-xs font-medium`; variants `:11-22`; uses `useRender` so the tag is swappable |
| Input | `driver/src/components/ui/input.tsx:12` | `h-8 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base … md:text-sm` — note h-8 is far smaller than the hand-rolled inputs actually in use |
| Dialog | `driver/src/components/ui/dialog.tsx` | Overlay `:34` `bg-black/10 supports-backdrop-filter:backdrop-blur-xs`; Content `:56` `rounded-xl bg-popover p-4 ring-1 ring-foreground/10 sm:max-w-sm`; Footer `:105`; Title `:125` |

**The real component vocabulary is hand-rolled Tailwind:**

| Pattern | Canonical file:line | Class string |
|---|---|---|
| Primary button (mobile) | `driver/src/app/(app)/bookings/[id]/page.tsx:270` | `w-full h-12 rounded-xl bg-blue-600 text-white font-semibold text-base disabled:opacity-40 active:scale-[0.98] transition-transform flex items-center justify-center gap-2` |
| Primary button (desktop) | `shipper/src/app/bookings/new/page.tsx:412` | `w-full bg-blue-600 text-white rounded-lg py-3 font-medium hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2` |
| Secondary (50/50 pair) | `driver/src/app/onboarding/personal/page.tsx:204` | `flex-1 rounded-xl border border-gray-200 px-4 py-3 text-sm font-medium text-gray-500 hover:bg-gray-50 transition-colors` |
| Destructive outline | `shipper/src/app/bookings/[id]/page.tsx:158` | `text-sm text-red-600 hover:text-red-700 border border-red-200 px-4 py-2 rounded-lg hover:bg-red-50 transition-colors` |
| Card (mobile, tappable = `<button>`) | `driver/src/app/(app)/available/page.tsx:98` | `w-full text-left bg-white rounded-2xl border border-gray-200 p-4 active:scale-[0.98] transition-transform shadow-sm` |
| Card (desktop) | `shipper/src/app/dashboard/page.tsx:64` | `block bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md transition-shadow`, in `grid gap-4 sm:grid-cols-2 lg:grid-cols-3` (`:47`) |
| Route indicator (the brand motif) | `driver/src/app/(app)/available/page.tsx:101-112` | rail `flex flex-col items-center mt-1` with `w-2.5 h-2.5 rounded-full bg-green-500`, `w-0.5 h-8 bg-gray-200 my-0.5`, `w-2.5 h-2.5 rounded-full bg-red-500`. Desktop dashed variant `shipper/src/app/dashboard/page.tsx:77-83` |
| Label/value pair (no KPI tiles exist) | `shipper/src/app/bookings/[id]/page.tsx:781-796` | `<p className="text-xs text-gray-400">{label}</p><p className="text-gray-700">{value}</p>` inside `grid grid-cols-2 gap-3 text-sm` (`:181`) |
| Status pill | `shipper/src/app/dashboard/page.tsx:67` | `text-xs font-medium px-2.5 py-1 rounded-full ${status.color}` |
| Tag pill | `driver/src/app/(app)/available/page.tsx:116` | `inline-flex items-center px-2.5 py-1 rounded-lg bg-gray-100 text-xs font-medium text-gray-700` |
| Modal (hand-rolled) | `shipper/src/components/CounterModal.tsx:32-36` | backdrop `fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4`, panel `bg-white rounded-xl shadow-xl w-full max-w-md p-6` + `onClick={e => e.stopPropagation()}`. Driver never uses overlay modals — inline expand-in-place confirms instead (`driver/src/app/(app)/bookings/[id]/page.tsx:683-711`) |
| "Table" (no `<table>` exists) | `shipper/src/app/bookings/[id]/page.tsx:245-259` | `divide-y divide-gray-100` rows, each `px-5 py-4` > `flex flex-col sm:flex-row` > `flex-1 grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm` with `<p className="text-xs text-gray-400">Header</p>` cells |
| Input (desktop) | `shipper/src/app/bookings/new/page.tsx:161-162` | `inputClass = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent'`, `labelClass = 'block text-sm font-medium text-gray-700 mb-1'` |
| Input (mobile, filled) | `driver/src/app/onboarding/personal/page.tsx:132` | `w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm placeholder-gray-400 focus:ring-2 focus:ring-blue-600 focus:border-transparent transition-shadow` |
| Amount input | `driver/src/app/(app)/bookings/[id]/page.tsx:254` | `w-full h-12 rounded-xl border border-gray-300 px-4 text-lg font-semibold focus:ring-2 focus:ring-blue-500` |
| OTP input | `driver/src/app/login/page.tsx:217` | `w-full rounded-lg border border-gray-300 px-3 py-2.5 text-center text-lg font-mono tracking-[0.5em]`, `inputMode="numeric" maxLength={6}` |
| Toggle chip | `driver/src/app/onboarding/personal/page.tsx:166-170` | `px-3 py-1.5 rounded-lg text-xs font-medium border transition-all` + selected `bg-blue-600 text-white border-blue-600` / unselected `bg-white text-gray-600 border-gray-200 hover:border-blue-300` |
| Spinner (**the only loading UI**) | `driver/src/components/spinner.tsx` | `animate-spin h-6 w-6 border-3 border-blue-600 border-t-transparent rounded-full`; recolored via className. Full-page variant is inlined at `border-4 h-8 w-8` (`driver/src/app/page.tsx:18`) |
| Empty state | `driver/src/app/(app)/available/page.tsx:41-57` | `flex flex-col items-center justify-center py-20 px-6 text-center` + 64px `w-16 h-16 text-gray-300` stroke SVG + `text-gray-500 text-lg font-medium` + `text-gray-400 text-sm mt-1` + CTA `mt-4 px-6 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-medium active:scale-95` |
| Terminal-state panel | `driver/src/app/(app)/bookings/[id]/page.tsx:347-355` | `bg-emerald-50 rounded-2xl border-2 border-emerald-400 p-6 text-center shadow-sm` (green-50/400/800 completed `:361`, purple `:940`, orange + `animate-pulse-border` `:408`, muted `bg-gray-50 … opacity-75` `:378`) |
| Progress bar | `driver/src/app/onboarding/review/page.tsx:97-102` | track `w-full bg-gray-200 rounded-full h-2`, fill `bg-green-500 h-2 rounded-full transition-all duration-500` with inline width % |
| Chat bubbles | `shipper/src/components/NegotiationHistory.tsx:52-59` | row `flex ${isShipper ? 'justify-end' : 'justify-start'}`, bubble `max-w-[75%] rounded-xl px-4 py-2.5` + own `bg-blue-600 text-white rounded-br-sm` / other `bg-gray-100 text-gray-900 rounded-bl-sm` |
| Toasts | `driver/src/app/layout.tsx:40` | sonner 2.0.7, `<Toaster position="top-center" richColors closeButton />` — identical `shipper/src/app/layout.tsx:31`. No custom theme. |

**No skeleton loaders exist anywhere** — every loading state is `<div className="flex items-center justify-center py-20"><Spinner /></div>`. `animate-pulse` is used only as a 2px liveness dot.

**Custom keyframes** (`globals.css:56-73`): `.animate-pulse-border` (2 s orange border + `box-shadow: 0 0 12px rgba(249,115,22,0.3)`), used on counter-offer cards (`driver/src/app/(app)/my-quotes/page.tsx:103`); `.animate-celebrate` is defined in both apps and referenced **nowhere** — dead CSS.

**Motion:** mobile press feedback `active:scale-[0.98] transition-transform` on cards and full-width buttons, `active:scale-95` on small text buttons; desktop uses `transition-colors`/`transition-shadow`. No framer-motion, no page transitions, no layout animation library.

### Layout shells

| | driver | shipper |
|---|---|---|
| Frame | `h-full flex flex-col`; sticky header `sticky top-0 z-30 bg-white border-b border-gray-200 px-4 h-14`; main `flex-1 overflow-y-auto pb-20`; **fixed bottom nav** `fixed bottom-0 left-0 right-0 z-30 bg-white border-t` (`driver/src/components/app-shell.tsx:60-101`) | sticky top Navbar only: `bg-white border-b border-gray-200 sticky top-0 z-50` > `max-w-7xl mx-auto px-4 sm:px-6` > `flex items-center justify-between h-14` (`shipper/src/components/Navbar.tsx:23-59`) |
| Nav items | 3 tabs `/available`, `/my-quotes`, `/profile` with 24px stroke SVGs; item `flex-1 flex flex-col items-center py-2 pt-3 min-h-[56px]` + active `text-blue-600` / inactive `text-gray-400`, label `text-xs mt-0.5 font-medium` (`app-shell.tsx:8-36`) | links `px-3 py-2 rounded-lg text-sm font-medium` + active `bg-blue-100 text-blue-700` / inactive `text-gray-600 hover:bg-gray-100` (`Navbar.tsx:32-36`) |
| Layout file | `driver/src/app/(app)/layout.tsx` (7 lines) wraps children in AppShell — only `/available`, `/my-quotes`, `/profile`, `/bookings/[id]` get the shell; login, callback and **all** onboarding pages render bare | **No layout.tsx anywhere**; each page renders `<Navbar />` itself then its own `<main>` |
| Widths | full-bleed `px-4 py-4 space-y-3/4`; onboarding uses `w-full max-w-[414px] flex flex-col gap-4` | `max-w-7xl` dashboard, `max-w-4xl` booking detail, `max-w-2xl` new-booking form, `px-4 sm:px-6` |
| Root layout | `<html className="${geistSans.variable} ${geistMono.variable} h-full antialiased"><body className="h-full bg-background text-foreground"><AuthProvider>{children}<Toaster/></AuthProvider><RegisterSW/></body>` (`driver/src/app/layout.tsx:34-45`) | same minus RegisterSW/manifest/appleWebApp; hand-writes the viewport meta instead of exporting `viewport` (`shipper/src/app/layout.tsx:25-27`) |

### API-client pattern (duplicated, near-identical)

```
API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080'   // the gateway origin
fetch(`${API_BASE}/api${path}`, …)                                      // paths written WITHOUT /api
```
`shipper/src/lib/api.ts:3,81-135`. Two functions: `request<T>` attaches `Authorization: Bearer` from localStorage, sets `Content-Type` only when a body exists, and on 401 calls `tryRefresh()` once, retries, then clears both tokens and does `window.location.href = '/login'`; `authRequest<T>` (`:139-166`) is the same minus refresh/redirect, used for all `/auth/*`. Both unwrap `json.data` only when `json.success` is truthy. Mirror at `driver/src/lib/api.ts:93-176`.

**Envelope:** `{ success, data, code?, message?, error? }`.
**Error type:** `class ApiError extends Error { code: string }` (`driver/src/lib/api.ts:50-56`), thrown as `new ApiError(ERROR_MESSAGES[code] || json.message || json.error || 'Something went wrong', code)` (`:138-142`). `ERROR_MESSAGES` (`:58-66`) covers `AUCTION_CLOSED`, `DUPLICATE_QUOTE`, `QUOTE_NOT_FOUND`, `ALREADY_AWARDED`, `NOT_FOUND`, `DRIVER_PROFILE_NOT_FOUND`, `FORBIDDEN`. Unparseable body → `ApiError('Server error — please try again','NETWORK_ERROR')`; expired session → `ApiError('Session expired','UNAUTHORIZED')`. UI convention: `catch (err) { if (err instanceof ApiError) toast.error(err.message) }` plus code-based branching (`driver/src/app/(app)/bookings/[id]/page.tsx:55-60,224-228`).

**Single-flight refresh mutex** (`driver/src/lib/api.ts:70-89`, mirror `shipper/src/lib/api.ts:58-77`): module-level `refreshPromise`; `tryRefresh()` returns the in-flight promise if present, else creates one that reads the refresh token, calls `refreshAccessToken(rt)`, persists via `setToken`, and clears in a `finally`. This is what prevents N parallel 401s firing N refreshes.

**Token storage — the one thing a third app must choose deliberately.** Keys **differ**: driver uses `bt_driver_token` / `bt_driver_refresh_token` (`driver/src/lib/api.ts:17-18`); shipper uses `bt_token` / `bt_refresh_token` (`shipper/src/lib/api.ts:4-5`). Both store raw JWTs in localStorage (no cookies, no httpOnly), all accessors SSR-guarded. Shipper's `getToken` additionally sanitizes pasted tokens with `raw.trim().replace(/[\r\n]+/g,'')` (`:12`); driver does not.

### Auth pattern

`AuthProvider` (`driver/src/lib/auth.tsx`, **byte-identical** to `shipper/src/lib/auth.tsx`): context `{ token, user, isReady, login, logout }` (`:16-30`). On mount (`:37-74`): read stored token → none ⇒ set `isReady` and stop; else set token and `getMe()`; on failure try the stored refresh token → `refreshAccessToken` → save → `getMe` again; on failure clear both. `login(access, refresh, user?)` persists both (`:76-81`); `logout()` clears both (`:83-88`). `isReady` is the gate every redirect waits on.

**Route guard:** driver's lives inside AppShell (`driver/src/components/app-shell.tsx:39-57`) — `useEffect(() => { if (isReady && !token) router.replace('/login') })`, a centered spinner while `!isReady`, and `return null` when `!token` so content never flashes. **Shipper has no client-side guard at all** — no layout, no token check in `dashboard/page.tsx`, `bookings/[id]/page.tsx` or `bookings/new/page.tsx`; the only protections are the index-page redirect (`shipper/src/app/page.tsx:11-14`) and the hard `window.location.href` in `api.ts` on an unrecoverable 401. Deep-linking to `/dashboard` without a token renders the chrome then bounces.

**Login screen** (`driver/src/app/login/page.tsx`, 618 lines; shipper's 617 differs only in `APP_ROLE`, `POST_LOGIN_PATH`, the hero SVG and the subtitle): frame `flex items-center justify-center min-h-screen px-4` > `w-full max-w-md` > `bg-white rounded-2xl shadow-lg p-6` (`:54-56`); brand block `w-14 h-14 bg-blue-600 rounded-2xl` + `text-2xl font-bold` (`:58-65`); 4 tabs phone \| google \| email \| magic-link (`:30-35`) as `flex border-b border-gray-200 mb-5` with `flex-1 pb-2.5 text-sm font-medium border-b-2` + active `border-blue-600 text-blue-600` (`:68-82`). Google GSI via `next/script strategy="afterInteractive"` (`:305-341`), degrading gracefully when `NEXT_PUBLIC_GOOGLE_CLIENT_ID` is unset (`:321-332`). A dev `<details>` escape hatch pastes a raw JWT (`:89-113`).

**Public unauthenticated page** — `shipper/src/app/pod/[bookingId]/page.tsx` deliberately bypasses the api client (raw `fetch` to `/api/cargo/pod/verify-otp`, `:54-58`, own `API_BASE` at `:17`), uses an **emerald** palette rather than blue, and carries the only two-tone wordmark (`Bharat<span className="text-emerald-600">Truck</span>`, `:23-31`). Errors render inline as `text-sm text-red-600 text-center` (`:150`), not as toasts.

### Maps, formatting, PWA

- Maps exist in **shipper only**: `@vis.gl/react-google-maps ^1.9.0` (`shipper/package.json:13`). `shipper/src/components/maps/LiveTrackMap.tsx` — props `{origin, dest, encodedPolyline?, bounds?, driver?, className?}` (`:30-40`), `DEFAULT_CLASS = 'h-[60vh] w-full rounded-2xl overflow-hidden'` (`:42`); `<Map defaultZoom={7} gestureHandling="greedy" disableDefaultUI>` (`:64-72`); teardrop pins green `#16a34a` "A" / red `#dc2626` "B" (`:73-78`), 30px 🚚 driver marker (`:79-83`); polyline `strokeColor:'#2563eb', strokeOpacity:0.9, strokeWeight:4` with `map.fitBounds(box, 48)` (`:96-142`). Degrades to `MapUnavailable` with inline styles when no key (`:58-60,174-192`).
- Env keys are LOCKED to `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` and `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` (`shipper/src/lib/maps.ts:29-34`, header `:1-13`); the secret `GOOGLE_MAPS_SERVER_KEY` lives in bt-tracking-service only. `maps.ts` also exports `LatLng`, `MapBounds`, `decodePolyline` (`:42-75`) and `lerp` (`:78-84`).
- The file comment claims the module is "COPIED into each app (driver/, shipper/)" — **driver has neither file**. Driver deep-links out instead: `buildNavDeepLink` → `https://www.google.com/maps/dir/?api=1&destination=lat,lng` (`driver/src/lib/nav.ts:18-29`).
- Formatting helpers (`driver/src/lib/utils.ts`, byte-identical to shipper's): `cn` = `twMerge(clsx(…))` (`:5-7`), `formatPrice` → `₹${amount.toLocaleString('en-IN')}` (`:9-11`), `relativeTime` (`:13-25`), `formatDate` (`:27-33`), `formatDateTime` (`:35-42`), `getCountdown` (`:44-51`).
- Domain types are redeclared verbatim in both apps (`driver/src/lib/types.ts:1-3` = `shipper/src/lib/types.ts:1-3`). All API JSON is snake_case; nothing is camel-cased on the client.
- **PWA is driver-only:** `driver/src/app/manifest.ts` (standalone, portrait, theme `#2563eb`), a 54-line hand-written `driver/public/sw.js` (`bt-driver-shell-v1`, network-first navigations, cache-first same-origin static, ignores cross-origin so gateway traffic is never cached), and `driver/src/components/register-sw.tsx`. Shipper has none. Driver also has `useScreenWakeLock` (`driver/src/lib/use-wake-lock.ts:17-57`) called only for `in_transit` (`driver/src/app/(app)/bookings/[id]/page.tsx:782`).
- **No websocket/SSE anywhere** — freshness is interval polling with silent failure: shipper quotes 15 s while pending (`shipper/src/app/bookings/[id]/page.tsx:60-71`), live track 10 s while in_transit (`:403`), driver booking+quote 10 s (`driver/src/app/(app)/bookings/[id]/page.tsx:71-77`), POD watch 10 s (`:868-884`), countdown/elapsed re-render 30 s.
- Build env contract: four `NEXT_PUBLIC_*` vars, **all baked at build time** (`driver/Dockerfile:1-4,11-20`).

---

## 6. Deploy wiring

### Per-service Dockerfile / port / env-var table

All backend services use the same 4-stage `node:20-alpine` Dockerfile: `deps` (`npm ci --omit=dev`) / `development` (`npm ci` + tsx watch) / `builder` (`npm ci` + `npm run build`) / `production` (COPY node_modules from deps, dist from builder, package.json, `EXPOSE <port>`, `ENV NODE_ENV=production`, `USER node`, `CMD ["node","dist/index.js"]`).

| Service | Dockerfile | Port | Required env (fail mode) | Optional env |
|---|---|---|---|---|
| **bt-fleet-service** | `bt-fleet-service/Dockerfile` (`:6-36`), byte-copy of the booking/pricing pattern; no `packages/shared` dep | 3007 (`:17,33`) | `JWT_SECRET` (`plugins/auth.ts:36` — unset ⇒ **every request 401**, not a crash); `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (`lib/supabase.ts:10-14` — **lazy**, 500 on first query); `REDIS_URL` (`lib/redis.ts:22-24` — **lazy**, must be the same instance booking writes); `INTERNAL_SERVICE_SECRET` (`plugins/internal-auth.ts:13-17` — **fails closed 503 MISCONFIGURED**) | `PORT` (default 3007, `index.ts:68`), `NODE_ENV` (`index.ts:16`). `.env.example` is accurate — no drift vs src |
| bt-auth-service | `bt-auth-service/Dockerfile`; adds `apk add python3 make g++` for bcrypt (`:19,26,38`) and `COPY public ./public` (`:50`) | 3001 (`:31,51`) | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (`plugins/supabase.ts:10-12` — **throws at plugin registration**, container exits); `JWT_SECRET` (`routes/auth.ts:21`); `JWT_REFRESH_SECRET` (`:22,633`); `ENCRYPTION_KEY` 64 hex (`lib/encryption.ts:10-13`, lazy) | `REDIS_URL` (defaults to localhost but `connect()` at boot, `plugins/redis.ts:10,27`), `SMTP_HOST/PORT/USER/PASS/FROM`, `EMAIL_DEV_MODE`, `OTP_DEV_MODE`, `GOOGLE_CLIENT_ID`, `DRIVER_/SHIPPER_MAGIC_LINK_URL`, `SUREPASS_API_KEY` (warn-only, `lib/surepass.ts:27`) |
| bt-booking-service | `bt-booking-service/Dockerfile` — **does not vendor `packages/shared`** | 3002 (`:17,33`) | `REDIS_URL` (`lib/redis.ts:3-4` — **throws at module load**, exit(1)); `SUPABASE_*` (`packages/shared/src/db.ts:20-21`); `JWT_SECRET` (`plugins/auth.ts:22`); `INTERNAL_SERVICE_SECRET`; `PRICING_SERVICE_URL` (`lib/pricing-client.ts:104` — throws) | `PAYMENT_SERVICE_URL` (`lib/payment-emit.ts:21` — silent skip). Dead: `CARGO_LEDGER_URL`, `MSG91_AUTH_KEY`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `GOOGLE_MAPS_API_KEY` (declared, no reader) |
| bt-pricing-service | `bt-pricing-service/Dockerfile` | 3003 (`:17,33`) | `JWT_SECRET` (`plugins/auth.ts:31`); `INTERNAL_SERVICE_SECRET` (`plugins/internal-auth.ts:13`); `SUPABASE_*` (`lib/supabase.ts:10-14`, lazy) | `DIESEL_PRICE_INR` (default 90, `lib/cto-cost.ts:42-43`) |
| bt-payment-service | `bt-payment-service/Dockerfile` | 3004 (`:17,33`) | `SUPABASE_*` (lazy, `lib/supabase.ts:10-14`); `JWT_SECRET` (`plugins/auth.ts:35`); `INTERNAL_SERVICE_SECRET`; `BOOKING_SERVICE_URL` (`lib/booking-client.ts:68-71` — throws) | **`FLEET_SERVICE_URL`** (`lib/fleet-emit.ts:18-20` — optional by design, silent skip). Dead: `RAZORPAY_*` |
| bt-cargo-ledger | `bt-cargo-ledger/Dockerfile`; dev stage pins `BLOCKCHAIN_ENABLED=false` (`:19`) | 3005 (`:17,34`) | `REDIS_URL` (**module-load throw**, `lib/redis.ts:3-4` — documented cause of historical 503s); `SUPABASE_*` (lazy); `BOOKING_SERVICE_URL` + `INTERNAL_SERVICE_SECRET` (`lib/booking-client.ts:66-71`) | `BLOCKCHAIN_ENABLED`, `SMTP_*`, `EMAIL_DEV_MODE`, `POD_EMAIL_FROM`, `RECEIVER_APP_BASE_URL`, `POD_OTP_PEPPER` (default `''`; changing it invalidates in-flight OTPs) |
| bt-tracking-service | `bt-tracking-service/Dockerfile` — **does not vendor `packages/shared`** | 3006 (`:17,33`) | `REDIS_URL` (module-load throw); `SUPABASE_*` (`lib/supabase.ts:3-8` — **module-load throw**, unlike the lazy services); `JWT_SECRET` (`plugins/auth.ts:30`); **`GOOGLE_MAPS_SERVER_KEY`** (`lib/google.ts:8-9` — **module-load throw**) | `ROUTE_CACHE_TTL_SECONDS` (default 21600). Dead: `DIESEL_PRICE_INR`, `BOOKING_SERVICE_URL` (set by deploy-all, no reader) |
| bt-gateway | `bt-gateway/Dockerfile` — `FROM nginx:alpine`, no package.json | `EXPOSE 80` (`:18`), nginx `listen 80` (`nginx.conf.template:73`) | `TRACKING_SERVICE_URL` (**no Docker default** — unset renders invalid nginx and the container will not start) | `DNS_RESOLVER`, `AUTH_/BOOKING_/PRICING_/PAYMENT_/CARGO_/FLEET_SERVICE_URL` all defaulted (`Dockerfile:9-16`); `CORS_ALLOWED_ORIGINS` is **dead** |
| driver / shipper | 2-stage, Next standalone; `EXPOSE 8080`, `CMD ["node","server.js"]` (`driver/Dockerfile:23-30`) | 8080 | — | build ARGs `NEXT_PUBLIC_API_URL` (default `https://bt-gateway-itcdoenefa-el.a.run.app`), `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY`, `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` (`:15-20`). **`NEXT_PUBLIC_GOOGLE_CLIENT_ID` is read by both login pages (`:23`) but is not an ARG and is not passed by CI — every CI-built image ships it empty and Google sign-in is dead in prod.** |
| bt-ops-web | `bt-ops-web/Dockerfile` — 2-stage Next 14, no `public/` copy, no named `development`/`production` stages despite compose referencing them | 8080 (`:20-22`) | — | `NEXT_PUBLIC_API_URL` ARG (`:12`) |

### CI deploy workflow

**`.github/workflows/deploy.yml`** — the only CD path. Trigger: push to `main` + `workflow_dispatch` (`:45-48`); permissions `contents: read`, `id-token: write` (`:50-53`). Three jobs: `detect` (`:58-103`), `deploy-services` (`:108-151`), `deploy-apps` (`:156-217`).

1. **detect** — `dorny/paths-filter@v3` (`:66-80`) with one filter per dir, each `['<dir>/**', '.github/workflows/deploy.yml']` (so touching the workflow redeploys everything), then a jq split into backend services vs apps (`:87-99`; `driver→bt-driver`, `shipper→bt-shipper`, `bt-ops-web→bt-ops-web` at `:96-98`).
2. **deploy-services** — `REGION: asia-south1`, `PROJECT: project-aa0faf06-c115-438a-a36` (`:125-126`); per-service concurrency group `deploy-<svc>`, `cancel-in-progress: false` (`:121-123`); `REV="${GITHUB_SHA::7}-${GITHUB_RUN_NUMBER}-${GITHUB_RUN_ATTEMPT}"`, then:
   ```
   gcloud run deploy "<svc>" --source "<svc>" --region "$REGION" --project "$PROJECT" \
     --revision-suffix "$REV" --labels "commit-sha=${GITHUB_SHA},managed-by=github-actions" --quiet
   ```
   (`:137-151`). **No `--port`, no `--allow-unauthenticated`, no `--set-env-vars`, no `--service-account`** — deliberate (`:11-14`): a `--source` deploy preserves existing env/SA/port/scaling, and a new env var is a one-time manual `gcloud run services update … --update-env-vars`.
3. **deploy-apps** — `gcloud auth configure-docker` (`:184`), `IMG="${REGION}-docker.pkg.dev/${PROJECT}/bt/<svc>:${GITHUB_SHA}"` (`:192`), conditional `--build-arg` array (API URL always if non-empty; Maps key + MapID only when `matrix.maps == true`, `:196-201`), `docker build` (`:202`), push (`:204`), `gcloud run deploy --image` (`:211-217`).

Auth is keyless WIF: provider `projects/752385541585/locations/global/workloadIdentityPools/github-pool/providers/github`, SA `bt-cicd-deployer@project-aa0faf06-c115-438a-a36.iam.gserviceaccount.com` (`:131-135,177-181`). Required roles documented at `.github/workflows/README.md:96-101`.

**`.github/workflows/ci.yml`** — PR to main + push to `main`/`feat/**` (`:12-17`). Its paths-filter **does** include `bt-fleet-service` (`:49`), so fleet type-checks but never deploys. Matrix runs `npm ci` → `npm run build --if-present` (the real typecheck gate) → non-blocking lint → `npm test --if-present` against a `redis:7-alpine` service container (`:69-115`). A separate job renders the gateway template with the full var list including `TRACKING_` and `FLEET_SERVICE_URL` and asserts `nginx -t` (`:117-138`) — the only place all vars are set together.

**Secondary manual path: `scripts/deploy/deploy-all.sh`.** `deploy_source()` is `gcloud run deploy "$1" --source "$2" --region --project --platform managed --allow-unauthenticated --port 8080 --quiet` (`:36-40`). Order: 6 backend services (`:56-61`) → copy shared secrets off the live bt-booking-service via the `bookenv()` helper (`:46-48,65-72`) and merge cross-service URLs with `--update-env-vars "^@^…"` (`:51-53`) → gateway (`:98`) → apps (`:105-107`) → `/health` checks (`:111-122`). **bt-booking-service is the de facto secret master**, and all 7 services share one `JWT_SECRET` and one `INTERNAL_SERVICE_SECRET` — a leak of either is total.

**Vestigial, do not model on:** `k8s/` (a namespace plus one bt-auth-service Deployment referencing Docker Hub images `bharattruck/bt-auth-service:latest` that no workflow builds — `k8s/bt-auth-service.yaml:48`; nothing references `k8s/` anywhere); `infra/docker-compose.yml` (standalone postgres+redis; the postgres half is dead since the platform is Supabase); `infra/env.template` (lists `MSG91_*`, `SIGNZY_API_KEY`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `GOOGLE_MAPS_API_KEY` — none has a reader — and omits `INTERNAL_SERVICE_SECRET`, `ENCRYPTION_KEY` and all SMTP vars).

### Gap list: what is required to add ONE more Cloud Run service

Verified blockers for `bt-fleet-service`, in dependency order. Each is a discrete, checkable action.

1. **Add the CD path filter.** `bt-fleet-service` appears nowhere in `.github/workflows/deploy.yml` — no filter at `:71-80` and no jq special-case at `:87-88`; `grep fleet deploy.yml` returns zero hits. Add `bt-fleet-service: ['bt-fleet-service/**', '.github/workflows/deploy.yml']` alongside `:77`. Without this the service is **never built or deployed**.
2. **Add it to the manual script.** `scripts/deploy/deploy-all.sh:56-61` deploys 6 services and `:112-116` health-checks 7 names — fleet is in neither.
3. **First creation needs `--allow-unauthenticated` explicitly.** `deploy.yml` never passes it (`:137-151`), which is fine for existing services because `--source` preserves IAM, but on the **first** creation of a new service `--quiet` defaults to authenticated-only and the gateway (plain nginx, no OIDC token) gets 403. Either create it once via `deploy-all.sh` (`:39`) or add the flag for the first run.
4. **Apply migrations before serving traffic.** `scripts/db/apply-fleet-migrations.sh:38-46` runs `supabase link` + `supabase db push` for 0014–0018; it needs a Supabase PAT or `SUPABASE_DB_PASSWORD` — the service-role key cannot do DDL (`:5-12`). Gate the deploy on `scripts/db/verify-fleet-schema.mjs`, which asserts the 10 tables, 17 columns, the `fleet_owner` enum member (`:84-86`) and seed row counts, exiting 1 on failure.
5. **Set the 5 runtime env vars manually — CD will never supply them.** `JWT_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `REDIS_URL`, `INTERNAL_SERVICE_SECRET`. Do not paste; copy from the live bt-booking-service using `bookenv()` (`deploy-all.sh:46-48`) or `scripts/ops/fix-blank-env.py` (which picks a delimiter absent from all values, `:77-82`, because `@` collides with `rediss://` passwords — add a fleet target to `TARGETS` at `:38-61`). `REDIS_URL` **must** be the same instance bt-booking-service writes (`bt-fleet-service/src/lib/redis.ts:32` reads `loc:driver:*`; `bt-booking-service/src/lib/redis.ts:19` is the sole writer). Do **not** set `PORT=3007` — Cloud Run injects 8080.
6. **Set `FLEET_SERVICE_URL` on bt-payment-service.** It is read at `bt-payment-service/src/lib/fleet-emit.ts:18` and returns immediately when unset (`:20`). `deploy-all.sh:86` sets `SUPABASE_*`, `JWT_SECRET`, `INTERNAL_SERVICE_SECRET` and `BOOKING_SERVICE_URL` on payment but **not** this one, and CD sets nothing. Without it every fleet settlement silently skips the roll-up and all five `/fleet/analytics/*` reports render zero with no error. It must be the **direct** Cloud Run URL of bt-fleet-service, not the gateway — the gateway proxies only `/api/fleet/` → `/fleet/` (`nginx.conf.template:224-228`) and does not expose `/internal`.
7. **Set `FLEET_SERVICE_URL` on the gateway** to the real `https://bt-fleet-service-…` URL. The Docker default `http://bt-fleet-service:3007` (`bt-gateway/Dockerfile:15`) only works on a Docker network. The route itself already exists (`nginx.conf.template:224-229`) and matches the service mount (`bt-fleet-service/src/index.ts:59`).
8. **While you are there, set `TRACKING_SERVICE_URL` on the gateway** — it has no Docker default (`bt-gateway/Dockerfile:9-16`) and an unset value renders `set $tracking_upstream ;`, an nginx syntax error that takes the entire gateway down, not just tracking.
9. **Do not add a `@bharattruck/shared` dependency.** `packages/shared` is `file:../packages/shared` in `bt-booking-service/package.json:12` and `bt-tracking-service/package.json:12` with `install-links=true` in their `.npmrc:7`, but **no Dockerfile COPYs `../packages/shared` and none COPYs `.npmrc`**, and the `gcloud run deploy --source <dir>` build context is the service directory alone. `deploy.yml`'s path filters also omit `packages/shared`, so a shared-only change never redeploys booking or tracking. `bt-fleet-service` has no such dep — that property is why it builds cleanly. Preserve it.
10. **Nothing pins the runtime service account.** No deploy command anywhere passes `--service-account`; existing services survive because `--source` preserves theirs. A brand-new service inherits the project's default Compute Engine SA. Decide this explicitly.
11. **`/health` is not a readiness signal.** `bt-fleet-service/src/index.ts:44-46` is registered before the auth-scoped plugin and returns 200 with every other env var missing, and Supabase/Redis are lazy (`lib/supabase.ts:8-17`, `lib/redis.ts:20-27`). The deploy script's own gate counts that 200 as success (`deploy-all.sh:112-116`). Verify with a real authenticated `/fleet/owners/me` call, or add a boot-time env assertion.
12. **Local-dev parity is missing** (not a prod blocker, but it hides regressions): `docker-compose.yml` has no `bt-fleet-service` and no `bt-tracking-service` block, and its gateway env (`:34-40`) omits both `TRACKING_SERVICE_URL` and `FLEET_SERVICE_URL`, so `docker compose up` renders an invalid nginx.conf. `docker-compose.prod.yml` has the same gaps and targets a `production` stage `bt-ops-web/Dockerfile` does not define. `Makefile:5` lists only 5 backend services (ports 3001-3005).
13. **No `.dockerignore` needed.** `bt-fleet-service` has none, but `gcloud run deploy --source` falls back to `.gitignore`, and `bt-fleet-service/.gitignore:1-2` excludes `node_modules/` and `dist/`, so the upload is clean.