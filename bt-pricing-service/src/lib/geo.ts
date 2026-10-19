// -----------------------------------------------------------
// geo — self-contained great-circle (haversine) distance × a road-winding
// factor, used to derive distance_km for a price quote SERVER-SIDE from the
// booking's coords (never client-asserted).
//
// FROZEN maps rule: the Google Maps SERVER key lives ONLY in bt-tracking-service.
// bt-pricing-service MUST NOT call Google Routes/Places or use a maps key — so we
// approximate on-road km as straight-line km × ROAD_WINDING_FACTOR. Routes-API
// road distance (via bt-tracking-service) is a future accuracy upgrade.
// -----------------------------------------------------------

const EARTH_RADIUS_KM = 6371

// Straight-line km underestimates real road distance; ~1.3 is the widely-used
// detour/circuity factor for interstate road networks. Tunable after real drives.
export const ROAD_WINDING_FACTOR = 1.3

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180
}

// haversineKm — great-circle distance between two lat/lng points, in km.
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRadians(lat2 - lat1)
  const dLng = toRadians(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return EARTH_RADIUS_KM * c
}

// roadDistanceKm — approximate on-road km = great-circle × road-winding factor,
// rounded to 2 dp to match the price_quotes.distance_km column (numeric(10,2))
// so the stored distance is exactly the one fed into the cost math.
export function roadDistanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const km = haversineKm(lat1, lng1, lat2, lng2) * ROAD_WINDING_FACTOR
  return Math.round(km * 100) / 100
}
