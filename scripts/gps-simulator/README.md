# Route-replay GPS simulator (T-115)

Replays a recorded lat/lng path by POSTing to the driver **location-ingestion** endpoint as a demo
driver, ~1 point / interval — so live tracking (the shipper map, ETA, breadcrumb trail) can be
exercised **without a real drive**.

It talks the exact same contract the driver PWA uses (verified against
`bt-booking-service/src/routes/location.ts`, `bt-gateway/nginx.conf`, `driver/src/lib/api.ts`):

```
POST {api}/api/location/update
Authorization: Bearer <driver access_token>
Content-Type: application/json
body: { lat, lng, heading?, speed_kmh?, accuracy_m?, booking_id? }   # snake_case
```

The server derives `drivers.id` from the token (`getDriverByUserId`). The token's user **must be the
driver assigned to `booking_id`**, and the booking **must be `accepted` or `in_transit`** — otherwise
the service returns 403/409 (the tool prints it). Requires **Node 20+** (uses global `fetch`, no deps).

## Quick start

```bash
cd scripts/gps-simulator

# A) with an existing driver access_token
node replay.mjs \
  --api https://bt-gateway-...-el.a.run.app \
  --booking <booking-uuid-in-accepted-or-in_transit> \
  --token <driver-access-token> \
  --interval 10

# B) fetch the token from driver credentials (posts to /api/auth/email/login)
node replay.mjs --api <gateway-url> --booking <uuid> \
  --login-email driver@example.com --login-password '••••••' --interval 10

# C) offline sanity check — no backend needed, prints each payload it WOULD send
node replay.mjs --booking 00000000-0000-4000-8000-000000000000 --dry-run --interval 1
```

## Options (all have env fallbacks)

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--booking` | `BT_BOOKING_ID` | — (required) | Trip to bind updates to; without it the shipper map won't move |
| `--path` | `BT_PATH_FILE` | `./sample-path.json` | JSON path: `[[lat,lng],…]`, `[{lat,lng,heading?,speed_kmh?},…]`, or `{points:[…]}` |
| `--interval` | `BT_INTERVAL` | `10` | Seconds between points (pilot cadence) |
| `--api` | `NEXT_PUBLIC_API_URL` / `BT_API_BASE` | `http://localhost:8080` | Gateway base URL |
| `--token` | `BT_DRIVER_TOKEN` | — | Driver access_token (Bearer) |
| `--login-email` / `--login-password` | `BT_DRIVER_EMAIL` / `BT_DRIVER_PASSWORD` | — | Fetch a token instead of passing one; auto-refreshes on 401 |
| `--loop` | — | off | Repeat the path forever (else stop at the end) |
| `--dry-run` | — | off | Print payloads without sending (no token/backend needed) |
| `--accuracy` | — | `8` | `accuracy_m` reported per point |

`heading` and `speed_kmh` are **auto-derived** (bearing + haversine distance / interval) for any point
that doesn't specify them, so the map marker rotates and shows a realistic speed.

## Verifying end-to-end (moves the truck on the shipper map)

1. Have an `accepted`/`in_transit` booking with a known driver assigned (the demo driver).
2. Get that driver's token (option A/B).
3. Run the simulator; open the shipper app tracking view for that booking.
4. The truck marker advances one point per interval; `/api/tracking/track/:bookingId` (ETA + polyline)
   and the `location_history` breadcrumb trail update as it moves.

`sample-path.json` is a ~24-point NE segment on the Bhiwandi pilot corridor (~72 km/h at 10s). Swap in
a real recorded path for a specific corridor.
