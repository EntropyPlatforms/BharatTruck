import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { BookingError } from '../lib/types.js'
import { CARRIER_KINDS, parseCarrierSearch } from '../lib/preferred/rules.js'
import {
  listPreferredCarriers,
  searchCarriers,
  starCarrier,
  unstarCarrier,
} from '../lib/preferred/service.js'

// -----------------------------------------------------------
// Preferred carriers (migration 0044). The Post-a-Load picker and the load page's bid and
// carrier cards read this to put a "Preferred" label in front of a driver or fleet the
// shipper has finished trips with, or has starred.
//
// Authorized purely by the caller's own identity, like /me/addresses and /me/summary:
// every read and write is keyed on req.user.userId as the shipper, there is no route
// parameter naming another shipper, and posting a load is a capability every account
// holds ('ship', D-27) — so there is no role gate to add, and none is added.
//
// Mounted under /me; the gateway routes /api/me/carriers here with its own location block
// (bt-gateway/nginx.conf.template), because the bare /api/me/ prefix belongs to auth.
//
// WHY A FLEET CANNOT BE THE TARGET OF A DIRECT LOAD (yet): a direct booking is aimed at
// bookings.target_driver_id, and a fleet has no such column — submitQuote refuses a fleet
// on a driver-targeted load and the fleet board hides those loads. Aiming the load at one
// of the fleet's EMPLOYED drivers would strand it (an employee can neither accept nor bid;
// their owner does). So a fleet is listed and labelled here, and the app posts a direct
// load "open to quotes" when a fleet is chosen; the fleet's quote then arrives on the load
// page wearing the Preferred label. `direct_targetable` on each card says which is which.
// -----------------------------------------------------------

const CarrierParams = z.object({
  kind: z.enum(CARRIER_KINDS as [string, ...string[]], { errorMap: () => ({ message: 'kind must be driver or fleet_owner' }) }),
  id: z.string().uuid('id must be a valid UUID'),
})

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof BookingError) {
    return reply.status(err.httpStatus).send({ success: false, error: err.message, code: err.code })
  }
  reply.log.error(err, 'Unhandled error in preferred-carrier routes')
  return reply.status(500).send({ success: false, error: 'Internal server error' })
}

export async function preferredCarrierRoutes(app: FastifyInstance) {
  // GET /me/carriers — the caller's Preferred carriers, automatic + starred, ranked.
  app.get('/carriers', async (req, reply) => {
    try {
      return reply.send({ success: true, data: await listPreferredCarriers(req.user.userId) })
    } catch (err) {
      return fail(reply, err)
    }
  })

  // GET /me/carriers/search?q= — name (2+ chars) or a whole 10-digit mobile.
  app.get('/carriers/search', async (req, reply) => {
    const q = (req.query as { q?: unknown } | undefined)?.q
    const search = parseCarrierSearch(typeof q === 'string' ? q : null)
    if (!search) {
      return reply.status(400).send({
        success: false,
        error: 'Type at least two letters of a name, or a full 10-digit mobile number',
        code: 'VALIDATION_ERROR',
      })
    }
    try {
      return reply.send({ success: true, data: await searchCarriers(req.user.userId, search) })
    } catch (err) {
      return fail(reply, err)
    }
  })

  // PUT /me/carriers/:kind/:id/star — mark Preferred (idempotent).
  app.put('/carriers/:kind/:id/star', async (req, reply) => {
    const parsed = CarrierParams.safeParse(req.params)
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }
    try {
      const data = await starCarrier(req.user.userId, { kind: parsed.data.kind as 'driver' | 'fleet_owner', id: parsed.data.id })
      return reply.send({ success: true, data })
    } catch (err) {
      return fail(reply, err)
    }
  })

  // DELETE /me/carriers/:kind/:id/star — remove the star (idempotent). Trips still count.
  app.delete('/carriers/:kind/:id/star', async (req, reply) => {
    const parsed = CarrierParams.safeParse(req.params)
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }
    try {
      const data = await unstarCarrier(req.user.userId, { kind: parsed.data.kind as 'driver' | 'fleet_owner', id: parsed.data.id })
      return reply.send({ success: true, data })
    } catch (err) {
      return fail(reply, err)
    }
  })
}
