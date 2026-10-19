// Server-side Google Routes API client. Uses GOOGLE_MAPS_SERVER_KEY (secret).
// Field masks are MANDATORY (Routes API rejects calls without them and they cap
// cost). Route polyline uses staticDuration (Essentials); ETA uses TRAFFIC_AWARE
// (Pro) per decision D-003.

import { TrackingError, type Bounds, type LatLng } from './types.js'
import { gstStateCode } from '@bharattruck/shared/india-states'

const KEY = process.env.GOOGLE_MAPS_SERVER_KEY
if (!KEY) throw new Error('GOOGLE_MAPS_SERVER_KEY must be set')

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes'
// Places API (NEW). The legacy /maps/api/place/* endpoints are BLOCKED for new GCP projects
// and are never referenced here (D-003).
const PLACES_NEARBY_URL = 'https://places.googleapis.com/v1/places:searchNearby'
const PLACES_AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete'
const PLACE_DETAILS_URL = 'https://places.googleapis.com/v1/places' // + /{placeId}

function waypoint(p: LatLng) {
  return { location: { latLng: { latitude: p.lat, longitude: p.lng } } }
}

/** Routes API durations are strings like "1234s". */
function parseDurationSeconds(d?: string): number {
  if (!d) return 0
  return Math.round(parseFloat(d.replace('s', '')))
}

async function callRoutes(body: unknown, fieldMask: string): Promise<any> {
  let res: Response
  try {
    res = await fetch(ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': KEY!,
        'X-Goog-FieldMask': fieldMask,
      },
      body: JSON.stringify(body),
    })
  } catch (e) {
    throw new TrackingError(`Routes API unreachable: ${(e as Error).message}`, 'UPSTREAM_ERROR', 502)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new TrackingError(`Routes API error ${res.status}: ${text.slice(0, 200)}`, 'UPSTREAM_ERROR', 502)
  }
  return res.json()
}

export interface ComputedRoute {
  polyline: string
  distance_m: number
  static_duration_s: number
  bounds: Bounds
}

/** Cached route polyline (Essentials, traffic-unaware static duration). */
export async function computeRoute(origin: LatLng, dest: LatLng): Promise<ComputedRoute> {
  const json = await callRoutes(
    {
      origin: waypoint(origin),
      destination: waypoint(dest),
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_UNAWARE',
      polylineEncoding: 'ENCODED_POLYLINE',
    },
    'routes.polyline.encodedPolyline,routes.distanceMeters,routes.staticDuration,routes.viewport',
  )

  const r = json.routes?.[0]
  if (!r) throw new TrackingError('No route found between pickup and drop', 'NOT_FOUND', 404)

  const vp = r.viewport ?? {}
  return {
    polyline: r.polyline?.encodedPolyline ?? '',
    distance_m: r.distanceMeters ?? 0,
    static_duration_s: parseDurationSeconds(r.staticDuration),
    bounds: {
      ne_lat: vp.high?.latitude ?? Math.max(origin.lat, dest.lat),
      ne_lng: vp.high?.longitude ?? Math.max(origin.lng, dest.lng),
      sw_lat: vp.low?.latitude ?? Math.min(origin.lat, dest.lat),
      sw_lng: vp.low?.longitude ?? Math.min(origin.lng, dest.lng),
    },
  }
}

export interface ComputedEta {
  eta_s: number
  remaining_m: number
  traffic: 'light' | 'moderate' | 'heavy' | 'unknown'
}

/** Live ETA from a point to the destination (Pro, traffic-aware). */
export async function computeEta(from: LatLng, dest: LatLng): Promise<ComputedEta> {
  const json = await callRoutes(
    {
      origin: waypoint(from),
      destination: waypoint(dest),
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
    },
    'routes.duration,routes.staticDuration,routes.distanceMeters',
  )

  const r = json.routes?.[0]
  if (!r) throw new TrackingError('No route found to destination', 'NOT_FOUND', 404)

  const eta_s = parseDurationSeconds(r.duration)
  const static_s = parseDurationSeconds(r.staticDuration)
  let traffic: ComputedEta['traffic'] = 'unknown'
  if (static_s > 0) {
    const ratio = eta_s / static_s
    traffic = ratio < 1.15 ? 'light' : ratio < 1.4 ? 'moderate' : 'heavy'
  }
  return { eta_s, remaining_m: r.distanceMeters ?? 0, traffic }
}

// ── Places API (New) — petrol pumps ──────────────────────────────────────────

export interface PetrolPump {
  place_id: string
  name: string
  lat: number
  lng: number
  distance_m: number
  address: string | null
  brand: string | null
}

/**
 * Nearest petrol pumps around a point (D-011: default top-8, ranked by distance).
 *
 * `rankPreference: 'DISTANCE'` makes Google do the ranking, so the field mask can stay
 * narrow — Places New bills by the fields you ask for, and `displayName`/`location`/
 * `formattedAddress` sit in the cheaper tiers. Never widen this mask casually.
 */
export async function searchPetrolPumps(
  centre: LatLng,
  radiusM: number,
  limit: number,
): Promise<Omit<PetrolPump, 'distance_m'>[]> {
  let res: Response
  try {
    res = await fetch(PLACES_NEARBY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': KEY!,
        'X-Goog-FieldMask':
          'places.id,places.displayName,places.location,places.formattedAddress,places.primaryTypeDisplayName',
      },
      body: JSON.stringify({
        includedTypes: ['gas_station'],
        maxResultCount: Math.min(Math.max(limit, 1), 20),
        rankPreference: 'DISTANCE',
        locationRestriction: {
          circle: {
            center: { latitude: centre.lat, longitude: centre.lng },
            radius: radiusM,
          },
        },
      }),
    })
  } catch (e) {
    throw new TrackingError(`Places API unreachable: ${(e as Error).message}`, 'UPSTREAM_ERROR', 502)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new TrackingError(`Places API error ${res.status}: ${text.slice(0, 200)}`, 'UPSTREAM_ERROR', 502)
  }

  const json = (await res.json()) as {
    places?: Array<{
      id?: string
      displayName?: { text?: string }
      location?: { latitude?: number; longitude?: number }
      formattedAddress?: string
      primaryTypeDisplayName?: { text?: string }
    }>
  }

  // A radius with no gas_station comes back as {} — an empty list, not an error.
  return (json.places ?? [])
    .filter((p) => p.id && typeof p.location?.latitude === 'number' && typeof p.location?.longitude === 'number')
    .map((p) => ({
      place_id: p.id!,
      name: p.displayName?.text ?? 'Petrol pump',
      lat: p.location!.latitude!,
      lng: p.location!.longitude!,
      address: p.formattedAddress ?? null,
      brand: p.primaryTypeDisplayName?.text ?? null,
    }))
}

// ── Places API (New) — address autocomplete + details (D-020) ─────────────────

export interface PlaceSuggestion {
  place_id: string
  /** Full suggested text, e.g. "45 MG Road, Bengaluru, Karnataka, India". */
  description: string
  /** The bold first line, e.g. "45 MG Road". */
  main_text: string
  /** The greyed remainder, e.g. "Bengaluru, Karnataka, India". */
  secondary_text: string
}

/**
 * Address autocomplete. Places API (New) `places:autocomplete`, biased to India
 * (`includedRegionCodes: ['in']`). A `sessionToken` groups the keystrokes of one search with
 * the following Details call so Google bills the pair once — the client mints it and passes
 * it to both endpoints. Autocomplete does NOT take a field mask (unlike the other Places
 * calls); the response shape is fixed.
 */
export async function autocompletePlaces(input: string, sessionToken?: string): Promise<PlaceSuggestion[]> {
  let res: Response
  try {
    res = await fetch(PLACES_AUTOCOMPLETE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': KEY!,
      },
      body: JSON.stringify({
        input,
        includedRegionCodes: ['in'],
        languageCode: 'en',
        ...(sessionToken ? { sessionToken } : {}),
      }),
    })
  } catch (e) {
    throw new TrackingError(`Places API unreachable: ${(e as Error).message}`, 'UPSTREAM_ERROR', 502)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new TrackingError(`Places autocomplete error ${res.status}: ${text.slice(0, 200)}`, 'UPSTREAM_ERROR', 502)
  }

  const json = (await res.json()) as {
    suggestions?: Array<{
      placePrediction?: {
        placeId?: string
        text?: { text?: string }
        structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } }
      }
    }>
  }

  return (json.suggestions ?? [])
    .map((s) => s.placePrediction)
    .filter((p): p is NonNullable<typeof p> => !!p?.placeId)
    .map((p) => ({
      place_id: p.placeId!,
      description: p.text?.text ?? '',
      main_text: p.structuredFormat?.mainText?.text ?? p.text?.text ?? '',
      secondary_text: p.structuredFormat?.secondaryText?.text ?? '',
    }))
}

export interface PlaceDetails {
  place_id: string
  lat: number
  lng: number
  formatted_address: string
  /** Postal (PIN) code from the address components, or null. */
  pincode: string | null
  /** State name as Google returns it, or null. */
  state: string | null
  /** GST 2-digit state code derived from the state name, or null when unmapped. */
  state_code: string | null
}

/**
 * Resolve one place to its coordinates + the fields the freight documents need: the PIN code
 * and the GST state code (derived from the state name). Places Details (New) with a NARROW
 * field mask — Places bills by fields, and `addressComponents` is what carries pincode/state,
 * so the mask is exactly location + formattedAddress + addressComponents + id, never wider.
 */
export async function placeDetails(placeId: string, sessionToken?: string): Promise<PlaceDetails> {
  const qs = sessionToken ? `?sessionToken=${encodeURIComponent(sessionToken)}` : ''
  let res: Response
  try {
    res = await fetch(`${PLACE_DETAILS_URL}/${encodeURIComponent(placeId)}${qs}`, {
      method: 'GET',
      headers: {
        'X-Goog-Api-Key': KEY!,
        'X-Goog-FieldMask': 'id,location,formattedAddress,addressComponents',
      },
    })
  } catch (e) {
    throw new TrackingError(`Places API unreachable: ${(e as Error).message}`, 'UPSTREAM_ERROR', 502)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    if (res.status === 404) throw new TrackingError('Place not found', 'NOT_FOUND', 404)
    throw new TrackingError(`Place details error ${res.status}: ${text.slice(0, 200)}`, 'UPSTREAM_ERROR', 502)
  }

  const json = (await res.json()) as {
    id?: string
    location?: { latitude?: number; longitude?: number }
    formattedAddress?: string
    addressComponents?: Array<{ longText?: string; shortText?: string; types?: string[] }>
  }

  if (typeof json.location?.latitude !== 'number' || typeof json.location?.longitude !== 'number') {
    throw new TrackingError('Place has no coordinates', 'UPSTREAM_ERROR', 502)
  }

  const components = json.addressComponents ?? []
  const pick = (type: string) => components.find((c) => (c.types ?? []).includes(type))
  const pincode = pick('postal_code')?.longText ?? null
  const state = pick('administrative_area_level_1')?.longText ?? null

  return {
    place_id: json.id ?? placeId,
    lat: json.location.latitude,
    lng: json.location.longitude,
    formatted_address: json.formattedAddress ?? '',
    pincode,
    state,
    state_code: gstStateCode(state),
  }
}

// ── Geocoding API (reverse) — a dropped map pin -> postal code + GST state (D-021) ─────────────
//
// Places API (New) has NO reverse-geocode (coords -> address); the Geocoding API is the only
// Google surface that returns a postal_code for an arbitrary point. It is NOT one of the three
// APIs the frozen Maps CONTRACT (§3.1) permits, so decision D-021 adds it for exactly this use:
// auto-filling the e-way-bill pincode/state when a shipper drops a pin instead of typing an
// address. Server-side (secret key) and Redis-cached by the caller for cost control.
//
// Degrades, never breaks: on ZERO_RESULTS, an unenabled API (REQUEST_DENIED — the GCP toggle is
// not flipped yet), or a rate cap, it returns `resolved:false` with null fields so the pin stays
// coords-only rather than erroring. The address centroid still governs distance; a bare pin never
// fabricates a place_id.
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json'

export interface ReverseGeocodeResult {
  lat: number
  lng: number
  formatted_address: string | null
  pincode: string | null
  state: string | null
  /** GST 2-digit state code derived from the state name, or null when unmapped. */
  state_code: string | null
  /** false when Google returned nothing usable OR the Geocoding API is not enabled yet. */
  resolved: boolean
}

export async function reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult> {
  const unresolved: ReverseGeocodeResult = {
    lat, lng, formatted_address: null, pincode: null, state: null, state_code: null, resolved: false,
  }

  let res: Response
  try {
    // region=in biases postal formatting to India; the key is the server-side secret.
    res = await fetch(`${GEOCODE_URL}?latlng=${lat},${lng}&region=in&key=${encodeURIComponent(KEY!)}`)
  } catch (e) {
    throw new TrackingError(`Geocoding API unreachable: ${(e as Error).message}`, 'UPSTREAM_ERROR', 502)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new TrackingError(`Geocoding API error ${res.status}: ${text.slice(0, 200)}`, 'UPSTREAM_ERROR', 502)
  }

  const json = (await res.json()) as {
    status?: string
    error_message?: string
    results?: Array<{
      formatted_address?: string
      address_components?: Array<{ long_name?: string; short_name?: string; types?: string[] }>
    }>
  }

  // The Geocoding API answers 200 with a status field even when it refuses. REQUEST_DENIED means
  // the API is not enabled on GOOGLE_MAPS_SERVER_KEY yet (the D-021 GCP toggle) — log it once so
  // it is findable, but do not fail the pin.
  if (json.status === 'REQUEST_DENIED') {
    console.warn(`[reverseGeocode] REQUEST_DENIED — enable the Geocoding API on GOOGLE_MAPS_SERVER_KEY (D-021): ${json.error_message ?? ''}`)
    return unresolved
  }
  if (json.status !== 'OK' || !json.results?.length) {
    return unresolved
  }

  // Results run most-specific first. The rooftop result may lack a postal_code that a broader
  // result carries, so scan across them for the first postal_code and the first state.
  let pincode: string | null = null
  let state: string | null = null
  for (const r of json.results) {
    for (const c of r.address_components ?? []) {
      const types = c.types ?? []
      if (!pincode && types.includes('postal_code') && c.long_name) pincode = c.long_name
      if (!state && types.includes('administrative_area_level_1') && c.long_name) state = c.long_name
    }
    if (pincode && state) break
  }

  return {
    lat,
    lng,
    formatted_address: json.results[0].formatted_address ?? null,
    pincode,
    state,
    state_code: gstStateCode(state),
    resolved: true,
  }
}
