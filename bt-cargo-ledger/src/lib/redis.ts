import { Redis } from 'ioredis'

const url = process.env.REDIS_URL
if (!url) throw new Error('REDIS_URL must be set')

export const redis = new Redis(url, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
})

// Receiver OTP is short-lived and attempt-bounded (D: security).
export const OTP_TTL_SECONDS   = 600  // 10 minutes
export const MAX_VERIFY_ATTEMPTS = 5

// Ephemeral OTP record: JSON { hash, receiver_email } under a per-booking key.
export const podOtpKey      = (bookingId: string) => `pod:otp:${bookingId}`
// Monotonic verify-attempt counter, TTL-bound to the OTP window.
export const podAttemptsKey = (bookingId: string) => `pod:otp-attempts:${bookingId}`
