import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { BookingError } from '../lib/types.js'
import * as svc from '../lib/service.js'
import * as repo from '../lib/repository.js'
import { emitTripCompleted } from '../lib/payment-emit.js'
import * as notify from '../lib/notifications/emit.js'
import { dispatchBlockedReason, dispatchOnce } from '../lib/notifications/dispatcher.js'
import { mailer } from '../lib/notifications/mailer.js'
import { runAlertSweep } from '../lib/alerts/service.js'
import { AlertsNotMigratedError } from '../lib/alerts/types.js'
import { resolveWhatsAppConfig } from '../lib/whatsapp/config.js'
import { CloudApiSender } from '../lib/whatsapp/client.js'
import { dispatchWhatsAppOnce } from '../lib/whatsapp/service.js'
import { WhatsAppNotMigratedError } from '../lib/whatsapp/repository.js'

// Which alert rules a sweep runs. Two Cloud Scheduler jobs: frequent (GPS silence, every
// 5 minutes) and daily (late starts, unpaid trips, licences — 08:00 IST). See docs/BIBLE.md §7.1.
const SweepQuerySchema = z.object({
  cadence: z.enum(['frequent', 'daily']).default('frequent'),
})

const UuidParamSchema = z.object({ id: z.string().uuid('id must be a valid UUID') })

// Optional settlement detail from bt-payment-service. Every field is optional so an
// older payment-service that posts no body at all keeps working exactly as before —
// markBookingPaid falls back to the booking's own price for the receipt.
const MarkPaidBodySchema = z.object({
  amount:        z.number().positive().optional(),
  method:        z.string().optional(),
  payment_id:    z.string().optional(),
  payout_status: z.string().optional(),
}).optional()

// Cross-service notification triggers. bt-fleet-service and bt-auth-service own these
// domain events but have no dispatcher of their own, so they post the event here and
// this service resolves the audience and queues it.
const NotifyBodySchema = z.discriminatedUnion('event', [
  z.object({
    event:          z.literal('fleet_invite'),
    invite_id:      z.string().uuid(),
    driver_id:      z.string().uuid(),
    fleet_owner_id: z.string().uuid(),
  }),
  z.object({
    event:          z.literal('fleet_invite_answered'),
    invite_id:      z.string().uuid(),
    driver_id:      z.string().uuid(),
    fleet_owner_id: z.string().uuid(),
    response:       z.enum(['accepted', 'declined']),
  }),
  z.object({
    event:      z.literal('password_changed'),
    user_id:    z.string().uuid(),
    changed_at: z.string().optional(),
  }),
])

function handleError(reply: FastifyReply, err: unknown) {
  if (err instanceof BookingError) {
    return reply.status(err.httpStatus).send({ success: false, error: err.message, code: err.code })
  }
  reply.log.error(err, 'Unhandled error in internal routes')
  return reply.status(500).send({ success: false, error: 'Internal server error' })
}

// -----------------------------------------------------------
// internalRoutes — service-to-service routes (internal-secret gated).
// Mounted under /internal; NOT exposed through the public gateway.
// -----------------------------------------------------------

export async function internalRoutes(app: FastifyInstance) {

  // POST /internal/bookings/:id/complete-pod
  // Called by bt-cargo-ledger after a receiver OTP is verified.
  // Drives in_transit → completed through the shared state machine.
  app.post('/bookings/:id/complete-pod', async (req, reply) => {
    const parsed = UuidParamSchema.safeParse(req.params)
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }
    try {
      const booking = await svc.completeBookingViaPod(parsed.data.id, req.log)
      emitTripCompleted(booking, req.log)  // best-effort payout-saga trigger
      return reply.send({ success: true, data: booking })
    } catch (err) {
      return handleError(reply, err)
    }
  })

  // GET /internal/bookings/:id
  // The booking as it is stored, with NO acting user. For a service that has already
  // authenticated its caller another way and has no JWT to forward — bt-payment-service's
  // Razorpay webhook, which must find the booking a captured payment belongs to.
  app.get('/bookings/:id', async (req, reply) => {
    const parsed = UuidParamSchema.safeParse(req.params)
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }
    try {
      const booking = await repo.getBookingById(parsed.data.id)
      if (!booking) throw new BookingError(`Booking ${parsed.data.id} not found`, 'NOT_FOUND', 404)
      return reply.send({ success: true, data: booking })
    } catch (err) {
      return handleError(reply, err)
    }
  })

  // POST /internal/bookings/:id/mark-paid
  // Called by bt-payment-service after a cash/direct settlement is
  // recorded. Drives completed → paid through the shared state machine.
  app.post('/bookings/:id/mark-paid', async (req, reply) => {
    const parsed = UuidParamSchema.safeParse(req.params)
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }
    const body = MarkPaidBodySchema.safeParse(req.body ?? undefined)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }
    try {
      const booking = await svc.markBookingPaid(
        parsed.data.id,
        {
          amount:       body.data?.amount ?? null,
          method:       body.data?.method ?? null,
          paymentId:    body.data?.payment_id ?? null,
          payoutStatus: body.data?.payout_status ?? null,
        },
        req.log,
      )
      return reply.send({ success: true, data: booking })
    } catch (err) {
      return handleError(reply, err)
    }
  })

  // POST /internal/notifications
  // Queue a notification for a domain event owned by another service.
  //
  // The audience resolution (drivers.id -> users.id -> email, fleet owner vs driver)
  // lives here rather than being reimplemented per service. Always 202: a caller must
  // never have its own operation fail because a notification could not be queued.
  app.post('/notifications', async (req, reply) => {
    const parsed = NotifyBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }
    const e = parsed.data
    if (e.event === 'fleet_invite') {
      await notify.emitFleetInvite(
        { inviteId: e.invite_id, driverId: e.driver_id, fleetOwnerId: e.fleet_owner_id },
        req.log,
      )
    } else if (e.event === 'fleet_invite_answered') {
      await notify.emitFleetInviteAnswered(
        {
          inviteId: e.invite_id, driverId: e.driver_id,
          fleetOwnerId: e.fleet_owner_id, response: e.response,
        },
        req.log,
      )
    } else {
      await notify.emitPasswordChanged({ userId: e.user_id, changedAt: e.changed_at }, req.log)
    }
    return reply.status(202).send({ success: true })
  })

  // POST /internal/notifications/dispatch
  // Drain the outbox. THIS IS THE SUPPORTED PRODUCTION TRIGGER: Cloud Run freezes the
  // container between requests unless CPU-always-allocated is set, so an in-process
  // timer does not reliably fire — a request does. Point Cloud Scheduler at this every
  // minute (see docs/BIBLE.md §7.1).
  //
  // Safe to call concurrently: the dispatcher claims each row with a compare-and-swap,
  // so an overlapping tick finds nothing to do rather than sending duplicates.
  app.post('/notifications/dispatch', async (req, reply) => {
    // Refuse rather than drain into the console sender. A 503 here makes the
    // Cloud Scheduler job go red, which is the whole point: a misconfigured
    // service should be loudly broken, not quietly marking mail as delivered.
    const blocked = dispatchBlockedReason()
    if (blocked) {
      req.log.error({ reason: blocked }, 'notification dispatch refused')
      return reply.status(503).send({ success: false, error: blocked, code: 'EMAIL_NOT_CONFIGURED' })
    }
    try {
      const result = await dispatchOnce(mailer(), 25, req.log)
      return reply.send({ success: true, data: result })
    } catch (err) {
      req.log.error(err, 'notification dispatch failed')
      return reply.status(500).send({ success: false, error: 'Dispatch failed' })
    }
  })

  // POST /internal/alerts/sweep?cadence=frequent|daily
  // Run the alert rules and reconcile the alerts table (migration 0042): open new
  // problems, refresh known ones, resolve the ones that cleared, and queue an email for
  // each newly critical one. Called by Cloud Scheduler for the same reason as the
  // dispatcher above — a request is the only thing guaranteed to get CPU on Cloud Run.
  //
  // Safe to overlap: alerts are keyed by dedupe_key and emails by an episode key, so a
  // second concurrent sweep refreshes rows rather than duplicating them.
  app.post('/alerts/sweep', async (req, reply) => {
    const parsed = SweepQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }
    try {
      const result = await runAlertSweep(parsed.data.cadence, new Date(), req.log)
      return reply.send({ success: true, data: result })
    } catch (err) {
      // Loud, like the dispatcher's 503: a Scheduler job hitting an unmigrated database
      // should go red, not report an empty sweep that looks like "nothing is wrong".
      if (err instanceof AlertsNotMigratedError) {
        req.log.error({ reason: err.message }, 'alert sweep refused')
        return reply.status(503).send({ success: false, error: err.message, code: err.code })
      }
      req.log.error(err, 'alert sweep failed')
      return reply.status(500).send({ success: false, error: 'Alert sweep failed' })
    }
  })

  // POST /internal/whatsapp/dispatch
  // Send the queued WhatsApp alerts. Its own Cloud Scheduler job (every minute) rather than
  // a passenger on /notifications/dispatch, because that route refuses with 503 whenever
  // email is not configured — WhatsApp must not depend on SMTP. Overlapping runs are safe:
  // rows are claimed with a compare-and-swap. Loud 503s, like the email drain, so a
  // misconfigured job goes red instead of quietly doing nothing.
  app.post('/whatsapp/dispatch', async (req, reply) => {
    const { config, missing } = resolveWhatsAppConfig()
    if (!config) {
      return reply.status(503).send({ success: false, error: `WhatsApp is not configured (missing ${missing.join(', ')})`, code: 'WHATSAPP_NOT_CONFIGURED' })
    }
    try {
      const result = await dispatchWhatsAppOnce({ config, sender: new CloudApiSender(config), log: req.log })
      return reply.send({ success: true, data: result })
    } catch (err) {
      if (err instanceof WhatsAppNotMigratedError) {
        return reply.status(503).send({ success: false, error: err.message, code: err.code })
      }
      req.log.error(err, 'whatsapp dispatch failed')
      return reply.status(500).send({ success: false, error: 'WhatsApp dispatch failed' })
    }
  })
}
