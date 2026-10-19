import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { QuoteBody, computeQuote } from '../lib/pricing.js'
import { insertPriceQuote } from '../lib/price-quote-store.js'
import { roadDistanceKm } from '../lib/geo.js'
import { resolveCostFloor, type CostFloorBreakdown } from '../lib/cost-engine.js'
import { defaultRouteDistanceClient } from '../lib/tracking-client.js'
import { resolveMarketPrice, type MarketResult, type MarketVehicleClass } from '../lib/market-engine.js'
import { reconcile } from '../lib/reconcile.js'
import { justifyPrice } from '../lib/justify.js'

// -----------------------------------------------------------
// pricingRoutes — public, JWT-gated. Mounted under `/pricing` so the gateway
// rewrite (/api/pricing/(.*) -> /pricing/$1) reaches POST /pricing/quote.
//
// POST /quote accepts the booking's ROUTE (source/dest coords) + cargo, DERIVES
// distance_km server-side (haversine × road-winding factor — never client-asserted;
// no Google Routes/maps key here per the FROZEN maps rule), computes the commercial
// split + CTO deterministic cost-breakdown (numbers unchanged), and PERSISTS it as a
// price_quotes lock (source of truth, no in-memory store). It returns the QuoteResult
// PLUS the lock handle { quote_id, quoted_price, breakdown, currency, expires_at } the
// shipper sends back on booking-create so the price SHOWN == the price CHARGED (PRD 5.4).
// The coords + cargo are persisted so booking-create can BIND the booking to exactly
// what was priced.
//
// "SHOWN == CHARGED" holds for BINDING quotes (booking_type 'direct', and any caller
// that sends no booking_type). For an ADVISORY quote — an auction — the platform has
// no price at all: quoted_price is a benchmark and the charge is the winning carrier's
// bid. The row is still written, because it is the record of what the shipper was
// shown and when, which is precisely the evidence you want if the pricing posture is
// ever questioned (INDIA_FREIGHT_COMPLIANCE.md §1.3). Read quote_kind out of
// breakdown_json before treating a stored quoted_price as an amount owed.
//
// The default cuts the wrong way at production volume, so read it as a compatibility
// shim and not as a safe fallback: booking_type is optional ONLY so that a caller
// written before this field keeps working. Live bookings are ~94% auction, so a
// caller that omits it does not produce a neutral row — it produces a stored
// `quote_kind: 'binding'`, a machine-readable claim that the platform charged that
// freight, on the exact bookings where §1.3 red line 3 says it must never claim
// that. Any NEW caller sends its booking_type. Adding one that does not is a
// regression even though nothing fails.
// -----------------------------------------------------------

// Request body: the booking's route + cargo. distance_km is DERIVED here, never
// accepted from the client. Reuses QuoteBody's vehicle_type/load_type/weight_kg
// enums (single source of truth) and drops the old client-supplied distance_km.
const lat = z.number().min(-90).max(90)
const lng = z.number().min(-180).max(180)
const QuoteRequestBody = QuoteBody.omit({ distance_km: true }).extend({
  source_lat: lat,
  source_lng: lng,
  dest_lat:   lat,
  dest_lng:   lng,
})

// Locked-quote validity window. Sane default; a shipper who dawdles past this
// re-fetches a fresh quote.
const QUOTE_TTL_MS = 30 * 60_000 // 30 minutes

// POST /justify (Mode B): a carrier names their OWN bid; the engine reverse-generates a cost
// breakdown that sums to it, from the load + route ALONE — no truck details. The caller passes the
// booking's load_type/weight_kg plus EITHER a distance_km or the route coords (from which distance
// is derived the same routed-or-haversine way /quote uses, reusing the tracking cache). Reuses
// QuoteBody's load_type enum (single source of truth).
const JustifyRequestBody = z
  .object({
    amount:      z.number().positive(),
    distance_km: z.number().positive().optional(),
    source_lat:  lat.optional(),
    source_lng:  lng.optional(),
    dest_lat:    lat.optional(),
    dest_lng:    lng.optional(),
    load_type:   QuoteBody.shape.load_type,
    weight_kg:   z.number().positive(),
  })
  .refine(
    (b) =>
      b.distance_km != null ||
      (b.source_lat != null && b.source_lng != null && b.dest_lat != null && b.dest_lng != null),
    { message: 'Provide distance_km or all four route coordinates (source_lat/lng, dest_lat/lng)' },
  )

function handleError(reply: FastifyReply, err: unknown) {
  reply.log.error(err, 'Unhandled error in pricing routes')
  return reply.status(500).send({ success: false, error: 'Internal server error', code: 'INTERNAL_ERROR' })
}

type WarnLogger = { warn(obj: unknown, msg: string): void }

/**
 * Real road distance from bt-tracking-service (cached there; the Google Maps key never enters
 * pricing — the frozen maps CONTRACT). Any failure/timeout/missing-secret falls back to the
 * self-contained haversine estimate, so pricing never hard-fails on tracking being down (P1).
 * Shared by /quote and /justify.
 */
async function resolveRouteDistance(
  coords: { source_lat: number; source_lng: number; dest_lat: number; dest_lng: number },
  log: WarnLogger,
): Promise<{ distance_km: number; distance_basis: 'routed' | 'estimated' }> {
  const routeClient = defaultRouteDistanceClient()
  let routedKm: number | null = null
  if (routeClient) {
    try {
      routedKm = await routeClient.routeDistanceKm(coords)
    } catch (err) {
      log.warn({ err }, 'tracking route lookup failed; falling back to haversine estimate')
    }
  }
  const distance_km = routedKm ?? roadDistanceKm(coords.source_lat, coords.source_lng, coords.dest_lat, coords.dest_lng)
  return { distance_km, distance_basis: routedKm != null ? 'routed' : 'estimated' }
}

export async function pricingRoutes(app: FastifyInstance) {
  // POST /quote (final path /pricing/quote). req.user.userId is the shipper's
  // users.id (JWT). shipper_pays === total_price is the number locked as quoted_price.
  app.post('/quote', async (req, reply) => {
    const body = QuoteRequestBody.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }
    try {
      // Real routed distance (cached in tracking), with a haversine fallback — see resolveRouteDistance.
      const { distance_km, distance_basis } = await resolveRouteDistance({
        source_lat: body.data.source_lat, source_lng: body.data.source_lng,
        dest_lat:   body.data.dest_lat,   dest_lng:   body.data.dest_lng,
      }, req.log)
      // Guard identical/degenerate coords so we never trip the DB check
      // (distance_km > 0 / quoted_price > 0) and leak a 500 — return a clean 4xx.
      if (!(distance_km > 0)) {
        return reply.status(400).send({
          success: false,
          error: 'Source and destination are the same location — cannot price a zero-distance trip',
          code: 'VALIDATION_ERROR',
        })
      }

      // Resolve the REAL CV-Parc cost floor. Defensive: a norms-table outage must
      // not take down quoting — the commercial split below does not depend on the
      // floor — so a failure logs and degrades to `cost_floor: null`. In
      // production the tables are seeded, so this populates.
      let costFloor: CostFloorBreakdown | null = null
      try {
        costFloor = await resolveCostFloor({
          distance_km,
          weight_kg:        body.data.weight_kg,
          load_type:        body.data.load_type,
          vehicle_type:     body.data.vehicle_type,
          model_category:   body.data.model_category,
          emission_norm:    body.data.emission_norm,
          truck_age:        body.data.truck_age,
          diesel_price_inr: body.data.diesel_price_inr,
        })
      } catch (err) {
        req.log.warn({ err }, 'CV-Parc cost floor unavailable; quoting with the commercial split only')
      }

      // booking_type is optional and only classifies the result (advisory vs
      // binding) — it does not touch the maths. Omitted → binding, so every
      // caller that predates it is byte-identical. See lib/pricing.ts.
      const result = computeQuote({
        distance_km,
        vehicle_type: body.data.vehicle_type,
        load_type:    body.data.load_type,
        weight_kg:    body.data.weight_kg,
        booking_type: body.data.booking_type,
      }, costFloor)

      // Market reference (P2): the FR8-calibrated corridor rate for this lane (directional), with a
      // national ₹/km-by-class fallback. Defensive like the cost floor — a market-table outage must
      // not fail a quote. This is a REFERENCE returned alongside the quote; the quote-vs-market
      // reconciliation is P3.
      let market: MarketResult | null = null
      try {
        market = await resolveMarketPrice({
          source_lat: body.data.source_lat, source_lng: body.data.source_lng,
          dest_lat:   body.data.dest_lat,   dest_lng:   body.data.dest_lng,
          distance_km,
          vehicle_class: result.cost_breakdown.vehicle_class as MarketVehicleClass,
        })
      } catch (err) {
        req.log.warn({ err }, 'market reference unavailable; quoting without it')
      }

      // Three-layer reconciliation (P3): place the headline quote against the operating-cost floor
      // and the market reference. Pure + additive — it DESCRIBES shipper_pays, never moves it (the
      // headline is the locked price the shipper is charged), so it cannot break the price-lock and
      // needs no defensive try/catch. Gives the UI the full floor/quote/market picture in one field.
      const reconciliation = reconcile(
        result.shipper_pays,
        costFloor?.floor ?? null,
        market?.market_price ?? null,
      )

      const expiresAt = new Date(Date.now() + QUOTE_TTL_MS).toISOString()

      const row = await insertPriceQuote({
        shipper_id:     req.user.userId,
        source_lat:     body.data.source_lat,
        source_lng:     body.data.source_lng,
        dest_lat:       body.data.dest_lat,
        dest_lng:       body.data.dest_lng,
        distance_km,
        vehicle_type:   body.data.vehicle_type,
        vehicle_class:  result.cost_breakdown.vehicle_class,
        load_type:      body.data.load_type,
        weight_kg:      body.data.weight_kg,
        breakdown_json: { ...result, distance_basis, market, reconciliation },
        quoted_price:   result.shipper_pays,
        currency:       'INR',
        expires_at:     expiresAt,
      })

      return reply.send({
        success: true,
        data: {
          ...result,
          distance_basis,
          market,
          reconciliation,
          quote_id:     row.id,
          quoted_price: row.quoted_price,
          breakdown:    result.cost_breakdown,
          currency:     row.currency,
          expires_at:   row.expires_at,
        },
      })
    } catch (err) {
      return handleError(reply, err)
    }
  })

  // POST /justify (final path /pricing/justify). Mode B — see JustifyRequestBody. Pure calculator:
  // given a bid and the load/route, returns the breakdown that sums to the bid. JWT-gated like the
  // rest of pricingRoutes, but role-agnostic — bidding authorization lives in bt-booking-service;
  // this only does the arithmetic. Never persists, never nudges.
  app.post('/justify', async (req, reply) => {
    const body = JustifyRequestBody.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }
    try {
      // distance_km wins if supplied; otherwise derive it from the coords the refine() guaranteed
      // are present, reusing the same routed-or-haversine path (and tracking cache) as /quote.
      let distance_km = body.data.distance_km
      let distance_basis: 'routed' | 'estimated' | 'given' = 'given'
      if (distance_km == null) {
        const resolved = await resolveRouteDistance({
          source_lat: body.data.source_lat!, source_lng: body.data.source_lng!,
          dest_lat:   body.data.dest_lat!,   dest_lng:   body.data.dest_lng!,
        }, req.log)
        distance_km = resolved.distance_km
        distance_basis = resolved.distance_basis
      }
      if (!(distance_km > 0)) {
        return reply.status(400).send({
          success: false,
          error: 'Source and destination are the same location — cannot justify a zero-distance trip',
          code: 'VALIDATION_ERROR',
        })
      }
      const breakdown = justifyPrice({
        amount:      body.data.amount,
        distance_km,
        load_type:   body.data.load_type,
        weight_kg:   body.data.weight_kg,
      })
      return reply.send({ success: true, data: { ...breakdown, distance_km, distance_basis } })
    } catch (err) {
      return handleError(reply, err)
    }
  })
}
