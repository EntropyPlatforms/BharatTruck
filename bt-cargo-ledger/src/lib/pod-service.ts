import { redis, podOtpKey, podAttemptsKey, OTP_TTL_SECONDS, MAX_VERIFY_ATTEMPTS } from './redis.js'
import { generateOtp, hashOtp, safeEqualHex } from './otp.js'
import { buildOtpEmail, type EmailSender } from './email.js'
import type { BookingClient } from './booking-client.js'
import type { PodStore } from './pod-store.js'
import { PodError } from './errors.js'

// -----------------------------------------------------------
// PodService — receiver-OTP proof-of-delivery that closes a trip.
// Dependencies (booking-service client, email sender, durable store)
// are injected so the whole flow is verifiable with fakes + real Redis.
// -----------------------------------------------------------

export type PodDeps = {
  booking: BookingClient
  email: EmailSender
  store: PodStore
  logger?: { warn(obj: unknown, msg: string): void }
}

type OtpRecord = { hash: string; receiver_email: string }

function maskEmail(email: string): string {
  const [user, domain] = email.split('@')
  if (!domain) return '***'
  const head = user.slice(0, 1)
  return `${head}${'*'.repeat(Math.max(1, user.length - 1))}@${domain}`
}

// requestOtp — assigned driver asks to issue a receiver OTP. Authorization
// (driver owns booking, trip is in_transit) is delegated to booking-service
// via the forwarded JWT; on success we issue a code and email the consignee.
export async function requestOtp(
  args: { bookingId: string; bearer: string },
  deps: PodDeps,
): Promise<{ booking_id: string; sent_to: string; expires_in_seconds: number }> {
  const ctx = await deps.booking.getPodContext(args.bookingId, args.bearer)
  if (!ctx.receiver_email) {
    throw new PodError('Booking has no receiver_email set for POD', 'NO_RECEIVER_EMAIL', 409)
  }

  const otp = generateOtp()
  const record: OtpRecord = { hash: hashOtp(otp, args.bookingId), receiver_email: ctx.receiver_email }

  const pipeline = redis.pipeline()
  pipeline.set(podOtpKey(args.bookingId), JSON.stringify(record), 'EX', OTP_TTL_SECONDS)
  pipeline.del(podAttemptsKey(args.bookingId)) // fresh code → reset attempt budget
  await pipeline.exec()

  await deps.email.send(
    buildOtpEmail(ctx.receiver_email, otp, Math.round(OTP_TTL_SECONDS / 60), args.bookingId),
  )

  return {
    booking_id: args.bookingId,
    sent_to: maskEmail(ctx.receiver_email),
    expires_in_seconds: OTP_TTL_SECONDS,
  }
}

// verifyOtp — receiver submits the code. Attempt-bounded + TTL-bounded.
// On the correct code we ask booking-service to run in_transit → completed
// (the state machine stays there), then best-effort record the POD artifact.
export async function verifyOtp(
  args: { bookingId: string; otp: string },
  deps: PodDeps,
): Promise<{ booking_id: string; status: string }> {
  const raw = await redis.get(podOtpKey(args.bookingId))
  if (!raw) {
    throw new PodError('No active OTP — it expired or was never requested', 'OTP_EXPIRED', 410)
  }
  const record = JSON.parse(raw) as OtpRecord

  const attempts = await redis.incr(podAttemptsKey(args.bookingId))
  if (attempts === 1) {
    await redis.expire(podAttemptsKey(args.bookingId), OTP_TTL_SECONDS)
  }
  if (attempts > MAX_VERIFY_ATTEMPTS) {
    await redis.del(podOtpKey(args.bookingId)) // burn the code after too many tries
    throw new PodError('Too many incorrect attempts — request a new code', 'RATE_LIMITED', 429)
  }

  if (!safeEqualHex(hashOtp(args.otp, args.bookingId), record.hash)) {
    throw new PodError('Incorrect delivery code', 'OTP_INVALID', 400)
  }

  // Correct code → booking-service performs the in_transit → completed transition.
  const result = await deps.booking.completeViaPod(args.bookingId)

  // One-time code: clear it so it can't be replayed.
  await redis.del(podOtpKey(args.bookingId), podAttemptsKey(args.bookingId))

  // Durable POD artifact is best-effort — the trip is already completed upstream.
  try {
    await deps.store.record({
      booking_id: args.bookingId,
      receiver_email: record.receiver_email,
      verified_via: 'receiver_otp',
    })
  } catch (err) {
    deps.logger?.warn({ err, booking_id: args.bookingId }, 'POD receipt persist failed (trip already completed)')
  }

  return { booking_id: args.bookingId, status: result.status }
}
