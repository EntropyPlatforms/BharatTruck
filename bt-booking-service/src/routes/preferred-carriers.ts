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
import { createCarrierInvite, getCurrentCarrierInvite, revokeCarrierInvite, MAX_TOKEN_LENGTH } from '../lib/preferred/invite-link.js'
import { acceptCarrierInvite, bulkAddCarriers, previewCarrierInvite, MAX_BULK_ROWS } from '../lib/preferred/onboarding.js'

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

// The invite token travels in the BODY (never the URL), so it never lands in a request log.
const TokenBody = z.object({
  token: z.string({ required_error: 'token is required', invalid_type_error: 'token is required' })
    .trim().min(1, 'token is required').max(MAX_TOKEN_LENGTH, 'This invite link is not valid'),
})

const BulkBody = z.object({
  rows: z.array(z.object({
    name: z.string().max(200).optional().nullable(),
    mobile: z.string({ required_error: 'mobile is required' }).max(40),
  })).min(1, 'The file has no rows').max(MAX_BULK_ROWS, `Up to ${MAX_BULK_ROWS} rows at a time`),
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

  // ── Onboarding carriers onto the Preferred list (invite link + bulk) ──────────

  // GET /me/carriers/invite-link — the caller's current link, or null.
  app.get('/carriers/invite-link', async (req, reply) => {
    try {
      return reply.send({ success: true, data: await getCurrentCarrierInvite(req.user.userId) })
    } catch (err) {
      return fail(reply, err)
    }
  })

  // POST /me/carriers/invite-link — make a new link (30 days); any earlier one stops working.
  app.post('/carriers/invite-link', async (req, reply) => {
    try {
      return reply.status(201).send({ success: true, data: await createCarrierInvite(req.user.userId) })
    } catch (err) {
      return fail(reply, err)
    }
  })

  // DELETE /me/carriers/invite-link — turn the link off.
  app.delete('/carriers/invite-link', async (req, reply) => {
    try {
      await revokeCarrierInvite(req.user.userId)
      return reply.send({ success: true, data: { revoked: true } })
    } catch (err) {
      return fail(reply, err)
    }
  })

  // POST /me/carriers/join/accept — a signed-in fleet owner or truck-owning driver joins the
  // link's shipper's Preferred list.
  app.post('/carriers/join/accept', async (req, reply) => {
    const parsed = TokenBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }
    try {
      return reply.send({ success: true, data: await acceptCarrierInvite(req.user.userId, parsed.data.token) })
    } catch (err) {
      return fail(reply, err)
    }
  })

  // POST /me/carriers/bulk — { rows: [{ name?, mobile }] }, up to 200; an outcome per row.
  app.post('/carriers/bulk', async (req, reply) => {
    const parsed = BulkBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }
    try {
      return reply.send({ success: true, data: { rows: await bulkAddCarriers(req.user.userId, parsed.data.rows) } })
    } catch (err) {
      return fail(reply, err)
    }
  })
}

// The ONE unauthenticated route here: the join page asks who sent the link before the carrier
// signs in. It answers only the shipper's name and the link's expiry, and every refusal is an
// "invalid / expired / replaced link" message, so it is no oracle for anything else. Registered
// outside the JWT scope (index.ts); the gateway's per-IP rate limit covers it.
export async function preferredCarrierPublicRoutes(app: FastifyInstance) {
  app.post('/carriers/join/preview', async (req, reply) => {
    const parsed = TokenBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }
    try {
      return reply.send({ success: true, data: await previewCarrierInvite(parsed.data.token) })
    } catch (err) {
      return fail(reply, err)
    }
  })
}
