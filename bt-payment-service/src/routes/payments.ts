import type { FastifyInstance, FastifyReply, FastifyPluginOptions } from 'fastify'
import { z } from 'zod'
import { PaymentError } from '../lib/errors.js'
import { settle, payoutView, assertSettlementParty, type PaymentDeps } from '../lib/payment-service.js'
import { defaultBookingClient } from '../lib/booking-client.js'
import { defaultPaymentStore } from '../lib/payment-store.js'
import { getSupabase } from '../lib/supabase.js'
import { resolvePersonas } from '@bharattruck/shared/personas'

// NOTE: the previous Razorpay/escrow handlers here (order/webhook/release)
// were fabricated stubs (`rzp_stub_order_id`, TODO Sprint 7) and were removed.
// This file is the RECORDED settlement (cash/UPI/bank transfer made outside the
// app). The real online collection is routes/razorpay.ts; escrow is still out.

const SettleBody = z.object({
  booking_id: z.string().uuid(),
  amount:     z.number().positive(),
  mode:       z.enum(['cash', 'upi', 'direct']),
  reference:  z.string().max(200).optional(),
})

type PaymentRouteOptions = FastifyPluginOptions & { deps?: PaymentDeps }

function handleError(reply: FastifyReply, err: unknown) {
  if (err instanceof PaymentError) {
    return reply.status(err.httpStatus).send({ success: false, error: err.message, code: err.code })
  }
  reply.log.error(err, 'Unhandled error in payment routes')
  return reply.status(500).send({ success: false, error: 'Internal server error' })
}

// -----------------------------------------------------------
// paymentRoutes — JWT-gated cash-recorded settlement (P1 #11).
// Deps default to real wiring; tests register with injected deps.
// -----------------------------------------------------------

export async function paymentRoutes(app: FastifyInstance, opts: PaymentRouteOptions) {
  const deps: PaymentDeps = opts.deps ?? {
    booking: defaultBookingClient(),
    store:   defaultPaymentStore(),
    // Bind the shared persona resolver to the service-role client — this is the
    // seam settle()/status authorize through (relation-to-booking, not role).
    resolvePersonas: (userId, primaryPersona) => resolvePersonas(getSupabase(), userId, primaryPersona),
    logger:  app.log,
  }

  // POST /payments/settle — ops/admin or paying shipper records a
  // cash/UPI/direct settlement for a completed trip; booking → paid.
  app.post('/settle', async (req, reply) => {
    const body = SettleBody.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }
    try {
      const data = await settle(
        { bookingId: body.data.booking_id, amount: body.data.amount, mode: body.data.mode, reference: body.data.reference ?? null },
        req.user,
        req.headers.authorization!,
        deps,
      )
      return reply.send({ success: true, data })
    } catch (err) {
      return handleError(reply, err)
    }
  })

  // GET /payments/status/:booking_id — ops/admin or shipper-owner reads
  // the recorded payment + payout(s) for a booking. `payout` is the bidder's
  // row and `payouts` is every payee, so a shipper client written before the
  // D-7 split existed keeps reading the same field with the same meaning.
  app.get('/status/:booking_id', async (req, reply) => {
    const params = z.object({ booking_id: z.string().uuid() }).safeParse(req.params)
    if (!params.success) {
      return reply.status(400).send({ success: false, error: params.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }
    const bookingId = params.data.booking_id
    try {
      // Read first (booking-service enforces read access), then authorize on the
      // caller's RELATION to the booking (D-27): the shipper, a to-pay consignee,
      // or ops may read a settlement — the same parties who may record one.
      const booking = await deps.booking.getBooking(bookingId, req.headers.authorization!)
      await assertSettlementParty(booking, req.user, deps)
      const payment = await deps.store.getPayment(bookingId)
      const payouts = await deps.store.getPayouts(bookingId)
      return reply.send({ success: true, data: { booking_id: bookingId, payment, ...payoutView(booking, payouts) } })
    } catch (err) {
      return handleError(reply, err)
    }
  })
}
