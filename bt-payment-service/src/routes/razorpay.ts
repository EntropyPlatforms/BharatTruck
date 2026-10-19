import type { FastifyInstance, FastifyReply, FastifyPluginOptions } from 'fastify'
import { z } from 'zod'
import { PaymentError } from '../lib/errors.js'
import { assertSettlementParty, payoutView, type PaymentDeps } from '../lib/payment-service.js'
import { agreedPaise, settleFromOrder } from '../lib/online-payment.js'
import { defaultGateway, orderNote, type PaymentGateway, type RazorpayOrder } from '../lib/razorpay.js'
import { defaultBookingClient } from '../lib/booking-client.js'
import { defaultPaymentStore } from '../lib/payment-store.js'
import { getSupabase } from '../lib/supabase.js'
import { resolvePersonas } from '@bharattruck/shared/personas'

// -----------------------------------------------------------
// Razorpay routes — the shipper pays the agreed price online.
//
//   GET  /payments/config            is online payment switched on? (+ the public key id)
//   POST /payments/razorpay/order    create (or reuse) the order the checkout opens
//   POST /payments/razorpay/verify   the checkout's success callback → close the trip
//   POST /payments/razorpay/sync     "did I already pay?" — heals a payment whose
//                                    callback never arrived (tab closed, network lost)
//   POST /payments/razorpay/webhook  Razorpay → us, signed; the same heal without the
//                                    shipper having to come back (separate scope, no JWT)
//
// Every path that closes a trip goes through settleFromOrder, which re-reads the order's
// payments FROM RAZORPAY and checks the captured amount against the booking's agreed
// price. Nothing the browser (or the webhook body) says about an amount is trusted.
//
// With no keys configured `gateway` is null and every route below answers 503 — see
// lib/razorpay.ts.
// -----------------------------------------------------------

type RazorpayRouteOptions = FastifyPluginOptions & { deps?: PaymentDeps; gateway?: PaymentGateway | null }

function handleError(reply: FastifyReply, err: unknown) {
  if (err instanceof PaymentError) {
    return reply.status(err.httpStatus).send({ success: false, error: err.message, code: err.code })
  }
  reply.log.error(err, 'Unhandled error in razorpay routes')
  return reply.status(500).send({ success: false, error: 'Internal server error' })
}

function defaultDeps(app: FastifyInstance): PaymentDeps {
  return {
    booking: defaultBookingClient(),
    store:   defaultPaymentStore(),
    resolvePersonas: (userId, primaryPersona) => resolvePersonas(getSupabase(), userId, primaryPersona),
    logger:  app.log,
  }
}

function requireGateway(gateway: PaymentGateway | null): PaymentGateway {
  if (!gateway) {
    throw new PaymentError('Online payment is not switched on yet', 'GATEWAY_NOT_CONFIGURED', 503)
  }
  return gateway
}

const BookingBody = z.object({ booking_id: z.string().uuid() })

const VerifyBody = z.object({
  booking_id:          z.string().uuid(),
  razorpay_order_id:   z.string().min(1).max(64),
  razorpay_payment_id: z.string().min(1).max(64),
  razorpay_signature:  z.string().min(1).max(256),
})

/** The order that already carries this booking's money, if any. */
function paidOrder(orders: RazorpayOrder[], bookingId: string): RazorpayOrder | null {
  return orders.find((o) => o.status === 'paid' && orderNote(o, 'booking_id') === bookingId) ?? null
}

export async function razorpayRoutes(app: FastifyInstance, opts: RazorpayRouteOptions) {
  const deps: PaymentDeps = opts.deps ?? defaultDeps(app)
  const gateway = opts.gateway === undefined ? defaultGateway() : opts.gateway

  // GET /payments/config — what the app needs to decide whether to offer "Pay online".
  // key_id is Razorpay's PUBLIC identifier (it is in the checkout's page source by design).
  app.get('/config', async (_req, reply) => {
    return reply.send({
      success: true,
      data: { razorpay: { enabled: !!gateway, key_id: gateway?.keyId ?? null, test_mode: gateway?.testMode ?? false } },
    })
  })

  // POST /payments/razorpay/order — the order the checkout is opened with.
  app.post('/razorpay/order', async (req, reply) => {
    const body = BookingBody.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }
    try {
      const gw = requireGateway(gateway)
      const booking = await deps.booking.getBooking(body.data.booking_id, req.headers.authorization!)
      await assertSettlementParty(booking, req.user, deps)

      if (booking.status !== 'completed') {
        throw new PaymentError(
          `A payment can only be made for a 'completed' trip (booking is '${booking.status}')`,
          'INVALID_STATE',
          409,
        )
      }
      const amountPaise = agreedPaise(booking)
      if (amountPaise === null) {
        throw new PaymentError('This booking has no agreed price to pay', 'INVALID_STATE', 409)
      }

      // One booking, one live order. If an earlier order was already PAID the money is
      // in — close the trip on it instead of taking a second payment. Otherwise reuse an
      // open order for the same amount, so a re-opened checkout does not pile up orders.
      const orders = await gw.findOrdersByReceipt(booking.id)
      const paid = paidOrder(orders, booking.id)
      if (paid) {
        const settled = await settleFromOrder(paid, booking, gw, deps, req.user.userId)
        if (settled) return reply.send({ success: true, data: { already_paid: true, settlement: settled } })
      }
      const open = orders.find(
        (o) => o.status !== 'paid' && o.amount === amountPaise && o.currency === 'INR' && orderNote(o, 'booking_id') === booking.id,
      )
      const order = open ?? await gw.createOrder({
        amountPaise,
        receipt: booking.id,
        notes: { booking_id: booking.id, payer_user_id: req.user.userId },
      })

      return reply.send({
        success: true,
        data: {
          already_paid: false,
          order_id: order.id,
          amount: order.amount,
          currency: order.currency,
          key_id: gw.keyId,
          test_mode: gw.testMode,
        },
      })
    } catch (err) {
      return handleError(reply, err)
    }
  })

  // POST /payments/razorpay/verify — the checkout handed the browser three values on
  // success; the signature proves they came from Razorpay for THIS order.
  app.post('/razorpay/verify', async (req, reply) => {
    const body = VerifyBody.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }
    try {
      const gw = requireGateway(gateway)
      const booking = await deps.booking.getBooking(body.data.booking_id, req.headers.authorization!)
      await assertSettlementParty(booking, req.user, deps)

      if (!gw.verifyCheckoutSignature(body.data.razorpay_order_id, body.data.razorpay_payment_id, body.data.razorpay_signature)) {
        throw new PaymentError('Payment signature did not verify', 'VALIDATION_ERROR', 400)
      }

      const order = await gw.fetchOrder(body.data.razorpay_order_id)
      const settled = await settleFromOrder(order, booking, gw, deps, req.user.userId)
      if (!settled) {
        // Signed but not captured yet (rare: capture lags the callback). Nothing is
        // written; the page's sync or the webhook closes the trip once it lands.
        throw new PaymentError('The payment has not been confirmed by the bank yet — check again in a minute', 'PAYMENT_PENDING', 409)
      }
      return reply.send({ success: true, data: settled })
    } catch (err) {
      return handleError(reply, err)
    }
  })

  // POST /payments/razorpay/sync — ask Razorpay whether this booking was already paid,
  // and close the trip if so. Safe to call on every page load of a completed trip.
  app.post('/razorpay/sync', async (req, reply) => {
    const body = BookingBody.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }
    try {
      const gw = requireGateway(gateway)
      const booking = await deps.booking.getBooking(body.data.booking_id, req.headers.authorization!)
      await assertSettlementParty(booking, req.user, deps)

      if (booking.status === 'completed') {
        const paid = paidOrder(await gw.findOrdersByReceipt(booking.id), booking.id)
        if (paid) {
          const settled = await settleFromOrder(paid, booking, gw, deps, req.user.userId)
          if (settled) return reply.send({ success: true, data: { synced: true, ...settled } })
        }
      }
      const payment = await deps.store.getPayment(booking.id)
      const payouts = await deps.store.getPayouts(booking.id)
      return reply.send({
        success: true,
        data: { synced: false, booking_id: booking.id, status: booking.status, payment, ...payoutView(booking, payouts) },
      })
    } catch (err) {
      return handleError(reply, err)
    }
  })
}

// -----------------------------------------------------------
// The webhook — registered in its OWN scope (no JWT: the caller is Razorpay, and the
// signature over the raw body is the authentication).
//
// Configure in the Razorpay dashboard: URL <gateway>/api/payments/razorpay/webhook,
// events `payment.captured` and `order.paid`, secret = RAZORPAY_WEBHOOK_SECRET.
//
// Response contract: 2xx = "do not send this again"; 5xx = "retry". So a delivery we
// cannot act on for a PERMANENT reason (not our order, wrong amount — already logged for
// a person) is acknowledged, and only a transient failure asks for a retry.
// -----------------------------------------------------------

export async function razorpayWebhookRoutes(app: FastifyInstance, opts: RazorpayRouteOptions) {
  const deps: PaymentDeps = opts.deps ?? defaultDeps(app)
  const gateway = opts.gateway === undefined ? defaultGateway() : opts.gateway

  // The signature is over the EXACT bytes Razorpay sent, so the body must not be parsed
  // and re-serialised before it is checked. Scoped to this plugin only.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body))

  app.post('/razorpay/webhook', async (req, reply) => {
    if (!gateway) {
      return reply.status(503).send({ success: false, error: 'Online payment is not switched on yet', code: 'GATEWAY_NOT_CONFIGURED' })
    }
    const raw = typeof req.body === 'string' ? req.body : ''
    const signature = req.headers['x-razorpay-signature']
    if (typeof signature !== 'string' || !gateway.verifyWebhookSignature(raw, signature)) {
      return reply.status(400).send({ success: false, error: 'Webhook signature did not verify', code: 'VALIDATION_ERROR' })
    }

    let event: any
    try { event = JSON.parse(raw) } catch {
      return reply.status(400).send({ success: false, error: 'Webhook body is not JSON', code: 'VALIDATION_ERROR' })
    }
    if (event?.event !== 'payment.captured' && event?.event !== 'order.paid') {
      return reply.send({ success: true, data: { handled: false, reason: 'event ignored' } })
    }
    const orderId: unknown = event?.payload?.payment?.entity?.order_id ?? event?.payload?.order?.entity?.id
    if (typeof orderId !== 'string' || !orderId) {
      return reply.send({ success: true, data: { handled: false, reason: 'no order on this payment' } })
    }

    try {
      // The body told us WHICH order; everything else is read back from Razorpay.
      const order = await gateway.fetchOrder(orderId)
      const bookingId = orderNote(order, 'booking_id')
      if (!bookingId) {
        return reply.send({ success: true, data: { handled: false, reason: 'not a booking order' } })
      }
      const booking = await deps.booking.getBookingInternal(bookingId)
      const settled = await settleFromOrder(order, booking, gateway, deps, booking.shipper_id)
      return reply.send({ success: true, data: { handled: !!settled, booking_id: bookingId } })
    } catch (err) {
      if (err instanceof PaymentError && err.httpStatus < 500) {
        // Permanent for this delivery (booking gone, wrong state, amount mismatch).
        // Logged where it was raised or here; a retry would only repeat it.
        req.log.warn({ order_id: orderId, code: err.code }, `razorpay webhook not applied: ${err.message}`)
        return reply.send({ success: true, data: { handled: false, reason: err.code } })
      }
      req.log.error(err, 'razorpay webhook failed; asking Razorpay to retry')
      return reply.status(500).send({ success: false, error: 'Internal server error' })
    }
  })
}
