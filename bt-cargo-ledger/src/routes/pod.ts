import type { FastifyInstance, FastifyReply, FastifyPluginOptions } from 'fastify'
import { z } from 'zod'
import { PodError } from '../lib/errors.js'
import { requestOtp, verifyOtp, type PodDeps } from '../lib/pod-service.js'
import { defaultBookingClient } from '../lib/booking-client.js'
import { defaultEmailSender } from '../lib/email.js'
import { defaultPodStore } from '../lib/pod-store.js'

const RequestOtpBody = z.object({ booking_id: z.string().uuid() })
const VerifyOtpBody  = z.object({
  booking_id: z.string().uuid(),
  otp:        z.string().regex(/^\d{6}$/, 'otp must be 6 digits'),
})

type PodRouteOptions = FastifyPluginOptions & { deps?: PodDeps }

function handleError(reply: FastifyReply, err: unknown) {
  if (err instanceof PodError) {
    return reply.status(err.httpStatus).send({ success: false, error: err.message, code: err.code })
  }
  reply.log.error(err, 'Unhandled error in POD routes')
  return reply.status(500).send({ success: false, error: 'Internal server error' })
}

// -----------------------------------------------------------
// podRoutes — receiver-OTP proof-of-delivery endpoints. Dependencies
// default to the real (Resend / booking-service / Supabase) wiring, but
// tests register with an injected `deps` object.
// -----------------------------------------------------------

export async function podRoutes(app: FastifyInstance, opts: PodRouteOptions) {
  const deps: PodDeps = opts.deps ?? {
    booking: defaultBookingClient(),
    email:   defaultEmailSender(),
    store:   defaultPodStore(),
    logger:  app.log,
  }

  // POST /pod/request-otp — assigned driver issues a receiver OTP.
  // The driver's JWT is forwarded to booking-service for authorization.
  app.post('/request-otp', async (req, reply) => {
    const bearer = req.headers.authorization
    if (!bearer?.startsWith('Bearer ')) {
      return reply.status(401).send({ success: false, error: 'Missing Bearer token', code: 'FORBIDDEN' })
    }
    const body = RequestOtpBody.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }
    try {
      const data = await requestOtp({ bookingId: body.data.booking_id, bearer }, deps)
      return reply.send({ success: true, data })
    } catch (err) {
      return handleError(reply, err)
    }
  })

  // POST /pod/verify-otp — receiver (no account) submits the code.
  // Bounded by TTL + attempt limit; on success the trip is completed.
  app.post('/verify-otp', async (req, reply) => {
    const body = VerifyOtpBody.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }
    try {
      const data = await verifyOtp({ bookingId: body.data.booking_id, otp: body.data.otp }, deps)
      return reply.send({ success: true, data })
    } catch (err) {
      return handleError(reply, err)
    }
  })
}
