import type { FastifyInstance, FastifyReply, FastifyPluginOptions } from 'fastify'
import { z } from 'zod'
import { PaymentError } from '../lib/errors.js'
import { onTripCompleted, type PaymentDeps } from '../lib/payment-service.js'
import { defaultPaymentStore } from '../lib/payment-store.js'
import { defaultBookingClient } from '../lib/booking-client.js'
import { getSupabase } from '../lib/supabase.js'
import { resolvePersonas } from '@bharattruck/shared/personas'

const TripCompletedBody = z.object({
  booking_id: z.string().uuid(),
  driver_id:  z.string().uuid().nullable().optional(),
  // Present only for a fleet-won booking; the payee is the bidder (Q15).
  fleet_owner_id: z.string().uuid().nullable().optional(),
  amount:     z.number().nonnegative(),
})

type InternalRouteOptions = FastifyPluginOptions & { deps?: PaymentDeps }

function handleError(reply: FastifyReply, err: unknown) {
  if (err instanceof PaymentError) {
    return reply.status(err.httpStatus).send({ success: false, error: err.message, code: err.code })
  }
  reply.log.error(err, 'Unhandled error in internal payment routes')
  return reply.status(500).send({ success: false, error: 'Internal server error' })
}

// -----------------------------------------------------------
// internalPaymentRoutes — service-to-service (internal-secret gated).
// The outbox/saga consumer for trip_completed. Idempotent on booking_id.
// -----------------------------------------------------------

export async function internalPaymentRoutes(app: FastifyInstance, opts: InternalRouteOptions) {
  const deps: PaymentDeps = opts.deps ?? {
    booking: defaultBookingClient(),
    store:   defaultPaymentStore(),
    // The saga consumer below never authorizes on a persona, but PaymentDeps is
    // one shape shared with the public settle path — bind it the same way so the
    // type stays honest rather than making the field optional and nullable.
    resolvePersonas: (userId, primaryPersona) => resolvePersonas(getSupabase(), userId, primaryPersona),
    logger:  app.log,
  }

  // POST /internal/trip-completed — booking-service emits this on completion.
  // Idempotently pre-creates a 'pending' payout keyed on booking_id.
  app.post('/trip-completed', async (req, reply) => {
    const body = TripCompletedBody.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }
    try {
      const data = await onTripCompleted(
        {
          booking_id:     body.data.booking_id,
          driver_id:      body.data.driver_id ?? null,
          fleet_owner_id: body.data.fleet_owner_id ?? null,
          amount:         body.data.amount,
        },
        deps,
      )
      return reply.send({ success: true, data })
    } catch (err) {
      return handleError(reply, err)
    }
  })
}
