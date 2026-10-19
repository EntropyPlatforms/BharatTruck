# BharatTruck — Maps & Tracking PLAN

> **Status: engineering narrative (living doc).**
> This PLAN is the deep, prose-level companion to `docs/BIBLE.md §3.1`.
> **The CONTRACT is the single source of truth.** On ANY conflict between something written here and the CONTRACT, **the CONTRACT wins** — this PLAN references it, elaborates on the *how* and *why*, and must never silently contradict a LOCKED fact.
> Decisions confirmed **2026-06-18**. Anything not locked that day is tagged inline **(INFERRED — confirm)** and must be pinned down (and the CONTRACT updated) before the relevant phase ships.
>
> Audience: the engineer (or Claude session) building one phase at a time. Read the CONTRACT first, then this, then start your phase.

---

## Table of contents

1. [Overview & goals](#1-overview--goals)
2. [Architecture](#2-architecture)
3. [Endpoint-by-endpoint design](#3-endpoint-by-endpoint-design)
4. [Migration 009 — `location_history`](#4-migration-009--location_history)
5. [Frontend — `<LiveTrackMap/>`, deep-link nav, shipper vs driver](#5-frontend)
6. [Google Maps Platform setup](#6-google-maps-platform-setup)
7. [Testing — GPS simulator + real drive tests](#7-testing)
8. [Phased roadmap (phases 0–6)](#8-phased-roadmap)
9. [React Native portability](#9-react-native-portability)
10. [Appendix — open INFERRED items to confirm](#10-appendix--inferred-items-to-confirm)

---

## 1. Overview & goals

### 1.1 The one sentence that matters

BharatTruck's MVP bar is a single proven loop: **one shipper → one driver → one tracked, proven, paid interstate trip** (North Star = Completed Paid Trips, deadline **31 Aug 2026**). "Tracked" is the word this feature is responsible for. Today we can *technically* follow a truck — the coordinates flow — but nobody can *see* it. This feature turns a stream of numbers into a moving truck on a map, with an ETA a shipper trusts and insights (fuel, pumps, alerts) a driver actually uses.

### 1.2 What is already working (do NOT rebuild)

Three things already exist and are load-bearing. The feature is designed *around* them, not on top of a rewrite.

**(a) 10-second GPS polling, end to end.**
The `driver/` PWA already captures the device position and pushes it, and both PWAs already poll live location every ~10s. In the driver client the push path is real code today:

```ts
// driver/src/lib/api.ts  (existing)
export function pushLocation(body: LocationUpdate) {
  return request(/* POST */ '/location/update', { method: 'POST', body: JSON.stringify(body) })
}
```

**(b) Raw GPS ingestion lives in `bt-booking-service`.**
`POST /location/update`, `GET /location/driver/:driver_id`, `GET /location/booking/:booking_id` are implemented and working (`bt-booking-service/src/routes/location.ts`). Ingestion writes a **30s-TTL** live-position record into Redis under the `loc:` namespace:

```ts
// bt-booking-service/src/lib/redis.ts  (existing)
export const LOCATION_TTL_SECONDS = 30
export const driverLocationKey = (driverId: string)  => `loc:driver:${driverId}`
export const bookingDriverKey  = (bookingId: string) => `loc:booking-driver:${bookingId}`
```

The write is authorization-aware (only the assigned driver may post; a shipper may only read a driver tied to one of their active bookings) and status-aware (tracking only for `accepted` / `in_transit`). That policy is the model `bt-tracking-service` mirrors.

**(c) The map-less status quo.** Both PWAs render `lat`/`lng` as **text**. The trip detail page shows "you are at 21.14, 79.08" — correct, useless. There is **no map library installed** in either app yet.

### 1.3 The gap this feature closes

| Missing piece | Delivered by |
|---|---|
| A visual map with a moving truck + route line | `<LiveTrackMap/>` (copied into each PWA), fed by the tracking service |
| A cached base route (origin→destination polyline) | `GET /api/tracking/route/:bookingId` (Routes API, Essentials tier) |
| A live, traffic-aware ETA | `GET /api/tracking/eta/:bookingId` (Routes API, TRAFFIC_AWARE/Pro) |
| A traveled breadcrumb trail (where the truck has been) | migration 009 `location_history` + `GET /api/tracking/history/:bookingId` |
| Nearest fuel stops for the driver | `GET /api/tracking/pumps/:bookingId` (Places API New) |
| Trip fuel-cost estimate | `GET /api/tracking/fuel/:bookingId` (arithmetic) |
| Off-route / idle / near-drop alerts | `GET /api/tracking/alerts/:bookingId` (geometry) |
| One-call shipper read-model | `GET /api/tracking/track/:bookingId` **[LOCKED #8]** |
| Turn-by-turn for the driver | **NOT built in-app** — deep-link handoff to the phone's Google Maps app |

### 1.4 Non-goals (explicitly out of scope)

- **No WebSocket / push transport.** Pilot stays on **10s HTTP polling** (Decision 5). We are not paying the complexity of a socket layer for ~20 users.
- **No in-app turn-by-turn navigation.** Navigation is a **deep-link handoff** to Google Maps (Decision 7 / §7.2 of the CONTRACT). Same behaviour on the web PWA now and React Native later.
- **No PostGIS.** `lat`/`lng` are plain decimals in Postgres (Supabase). All geometry math (off-route distance, near-drop) is done in TypeScript, not in the DB.
- **No shared npm package** for the map component. `<LiveTrackMap/>` is **COPIED** into `driver/` and `shipper/` (Decision 8), kept in sync by hand.
- **No re-ingestion of GPS.** `bt-tracking-service` never re-implements `POST /location/update`. It *reads* the live position that booking-service already caches.

### 1.5 Success criteria for the feature

1. A shipper opens a booking in transit and sees a truck marker moving along a route line, with a trustworthy "arrives ~8:59 PM" ETA that updates on the poll cadence.
2. A driver sees the same map plus a "Navigate" button that opens Google Maps to the drop, a fuel-cost estimate, the 8 nearest pumps, and an alert if they drift 500 m off route / idle 15 min / come within 2 km of the drop.
3. During a real drive on the pilot corridor (Bhiwandi → Narela used as the running example), the whole loop works over HTTPS on an Android phone.
4. Google spend for the pilot stays inside the **free monthly tiers** — verified by the per-API quota caps, not just a budget alert.

---

## 2. Architecture

### 2.1 Where `bt-tracking-service` sits

`bt-tracking-service` is a **new, thin, server-side Google Maps proxy with Redis caching**. It is a **derived/read-model** service: it owns no source-of-truth data. Every value it returns is derived from one of four upstreams — booking-service's live Redis position, the `location_history` table, the Google Routes/Places APIs, or arithmetic over the above — and it aggressively caches so the 10s poll storm never becomes a Google-call storm.

Service facts (from the CONTRACT §2, restated so this doc stands alone):

| Fact | Value |
|---|---|
| Name | `bt-tracking-service` |
| Runtime | Node.js **20** (`node:20-alpine`) |
| Framework | **Fastify 4** |
| Language | **TypeScript 5**, ESM (`"type":"module"`, NodeNext, `.js` import specifiers) |
| Port | **3006** |
| Deploy | GCP Cloud Run, `asia-south1`, multi-stage Dockerfile, `USER node` |
| Cache | Redis via `ioredis`, `trk:` key namespace |
| DB | Supabase JS (service-role), **read-only** on `location_history` |
| Auth | JWT gate, same `JWT_SECRET` as the other services |

It follows the **exact same recipe** as `bt-auth-service` / `bt-booking-service`, which we verified against the real code:

- Bootstrap = `cors({origin:true})` → unauth `/health` → auth-gated route group (`app.register(async (authed) => { authed.register(authPlugin); authed.register(routes,{prefix}) })`).
- `authPlugin` = `fastify-plugin`, `onRequest` hook, `Bearer` header, `jwt.verify(token, JWT_SECRET)`, decorates `req.user = { userId, role }`.
- Error shape = `{ success:false, error, code }`; success = `{ success:true, data }`.
- A `TrackingError` class mirrors `BookingError` (`message`, `code`, `httpStatus`).

### 2.2 The four upstreams and the ownership line

```
                        OWNED BY bt-booking-service (do NOT rebuild)
                        ┌─────────────────────────────────────────────┐
 driver phone GPS ──▶   │ POST /location/update                        │
 (every ~10s)           │  ├─ Redis SET loc:driver:{id}   EX 30  (live)│
                        │  ├─ Redis SET loc:booking-driver:{bid} EX 30 │
                        │  └─ throttled INSERT location_history (~1/10-15s)
                        └─────────────────────────────────────────────┘
                              │ Redis (loc:*)        │ Postgres
                              │ 30s TTL live pos      │ location_history (breadcrumbs)
                              ▼                        ▼
                        ┌─────────────────────────────────────────────┐
                        │   bt-tracking-service (READ-ONLY consumer)   │
                        │   server-side Google proxy + Redis cache     │
                        │   trk:* namespace                            │
                        └─────────────────────────────────────────────┘
                              │ Google Maps Platform (server key)
                              ▼
                        Routes API (route + ETA) · Places API New (pumps)
```

The **ownership line is the most important architectural fact**: booking-service *writes*, tracking-service *reads*. Two consequences:

1. **`bt-tracking-service` never writes `location_history` and never writes `loc:*`.** If it did, we'd have two writers racing on the same trip state.
2. The **breadcrumb WRITE** (the throttled `location_history` insert) belongs to booking-service's ingestion path. The CONTRACT locks *that booking-service owns the write*; the exact call-site / throttle mechanism inside booking-service is **(INFERRED — confirm)** and is a Phase-1 task (see §4.4 and §8).

### 2.3 End-to-end data flow (the full picture)

```
 ┌────────────┐   POST /location/update (10s)   ┌──────────────────────┐
 │  driver    │ ───────────────────────────────▶│  bt-booking-service  │
 │  PWA       │   {lat,lng,heading,speed,        │  (ingestion, EXISTING)│
 │            │    accuracy,booking_id}          │                      │
 └────────────┘                                  │  Redis  loc:* (30s)  │
       ▲   ▲                                     │  PG   location_history│
       │   │  GET /api/tracking/*  (nav view,    │        (throttled W) │
       │   │       pumps, fuel, alerts)          └───────────┬──────────┘
       │   │                                                 │ reads
       │   │                                                 ▼
 ┌─────┴───┴──┐  GET /api/tracking/track/:id     ┌──────────────────────┐
 │  shipper   │ ───────────────────────────────▶│  bt-tracking-service │
 │  PWA       │   (aggregate: loc+route+eta+     │  READ MODELS + CACHE │
 │ LiveTrack  │    status, every 10s)            │  trk:route  (24h)    │
 │   Map      │ ◀───────────────────────────────│  trk:eta    (60s)    │
 └────────────┘   snake_case JSON                │  trk:history(15s)    │
                                                 │  trk:pumps  (120s)   │
                                                 │  trk:fuel   (1h)     │
                                                 │  trk:alerts (30s)    │
                                                 │  trk:track  (10s)    │
                                                 └───┬──────────┬───────┘
                             live pos (server→server │          │ Google (server key)
                             or Redis loc:* read)     ▼          ▼
                                         ┌────────────────┐  ┌────────────────────┐
                                         │ booking-service│  │ Google Maps Platform│
                                         │ GET /location/ │  │ Routes API          │
                                         │   booking/:id  │  │ Places API (New)    │
                                         └────────────────┘  └────────────────────┘
```

All browser traffic goes through the existing **API gateway** (`NEXT_PUBLIC_API_URL`, default `http://localhost:8080` in dev; the GCP gateway in prod). `bt-tracking-service` is added as an upstream on that gateway under the `/api/tracking/*` prefix, exactly as booking-service is mounted under `/location` and `/bookings`. The browser never calls `bt-tracking-service` directly and never sees `GOOGLE_MAPS_SERVER_KEY`.

### 2.4 How tracking-service reads the live position (the one design choice to pin)

The live truck position is booking-service's 30s-TTL Redis record. `bt-tracking-service` needs it for `/eta`, `/pumps`, `/alerts`, and `/track`. Two options — the CONTRACT allows either and marks the choice **(INFERRED — confirm)**:

- **Option A — HTTP read-through (recommended default).** `bt-tracking-service` calls `GET {BOOKING_SERVICE_URL}/location/booking/:bookingId` server-to-server, forwarding a service JWT. Pros: respects booking-service's authorization + status gating for free, no shared-Redis coupling, clean service boundary. Cons: one extra hop.
- **Option B — direct Redis read** of the shared `loc:booking-driver:{bookingId}` → `loc:driver:{driverId}` keys. Pros: fastest, zero extra hop. Cons: couples the two services to one Redis instance and duplicates the key-shape knowledge.

**Recommendation: Option A for correctness and boundary hygiene**, wrapped in `src/lib/booking.ts` so switching to B later is a one-file change. `BOOKING_SERVICE_URL` defaults to `http://localhost:3002`. Because `/eta` is cached 60s and `/track` composes from cache, the extra hop happens at most ~once/minute per active booking, not once/poll.

### 2.5 Folder layout (mirrors the existing services)

```
bt-tracking-service/
├── Dockerfile                 # multi-stage: deps / development / builder / production
├── .env.example
├── package.json               # "type":"module"; dev(tsx watch)/build(tsc)/start(node dist/index.js)
├── tsconfig.json
└── src/
    ├── index.ts               # Fastify bootstrap
    ├── plugins/
    │   ├── auth.ts            # JWT gate (copy of booking-service authPlugin)
    │   └── redis.ts           # ioredis decorate + graceful close
    ├── lib/
    │   ├── google.ts         # Routes API + Places API (New) client
    │   ├── cache.ts          # trk: cache-key builders + TTL constants
    │   ├── supabase.ts       # service-role client (read location_history)
    │   ├── booking.ts        # live-position read-through (Option A)
    │   ├── geo.ts            # haversine + point-to-polyline distance + polyline decode
    │   └── types.ts          # snake_case DTOs + TrackingError
    └── routes/
        └── tracking.ts        # all /api/tracking/* routes (prefix /api/tracking)
```

### 2.6 `package.json` dependency set (matches the house recipe)

```jsonc
{
  "name": "bt-tracking-service",
  "type": "module",
  "scripts": {
    "dev":   "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@fastify/cors": "^9.0.1",
    "@supabase/supabase-js": "^2.43.4",
    "dotenv": "^16.4.5",
    "fastify": "^4.27.0",
    "fastify-plugin": "^5.0.1",
    "ioredis": "^5.3.2",
    "jsonwebtoken": "^9.0.2",
    "pino-pretty": "^11.0.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/jsonwebtoken": "^9.0.6",
    "@types/node": "^20.14.0",
    "tsx": "^4.15.1",
    "typescript": "^5.4.5"
  }
}
```

No Google SDK dependency — the Routes API and Places API (New) are plain REST/JSON over `fetch` (Node 20 has global `fetch`), which keeps the image small and avoids legacy-client packages that might reach for blocked legacy endpoints.

### 2.7 `src/index.ts` bootstrap (locked shape)

```ts
import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import authPlugin from './plugins/auth.js'
import redisPlugin from './plugins/redis.js'
import { trackingRoutes } from './routes/tracking.js'

const app = Fastify({
  logger: {
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
  },
})

async function bootstrap() {
  await app.register(cors, { origin: true })              // INFERRED — confirm origin policy

  app.get('/health', () => ({
    status: 'ok', service: 'bt-tracking-service', ts: new Date().toISOString(),
  }))

  await app.register(redisPlugin)                          // decorates app.redis

  await app.register(async (authed) => {
    await authed.register(authPlugin)                      // JWT gate
    await authed.register(trackingRoutes, { prefix: '/api/tracking' })
  })

  await app.listen({ port: Number(process.env.PORT ?? 3006), host: '0.0.0.0' })
}

bootstrap().catch((err) => { console.error(err); process.exit(1) })
```

### 2.8 Cache & TTL module (`src/lib/cache.ts`)

Central so every route and the aggregate agree on key shapes and TTLs. The `trk:` namespace parallels booking-service's `loc:`.

```ts
export const TTL = {
  route:   86_400, // 24h  (INFERRED — confirm)
  eta:     60,     // 60s  (INFERRED — confirm)
  history: 15,     // 15s  (INFERRED — confirm)
  pumps:   120,    // 120s (INFERRED — confirm)
  fuel:    3_600,  // 1h base (INFERRED — confirm; not cached when overrides present)
  alerts:  30,     // 30s  (INFERRED — confirm)
  track:   10,     // 10s  (INFERRED — confirm)
} as const

export const key = {
  route:   (b: string) => `trk:route:${b}`,
  eta:     (b: string) => `trk:eta:${b}`,
  history: (b: string) => `trk:history:${b}`,
  pumps:   (b: string) => `trk:pumps:${b}`,
  fuel:    (b: string) => `trk:fuel:${b}`,
  alerts:  (b: string) => `trk:alerts:${b}`,
  track:   (b: string) => `trk:track:${b}`,
}

/** read-through helper: return cached JSON or compute+cache. */
export async function cached<T>(
  redis: import('ioredis').Redis, k: string, ttl: number, compute: () => Promise<T>,
): Promise<T> {
  const hit = await redis.get(k)
  if (hit) return JSON.parse(hit) as T
  const val = await compute()
  await redis.set(k, JSON.stringify(val), 'EX', ttl)
  return val
}
```

The TTL numbers are the CONTRACT's inferred starting points. Only the **Essentials-vs-Pro tier split**, the **thresholds (500 m / 15 min / 2 km)**, the **top-8 pump default**, the **endpoint set/paths**, and the **snake_case + `:bookingId`** conventions are LOCKED — every TTL here is tunable and must be confirmed, not treated as frozen.

### 2.9 `TrackingError` (mirrors `BookingError`)

```ts
export type TrackingErrorCode =
  | 'VALIDATION_ERROR' | 'UNAUTHORIZED' | 'FORBIDDEN'
  | 'NOT_FOUND' | 'INVALID_TRANSITION' | 'UPSTREAM_ERROR'

export class TrackingError extends Error {
  constructor(
    message: string,
    public readonly code: TrackingErrorCode,
    public readonly httpStatus = 400,
  ) { super(message); this.name = 'TrackingError' }
}
```

A single `handleError(reply, err)` (copied from booking-service's `location.ts`) maps `TrackingError` → its `httpStatus`, and anything else → `500 { success:false, error:'Internal server error' }`.

---

## 3. Endpoint-by-endpoint design

Conventions for **every** route below (from CONTRACT §4/§8, restated): JSON is **snake_case**; path param is **`:bookingId`**; all `/api/tracking/*` are **JWT-gated** (`/health` open); success = `{ success:true, data }`; error = `{ success:false, error, code }`; live position is sourced from booking-service (never re-ingested); zod validates params/query.

A shared preamble runs on the booking-scoped routes:

```ts
const BookingIdParam = z.object({ bookingId: z.string().uuid() })

async function loadBookingOr404(bookingId: string) {
  const booking = await getBooking(bookingId)          // via lib/booking.ts / supabase
  if (!booking) throw new TrackingError(`Booking ${bookingId} not found`, 'NOT_FOUND', 404)
  return booking
}

// Authorization mirrors booking-service: shipper sees own bookings; driver sees assigned.
function assertCanView(user: { userId: string; role: string }, booking: Booking) {
  if (user.role === 'shipper' && booking.shipper_id !== user.userId)
    throw new TrackingError('Forbidden', 'FORBIDDEN', 403)
  // driver check resolves driver profile → booking.driver_id (as booking-service does)
}
```

### 3.0 `GET /health`

Unauthenticated Cloud Run liveness probe. No Google, no cache.

```json
{ "status": "ok", "service": "bt-tracking-service", "ts": "2026-07-04T09:30:00.000Z" }
```

### 3.1 `GET /api/tracking/route/:bookingId` — cached base route

**Purpose:** the stable origin→destination polyline drawn under the moving truck.
**Google:** Routes API `computeRoutes`, **Essentials / static tier**, `routingPreference: TRAFFIC_UNAWARE`. Traffic is deliberately not requested here (that's `/eta`).
**Cache:** `trk:route:{bookingId}`, **TTL 86400s (24h)** — the geometry is stable for a booking's fixed endpoints.

**Google request shape:**

```http
POST https://routes.googleapis.com/directions/v2:computeRoutes
X-Goog-Api-Key: {GOOGLE_MAPS_SERVER_KEY}
X-Goog-FieldMask: routes.polyline.encodedPolyline,routes.distanceMeters,routes.staticDuration
Content-Type: application/json
```
```json
{
  "origin":      { "location": { "latLng": { "latitude": 19.0760, "longitude": 72.8777 } } },
  "destination": { "location": { "latLng": { "latitude": 28.7041, "longitude": 77.1025 } } },
  "travelMode": "DRIVE",
  "routingPreference": "TRAFFIC_UNAWARE",
  "polylineEncoding": "ENCODED_POLYLINE"
}
```

The **field mask is mandatory** on Routes API and is also a cost lever — request only the three fields we render. Origin/destination come from the booking record (its pickup/drop lat/lng + addresses).

**Response 200:**

```json
{
  "success": true,
  "data": {
    "booking_id": "b1f2c3d4-0000-4000-8000-000000000001",
    "source": { "lat": 19.0760, "lng": 72.8777, "address": "Bhiwandi, Maharashtra" },
    "destination": { "lat": 28.7041, "lng": 77.1025, "address": "Narela, Delhi" },
    "polyline": "yx}mCwzr{Lg@...",
    "distance_km": 1412.6,
    "static_duration_seconds": 97200,
    "provider": "google_routes",
    "tier": "essentials",
    "cached_at": "2026-07-04T06:00:00.000Z"
  }
}
```

**Errors:** `404 NOT_FOUND` (unknown booking); `422/500 UPSTREAM_ERROR` if Google returns no route (e.g. bad coords) — surface a clean message, never the raw Google body.
**Notes:** the decoded polyline + `distance_km` are reused by `/fuel`, `/alerts`, and `/track`, so this is the cache other endpoints lean on.

### 3.2 `GET /api/tracking/eta/:bookingId` — live traffic ETA

**Purpose:** trustworthy "arrives ~X" from the truck's *current* position to the drop.
**Google:** Routes API `computeRoutes`, **TRAFFIC_AWARE / Pro tier** (Decision 1). Origin = live position; destination = booking drop.
**Cache:** `trk:eta:{bookingId}`, **TTL 60s** — refreshes near the 10s poll cadence without a Google call per poll (a fresh Google ETA at most ~once/min per active trip).

**Google request shape:**

```json
{
  "origin":      { "location": { "latLng": { "latitude": 21.1458, "longitude": 79.0882 } } },
  "destination": { "location": { "latLng": { "latitude": 28.7041, "longitude": 77.1025 } } },
  "travelMode": "DRIVE",
  "routingPreference": "TRAFFIC_AWARE",
  "departureTime": "2026-07-04T09:29:55Z"
}
```
Field mask: `routes.duration,routes.distanceMeters`. `routes.duration` (traffic-aware) vs `staticDuration` (free-flow) is exactly the Pro-vs-Essentials difference — `in_traffic` in our response is `duration > staticDuration` by a meaningful margin.

**Response 200:**

```json
{
  "success": true,
  "data": {
    "booking_id": "b1f2c3d4-0000-4000-8000-000000000001",
    "current_location": { "lat": 21.1458, "lng": 79.0882, "updated_at": "2026-07-04T09:29:50.000Z" },
    "destination": { "lat": 28.7041, "lng": 77.1025 },
    "eta_seconds": 41400,
    "eta_iso": "2026-07-04T20:59:50.000Z",
    "remaining_distance_km": 842.3,
    "in_traffic": true,
    "provider": "google_routes",
    "tier": "traffic_aware_pro",
    "computed_at": "2026-07-04T09:29:55.000Z"
  }
}
```

**No-live-position case** (driver offline / >30s TTL expired) — return success with `null` data, **do not** call Google:

```json
{ "success": true, "data": null, "message": "No recent driver location — ETA unavailable" }
```

`eta_iso` = `computed_at + eta_seconds`. Caching-with-`null`: cache the null result too (short) so an offline driver doesn't cause a Google call every poll.

### 3.3 `GET /api/tracking/history/:bookingId` — traveled breadcrumb trail

**Purpose:** the "where it's been" trail drawn behind the truck; also feeds `/alerts` idle detection.
**Google:** none (pure DB read from `location_history`).
**Cache:** `trk:history:{bookingId}`, **TTL 15s** (new breadcrumbs land ~every 10–15s).
**Query params (optional):** `since` (ISO-8601, return points ≥ this time), `limit` (INFERRED default **500**, max **2000**).

```ts
const HistoryQuery = z.object({
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
})
```

**Supabase read (read-only, ordered):**

```ts
let q = supabase.from('location_history')
  .select('lat,lng,heading,speed_kmh,recorded_at')
  .eq('booking_id', bookingId)
  .order('recorded_at', { ascending: true })
  .limit(limit)
if (since) q = q.gte('recorded_at', since)
const { data, error } = await q
```

**Response 200:**

```json
{
  "success": true,
  "data": {
    "booking_id": "b1f2c3d4-0000-4000-8000-000000000001",
    "point_count": 3,
    "points": [
      { "lat": 19.0760, "lng": 72.8777, "speed_kmh": 0,  "heading": 12, "recorded_at": "2026-07-04T06:00:05.000Z" },
      { "lat": 19.9975, "lng": 73.7898, "speed_kmh": 58, "heading": 41, "recorded_at": "2026-07-04T07:12:20.000Z" },
      { "lat": 21.1458, "lng": 79.0882, "speed_kmh": 62, "heading": 39, "recorded_at": "2026-07-04T09:29:50.000Z" }
    ]
  }
}
```

**Notes:** with `since`, the client fetches only the tail since its last point — cheap incremental polling. Because it's read-only, a missing/empty table yields `point_count: 0, points: []`, not an error.

### 3.4 `GET /api/tracking/pumps/:bookingId` — top-8 nearest petrol pumps

**Purpose:** driver insight — nearest fuel around the truck's live position (Decision 6).
**Google:** **Places API (New)** `places:searchNearby`, `includedTypes:["gas_station"]`, ranked by distance. **Legacy Places API is BLOCKED.**
**Cache:** `trk:pumps:{bookingId}`, **TTL 120s** (pumps change slowly but the anchor moves).
**Query params (optional):** `limit` default **8** (LOCKED default; cap 8 for pilot), `radius_m` default **5000**.

Anchor = the live position from booking-service. If no live position → `{ success:true, data:null, message:"No recent driver location — pump search unavailable" }` (no Google call).

**Google request shape:**

```http
POST https://places.googleapis.com/v1/places:searchNearby
X-Goog-Api-Key: {GOOGLE_MAPS_SERVER_KEY}
X-Goog-FieldMask: places.id,places.displayName,places.formattedAddress,places.location
```
```json
{
  "includedTypes": ["gas_station"],
  "maxResultCount": 8,
  "rankPreference": "DISTANCE",
  "locationRestriction": {
    "circle": {
      "center": { "latitude": 21.1458, "longitude": 79.0882 },
      "radius": 5000.0
    }
  }
}
```

`distance_m` is computed server-side (haversine from anchor to each `places.location`) — Places New returns place location but not distance in this shape. `brand` is a best-effort parse from the display name (INFERRED — confirm whether to keep or drop). Response mirrors CONTRACT §4.4 (place_id, name, lat, lng, distance_m, address, brand).

### 3.5 `GET /api/tracking/fuel/:bookingId` — fuel-cost estimate

**Purpose:** trip fuel cost (Decision 4). `fuel = distance_km / mileage_kmpl × diesel_price`.
**Google:** none (arithmetic over the cached route distance §3.1).
**Cache:** `trk:fuel:{bookingId}` **TTL 3600s** for the **base (no-override)** result only; **not cached when any override is present.**
**Query params (all optional overrides):** `vehicle_class` (`MCV` | `HCV`), `mileage_kmpl`, `diesel_price`, `distance_km`.

Prefilled mileage by class **(INFERRED — confirm exact kmpl):** `MCV ≈ 6.0`, `HCV ≈ 3.5`. Default `diesel_price` = `DIESEL_PRICE_INR` (default **90**). Default `distance_km` = the cached base route's `distance_km`.

```ts
const FuelQuery = z.object({
  vehicle_class: z.enum(['MCV', 'HCV']).optional(),
  mileage_kmpl:  z.coerce.number().positive().optional(),
  diesel_price:  z.coerce.number().positive().optional(),
  distance_km:   z.coerce.number().positive().optional(),
})
const CLASS_MILEAGE: Record<'MCV'|'HCV', number> = { MCV: 6.0, HCV: 3.5 } // INFERRED — confirm
```
```ts
const distance = q.distance_km ?? route.distance_km
const mileage  = q.mileage_kmpl ?? (q.vehicle_class ? CLASS_MILEAGE[q.vehicle_class] : CLASS_MILEAGE.HCV)
const diesel   = q.diesel_price ?? Number(process.env.DIESEL_PRICE_INR ?? 90)
const litres   = distance / mileage
const cost     = litres * diesel
const overridden = Boolean(q.mileage_kmpl || q.diesel_price || q.distance_km || q.vehicle_class)
```

**Response 200** (round `litres_required` and cost to 1 / 0 dp):

```json
{
  "success": true,
  "data": {
    "booking_id": "b1f2c3d4-0000-4000-8000-000000000001",
    "vehicle_class": "HCV",
    "distance_km": 1412.6,
    "mileage_kmpl": 3.5,
    "diesel_price_inr": 90,
    "litres_required": 403.6,
    "estimated_fuel_cost_inr": 36324,
    "inputs_overridden": false
  }
}
```

**Note:** the default class when none is supplied is **(INFERRED — confirm)** — HCV assumed here since interstate freight skews heavy. If the booking record carries a vehicle class, prefer it over the default.

### 3.6 `GET /api/tracking/alerts/:bookingId` — route alerts

**Purpose:** off-route / idle / near-drop flags (Decision 7).
**Google:** none (geometry over cached route §3.1 + live position + recent `location_history`).
**Cache:** `trk:alerts:{bookingId}`, **TTL 30s**.
**Thresholds (LOCKED, tunable after first real drive):** `off_route` > **500 m** from base polyline; `idle` no meaningful movement > **15 min**; `near_drop` within **2 km** of destination.

Computation (all in `src/lib/geo.ts`, no PostGIS):

- **off_route** — decode the cached polyline once, compute min perpendicular distance from the live point to the polyline segments (point-to-segment haversine). `active = value_m > 500`.
- **idle** — look at recent `location_history`: if the max pairwise displacement over the last window is under a small epsilon (e.g. < ~50 m, INFERRED — confirm), the truck hasn't meaningfully moved. `idle_seconds` = now − last movement. `active = idle_seconds > 900`.
- **near_drop** — haversine(live, destination). `active = distance_to_drop_m < 2000`.

**Response 200:**

```json
{
  "success": true,
  "data": {
    "booking_id": "b1f2c3d4-0000-4000-8000-000000000001",
    "evaluated_at": "2026-07-04T09:30:00.000Z",
    "current_location": { "lat": 21.1458, "lng": 79.0882, "updated_at": "2026-07-04T09:29:50.000Z" },
    "alerts": [
      { "type": "off_route", "active": false, "value_m": 120, "threshold_m": 500 },
      { "type": "idle",      "active": false, "idle_seconds": 45, "threshold_seconds": 900 },
      { "type": "near_drop", "active": false, "distance_to_drop_m": 842300, "threshold_m": 2000 }
    ]
  }
}
```

No live position → all three inactive with `null` measured values plus a `message`, no crash. Point-to-polyline is O(n) in polyline vertices; decode once and cache the decoded array in-process per request (or memoize on the `trk:route` value).

### 3.7 `GET /api/tracking/track/:bookingId` — **[LOCKED #8] shipper aggregate**

**Purpose:** the shipper read-through — current location + route + live ETA + status in **ONE** call. Identity, path, and role are **LOCKED**.
**Google:** aggregates §3.1 (Essentials) + §3.2 (Pro) but serves from the underlying caches so it does **not** multiply Google calls. This is the cost-critical endpoint: it is polled every 10s by every watching shipper.
**Cache:** own envelope `trk:track:{bookingId}` **TTL 10s** to match poll cadence, composed from `trk:route:*` + `trk:eta:*` + live position + booking status.

**Composition (read-through, never fresh Google on the hot path):**

```ts
const booking = await loadBookingOr404(bookingId)
assertCanView(req.user, booking)

const track = await cached(redis, key.track(bookingId), TTL.track, async () => {
  const [route, live] = await Promise.all([
    getRouteCached(bookingId),        // trk:route (24h) — computes once/day at most
    getLivePosition(bookingId),       // booking-service read-through
  ])
  const eta = live ? await getEtaCached(bookingId, live) : null  // trk:eta (60s)
  return {
    booking_id: bookingId,
    status: booking.status,
    current_location: live && {
      lat: live.lat, lng: live.lng, heading: live.heading,
      speed_kmh: live.speed_kmh, updated_at: live.updated_at,
    },
    route: route && {
      polyline: route.polyline, distance_km: route.distance_km,
      source: route.source, destination: route.destination,
    },
    eta: eta && {
      eta_seconds: eta.eta_seconds, eta_iso: eta.eta_iso,
      remaining_distance_km: eta.remaining_distance_km, in_traffic: eta.in_traffic,
    },
    served_at: new Date().toISOString(),
  }
})
```

**Response 200:** exactly the CONTRACT §4.7 envelope (`booking_id`, `status`, `current_location`, `route`, `eta`, `served_at`).
**No live position yet:** `current_location` and `eta` are `null`, `route` still populated, `status` reflects the booking (e.g. `"accepted"`). The cost math (§6.5) hinges on this endpoint serving from cache — a fresh Google call on every 10s `/track` poll would blow the free tier.

### 3.8 Endpoint summary

| # | Method | Path | Google API / tier | Cache key | TTL |
|---|---|---|---|---|---|
| — | GET | `/health` | none | — | — |
| 1 | GET | `/api/tracking/route/:bookingId` | Routes — Essentials/static | `trk:route:{id}` | 24h *(INF)* |
| 2 | GET | `/api/tracking/eta/:bookingId` | Routes — TRAFFIC_AWARE/Pro | `trk:eta:{id}` | 60s *(INF)* |
| 3 | GET | `/api/tracking/history/:bookingId` | none (DB) | `trk:history:{id}` | 15s *(INF)* |
| 4 | GET | `/api/tracking/pumps/:bookingId` | Places New — searchNearby | `trk:pumps:{id}` | 120s *(INF)* |
| 5 | GET | `/api/tracking/fuel/:bookingId` | none (arithmetic) | `trk:fuel:{id}` | 1h base *(INF)* |
| 6 | GET | `/api/tracking/alerts/:bookingId` | none (geometry) | `trk:alerts:{id}` | 30s *(INF)* |
| 8 | GET | `/api/tracking/track/:bookingId` | Routes (composed, cached) | `trk:track:{id}` | 10s *(INF)* |

Only the tier split, the 500 m / 15 min / 2 km thresholds, the top-8 default, the endpoint set/paths, endpoint #8's identity, and the `:bookingId` + snake_case conventions are **LOCKED**. Every TTL/limit tagged *(INF)* is a starting point to confirm.

### 3.9 Error handling summary

Reuse the house codes: `VALIDATION_ERROR` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `INVALID_TRANSITION` (409), plus a tracking-specific `UPSTREAM_ERROR` (502/500) when Google or booking-service fails, and the catch-all `500 { success:false, error:"Internal server error" }`. Google/upstream failures must **never** leak the raw provider body — log it at `error`, return a clean message. Zod parse failures return `400 VALIDATION_ERROR` with the first message, exactly as booking-service does today.

---

## 4. Migration 009 — `location_history`

Migration **009 ENABLES** a new dense-breadcrumb table in Supabase Postgres. **No PostGIS** — `lat`/`lng` are plain decimals. The existing `trip_events` table keeps its coarse lat/lng audit trail; `location_history` is the *dense* movement breadcrumb, throttled to **~1 point / 10–15s** (Decision 2). Breadcrumb **WRITE belongs to `bt-booking-service`** ingestion; `bt-tracking-service` is **read-only**.

### 4.1 SQL

```sql
-- migration 009: location_history (dense GPS breadcrumbs)
-- No PostGIS. lat/lng are plain decimals. Read-only for bt-tracking-service.

create table if not exists public.location_history (
  id           bigint generated always as identity primary key,
  booking_id   uuid        not null references public.bookings(id) on delete cascade,
  driver_id    uuid        not null references public.drivers(id)  on delete cascade,
  lat          double precision not null check (lat between -90  and 90),
  lng          double precision not null check (lng between -180 and 180),
  heading      double precision     null check (heading is null or (heading >= 0 and heading <= 360)),
  speed_kmh    double precision     null check (speed_kmh is null or speed_kmh >= 0),
  accuracy_m   double precision     null check (accuracy_m is null or accuracy_m >= 0),
  recorded_at  timestamptz not null,                 -- device/ingest capture time (ordering + `since`)
  created_at   timestamptz not null default now()    -- row insert time
);

-- Primary read pattern: /history?since=... ordered by recorded_at for one booking.
create index if not exists location_history_booking_recorded_idx
  on public.location_history (booking_id, recorded_at desc);

-- Idle detection & latest-point lookups by driver.
create index if not exists location_history_driver_recorded_idx
  on public.location_history (driver_id, recorded_at desc);

comment on table public.location_history is
  'Dense GPS breadcrumbs (~1 point / 10-15s). WRITE owner = bt-booking-service ingestion; READ-only for bt-tracking-service.';
```

**(INFERRED — confirm all of the following against the real migration 009 when it lands):** exact column names/types, `bigint identity` vs `uuid` PK, whether `accuracy_m` is kept, `on delete cascade`, and the exact index list. The *ownership* (booking-service writes, tracking-service reads) is LOCKED; the column/index shape is INFERRED.

### 4.2 Row Level Security

The service-role key bypasses RLS, so `bt-tracking-service` reads regardless. If any anon/authenticated client ever touches this table directly (it should not — all reads go through the service), add a policy. For the pilot, keep it service-role-only:

```sql
alter table public.location_history enable row level security;
-- No public policies: only service-role (bt-booking-service write, bt-tracking-service read) may access.
```

### 4.3 Retention

Breadcrumbs are dense: a 20-hour interstate drive at ~1 point/12s ≈ 6,000 rows/trip. For ~20 pilot users this is trivial, but note a retention lever for later — e.g. drop breadcrumbs for `completed` bookings older than N days, or archive to cold storage. Not needed for the pilot; flagged so it isn't forgotten.

### 4.4 The throttled WRITE (booking-service side — Phase 1 task)

The insert lives in booking-service's ingestion path, **not** here. The design (**INFERRED — confirm** the exact mechanism):

- On `POST /location/update` with a `booking_id` in `accepted`/`in_transit`, after the existing Redis writes, decide whether to also persist a breadcrumb.
- **Throttle** to ~1 point / 10–15s. Since GPS already posts every ~10s, the simplest throttle is a per-booking Redis "last breadcrumb at" marker with a short TTL:

```ts
// inside bt-booking-service POST /location/update, AFTER the loc:* pipeline (illustrative)
if (booking_id) {
  const gateKey = `loc:bc-gate:${booking_id}`
  const fresh = await redis.set(gateKey, '1', 'EX', 12, 'NX')  // ~12s throttle window
  if (fresh === 'OK') {
    await supabase.from('location_history').insert({
      booking_id, driver_id: driverId, lat, lng,
      heading: heading ?? null, speed_kmh: speed_kmh ?? null,
      accuracy_m: accuracy_m ?? null, recorded_at: now,
    })
  }
}
```

`SET NX EX 12` is an atomic throttle gate: the first update in each ~12s window wins the insert, the rest are Redis-only. This keeps breadcrumb density at the target without a cron. The 12s window and the "insert only for `accepted`/`in_transit`" rule are **(INFERRED — confirm)**. `bt-tracking-service` code must not contain this insert.

---

## 5. Frontend

Two separate Next.js 16 / React 19 App-Router PWAs (`driver/`, `shipper/`), Tailwind 4, Context+useState. **No map library is installed yet** — this feature adds `@vis.gl/react-google-maps`. Per Decision 8 there is **no shared npm package**: `<LiveTrackMap/>` is **COPIED** into each app and kept in sync by hand.

### 5.1 Install (per app)

```bash
# in driver/ and again in shipper/
npm i @vis.gl/react-google-maps
```

Env (both apps; naming LOCKED):

```
NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY=...   # HTTP-referrer restricted, Maps JS only
NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID=...        # vector Map ID for styled maps
NEXT_PUBLIC_API_URL=http://localhost:8080 # existing gateway; /api/tracking/* proxied here
```

`GOOGLE_MAPS_SERVER_KEY` **never** appears in a `NEXT_PUBLIC_` var — it lives only in `bt-tracking-service`.

### 5.2 `<LiveTrackMap/>` props (CONTRACT §7.1)

```ts
type LatLng = { lat: number; lng: number }

interface LiveTrackMapProps {
  bookingId: string
  currentLocation: (LatLng & {
    heading?: number | null
    speed_kmh?: number | null
    updated_at?: string
  }) | null
  routePolyline?: string | null          // Google encoded polyline
  source?: LatLng | null
  destination?: LatLng | null
  historyPath?: LatLng[]                  // from /history, drawn behind the truck
  etaSeconds?: number | null
  mapId: string                           // NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID
  apiKey: string                          // NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY
  follow?: boolean                        // default: follow the truck
  height?: string | number                // default 100%
  onMarkerClick?: () => void
}
```
Prop names are **(INFERRED — confirm)**; only "component is `@vis.gl/react-google-maps`-based, copied per app, consumes the locked endpoints and locked env keys" is frozen.

### 5.3 `<LiveTrackMap/>` skeleton

```tsx
'use client'
import { useMemo } from 'react'
import {
  APIProvider, Map, AdvancedMarker, Pin, useMap,
} from '@vis.gl/react-google-maps'

// Decode a Google encoded polyline → LatLng[] (no extra dep; ~40 lines).
function decodePolyline(encoded: string): LatLng[] { /* standard algorithm */ return [] }

function RouteLayer({ path, color, weight }: { path: LatLng[]; color: string; weight: number }) {
  const map = useMap()
  useMemo(() => {
    if (!map || path.length < 2) return
    const line = new google.maps.Polyline({
      path, geodesic: true, strokeColor: color, strokeWeight: weight, map,
    })
    return () => line.setMap(null)
  }, [map, path, color, weight])
  return null
}

export function LiveTrackMap({
  currentLocation, routePolyline, source, destination, historyPath,
  etaSeconds, mapId, apiKey, follow = true, height = '100%', onMarkerClick,
}: LiveTrackMapProps) {
  const routePath   = useMemo(() => routePolyline ? decodePolyline(routePolyline) : [], [routePolyline])
  const center      = currentLocation ?? source ?? { lat: 20.5937, lng: 78.9629 } // India centroid fallback
  const etaLabel    = etaSeconds != null ? formatEta(etaSeconds) : null

  return (
    <div style={{ height, position: 'relative' }}>
      <APIProvider apiKey={apiKey}>
        <Map
          mapId={mapId}
          defaultCenter={center}
          defaultZoom={7}
          gestureHandling="greedy"
          disableDefaultUI={false}
        >
          {/* base route (grey) then traveled trail (accent) drawn on top */}
          <RouteLayer path={routePath}   color="#9ca3af" weight={5} />
          {historyPath && historyPath.length > 1 &&
            <RouteLayer path={historyPath} color="#2563eb" weight={5} />}

          {source &&      <AdvancedMarker position={source}><Pin background="#16a34a" /></AdvancedMarker>}
          {destination && <AdvancedMarker position={destination}><Pin background="#dc2626" /></AdvancedMarker>}
          {currentLocation &&
            <AdvancedMarker position={currentLocation} onClick={onMarkerClick}>
              <TruckMarker heading={currentLocation.heading ?? 0} />
            </AdvancedMarker>}

          {follow && currentLocation && <FollowCamera target={currentLocation} />}
        </Map>
      </APIProvider>
      {etaLabel && <div className="absolute bottom-4 left-4 rounded-xl bg-white/95 px-4 py-2 shadow">
        Arrives ~{etaLabel}
      </div>}
    </div>
  )
}
```

`AdvancedMarker` requires a `mapId` (vector map) — hence `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` is mandatory, not cosmetic. `TruckMarker` rotates a truck glyph by `heading`. `FollowCamera` uses `useMap()` to `panTo` the truck when `follow` is on. `decodePolyline` is inlined (~40 lines) so we don't add a dependency just to render the line.

### 5.4 The data hook (per app)

Both apps poll every 10s (Decision 5) through the existing gateway client, reusing the `request()` helper in `src/lib/api.ts`:

```ts
// shipper/src/lib/tracking.ts (and copied to driver/)
export function fetchTrack(bookingId: string) {
  return request<TrackAggregate>(`/api/tracking/track/${bookingId}`, { method: 'GET' })
}

export function useTrack(bookingId: string) {
  const [data, setData] = useState<TrackAggregate | null>(null)
  useEffect(() => {
    let alive = true
    const tick = async () => { try { const r = await fetchTrack(bookingId); if (alive) setData(r) } catch {} }
    tick()
    const id = setInterval(tick, 10_000)   // 10s poll — matches Decision 5
    return () => { alive = false; clearInterval(id) }
  }, [bookingId])
  return data
}
```

The **shipper** binds the aggregate straight into the map:

```tsx
const t = useTrack(bookingId)
<LiveTrackMap
  bookingId={bookingId}
  currentLocation={t?.current_location ?? null}
  routePolyline={t?.route?.polyline ?? null}
  source={t?.route?.source} destination={t?.route?.destination}
  etaSeconds={t?.eta?.eta_seconds ?? null}
  mapId={process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID!}
  apiKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY!}
  follow
/>
```

### 5.5 Deep-link navigation helper (CONTRACT §7.2)

Navigation is a **deep-link handoff to the phone's Google Maps app** — **NOT** in-app turn-by-turn. Same behaviour on web PWA now and React Native later. Locked URL bases: `https://www.google.com/maps/dir/` (universal) and `comgooglemaps://` (iOS).

```ts
// driver/src/lib/nav.ts (copied per app if shipper ever needs it)
type LatLng = { lat: number; lng: number }

export function buildNavDeepLink(args: {
  destination: LatLng
  origin?: LatLng           // omit → Google uses the phone's current location
  travelMode?: 'driving'    // pilot = driving
}): string {
  const { destination, origin, travelMode = 'driving' } = args
  const dest = `${destination.lat},${destination.lng}`
  const isIOS = typeof navigator !== 'undefined' && /iP(hone|ad|od)/.test(navigator.userAgent)

  if (isIOS) {
    // comgooglemaps:// — opens the Google Maps app on iOS; falls back to https if absent.
    const p = new URLSearchParams({ daddr: dest, directionsmode: travelMode })
    if (origin) p.set('saddr', `${origin.lat},${origin.lng}`)
    return `comgooglemaps://?${p.toString()}`
  }
  // Universal URL — Android opens the app, desktop opens the web.
  const p = new URLSearchParams({ api: '1', destination: dest, travelmode: travelMode })
  if (origin) p.set('origin', `${origin.lat},${origin.lng}`)
  return `https://www.google.com/maps/dir/?${p.toString()}`
}
```

Wire-up (driver nav view):

```tsx
<button onClick={() => {
  const url = buildNavDeepLink({ destination: t!.route!.destination! })
  window.open(url, '_blank')  // on iOS, retry with the https URL if the app scheme fails
}}>Navigate</button>
```

Do **not** build a custom in-app navigator — that's an explicit non-goal.

### 5.6 Shipper live map vs driver nav view

| | shipper/ | driver/ |
|---|---|---|
| Primary source | `GET /api/tracking/track/:bookingId` (one call) | `track` + `/pumps` + `/fuel` + `/alerts` |
| Map role | **watch** — moving truck + route + ETA overlay | **navigate + insights** — same map plus tools |
| Extra UI | ETA card | "Navigate" (deep-link) button, fuel-cost card, pumps list, alert banners |
| Wake Lock | no | **yes** — Screen Wake Lock while driving |
| Deep-link nav | no | yes |

Driver insights panel (below/beside the map):

```tsx
const alerts = usePoll(`/api/tracking/alerts/${bookingId}`, 30_000)
const pumps  = usePoll(`/api/tracking/pumps/${bookingId}`, 120_000)
const fuel   = useOnce(`/api/tracking/fuel/${bookingId}?vehicle_class=HCV`)
// render: active alerts as banners, top-8 pumps as a list, fuel-cost summary card
```

### 5.7 PWA basics + Screen Wake Lock (Decision 3)

Add a **minimal PWA manifest + service worker now**, and use the **Screen Wake Lock API** to keep the driver's screen on during a drive.

```json
// driver/public/manifest.webmanifest (minimal)
{
  "name": "BharatTruck Driver", "short_name": "BT Driver",
  "start_url": "/", "display": "standalone",
  "background_color": "#ffffff", "theme_color": "#111827",
  "icons": [{ "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
            { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }]
}
```
```ts
// driver/src/lib/wakelock.ts
export async function keepScreenAwake(): Promise<() => void> {
  if (!('wakeLock' in navigator)) return () => {}
  let sentinel: WakeLockSentinel | null = null
  const acquire = async () => { try { sentinel = await (navigator as any).wakeLock.request('screen') } catch {} }
  await acquire()
  const onVis = () => { if (document.visibilityState === 'visible' && !sentinel) acquire() }
  document.addEventListener('visibilitychange', onVis)         // re-acquire after tab-switch/lock
  return () => { document.removeEventListener('visibilitychange', onVis); sentinel?.release(); sentinel = null }
}
```

Acquire the lock when the driver enters the active-trip screen, release on exit. Re-acquire on `visibilitychange` because the OS drops the sentinel when the tab backgrounds. Wake Lock requires a **secure context (HTTPS)** — same requirement as Geolocation (§7).

### 5.8 The "copy per app" rule

`<LiveTrackMap/>`, `decodePolyline`, `buildNavDeepLink`, and the tracking hooks are **duplicated** in `driver/src/components|lib` and `shipper/src/components|lib`. Keep them byte-identical where shared; when one changes, port the diff to the other in the same PR. A short `// SYNC: keep in sync with <other app> — Decision 8` header comment on each copied file makes the rule self-documenting. Do **not** extract an npm package — that's an explicit LOCKED non-goal.

---

## 6. Google Maps Platform setup

Provider is **LOCKED to Google Maps Platform**. Exactly **three** APIs are enabled; everything else is out of contract. This whole section is **Phase 0** and is a **hard gate before any map code** (CONTRACT §6.5).

### 6.1 Enable exactly three APIs

| API | Side | Used for |
|---|---|---|
| **Maps JavaScript API** | Browser (`NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY`) | render the vector map in `<LiveTrackMap/>` |
| **Routes API** | Server (`GOOGLE_MAPS_SERVER_KEY`) | `/route` (Essentials/static) + `/eta` (TRAFFIC_AWARE/Pro) |
| **Places API (New)** | Server (`GOOGLE_MAPS_SERVER_KEY`) | `/pumps` — `searchNearby`, `gas_station` |

```bash
gcloud services enable \
  maps-backend.googleapis.com \       # Maps JavaScript API
  routes.googleapis.com \             # Routes API
  places.googleapis.com \            # Places API (New)
  --project bharattruck-maps
```

### 6.2 BLOCKED — never reference

- **Legacy Directions API** — blocked for new GCP projects. Use **Routes API**.
- **Legacy Places API** — blocked for new GCP projects. Use **Places API (New)**.
- Any Google Maps API not in §6.1.

The server client (`src/lib/google.ts`) must hit only `routes.googleapis.com` and `places.googleapis.com/v1/...` — no `maps.googleapis.com/maps/api/directions` or `.../place` legacy paths.

### 6.3 Two physically separate restricted keys

Cost control = **restricted keys + per-API quota caps** (Decision). Two keys, never interchanged:

1. **`NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY`** — Application restriction: **HTTP referrers**, allow-listing the PWA origins (`https://driver.bharattruck.*/*`, `https://shipper.bharattruck.*/*`, and dev origins). API restriction: **Maps JavaScript API only**. Safe to ship to the browser.
2. **`GOOGLE_MAPS_SERVER_KEY`** — **secret**, lives only in `bt-tracking-service` (Cloud Run secret / env). Application restriction: **none needed** (server-side; ideally IP-restrict to Cloud Run egress if practical). API restriction: **Routes API + Places API (New) only**.

**Never** put the server key behind a `NEXT_PUBLIC_` prefix.

### 6.4 Per-API quota caps (the actual spend ceiling)

A **billing budget only ALERTS — it does NOT cap spend.** The hard cap is the **per-API quota limit** (APIs & Services → Quotas → set requests/min or requests/day per API). Set conservative caps sized to the pilot so a bug/loop can't run up a bill:

- **Routes API** — cap requests/day well above expected (see §6.5) but far below anything scary (e.g. a few thousand/day for the pilot).
- **Places API (New)** — cap requests/day similarly (pumps polled 120s only when a driver views the panel).
- **Maps JS API** — cap map loads/day.

Also keep a **budget alert** as a secondary tripwire (email at 50/90/100% of a small monthly figure), understanding it does not stop calls.

### 6.5 Free-tier math for a ~20-user pilot

The whole caching design exists to keep Google call volume inside the free monthly tiers. Worst-case sizing with ~20 users and, say, up to **5 concurrent active trips**, each watched by a shipper + driver polling every 10s:

- **`/track` polling:** 5 trips × (1 shipper + 1 driver) × 6 polls/min = 60 `/track` req/min hitting *our* service. But `/track` serves from `trk:track` (10s) and composes from `trk:route` (24h) + `trk:eta` (60s) — so **Google** calls are bounded by the caches, not the poll rate.
  - **Routes ETA (Pro):** at TTL 60s, ≤ **1 Google ETA call/min per active trip** = ≤ 5/min = ≤ **~7,200/day** worst case, realistically far less (trips aren't 24h × 5 all day). Sized to fit the free tier for a pilot.
  - **Routes base route (Essentials):** TTL 24h → **~1 call per booking per day**. For a pilot handful of trips/day this is a few dozen calls total.
  - **Places (pumps):** only when a driver opens the pumps panel, TTL 120s → ≤ 30 calls/hour per active driver viewing it. Negligible.
  - **Maps JS loads:** one map init per screen open; a pilot's worth of opens is well inside the free map-load tier.

**Conclusion:** with the §4 TTLs, the dominant cost driver is the traffic-aware ETA, capped at ~1 Google call/min/active-trip by the 60s cache. For ~20 users / a few concurrent trips this sits comfortably inside Google's free monthly tiers. The per-API quota cap is the hard backstop; the budget alert is the tripwire. If real usage climbs, the first lever is lengthening `trk:eta` TTL, not adding capacity.

### 6.6 Phase-0 gate checklist (must be green before any map code)

1. ☐ GMP/GCP project created (`bharattruck-maps` or agreed name).
2. ☐ The **3 APIs** enabled (Maps JS, Routes, Places New) — and *only* those.
3. ☐ **Browser key** created, HTTP-referrer restricted, Maps-JS-only.
4. ☐ **Server key** created, secret, Routes+Places-New-restricted, stored as a Cloud Run secret.
5. ☐ **Per-API quota caps** set on all three.
6. ☐ Budget alert configured (secondary).
7. ☐ Keys placed: browser key + Map ID in both PWA envs; server key in `bt-tracking-service` only.

---

## 7. Testing

Two testing modes (CONTRACT §6.5): a **route-replay GPS simulator** (movement testable without driving) and **real Android drive tests** on the pilot corridor. **Geolocation requires HTTPS (secure context)** for phone testing.

### 7.1 Route-replay GPS simulator

**Goal:** exercise the whole loop (ingest → Redis + breadcrumbs → tracking read-models → map) by replaying a recorded path, so the truck "moves" on a laptop without anyone driving.

**Design:** a small Node script that takes a recorded path (an array of `{lat,lng,heading,speed_kmh,recorded_at}`, e.g. sampled from a previous drive or hand-drawn along the Bhiwandi→Narela route) and replays it by POSTing to booking-service's real `POST /location/update` on a cadence — driving the *exact same* ingestion path production uses.

```ts
// scripts/gps-replay.ts  (dev-only harness; lives under bt-tracking-service or a tools/ dir)
import fs from 'node:fs'

const GATEWAY = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080'
const TOKEN   = process.env.DRIVER_JWT!            // a driver JWT for the seeded pilot booking
const BOOKING = process.env.BOOKING_ID!
const path = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) as Array<{
  lat: number; lng: number; heading?: number; speed_kmh?: number
}>

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

for (const p of path) {
  await fetch(`${GATEWAY}/location/update`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ ...p, booking_id: BOOKING }),
  })
  await sleep(10_000)   // 10s cadence — matches production polling & the breadcrumb throttle
}
```

**What it proves:**
- Redis `loc:*` live position updates (30s TTL) → `/eta`, `/pumps`, `/alerts`, `/track` all see a moving truck.
- The **breadcrumb throttle** persists ~1 point/10–15s → `/history` returns a growing trail.
- `/alerts`: feed a path that leaves the route to fire `off_route`; a stationary stretch to fire `idle` after 15 min (or temporarily lower the threshold for the test); a path that ends near the drop to fire `near_drop`.
- The shipper `<LiveTrackMap/>` renders a marker crawling along the polyline with a live ETA.

**Speed knob:** add a `SPEED=10` env to divide the sleep (replay 10× faster) for quick iteration — but run at least one pass at the real 10s cadence to validate throttle timing.

### 7.2 Real Android drive test (pilot corridor)

**Corridor:** the pilot interstate lane (Bhiwandi, Maharashtra → Narela, Delhi as the running example). Goal: prove the loop on a real phone, real GPS, real traffic, over HTTPS.

**HTTPS is mandatory** — the browser Geolocation API and Screen Wake Lock only work in a **secure context**. On a phone that means the PWA must be served over `https://` (not `http://<lan-ip>`). Options for the drive test:
- Deploy the PWAs to their real HTTPS hosts (or a preview URL) and point them at the deployed gateway + `bt-tracking-service`.
- Or tunnel local dev over HTTPS (e.g. an ngrok/Cloudflared HTTPS tunnel) so the phone hits a valid cert — still exercising local services.

**Procedure:**
1. Seed a real pilot booking (`accepted`/`in_transit`) with a real driver + shipper account.
2. Driver phone: open `driver/` PWA over HTTPS, grant Location, start the trip → the app begins its 10s `POST /location/update`. Confirm the Wake Lock keeps the screen on.
3. Driver taps **Navigate** → confirm the deep-link opens the **Google Maps app** to the drop (Android universal URL; iOS `comgooglemaps://`).
4. Shipper phone (or laptop): open the booking → confirm the truck marker moves, the route line shows, and the ETA updates and is *plausible vs traffic*.
5. Drive a stretch off the planned route → confirm `off_route` fires (>500 m). Park 15 min → confirm `idle`. Approach the drop → confirm `near_drop` within 2 km.
6. After the drive, `/history` returns the full breadcrumb trail; the traveled line matches reality.

**Instrumentation:** watch `bt-tracking-service` logs (pino) for cache hit/miss and Google call counts; verify against §6.5 that Google calls stayed at ~1 ETA/min/trip. Record the actual path so it becomes a **replay fixture** for the simulator (§7.1) — real drives feed the regression harness.

**Threshold tuning:** the 500 m / 15 min / 2 km thresholds are LOCKED *but tunable after the first real drive*. Capture false-positive/negative alerts on this drive and record any proposed change as a `D-xxx` decision before altering the CONTRACT.

### 7.3 Service-level tests (no phone)

- **Unit:** `geo.ts` (haversine, point-to-polyline, polyline decode) against known fixtures; `fuel` arithmetic (HCV 1412.6 km / 3.5 kmpl × 90 = ₹36,324 — matches the CONTRACT example); `buildNavDeepLink` output for iOS vs universal.
- **Cache:** hit `/track` twice inside 10s → second serve is a cache hit, zero Google calls (assert via a mocked google client call-count).
- **Auth:** `/api/tracking/*` without a Bearer token → 401; a shipper requesting another shipper's booking → 403; unknown booking → 404.
- **No-live-position:** with an empty `loc:*`, `/eta`, `/pumps`, `/track` return the documented `null` shapes and make **zero** Google calls.

---

## 8. Phased roadmap

The build runs **one phase per Claude session, phases 0–6, strictly sequential.** Each session: read the CONTRACT, read this PLAN, do exactly one phase, leave the tree green. A phase must not start until the prior phase's exit criteria are met.

### Phase 0 — GMP/GCP gate (no map code)

**Do:** everything in §6.6 — create the project, enable the 3 APIs, create the 2 restricted keys, set per-API quota caps + budget alert, distribute keys (browser+MapID to both PWAs, server key to `bt-tracking-service` secret).
**Exit:** §6.6 checklist all green; a `curl` to Routes API with the server key returns a route; a trivial Maps JS page with the browser key renders a map from an allow-listed origin. **No application code yet.**

### Phase 1 — data layer: migration 009 + breadcrumb write

**Do:** apply migration 009 (`location_history`, §4.1) to Supabase; add the **throttled breadcrumb INSERT** to `bt-booking-service` ingestion (§4.4, the `SET NX EX 12` gate). Confirm the INFERRED column/index shape and the throttle window; update the CONTRACT for anything pinned.
**Exit:** the GPS simulator (§7.1) against booking-service writes ~1 breadcrumb/12s; a direct `select` shows a growing trail. `bt-tracking-service` still doesn't exist.

### Phase 2 — `bt-tracking-service` skeleton + read endpoints (no Google)

**Do:** scaffold the service per §2.5–§2.9 (Dockerfile, package.json, tsconfig, bootstrap, auth plugin copy, redis plugin, supabase lib, booking read-through lib, cache lib, geo lib, TrackingError). Implement the **no-Google** endpoints first: `/health`, `/history` (DB), `/fuel` (arithmetic), and `/alerts` (geometry — needs a route, so stub route distance until Phase 3 or gate `off_route` behind a present polyline).
**Exit:** `/health` green; `/history` returns simulator breadcrumbs; `/fuel` matches the CONTRACT example; all routes JWT-gated; error shapes match booking-service.

### Phase 3 — Google Routes: `/route` + `/eta`

**Do:** implement `src/lib/google.ts` (Routes `computeRoutes`, field masks); `/route` (Essentials, `trk:route` 24h) and `/eta` (TRAFFIC_AWARE/Pro, `trk:eta` 60s, no-live-position `null` case). Wire `/alerts` `off_route` to the real cached polyline now that it exists.
**Exit:** `/route` returns a real polyline + distance for the pilot booking; `/eta` returns a plausible traffic ETA from a simulator position; cache-miss makes one Google call, cache-hit makes zero.

### Phase 4 — Places pumps + aggregate #8

**Do:** implement Places New `searchNearby` in `google.ts`; `/pumps` (top-8, `trk:pumps` 120s, no-position `null` case); then the **LOCKED #8** `/track` aggregate (§3.7) composing route+eta+live+status from the caches, `trk:track` 10s.
**Exit:** `/pumps` returns 8 ranked stations near a simulator position; `/track` returns the full CONTRACT §4.7 envelope and, verified by mock call-count, issues **zero** fresh Google calls on a warm cache during 10s polling.

### Phase 5 — frontend: `<LiveTrackMap/>` (shipper) + driver nav view

**Do:** install `@vis.gl/react-google-maps` in both apps; build `<LiveTrackMap/>` + `decodePolyline` + hooks; **shipper** live map bound to `/track`; **driver** nav view + insights (pumps/fuel/alerts) + `buildNavDeepLink` button; add PWA manifest + service worker + Screen Wake Lock (driver). Copy the shared files per app (Decision 8) with the `// SYNC` header.
**Exit:** with the simulator running, the shipper sees a moving truck + route + live ETA; the driver sees the same plus a working Google-Maps deep-link, fuel card, pumps list, and alert banners; Wake Lock holds the driver screen.

### Phase 6 — real drive test + tuning + deploy

**Do:** deploy `bt-tracking-service` to Cloud Run (`asia-south1`) and mount `/api/tracking/*` on the gateway; run the **real Android drive test** (§7.2) over HTTPS on the pilot corridor; capture the drive as a replay fixture; tune thresholds/TTLs based on real data (record `D-xxx` for any LOCKED-threshold change); confirm Google spend matched §6.5.
**Exit:** one shipper → one driver → one tracked, proven, paid interstate trip, with the map, ETA, and insights working end-to-end on real phones — the North-Star loop, tracked.

### Phase → CONTRACT mapping

| Phase | CONTRACT sections exercised |
|---|---|
| 0 | §3 (env keys), §6 (GMP setup, Phase-0 gate) |
| 1 | §5 (`location_history`, write ownership) |
| 2 | §2 (service facts/layout), §4.3/§4.5/§4.6, §8 (error/success shapes) |
| 3 | §4.1, §4.2, §6.1 (Routes) |
| 4 | §4.4 (Places), §4.7 (#8 LOCKED) |
| 5 | §7 (frontend, deep-link, PWA/Wake Lock), Decision 8 |
| 6 | §6.4–§6.5 (cost), §6.5 testing, §8 change control |

---

## 9. React Native portability

`driver/` and `shipper/` are Next.js PWAs today; the CONTRACT anticipates a later React Native move. Two design choices are deliberately portable, and the service layer is untouched by the move.

### 9.1 What carries over unchanged

- **The entire `bt-tracking-service` and all 8 endpoints.** They're transport-agnostic HTTP + snake_case JSON. RN clients call the same gateway routes with the same `Bearer` JWT. **Zero** server change for RN.
- **The deep-link nav model.** Navigation is *already* a handoff to the phone's Google Maps app — "same behaviour on the web PWA now and React Native later" is a locked design point. `buildNavDeepLink` returns a URL string; on web you `window.open`, on RN you `Linking.openURL`. The **iOS `comgooglemaps://`** and **universal `https://www.google.com/maps/dir/`** bases are exactly what RN's `Linking` wants — the helper is portable as-is:

```ts
// RN wire-up — same buildNavDeepLink(), different opener
import { Linking } from 'react-native'
const url = buildNavDeepLink({ destination })
const ok = await Linking.canOpenURL(url)          // comgooglemaps:// on iOS
await Linking.openURL(ok ? url : httpsFallback)   // fall back to the universal URL
```

- **The 10s polling contract.** No socket layer to port; RN polls the same `/track` on the same cadence.

### 9.2 What swaps at the platform boundary

- **Geolocation source.** On web it's `navigator.geolocation.watchPosition`; on RN it's a native geolocation module (e.g. `react-native-geolocation-service`) or Capacitor's Geolocation (the memory notes a **Capacitor escape hatch** for background GPS). The *shape* posted to `POST /location/update` (`{lat,lng,heading,speed_kmh,accuracy_m,booking_id}`) is identical — only the capture API changes. Keep GPS capture behind a thin `getPosition()` / `watchPosition()` interface in `lib/` so the swap is one file.
- **The map renderer.** `@vis.gl/react-google-maps` is web-only. On RN the map layer swaps to `react-native-maps` (Google provider) or the Maps SDK for iOS/Android. `<LiveTrackMap/>`'s **props stay the same** (`currentLocation`, `routePolyline`, `source`, `destination`, `etaSeconds`, …) — only the JSX body is re-implemented. Because the component is **copied per app** (Decision 8, not a shared package), the RN rewrite is a per-app swap with no cross-package coupling.
- **Wake Lock.** Web Screen Wake Lock API → RN `KeepAwake` (or Capacitor). Same lifecycle (acquire on trip screen, release on exit).
- **Secure context / HTTPS.** RN native apps don't need the HTTPS-for-Geolocation rule (that's a browser secure-context constraint), but they still call the HTTPS gateway. The drive-test HTTPS requirement is a web-PWA concern that simply disappears on native.

### 9.3 Portability guardrails to keep now

1. Keep GPS capture and `Linking`/`window.open` behind thin interfaces (`lib/geo-capture.ts`, `lib/nav.ts`) so RN swaps a file, not a call-site graph.
2. Keep `<LiveTrackMap/>` props platform-neutral (plain data: LatLng, polyline string, seconds) — never leak a `google.maps.*` object across the prop boundary.
3. Never move the server key or any Google server call into the client — the RN client, like the PWA, only ever holds the referrer/bundle-restricted **browser** key and talks to `bt-tracking-service` for everything server-side. This keeps the RN migration a pure client concern.

---

## 10. Appendix — INFERRED items to confirm

These are **not frozen.** Each must be pinned during its phase; pinning one updates the CONTRACT (a change to a LOCKED item instead needs a `D-xxx`).

| # | Item | Where | Proposed value |
|---|---|---|---|
| I-1 | All numeric TTLs (`trk:*`) | §2.8, §3.8 | route 24h / eta 60s / history 15s / pumps 120s / fuel 1h / alerts 30s / track 10s |
| I-2 | Live-position read: HTTP read-through vs direct Redis | §2.4 | **Option A** (HTTP read-through via `BOOKING_SERVICE_URL`) |
| I-3 | `location_history` exact columns / PK type / indexes | §4.1 | `bigint identity` PK, `double precision` lat/lng, `(booking_id, recorded_at desc)` idx |
| I-4 | Breadcrumb throttle mechanism + window | §4.4 | Redis `SET NX EX 12` gate in booking-service ingestion |
| I-5 | Prefilled mileage per class | §3.5 | MCV ≈ 6.0, HCV ≈ 3.5 kmpl |
| I-6 | Default vehicle class when none given | §3.5 | HCV (or from booking record if present) |
| I-7 | `/history` default/max `limit` | §3.3 | default 500, max 2000 |
| I-8 | `/pumps` default `radius_m` and 8-cap | §3.4 | radius 5000 m; cap 8 for pilot |
| I-9 | `idle` movement epsilon | §3.6 | < ~50 m over the window = "not moving" |
| I-10 | CORS `origin` policy | §2.7 | `origin: true` (match existing services) — confirm tighten for prod |
| I-11 | `pumps.brand` parse — keep or drop | §3.4 | best-effort from display name |
| I-12 | `location_history` retention | §4.3 | none for pilot; revisit post-pilot |

**LOCKED (do not touch without a `D-xxx`):** the endpoint set/paths, endpoint #8's identity, snake_case + `:bookingId`, the env-key names, provider/API choice (Routes + Places New + Maps JS; legacy blocked), the deep-link nav model, the 500 m / 15 min / 2 km thresholds, the top-8 pump default, the Essentials-vs-Pro tier split, write-owner = booking-service, and "copy `<LiveTrackMap/>` per app."

---

*End of PLAN. The CONTRACT (`docs/BIBLE.md §3.1`) wins on any interface conflict.*
