/**
 * Maps helpers for the shipper live-tracking view.
 *
 * Per the FROZEN Maps & Tracking contract (docs/BIBLE.md §3.1):
 *  - Provider is Google Maps Platform; the browser layer uses
 *    `@vis.gl/react-google-maps` + the Maps JavaScript API only.
 *  - Env-key names are locked — use exactly these, and only the public
 *    browser key / map id are allowed behind `NEXT_PUBLIC_`. The secret
 *    server key (`GOOGLE_MAPS_SERVER_KEY`) lives in bt-tracking-service ONLY
 *    and must never appear in app code.
 *  - Per decision #8 this module is COPIED into each app (driver/, shipper/),
 *    not shared as a package.
 */

export interface LatLng {
  lat: number
  lng: number
}

/** Geographic viewport of a route (matches the tracking-service `bounds`). */
export interface MapBounds {
  ne_lat: number
  ne_lng: number
  sw_lat: number
  sw_lng: number
}

/** HTTP-referrer-restricted browser key for the Maps JavaScript API. */
export const GOOGLE_MAPS_BROWSER_KEY =
  process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY ?? ''

/** Vector Map ID for styled maps (advanced markers need this). */
export const GOOGLE_MAPS_MAP_ID =
  process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID ?? ''

/**
 * Decode a Google "encoded polyline algorithm format" string into points.
 * Standard precision-5 encoding, matching what the Routes API returns via
 * `ENCODED_POLYLINE`. Reference:
 * https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
export function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = []
  let index = 0
  let lat = 0
  let lng = 0
  const len = encoded.length

  while (index < len) {
    let result = 0
    let shift = 0
    let b: number
    do {
      b = encoded.charCodeAt(index++) - 63
      result |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 0x20)
    const dlat = result & 1 ? ~(result >> 1) : result >> 1
    lat += dlat

    result = 0
    shift = 0
    do {
      b = encoded.charCodeAt(index++) - 63
      result |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 0x20)
    const dlng = result & 1 ? ~(result >> 1) : result >> 1
    lng += dlng

    points.push({ lat: lat / 1e5, lng: lng / 1e5 })
  }

  return points
}

/**
 * The light, quiet basemap used by the preview maps (RouteMap): pale land, white roads,
 * highways tinted the brand marigold, no POIs or transit, so our route and pins read
 * first. Classic JSON styling applies only to maps created WITHOUT a mapId — the live
 * tracking maps keep the cloud-styled vector map.
 */
export const LIGHT_MAP_STYLE: google.maps.MapTypeStyle[] = [
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { elementType: 'geometry', stylers: [{ color: '#f3f5f8' }] },
  { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: '#eef2ec' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#cddff3' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
  { featureType: 'road.highway', elementType: 'geometry.fill', stylers: [{ color: '#fde9b8' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#f3c463' }] },
  { featureType: 'administrative.province', elementType: 'geometry.stroke', stylers: [{ color: '#b9c3d1' }, { weight: 1 }] },
  { featureType: 'administrative.country', elementType: 'geometry.stroke', stylers: [{ color: '#94a0b0' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#5b6676' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#ffffff' }, { weight: 3 }] },
  { featureType: 'road', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
]

/** LIGHT_MAP_STYLE's night twin, for the dark theme: deep navy land, dim roads, amber highways. */
export const DARK_MAP_STYLE: google.maps.MapTypeStyle[] = [
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { elementType: 'geometry', stylers: [{ color: '#151b25' }] },
  { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: '#18212a' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0b1a2e' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2a3342' }] },
  { featureType: 'road.highway', elementType: 'geometry.fill', stylers: [{ color: '#5a4416' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#3a2d12' }] },
  { featureType: 'administrative.province', elementType: 'geometry.stroke', stylers: [{ color: '#384354' }, { weight: 1 }] },
  { featureType: 'administrative.country', elementType: 'geometry.stroke', stylers: [{ color: '#6f7b8c' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#b4becc' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0c1017' }, { weight: 3 }] },
  { featureType: 'road', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
]

/** True when both coordinates are real numbers (a null slipping past the type would map to 0,0). */
export function isLatLng(p: { lat: unknown; lng: unknown } | null | undefined): p is LatLng {
  return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng)
}

/** The point a fraction `t` of the way along a path, by distance (flat approximation). */
export function pointAlong(path: LatLng[], t: number): LatLng | null {
  if (path.length === 0) return null
  if (path.length === 1) return path[0]
  const seg = path.slice(1).map((p, i) => Math.hypot(p.lat - path[i].lat, p.lng - path[i].lng))
  let left = seg.reduce((a, b) => a + b, 0) * Math.min(1, Math.max(0, t))
  for (let i = 0; i < seg.length; i++) {
    if (left <= seg[i]) return lerp(path[i], path[i + 1], seg[i] ? left / seg[i] : 0)
    left -= seg[i]
  }
  return path[path.length - 1]
}

/** Linear interpolation between two points; `t` in [0, 1]. */
export function lerp(a: LatLng, b: LatLng, t: number): LatLng {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t
  return {
    lat: a.lat + (b.lat - a.lat) * clamped,
    lng: a.lng + (b.lng - a.lng) * clamped,
  }
}

/**
 * Navigation deep-link handoff to the phone's Google Maps app (the drive surface's
 * Navigate button). FROZEN Maps contract: navigation is a deep-link handoff — NO
 * in-app turn-by-turn, NO backend (docs/BIBLE.md §3.1, Maps D-004). Copied from
 * driver/src/lib/nav.ts.
 *
 * We return the universal `https://www.google.com/maps/dir/?api=1` link as the single
 * reliable target: it opens the Google Maps app when installed and otherwise falls back
 * to web Google Maps / Apple Maps. We deliberately do NOT emit a bare `comgooglemaps://`
 * link on iOS — that scheme silently dead-ends when Google Maps isn't installed, and we
 * don't implement a real https fallback for it. The universal link already deep-links
 * into the app when present, so a driver without the app still lands somewhere usable.
 * Destination-only lets Google Maps use the device's live location as the start point.
 */
export function buildNavDeepLink({
  destination,
  origin,
}: {
  destination: LatLng
  origin?: LatLng
}): string {
  const dest = `${destination.lat},${destination.lng}`
  let url = `https://www.google.com/maps/dir/?api=1&destination=${dest}`
  if (origin) url += `&origin=${origin.lat},${origin.lng}`
  return url
}
