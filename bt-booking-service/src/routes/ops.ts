import type { FastifyInstance, FastifyReply, FastifyPluginOptions } from 'fastify'
import { z } from 'zod'
import { BookingError } from '../lib/types.js'
import * as svc from '../lib/service.js'
import { emitTripCompleted } from '../lib/payment-emit.js'
import { type AuditStore, defaultAuditStore } from '../lib/audit.js'

const UuidParam    = z.object({ id: z.string().uuid('id must be a valid UUID') })
const ReassignBody = z.object({ driver_id: z.string().uuid('driver_id must be a valid UUID') })

type OpsRouteOptions = FastifyPluginOptions & { auditStore?: AuditStore }

function handleError(reply: FastifyReply, err: unknown) {
  if (err instanceof BookingError) {
    return reply.status(err.httpStatus).send({ success: false, error: err.message, code: err.code })
  }
  reply.log.error(err, 'Unhandled error in ops routes')
  return reply.status(500).send({ success: false, error: 'Internal server error' })
}

// -----------------------------------------------------------
// opsRoutes — ops/admin manual override tools (mounted under /bookings so
// they reach the app through the existing /api/bookings gateway prefix).
// Both actions write a best-effort ops-override audit row: a failed audit
// must not stop an operator unsticking a trip (and keeps the endpoints
// working before migration 012 lands), so it is logged, never swallowed.
// -----------------------------------------------------------

export async function opsRoutes(app: FastifyInstance, opts: OpsRouteOptions) {
  const audit = opts.auditStore ?? defaultAuditStore()

  // POST /bookings/:id/force-complete — ops force a stuck trip to completed
  app.post('/:id/force-complete', async (req, reply) => {
    const p = UuidParam.safeParse(req.params)
    if (!p.success) return reply.status(400).send({ success: false, error: p.error.errors[0].message, code: 'VALIDATION_ERROR' })
    try {
      const { booking, fromStatus } = await svc.forceCompleteBooking(p.data.id, req.user, req.log)
      emitTripCompleted(booking, req.log) // same payout-saga trigger as normal completion
      try {
        await audit.record({
          booking_id: booking.id, action: 'force_complete', actor_user_id: req.user.userId,
          acted_for_fleet_owner_id: booking.fleet_owner_id ?? null,
          from_status: fromStatus, to_status: 'completed',
          from_driver_id: booking.driver_id, to_driver_id: booking.driver_id,
        })
      } catch (err) {
        req.log.warn({ err, booking_id: booking.id }, 'ops_overrides audit write failed (override applied)')
      }
      return reply.send({ success: true, data: booking })
    } catch (err) {
      return handleError(reply, err)
    }
  })

  // POST /bookings/:id/reassign {driver_id} — ops reassign the driver
  app.post('/:id/reassign', async (req, reply) => {
    const p = UuidParam.safeParse(req.params)
    if (!p.success) return reply.status(400).send({ success: false, error: p.error.errors[0].message, code: 'VALIDATION_ERROR' })
    const b = ReassignBody.safeParse(req.body)
    if (!b.success) return reply.status(400).send({ success: false, error: b.error.errors[0].message, code: 'VALIDATION_ERROR' })
    try {
      const { booking, fromDriverId } = await svc.reassignBooking(p.data.id, b.data.driver_id, req.user, req.log)
      try {
        await audit.record({
          booking_id: booking.id, action: 'reassign', actor_user_id: req.user.userId,
          acted_for_fleet_owner_id: booking.fleet_owner_id ?? null,
          from_status: booking.status, to_status: booking.status,
          from_driver_id: fromDriverId, to_driver_id: b.data.driver_id,
        })
      } catch (err) {
        req.log.warn({ err, booking_id: booking.id }, 'ops_overrides audit write failed (reassign applied)')
      }
      return reply.send({ success: true, data: booking })
    } catch (err) {
      return handleError(reply, err)
    }
  })
}
