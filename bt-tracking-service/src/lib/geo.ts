// Spherical geometry for the tracking evaluator.
//
// NO PostGIS (D-007) — every distance in this service is computed here, in app code, from
// plain decimal lat/lng. That is a deliberate constraint, not a gap: the whole geometry
// surface is off-route distance, geofence containment and driven distance, all of which are
// a few dozen lines of haversine and none of which justify a spatial extension.
//
// Pure functions, no I/O, no Redis, no Supabase — this file is the one part of the service
// that is trivially unit-testable, and test/geo.test.mts pins it.

export type LatLng = { lat: number; lng: number }

const EARTH_RADIUS_M = 6_371_008.8 // IUGG mean radius
const DEG_TO_RAD = Math.PI / 180

/**
 * Great-circle distance in metres.
 *
 * Haversine rather than the cheaper equirectangular approximation because this is also the
 * function that sums DRIVEN distance across a 1400 km corridor: an approximation's error
 * compounds over ~7000 breadcrumbs, and driven-vs-planned distance is a number a fleet
 * owner may be billed on.
 */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * DEG_TO_RAD
  const dLng = (b.lng - a.lng) * DEG_TO_RAD
  const lat1 = a.lat * DEG_TO_RAD
  const lat2 = b.lat * DEG_TO_RAD

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Local flat-earth projection, metres, anchored at `origin`.
 *
 * Used ONLY for the point-to-segment maths below, where both operands are within a few km
 * of each other. At that scale the equirectangular error is far under a metre, and working
 * in a flat plane is what makes the perpendicular projection a two-line dot product instead
 * of spherical trigonometry.
 */
function project(p: LatLng, origin: LatLng): { x: number; y: number } {
  const cosLat = Math.cos(origin.lat * DEG_TO_RAD)
  return {
    x: (p.lng - origin.lng) * DEG_TO_RAD * cosLat * EARTH_RADIUS_M,
    y: (p.lat - origin.lat) * DEG_TO_RAD * EARTH_RADIUS_M,
  }
}

/** Perpendicular distance in metres from `p` to the segment `a`→`b` (clamped to the ends). */
export function pointToSegmentMeters(p: LatLng, a: LatLng, b: LatLng): number {
  const pp = project(p, p)
  const pa = project(a, p)
  const pb = project(b, p)

  const dx = pb.x - pa.x
  const dy = pb.y - pa.y
  const lenSq = dx * dx + dy * dy

  // Degenerate segment (duplicate points are common in encoded polylines).
  if (lenSq === 0) return Math.hypot(pp.x - pa.x, pp.y - pa.y)

  // Projection parameter, clamped so we measure to the segment and not its infinite line.
  let t = ((pp.x - pa.x) * dx + (pp.y - pa.y) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))

  return Math.hypot(pp.x - (pa.x + t * dx), pp.y - (pa.y + t * dy))
}

/**
 * Shortest distance in metres from `p` to a polyline.
 *
 * Full linear scan. A Mumbai-Delhi route decodes to a few thousand vertices and this runs
 * once per GPS fix (~1 per 12 s per truck), so an index would be complexity with no payoff
 * at pilot scale. If this ever shows up in a profile, the fix is to cache the nearest
 * segment index per booking and search a window around it — the truck moves monotonically
 * along the route, so the previous match is always a good starting guess.
 */
export function distanceToPolylineMeters(p: LatLng, path: readonly LatLng[]): number {
  if (path.length === 0) return Number.POSITIVE_INFINITY
  if (path.length === 1) return haversineMeters(p, path[0])

  let best = Number.POSITIVE_INFINITY
  for (let i = 1; i < path.length; i++) {
    const d = pointToSegmentMeters(p, path[i - 1], path[i])
    if (d < best) best = d
    // Nothing can beat being on the line.
    if (best === 0) break
  }
  return best
}

/** True when `p` lies within `radiusM` of `centre`. */
export function isInsideCircle(p: LatLng, centre: LatLng, radiusM: number): boolean {
  return haversineMeters(p, centre) <= radiusM
}

/**
 * Decode a Google encoded polyline into points.
 *
 * The server holds the encoded string (that is what the Routes API returns and what
 * trip_routes stores); the evaluator needs vertices. Implemented here rather than pulled in
 * as a dependency — it is the standard signed-varint scheme in ~20 lines, and a decoder is
 * exactly the kind of trivial package that becomes a supply-chain surface for no benefit.
 *
 * Returns [] for empty/malformed input rather than throwing: a missing route must degrade
 * the off-route check to "unknown", never fail a GPS ingest.
 */
export function decodePolyline(encoded: string): LatLng[] {
  if (!encoded) return []

  const points: LatLng[] = []
  let index = 0
  let lat = 0
  let lng = 0

  while (index < encoded.length) {
    let result = 0
    let shift = 0
    let byte: number

    do {
      byte = encoded.charCodeAt(index++) - 63
      if (byte < 0) return points // truncated input — keep what decoded cleanly
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20 && index < encoded.length)
    lat += result & 1 ? ~(result >> 1) : result >> 1

    result = 0
    shift = 0
    do {
      byte = encoded.charCodeAt(index++) - 63
      if (byte < 0) return points
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20 && index < encoded.length)
    lng += result & 1 ? ~(result >> 1) : result >> 1

    points.push({ lat: lat / 1e5, lng: lng / 1e5 })
  }

  return points
}

/**
 * Initial bearing in degrees (0-360, 0 = north) from `a` to `b`.
 *
 * Feeds the heading-rotated truck marker when a device reports position but no heading —
 * cheap Android GPS often omits it when stationary or moving slowly.
 */
export function bearingDegrees(a: LatLng, b: LatLng): number {
  const lat1 = a.lat * DEG_TO_RAD
  const lat2 = b.lat * DEG_TO_RAD
  const dLng = (b.lng - a.lng) * DEG_TO_RAD

  const y = Math.sin(dLng) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)

  return (Math.atan2(y, x) / DEG_TO_RAD + 360) % 360
}

/**
 * Whether an instant falls in the night-driving window, 22:00-06:00 **IST**.
 *
 * IST is fixed UTC+05:30 with no daylight saving, so the offset is a constant rather than a
 * timezone lookup. Hardcoded to IST because BharatTruck is an India-only marketplace — a
 * multi-country build would need the vehicle's local zone here instead.
 */
const IST_OFFSET_MINUTES = 5 * 60 + 30

export function isNightIST(at: Date): boolean {
  const istMinutes = (at.getUTCHours() * 60 + at.getUTCMinutes() + IST_OFFSET_MINUTES) % (24 * 60)
  const hour = Math.floor(istMinutes / 60)
  return hour >= 22 || hour < 6
}
