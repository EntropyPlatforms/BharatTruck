import { Redis } from 'ioredis'
import { positiveIntEnv } from './env.js'

const url = process.env.REDIS_URL
if (!url) throw new Error('REDIS_URL must be set')

export const redis = new Redis(url, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
})

// ── READ-ONLY keys owned by bt-booking-service (GPS ingestion) ──────────────
// NEVER write these from this service (contract §4, decision D-010).
export const driverLocationKey = (driverId: string) => `loc:driver:${driverId}`
export const bookingDriverKey = (bookingId: string) => `loc:booking-driver:${bookingId}`

// ── WRITE keys — bt-tracking-service namespace (trk:*) ──────────────────────
export const routeKey = (bookingId: string) => `trk:route:${bookingId}`
// Point-to-point (pre-booking) route cache, keyed by coords rounded to ~110m so repeat price
// quotes on the same lane collapse to one cache hit (D-14 / pricing-engine P1).
export const pointRouteKey = (sLat: number, sLng: number, dLat: number, dLng: number) =>
  `trk:route-pt:${sLat.toFixed(3)},${sLng.toFixed(3)}:${dLat.toFixed(3)},${dLng.toFixed(3)}`
export const etaKey = (bookingId: string) => `trk:eta:${bookingId}`
export const pumpsKey = (bookingId: string) => `trk:pumps:${bookingId}`
export const lockKey = (key: string) => `trk:lock:${key}`
export const historyKey = (bookingId: string) => `trk:history:${bookingId}`
export const fleetOverviewKey = (fleetOwnerId: string) => `trk:fleet:${fleetOwnerId}`
/**
 * Which geofences the truck is currently INSIDE, for one booking.
 *
 * A pure cache — the durable answer is derivable from geofence_events (an 'enter' with no
 * later 'exit'), and the evaluator rebuilds from there on a miss. Redis only saves that
 * rebuild query on the hot path.
 */
export const fenceStateKey = (bookingId: string) => `trk:fence:${bookingId}`

// ── Geocoding (D-020) ────────────────────────────────────────────────────────
// Autocomplete keyed by the normalised query so the same typed prefix across users is one
// Google call; place details keyed by the stable place id.
export const placeAutocompleteKey = (q: string) => `trk:ac:${q.trim().toLowerCase()}`
export const placeDetailsKey = (placeId: string) => `trk:place:${placeId}`
// Reverse geocode (pin -> pincode/state), keyed by coords rounded to ~11m (4 dp) so a dragged
// pin nudged a few metres reuses the same cached postal area instead of billing a new call.
export const reverseGeocodeKey = (lat: number, lng: number) =>
  `trk:revgeo:${lat.toFixed(4)},${lng.toFixed(4)}`

export const ROUTE_TTL_SECONDS = positiveIntEnv('ROUTE_CACHE_TTL_SECONDS', 21600) // 6h
export const ETA_TTL_SECONDS = 45
export const PUMPS_TTL_SECONDS = 21600
export const LOCK_TTL_SECONDS = 10
/** §3.1 §4 pins /history at 15s; breadcrumbs land ~1/12s so a shorter TTL buys nothing. */
export const HISTORY_TTL_SECONDS = 15
/**
 * The fleet board polls every 10s per open dashboard. 8s keeps two owners' tabs from
 * multiplying the query load while staying inside one poll interval, so the board never
 * shows a position older than one tick beyond the GPS TTL itself.
 */
export const FLEET_OVERVIEW_TTL_SECONDS = 8
/** Longer than any realistic single trip — the state is deleted on trip end, not expiry. */
export const FENCE_STATE_TTL_SECONDS = 7 * 24 * 3600

// Autocomplete predictions for a query prefix are stable for minutes; 1h keeps the Google
// call count low without serving stale suggestions. A resolved place (lat/lng/pincode/state)
// effectively never changes, so it is cached for a month.
export const AUTOCOMPLETE_TTL_SECONDS = 3600
export const PLACE_DETAILS_TTL_SECONDS = 30 * 24 * 3600
// A coordinate's postal area is effectively static, so cache a reverse result for a month too.
export const REVERSE_GEOCODE_TTL_SECONDS = 30 * 24 * 3600
