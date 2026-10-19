# CLAUDE.md

> **New here? Read `docs/BIBLE.md` first** — the single self-contained source of truth for this repo's
> docs: background, product spec, execution plan, the frozen Maps contract, team process, current
> live state, the QA harness, and runbooks. It replaced 20 separate, drifting docs on 2026-07-20 (see
> `docs/BIBLE.md §0.3` for why) — every filename this file used to point you at individually is now
> a section of `docs/BIBLE.md` instead.

> **Building anything identity-, persona-, auth-, KYC-, document- or app-shaped? Read
> `docs/ARCHITECTURE_UNIFIED_IDENTITY.md` FIRST.** It is the LOCKED model (D-1..D-38): one account,
> personas COMPUTED from owned assets + relationships (never a `role` flag), KYC that prompts but
> never gates (D-31), the consignee as an unclaimed party reachable by a claim link (D-22/D-35), and
> the plan for the ONE app (`bt-app`) in `docs/UNIFIED_APP_PLAN.md`. **Authorize on capabilities +
> `relationsToBooking` from `@bharattruck/shared/personas`, never on the JWT `role` string** — the
> `role` gates are being removed (§10.3); do not add new ones. Current schema truth is
> `supabase/schema/baseline.sql` (generated from prod); the files in `supabase/migrations/` are
> HISTORY — never read them to learn current state.

## Repo orientation

BharatTruck is an India interstate/intrastate freight-booking marketplace built on the LogisticOS microservices platform. **This is the single source-of-truth monorepo** for the whole system — all backend services, both customer PWAs, the internal ops console, the API gateway, infra, and DB migrations live here. MVP deadline: **31 Aug 2026**. North star: **Completed Paid Trips** — the bar is one shipper → one driver → one tracked, proven, paid interstate trip.

> **Repo history (2026-07-04):** consolidated into this one monorepo from scattered `Entropy-LLP/*` standalone repos. The old standalones, the stale `Entropy-LLP/LogisticOS` aggregate, and the dead `deltaos1997/*` mirrors are **retired — never push to them**. This monorepo is the only place code lands.

**Services** (Fastify / TypeScript / Node 20, deployed to GCP Cloud Run, `asia-south1`):
- `bt-gateway` — Nginx edge; maps app `/api/*` → service routes. Every app talks to the backend only through this (`NEXT_PUBLIC_API_URL`).
- `bt-auth-service` — authentication and identity (custom HS256 JWT; KYC via Surepass — currently stubbed).
- `bt-booking-service` — bookings + auction/negotiation + direct-attach (D-10) + freight documents (LR/invoice/e-way-bill) + POD evidence + **live GPS ingestion** (`POST /location/update`, trip-scoped since 2026-08-07 — D-25, no GPS outside an active trip; `GET /location/booking/:id`, Redis-backed, 30s TTL) and the `location_history` breadcrumb write. The trip lifecycle **closes end-to-end** (posted → award → in_transit → completed/delivery_asserted → paid); the old "dead-ends at accepted" note is retired.
- `bt-pricing-service` — freight quotes / pricing (CTO cost-breakdown anchor; RL engine is OUT of MVP).
- `bt-payment-service` — payments (**cash-recorded/direct first**; escrow is OUT of MVP).
- `bt-cargo-ledger` — cargo / trip POD + ledger (on-chain anchor is OUT of MVP; receiver-OTP POD is IN).
- `bt-tracking-service` — Maps & Tracking proxy (port 3006): cached route, live ETA, petrol pumps, fuel estimate, route alerts, shipper read-through aggregate. Server-side Google proxy with Redis caching. **Built through Phase 2** (`/route`, `/eta`, `/track`, `/health`); Phase 3+ pending.
- `bt-ops-web` — internal operations console (**Next.js 14 / React 18**; auth + data currently stubbed).

**Apps** (separate Next.js 16 / React 19 PWAs — App Router, Tailwind 4, Context+useState; both currently fail `next build` — fixing is Week 0):
- `driver/` — driver app: navigation view + insights (pumps / fuel / alerts).
- `shipper/` — shipper app: live-tracking map.

**Authoritative specs:** `docs/BIBLE.md §1` (product spec) and `docs/BIBLE.md §2` (how we build +
committed cuts — including the still-open 2026-07-12 escrow/RL scope-reversal note). These sections
win over ad-hoc narrative.

---

## How we work (operating model)

Locked 2026-07-04. Full detail in `docs/BIBLE.md §2`.

- **One target: a Completed Paid Trip.** Build **vertical slices** (one booking driven post → paid), not horizontal layers. **Definition of Done = demoable through the UI on the pilot corridor**, not "the endpoint returns 200".
- **Walking skeleton first.** Keep the thinnest end-to-end thread runnable (apps build, gateway routes to every service, a booking flows shipper → gateway → booking-service → DB → back) before deepening any feature.
- **Ruthless triage — committed cuts (OUT of MVP):** RL/LinUCB dynamic pricing, Razorpay escrow (cash-recorded/direct first), blockchain hash-anchor ledger, fleet reviews, detention, halt alerts, multi-pickup/drop, in-app turn-by-turn. **Never cut:** lifecycle closure, tracking map, POD-OTP, KYC gate. Fake non-load-bearing bits with Ops (e.g. manual KYC approval early).
- **Trunk-based + PR + green CI, production-ready only.** Short-lived `feat/*` branches → one PR → CI green → merge. **No stubs, TODOs, or `throw new Error('not implemented')` in `main`.**
- **First paid trip settles cash-recorded / direct**, not escrow.

---

## Maps & Tracking work — READ FIRST

Before touching **any** tracking/maps code:
1. Read `docs/BIBLE.md §3.1` (the CONTRACT) and `§3.2` (the append-only DECISIONS log, D-001..D-013).
2. **The CONTRACT (§3.1) is frozen and wins over the PLAN** (§3.4, `docs/MAPS_TRACKING_PLAN.md` — the
   one source doc that stayed a separate file) wherever they disagree.
3. Never silently fork a decision. To change anything, **append a new `D-xxx` decision** to `§3.2` —
   do not edit or contradict existing frozen ones.
4. Follow `docs/BIBLE.md §3.3`: the build runs **one phase per Claude session**, phases 0–6, strictly sequential. Phase 0 is a hard gate (GMP/GCP project, enable the 3 APIs, create the 2 restricted keys, set per-API quota caps) that must complete **before any map code**.

### Frozen facts (do not contradict)
- **Provider:** Google Maps Platform. Use **only** Routes API + Places API (New) + Maps JavaScript API. Legacy Directions API and legacy Places API are **BLOCKED** for new GCP projects — never reference them.
- **Navigation** is a **deep-link handoff** to the phone's Google Maps app (`https://www.google.com/maps/dir/` + `comgooglemaps://` on iOS). No in-app turn-by-turn. Same on web now and React Native later.
- **Ingestion stays in `bt-booking-service`.** `bt-tracking-service` does **not** do raw GPS ingestion — do not rebuild it. `bt-tracking-service` only READS `location_history` for the traveled-path/history view; the breadcrumb WRITE belongs to the ingestion path in `bt-booking-service`.
- **DB:** Supabase Postgres, **no PostGIS**. lat/lng are plain decimals. Migration 009 enables the `location_history` breadcrumb table (throttled ~1 point / 10–15s).
- **Polling:** keep 10s GPS polling for the pilot (no WebSocket push yet).
- **Cost control** = per-API quota limits + restricted keys. A billing budget only ALERTS, it does not cap. Pilot (~20 users) should fit Google's free monthly tiers.
- **Frontend:** use `@vis.gl/react-google-maps` for the React map layer. Per decision #8, **COPY** the `<LiveTrackMap/>` component into each app (`driver/` and `shipper/` are separate Next projects) — no shared npm package. Each app also gets a deep-link nav helper.

### Locked env-key names (use exactly these)
- `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` — HTTP-referrer-restricted, browser/client, Maps JS only.
- `GOOGLE_MAPS_SERVER_KEY` — secret, `bt-tracking-service` ONLY, for Routes API + Places API (New).
- `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` — vector Map ID for styled maps.
- `DIESEL_PRICE_INR=90` — default, editable diesel price (INR/litre).

### `bt-tracking-service` endpoints (snake_case JSON, `:bookingId` path param, namespaced `/api/tracking/...`)
- `GET  /health`
- `GET  /api/tracking/route/:bookingId` — cached base polyline (Routes **Essentials**, long Redis TTL).
- `GET  /api/tracking/eta/:bookingId` — live traffic ETA (Routes **TRAFFIC_AWARE / Pro**, short Redis TTL).
- `GET  /api/tracking/history/:bookingId` — traveled breadcrumb trail from `location_history`.
- `GET  /api/tracking/pumps/:bookingId` — top-**8** nearest petrol pumps (Places New; default limit 8).
- `GET  /api/tracking/fuel/:bookingId` — fuel estimate; accepts overrides. `fuel = distance_km / mileage_kmpl * diesel_price`; mileage prefilled by vehicle class (MCV/HCV).
- `GET  /api/tracking/alerts/:bookingId` — off-route (500 m) / idle (15 min) / near-drop (2 km) alerts; thresholds tunable after the first real drive.
- `GET  /api/tracking/track/:bookingId` — **[LOCKED #8]** shipper read-through aggregate: current location + route + live ETA + status in ONE call.

### Driver PWA runtime notes
- Add a minimal PWA manifest + service worker; use the **Screen Wake Lock API** to keep the driver's screen on during drives.
- Geolocation requires **HTTPS** (secure context) for phone testing.
- Test via real Android drives on the pilot corridor **and** a route-replay GPS simulator (replays a recorded path so movement is testable without driving).

---

## UI / Claude Browser verification — READ FIRST

Before doing any UI/QA pass on `shipper/`, `driver/`, or `bt-ops-web` in Claude Browser (or any
browser-automation tool): read **`docs/BIBLE.md §6`** first — URLs, demo logins, tool-specific
gotchas, and known-broken features are all there. It exists so you don't re-pay the token cost of
rediscovering how to test this app — login flow quirks, which backend 503s explain which UI symptoms,
and Claude-Browser-tool-specific gotchas are all already recorded there. **§6 is a living section — if
you learn something new while testing, you are expected to update it (or `§5.4` for a new/fixed bug)
before your session ends** (see `docs/BIBLE.md §0.2` for the exact rule). Default to testing against
the **live Cloud Run deployment**, not local dev — the whole stack is already up.

---

## Global conventions
- **Monorepo:** all code lives in this one repo; cross-service changes go in a single PR. Never push to the retired `Entropy-LLP/*` standalones or `deltaos1997/*` mirrors.
- **Trunk-based:** short-lived `feat/*` branches, PR + green CI before merge to `main`; keep `main` demoable; no stubs/TODOs left in `main`.
- **Trust order for build state:** frozen CONTRACT (`docs/BIBLE.md §3.1`) → code → `docs/BIBLE.md §5`. The per-service `README.md`/`API.md`/`ROADMAP.md` files were deleted on 2026-08-07 because they asserted behaviour the code contradicts; do not recreate them. A service folder gets a README only if it documents something the code cannot state itself (`bt-fleet-service/README.md` is the model), and the code still wins.
- **Auth/identity gotcha:** the JWT carries `users.id` as `userId`; `drivers.id` is a *separate* row (resolved via `getDriverByUserId`). `bookings.driver_id`, `quotes.driver_id`, and Redis `loc:*` keys reference `drivers.id`, **not** `users.id`.
- **Tracking endpoints:** snake_case JSON everywhere; namespaced under `/api/tracking/...`; `:bookingId` path param.
- **Do not rebuild GPS ingestion** in `bt-booking-service` — it already exists and stays there.
- **Maps:** only Routes API, Places API (New), Maps JavaScript API. No legacy Directions/Places APIs.
- **Env-key names are locked** — use the exact names above; never invent variants.
- New services follow the existing microservice recipe (folder layout, Fastify bootstrap, Dockerfile, GCP Cloud Run deploy) used by `bt-auth-service` / `bt-booking-service`.
- Per-app CLAUDE.md files (`driver/CLAUDE.md`, `shipper/CLAUDE.md`) add app-specific rules on top of this one.
- **Active `feat/*` branches get a task file** at `docs/tasks/<branch-name>.md` (see `docs/BIBLE.md §0.4`)
  — created when the branch starts, deleted on merge. Replaces tracking active work in ad-hoc tables
  inside a handoff doc.
