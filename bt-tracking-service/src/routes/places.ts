import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getOrCompute } from '../lib/cache.js'
import {
  redis,
  placeAutocompleteKey,
  placeDetailsKey,
  reverseGeocodeKey,
  AUTOCOMPLETE_TTL_SECONDS,
  PLACE_DETAILS_TTL_SECONDS,
  REVERSE_GEOCODE_TTL_SECONDS,
} from '../lib/redis.js'
import { autocompletePlaces, placeDetails, reverseGeocode } from '../lib/google.js'
import { TrackingError } from '../lib/types.js'

// -----------------------------------------------------------
// Geocoding — address autocomplete + place details (D-020, BIBLE §3.2).
//
// These break the §3.1 `:bookingId` convention on purpose: geocoding happens BEFORE a booking
// exists (a shipper is typing a pickup on the post-load form). They live here, not in a new
// service, because the frozen maps CONTRACT keeps GOOGLE_MAPS_SERVER_KEY in this service alone
// and these are Places API (New) calls — the exact provider §3.1 already permits.
//
// JWT-gated (registered inside the authed scope), cached in Redis to hold Google's per-call
// cost down. The session_token, when the client sends one, groups a search's keystrokes with
// the one Details call that follows so Google bills the pair as a single session.
// -----------------------------------------------------------

const AutocompleteQuery = z.object({
  // Two chars is the shortest worth a round trip; below that Places returns noise.
  q: z.string().trim().min(2, 'q must be at least 2 characters').max(200),
  session_token: z.string().min(1).max(128).optional(),
})

const DetailsQuery = z.object({
  place_id: z.string().min(1, 'place_id is required').max(512),
  session_token: z.string().min(1).max(128).optional(),
})

const ReverseQuery = z.object({
  lat: z.coerce.number().gte(-90).lte(90),
  lng: z.coerce.number().gte(-180).lte(180),
})

export async function placesRoutes(app: FastifyInstance) {
  // GET /api/tracking/places/autocomplete?q=&session_token=
  app.get('/autocomplete', async (req, reply) => {
    const parsed = AutocompleteQuery.safeParse(req.query)
    if (!parsed.success) {
      throw new TrackingError(parsed.error.errors[0].message, 'VALIDATION_ERROR', 400)
    }
    const { q, session_token } = parsed.data

    // Cache is keyed by the query text only: a session token is per-user and must NOT split
    // the cache, but it still needs to reach Google, so it is passed to the compute fn.
    const { value, cached } = await getOrCompute(placeAutocompleteKey(q), AUTOCOMPLETE_TTL_SECONDS, () =>
      autocompletePlaces(q, session_token),
    )
    return reply.send({ success: true, data: { query: q, suggestions: value, cached } })
  })

  // GET /api/tracking/places/details?place_id=&session_token=
  app.get('/details', async (req, reply) => {
    const parsed = DetailsQuery.safeParse(req.query)
    if (!parsed.success) {
      throw new TrackingError(parsed.error.errors[0].message, 'VALIDATION_ERROR', 400)
    }
    const { place_id, session_token } = parsed.data

    const { value, cached } = await getOrCompute(placeDetailsKey(place_id), PLACE_DETAILS_TTL_SECONDS, () =>
      placeDetails(place_id, session_token),
    )
    return reply.send({ success: true, data: { ...value, cached } })
  })

  // GET /api/tracking/places/reverse?lat=&lng= — a dropped map pin -> pincode + GST state (D-021).
  // Cached manually (not via getOrCompute) so an UNRESOLVED answer — the Geocoding API not being
  // enabled yet, or a point with no postal area — is never cached; only a real hit is stored, so
  // the feature starts working the instant the GCP toggle is flipped, with no stale negative.
  app.get('/reverse', async (req, reply) => {
    const parsed = ReverseQuery.safeParse(req.query)
    if (!parsed.success) {
      throw new TrackingError(parsed.error.errors[0].message, 'VALIDATION_ERROR', 400)
    }
    const { lat, lng } = parsed.data
    const key = reverseGeocodeKey(lat, lng)

    const cachedRaw = await redis.get(key).catch(() => null)
    if (cachedRaw) {
      try {
        return reply.send({ success: true, data: { ...JSON.parse(cachedRaw), cached: true } })
      } catch {
        /* fall through and recompute on a corrupt cache entry */
      }
    }

    const result = await reverseGeocode(lat, lng)
    if (result.resolved) {
      await redis.set(key, JSON.stringify(result), 'EX', REVERSE_GEOCODE_TTL_SECONDS).catch(() => {})
    }
    return reply.send({ success: true, data: { ...result, cached: false } })
  })
}
