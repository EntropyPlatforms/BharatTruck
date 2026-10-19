# feat/dashboard-exception-hierarchy

**Started** 2026-10-07 · **Owner** Claude session · **Surface** `bt-app` `/dashboard` + `/home`;
since 2026-10-16 also `bt-booking-service` (`/me/summary`, alerts), `bt-gateway`, `packages/shared`,
migrations 0041–0042

## Why

The product owner set a reading hierarchy for the owner's dashboard (5 Oct 2026):

| In | The question |
|---|---|
| 5 sec | How is my fleet doing, financially and operationally? |
| 10 sec | Is anything going wrong? |
| 20 sec | Which truck / trip / load is causing it? |
| Then | What should I do? |

The page as built answered those out of order: six equal-weight KPI tiles (no ranking),
`Needs attention` buried in row 3 inside a 1fr sidebar, and a generic `Quick actions` card
duplicating the hero's buttons.

## Scope

1. **5s layer** — three headline tiles (Net profit · Revenue · Fleet) with a real
   period-over-period delta. Trips / Distance / Clearing-EMI demote to a thin secondary strip.
2. **10s layer** — `Needs attention` gains a **severity** model (`critical | warning | info`,
   the `TrackedAlert` vocabulary), is **sorted** by it, moves to row 2 full-width, and gains
   two detectors: **trip delayed** (off-route / idle alerts) and **high fuel usage**
   (fuel variance).
3. **Act layer** — delete the `Quick actions` card (the nav rail and hero already carry every
   one of its six links). Actions stay attached to each exception row.
4. Shrink the dashboard's `PhotoHero` from `lg` to `md` so the 5s answer is above the fold.

## Decisions

- **Deltas are computed client-side from a second `getFleetSummary()` call** for the preceding
  window of equal length. `FleetSummary` has no `previous` block and adding one to
  bt-fleet-service would not reach this app, which runs against the **live** gateway — a server
  field would show nothing until deployed. One extra call, no deploy, real numbers.
- **No sparklines.** Nothing server-side returns a per-day series, and the repo rule is that
  only real data is drawn. The owner's mockup asks for `↑14.2%`, which is a delta, not a series.
- **Trip-delayed / high-fuel read existing endpoints only** — `/tracking/fleet/overview`
  (one call, Redis-backed, no Google call, already safe to poll) and
  `/fleet/analytics/fuel`. No new service code.
- **Severity is not emoji.** `TrackedAlert.severity` already exists server-side with exactly
  this vocabulary; the row renders it as an `IconTile` tint plus a coloured left rail plus the
  text label, so it survives a colour-blind reader and matches the house rule that colour
  encodes health, not category.
- **`Fleet` tile = trucks that earned / trucks active**, not EMI coverage. EMI is an exception
  and lives in the attention list. No percentage under it — on a 2-truck fleet a percentage is
  noise, which `low_sample` already concedes elsewhere.

## Deliberately out

- **Service due** — needs a `service_interval_km` / `last_service_odometer_km` field that does
  not exist. Schema call for the founder; not invented here.
- Server-side `previous` on `/fleet/analytics/summary` — the right long-term home for the
  delta, worth doing when the fleet service is next touched.

## Status

Dashboard changes applied; verified against the live gateway on localhost. Extended 2026-10-16 with
per-person dashboards, status history and alerts (last section). Rebased onto main @ 0894c2f on
2026-10-16; the two migrations were renumbered 0041 / 0042 because main had taken 0040
(`0040_eway_portal_credentials.sql`). PR opened on the founder's go-ahead.

## Verification

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `eslint` (both changed files) | clean, 0 warnings |
| `next build` | passes — all 21 routes |
| Dev server | runs on `localhost:3215` |
| Login page renders | yes |
| Dev API proxy reaches the live gateway | yes — `POST /api/auth/email/login` returned a real **401**, which is a routed response, not a CORS failure |
| **Dashboard rendered with real data** | **BLOCKED — no working credentials** |

The five accounts in `scripts/seed/seed-demo-personas.mjs` do not exist in the live database
(zero rows for `%@bharattruck.in`). This is the 2026-08-16 regression in BIBLE §6.4 recurring;
that section now carries a dated warning. The dashboard changes are therefore **built, typechecked,
linted and served, but not visually confirmed against real fleet data.**

Also found, not fixed (out of this branch's scope):
- `CLAUDE.md` still describes `bt-ops-web` and `driver/` + `shipper/` as the app surfaces. Only
  `bt-app` exists, and it builds — the "both currently fail `next build`" line is stale.

## Charts (added 2026-10-07)

Two charts, both from data the dashboard **already fetched** — no new endpoint, no new dependency:

- **Revenue over time** — a real series derived from `bookings[]`, bucketed weekly (30d) or
  monthly (90/180d), counting only `paid`/`completed`/`delivery_asserted` trips so the money
  is earned rather than asked-for. Crosshair + tooltip, direct label on the peak only,
  and a "Show numbers" table as the text equivalent.
- **Profit by truck** — `vehicles[]` sorted by surplus, bars diverging from a zero line so a
  loss reads as a loss. Coloured by the EMI verdict (emerald clears / red short), never one
  hue per truck, per the house rule that colour encodes health, not category.

**`--chart-1..5` were shadcn's greyscale defaults**, never touched since install. They are now a
categorical theme drawn from this file's own ramps, with a separately re-stepped dark set
(the light steps are too dark on `#151b25`; the Tailwind dark steps are too light to hold the
band). Both sets pass all six checks of the palette validator — lightness band, chroma floor,
adjacent-pair CVD separation, normal-vision separation, contrast. **Do not substitute a step by
eye; re-run the validator.** Marigold is deliberately absent at its brand step: `#f2a516` clears
only 2:1 on white, so `chart-2` is the same hue at brand-700.

**No chart library.** Recharts (what the shadcn chart registry wraps) was the default choice, but
it adds a charting runtime to a PWA whose payload is already a tracked problem, React 19 support
across that ecosystem is still uneven, and everything visual here is already hand-drawn. The
`--chart-*` tokens are exactly the ones shadcn's charts read, so adopting it later is a
re-render, not a redesign.

## How this was verified without touching production

There is **no local backend on this machine** — no Docker, no Supabase CLI, and `docker-compose.yml`
defines no database — so localhost proxies to the live gateway and the production Supabase DB.
Rather than write fixture data to production, verification ran against a **local mock gateway**
(in the session scratch directory, not in this repo) serving the eight endpoints `/dashboard`
calls, with a deterministic 6-truck / 103-booking / 190-day fixture shaped to fire every alert
severity and give both charts real history.

Confirmed in the browser, light and dark: the three headline tiles with live deltas, the
severity-sorted two-column alert list (2 critical, 3 warning, 1 info), the revenue trend with
crosshair tooltip and its numbers table (values match the chart), and profit-by-truck with four
trucks clearing EMI and two short.

**Nothing was written to production. Nothing was pushed.**

## Regression pass (2026-10-07, second sitting)

The first pass shipped four known downsides. Three are fixed; one is narrowed.

**1. Recent trips had been demoted to last in the drill-down tier.** It now sits third,
directly under the shortfall table, and the LIVE MAP took its place at the bottom instead.
The map is the right thing to demote: two of the six alerts deep-link to `/map` and carry
their own button, so it is the most duplicated surface on the page, whereas Recent trips is
the only place that answers "which LOAD" and needs the full width for its seven columns
(`min-w-[720px]`, so it cannot be squeezed beside the map without scrolling forever).

**2. The page had grown by two full-width rows.** `Assets that did not cover their EMI` now
sits immediately under `Profit by truck` — overview then detail, adjacent. Same height, but
the table now reads as the answer to the red bars directly above it rather than as an
unrelated fourth table two rows later. Verified: the chart's −₹59.4K / −₹55.0K bars and the
table's −₹59,436 / −₹54,968 rows are the same two trucks.

**3. The extra call delayed first paint.** The comparison-window fetch has been lifted out of
the main `Promise.all`. It feeds only the three delta chips, so the dashboard no longer waits
on it; tiles render without a delta and gain one when it lands — the same path as when the
call fails, so there is one branch, not two. (Clearing the stale baseline moved to the period
buttons, because a synchronous `setState` in the effect trips
`react-hooks/set-state-in-effect` — the same reason `loading` and `error` already live there.)

**4. "Messy real data" — two real defects found by testing, both fixed.**

- **Bucketing bug in `revenueSeries`.** On any window over 30 days the LABEL came from
  calendar months (`setMonth`) while the INDEX came from fixed 30-day arithmetic. Calendar
  months are 28–31 days, so the two disagreed and a trip could be labelled under one month
  and counted under its neighbour. Buckets now own an explicit `[start, end)` range and a trip
  is placed by comparing against it — one source of truth for both. 180d now renders six
  evenly spaced points (10 May · 9 Jun · 9 Jul · 8 Aug · 7 Sept · 7 Oct).
- **Runaway percentages.** On the 180-day window the revenue tile read **`+5018.7%`**, because
  the comparison window barely overlaps the fleet's history — a true number, and useless. A
  ₹1,000 baseline floor was not enough. Deltas now cap at `↑>999%`, keeping direction and
  magnitude while dropping precision that was never real, with the reason on hover. A fleet
  whose first trips fall inside the comparison window will hit this legitimately.

**Still open, unchanged:** "Service due" needs `service_interval_km` /
`last_service_odometer_km`, which do not exist — a schema call, not something to invent. And
everything here is still verified against the local mock only, never against production data.

## New insights (2026-10-07, third sitting)

Five additions, two new API calls total. Both new calls sit in the fail-soft bucket, so neither
can blank the page.

| Insight | Source | New call? |
|---|---|---|
| **Cash delivered but unpaid** | `bookings` already fetched — `completed`/`delivery_asserted` not yet `paid` | no |
| **RC expiring / expired** | `rc_expiry` on the fleet overview already fetched | no |
| **Profit by driver** | `getDriverAnalytics()` | yes |
| **Bid win rate** | `listMyBids()` | yes |
| **Revenue by shipper** | `bookings` already fetched | no |

**Cash** is the one this page most needed. It reported what the fleet EARNED and never what it
had been PAID — and for an Indian fleet owner a profitable quarter with ninety days of
receivables is still a fleet that cannot buy diesel. It enters the alert list as `warning`, or
`critical` once something has been owed more than 30 days (past that it is not a billing lag).

**RC expiry** partly retires the "service due needs a schema change" note above. Odometer-based
service intervals still need `service_interval_km` / `last_service_odometer_km`, but RC expiry
is already on every vehicle in the overview, and an expired RC grounds a truck at the first
checkpost. Permits (`VehiclePermit.expiry_date`) and licences (`DriverLicense.expiry_date`)
carry the same risk and the same shaped field, but are per-entity reads today — surfacing them
would be one call per truck and per driver, so they want a fleet-scoped endpoint first.

**Profit by driver** renders `/fleet/analytics/drivers`, which has been deployed and typed
since the fleet console and was never called by any surface. An owner could see which TRUCK
lost money and never which DRIVER. `ProfitByTruck` and `ProfitByDriver` now share one
`DivergingBars` component rather than duplicating the bar logic.

**Bid win rate** matters because bidding is this fleet's entire sales function and nothing
reported on it. It counts only DECIDED bids — live ones are excluded, or the rate would drift
down every time the owner bid on something. `/fleet/bookings` cannot answer this:
`bookings.fleet_owner_id` is written only on accept, so it can only ever show bids already won.

### One bug caught in review

`listFleetBookings()` returns **every** booking this fleet has ever had, with no period filter.
The first cut of "revenue by shipper" therefore summed all-time (~₹83L) under a card sitting
beneath a 30/90/180-day switch, next to a revenue tile reading ₹15.29L. Now scoped to the
window like everything else on the page (₹5.7L over 30 days). Worth remembering for any future
derivation off `bookings` — `revenueSeries` was already safe because its buckets are ranges.

### Still not built

Actual-vs-rated mileage per truck (the fuel-theft signal) needs `TripExpense` per booking — one
call per trip, so it wants a fleet-scoped expense endpoint. Lane profitability needs per-booking
distance, which is derivable from the stored coordinates but is a bigger piece of work.

## First contact with real production data (2026-10-09)

Logged into the live gateway through the local proxy with a real fleet-owner account
(`fleet_owner`, capabilities `ship`/`carry`/`operate`, 2 owned vehicles, 0 drivers).

**All eight endpoints the dashboard calls returned 200.** The wiring is correct against
production, not just against the mock:

| Endpoint | Result |
|---|---|
| `/fleet/analytics/summary` | 200 — 0 trips, ₹0 revenue, 2 active vehicles |
| `/fleet/analytics/vehicles` | 200 — 2 trucks (`JH12ORST`, `MH471234`), 0 trips each |
| `/fleet/analytics/drivers` | 200 — 0 drivers |
| `/fleet/analytics/fuel` | 200 — `variance_pct: null`, 0 trips with actuals |
| `/fleet/live` | 200 — 0 positions |
| `/fleet/bookings` | 200 — 0 bookings |
| `/fleet/bids` | 200 — 0 bids |
| `/tracking/fleet/overview` | 200 — 2 vehicles, 0 alerts |

Unauthenticated, the gateway exposes only `GET /health`. Every data route is 401, and there
are no per-service health routes through the gateway (`/api/auth/health`,
`/api/tracking/health` both 404).

### Every empty state behaved

No delta chips (no baseline → suppressed, not `0%`), `Nothing needs you right now`,
`Not enough completed trips yet to draw a trend`, and both profit charts fell to their own
empty copy. Dark theme, which is what this account is set to.

### The bug real data found

`ShortfallTable` congratulated the owner: **"All 2 trucks cleared running cost, tolls, fixed
cost and EMI"** on a fleet that had run **zero trips**. A truck that never moved has a surplus
of 0, and 0 satisfies `covered`, so an idle fleet read as a healthy one. This is pre-existing —
not introduced by this branch — but it was invisible until the page met a fleet with no
activity, which no fixture had. The card now distinguishes "nothing to settle yet" from
"settled successfully", in both the header and the empty state.

That is the whole argument for testing on real data: the fixture was richer than production and
therefore could not produce the one case that mattered.

## Lifecycle walkthrough (2026-10-11)

Live write steps against production were blocked (no GSTIN on the account; invites only reach driver
accounts that already exist), so one load was walked through all nine lifecycle stages on localhost
against a stateful mock built from the real account's shape and the backend's own rules. The dashboard
under test is the real code. All seven predicted changes were confirmed. Three dashboard defects
surfaced and are fixed on this branch:

- **Revenue definition mismatch.** The Revenue tile reads `trip_economics`, which bt-fleet-service
  writes only at `paid` (`economics.ts`). The revenue chart and shipper shares also counted
  `completed` / `delivery_asserted`, so a delivered-but-unpaid trip drew a chart point under a tile
  reading ₹0. Both now count `paid` only; owed money is carried by the "delivered but not paid" alert.
- **GPS false alarm (pre-existing).** "Trucks not sending GPS" was `live.filter(p => !hasFix(p))`, but
  `/fleet/live` lists every active driver, idle ones included, and D-25 forbids GPS outside an active
  trip — so every driver not currently driving was flagged. Now limited to drivers whose booking is
  `in_transit`. Invisible on the rich mock, where every driver was mid-trip.
- **Copy:** "All 1 truck that ran cleared…" → "The truck that ran cleared…".

A simulation proves the dashboard reacts correctly to each stage; it does not prove the backend emits
those responses. That is covered by the backend's in-process suite and, finally, only by a real trip.

## Full flow through the real UI — localhost sandbox (2026-10-11)

Ran the owner's requested flow through the actual app pages against an in-memory sandbox backend
(scratch directory, never production) with exactly the three rules that blocked the live run switched
off — R1 GSTIN-before-posting, R2 invites-only-reach-existing-drivers, R3 driver-consent — and every
other rule left on. Login (login page) → 3 invites (Drivers page) → quote, post, direct-attach and
assign in one submit (Post a load page) → driver start / GPS / delivery (driver API calls) → POD
approval → cash settlement (load page, Payment tab) → dashboard checked at four checkpoints.

Rules left on were observed holding: a GPS fix before the trip started was refused (409, D-25), and a
₹1 settlement on a ₹24,300 trip was refused (422 AMOUNT_MISMATCH).

One more defect fixed: the Live fleet card read "0 of 3 tracked trucks" on a 2-truck fleet —
`/fleet/live` is one row per DRIVER, idle ones included. Now "0 of 3 drivers reporting a live fix".

## Which dashboard values can be trusted today (2026-10-12)

Rated all 30 values on the dashboard against the code (owner-facing reliability map, kept outside the
repo): **11 Works · 3 Estimate · 14 At risk · 2 No data.**

- **One cause behind 12 of the 14 At-risk values: trip distance.** `chooseDistance`
  (`bt-fleet-service/src/lib/economics.ts`) takes the measured GPS trail whenever it is above zero,
  with no check against the routed distance. The driver's GPS is a foreground `watchPosition`
  (`bt-app/src/app/(app)/my-trips/[id]/page.tsx`), and Navigate hands off to Google Maps, so the trail
  can stop early (a 502 km trip recorded ~15 km). Every per-km cost then shrinks: net profit, gross
  margin, distance, clearing-EMI, the EMI alert and table, profit by truck/driver, the utilisation
  distance %, revenue-vs-costs, the cost mix — and the **fuel alert**, whose "estimate" side is
  `fuel_cost_est_inr` = litres-per-km × that distance (`computeFuelComparison`,
  `bt-fleet-service/src/lib/analytics.ts`), so a short trail inflates "% over estimate".
- **The other 2 At-risk values** (live fleet positions, off-route/idle alert) break at the same step:
  no location while the driver app is in the background.
- **Estimate:** unpaid "oldest N days" (aged from pickup), the revenue chart and shipper shares
  (bucketed by pickup date; shippers merged by name — `FleetBooking` carries no `shipper_id`).
- **No data:** RC-expiry alert (`rc_expiry` empty on every truck), volume utilisation.

Proposed fixes, none started: trust a GPS trail only when it covers ~85% of the routed distance (12
values → Estimate); keep the driver's GPS reporting while the app is in the background (2 → Works); prompt for tolls/fuel at trip
end (fuel alert → Works); EMI per truck; map VAHAN expiry dates onto trucks (RC alert → Works); and
the three dashboard/feed fixes above (3 → Works). After all six: 18 Works · 11 Estimate · 0 At risk ·
1 No data — running cost stays a per-km norm by design.

## Data gap map (2026-10-13)

Mapped every data point the dashboard and the trip loop depend on — where it should come from, how it
gets in today — from four read-only sweeps of the services, the app and `baseline.sql`, with the
consequential claims re-checked by hand. 72 data points: **8 in place · 28 partial · 19 with a table but
nothing filling it · 17 with no source at all.** The map itself is a PDF kept outside the repo; the
verified bugs it surfaced are recorded in `docs/BIBLE.md §5.4` (OPEN 2026-10-13). For this branch, the
ones that touch the dashboard: trip milestone times don't exist (unpaid age and completion-date
grouping need them), a driver's direct trips never get a `trip_economics` row (no owner-driver P&L),
and the fuel alert's "estimate" side shrinks with a short GPS trail.

## Dashboard per person, status history and alerts (2026-10-16)

The founder's call on the plan: **build** a dashboard for each kind of person and the status-history
+ alerts layer; **plan, don't build** the fixes that let a trip finish; **leave trip distance alone and
assume it is accurate.**

**Assumption, stated once:** every distance-derived number on these pages (net profit, per-km cost,
clearing-EMI, the fuel estimate) assumes trip distance is right. It is not guaranteed yet —
`chooseDistance` trusts any GPS trail above zero (see "Which dashboard values can be trusted" above).
That fix is a separate change.

### What was built

| Piece | Where |
|---|---|
| Every booking status change, with its time | migration `0041_booking_status_events.sql` — table, trigger on `bookings`, `booking_milestones` view; existing trips backfilled and flagged `backfilled = true` |
| Alerts table | migration `0042_alerts.sql` |
| Alert rules (pure) and the sweep (raise / refresh / escalate / reopen / resolve) | `bt-booking-service/src/lib/alerts/` |
| Sweep endpoint for Cloud Scheduler | `POST /internal/alerts/sweep?cadence=frequent\|daily` (`routes/internal.ts`); jobs in BIBLE §7.1 |
| Alerts on Home | `alerts.open` feed source (`lib/feed/service.ts`); each row opens the load, the trip, the licence or the fleet board |
| Critical alerts by email | `alert_raised` event (`packages/shared`), template in `lib/notifications/templates.ts` |
| One summary per person | `GET /me/summary` (`lib/summary/`, `routes/summary.ts`) + gateway `location /api/me/summary` |
| Dashboard for everyone | `/dashboard` in every rail; the fleet panel is the redesigned owner dashboard above, followed by `TruckPanel` / `DrivingPanel` / `ShipmentsPanel` (`components/persona-panels.tsx`) |

### Decisions

- **Panels follow capabilities, never a role** (D-3, D-27/D-36): fleet = operate or a fleet profile;
  truck = carry with no fleet and a driver row (the owner-driver); driving = drive; shipments = has
  posted a load. Order follows the primary persona (D-32).
- **Money follows truck ownership (§1.1), enforced on the server.** The driving panel has no amounts
  at all; the truck panel counts only trips on the person's own truck (`fleet_owner_id is null`); an
  alert raised for the `driver` persona never names an amount.
- **The status trigger cannot fail a booking write.** Its body traps every error and raises a
  WARNING; `security definer` with `search_path` pinned and EXECUTE revoked from
  public/anon/authenticated. The view is `security_invoker` and revoked from anon/authenticated. Both
  tables have RLS on with no policies (service role only), per the migrations README.
- **Safe before the migrations are applied** (CD deploys code on merge; migrations are applied by
  hand): milestones read as empty, Home shows no alerts and no degraded source, `/me/summary` still
  answers, and the sweep answers 503 `ALERTS_NOT_MIGRATED` and writes nothing.
- **One open alert per kind + subject + person** (`dedupe_key`). A kind whose read fails is skipped
  and its open alerts are **not** resolved — a failed query must not look like "all clear".
- **Email only on critical** (opened as critical, or escalated to it), once per episode: the outbox
  key carries the episode, so a re-opened alert can email again but a refresh never does.
- **One row per unpaid load for the shipper.** main's `payment_due` feed row (#205) asks for payment
  from delivery; once the daily sweep raises `unpaid_overdue` (3+ days late) the alert replaces that
  row in the feed and opens the same Payment tab, adding how late the payment is.
- **Overlapping sweeps are safe** (a slow run, a Scheduler retry). A second insert of the same
  problem hits the unique key and counts as "already open"; a reopen only matches while the row is
  still resolved, so one run wins and emails. Found by testing two concurrent sweeps — before the
  fix the second one returned 500 half-way, and both runs reopened the same alert (two emails
  whenever the runs are a millisecond apart).
- **Thresholds:** GPS silent 15 min warning / 2 h critical (in-transit trips only, D-25); trip not
  started 1 day late warning / 3 days critical (IST dates); delivered but unpaid 3 days warning /
  7 days critical, aged from delivery (0041's history; the last update before it exists); licence
  within 30 days warning / expired critical.

### Verification

| Check | Result |
|---|---|
| Migrations 0041 + 0042 on PGlite (scratch) | 16/16 — backfill, idempotent re-run, trigger rows, no-op update ignored, milestones, a failing trigger body does not fail the write, grants, RLS, uniqueness and checks |
| `alert-rules.unit` / `alerts-sweep.e2e` / `me-summary.e2e` | 42 / 32 / 32 pass |
| Rest of bt-booking-service | unchanged; the same 5 files fail on this Windows machine only (doubled `C:\C:\` path, no local Redis, CRLF in a migration read) |
| `packages/shared` | tsc clean, 60/60 tests |
| bt-app | tsc clean, eslint clean on touched files, `next build` passes (21 routes) |
| Panels in the browser | full and empty data, light and dark, 375 px with no sideways scroll (temporary local page, deleted) |

### Planned, not built — trips that can actually finish

1. **E-way bill upload.** A bill generated in the app on NIC's portal (#209) now carries the portal's
   PDF, but recording a bill made elsewhere still fails: the manual form's `recordEwayBill` never
   sends `document_uri` and the server requires it, so that trip cannot start (§5.4, OPEN
   2026-10-13). Add a file upload to the manual form and record the bill with its URI.
2. **Delivery OTP by SMS.** The receiver's OTP goes by email only. Route it through the same
   all-or-nothing SMS seam as `bt-auth-service/src/lib/sms.ts` once DLT registration clears (B-2).
3. **Keep delivery photos.** `POD_EVIDENCE_BUCKET` is set nowhere, so only the hashes survive.
   Create the bucket and set the variable on bt-booking-service — config, no code.
4. **Mark payouts paid.** An online payment leaves the carrier's payout `pending` forever. Add an
   ops action that records the payout as paid with its bank reference, and until then stop the
   Payment tab saying "Being paid out by BharatTruck".
