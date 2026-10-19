import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { getPriceQuoteById, consumePriceQuote } from '../lib/price-quote-store.js'

// -----------------------------------------------------------
// internalPricingRoutes — service-to-service (internal-secret gated, NOT
// gateway-exposed). Mounted under `/internal`. bt-booking-service reads a
// locked price_quote here (GET) and atomically consumes it (POST) when a
// booking locks in the quote, so the price SHOWN == the price CHARGED.
// snake_case JSON; {success,data} / {success,error,code} envelope.
// -----------------------------------------------------------

const IdParam = z.object({ id: z.string().uuid('id must be a valid UUID') })
const ConsumeBody = z.object({ booking_id: z.string().uuid('booking_id must be a valid UUID') })

function handleError(reply: FastifyReply, err: unknown) {
  reply.log.error(err, 'Unhandled error in internal pricing routes')
  return reply.status(500).send({ success: false, error: 'Internal server error', code: 'INTERNAL_ERROR' })
}

export async function internalPricingRoutes(app: FastifyInstance) {
  // GET /internal/quote/:id — return the full locked row (incl. shipper_id,
  // quoted_price, expires_at, consumed_by_booking_id) for booking to validate.
  app.get('/quote/:id', async (req, reply) => {
    const params = IdParam.safeParse(req.params)
    if (!params.success) {
      return reply.status(400).send({ success: false, error: params.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }
    try {
      const row = await getPriceQuoteById(params.data.id)
      if (!row) {
        return reply.status(404).send({ success: false, error: 'Quote not found', code: 'NOT_FOUND' })
      }
      return reply.send({ success: true, data: row })
    } catch (err) {
      return handleError(reply, err)
    }
  })

  // POST /internal/quote/:id/consume — atomically stamp consumed_at +
  // consumed_by_booking_id together. The conditional UPDATE in the store
  // (WHERE consumed_at IS NULL AND expires_at > now()) is the DB-enforced replay
  // + expiry guard; consumed_at (not the FK) is the guard because it is immutable
  // and survives a compensating booking-delete.
  app.post('/quote/:id/consume', async (req, reply) => {
    const params = IdParam.safeParse(req.params)
    if (!params.success) {
      return reply.status(400).send({ success: false, error: params.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }
    const body = ConsumeBody.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }
    try {
      const row = await consumePriceQuote(params.data.id, body.data.booking_id)
      if (!row) {
        return reply.status(409).send({ success: false, error: 'Quote already used or expired', code: 'INVALID_TRANSITION' })
      }
      return reply.send({ success: true, data: row })
    } catch (err) {
      return handleError(reply, err)
    }
  })
}
