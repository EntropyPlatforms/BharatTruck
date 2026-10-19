import { createHash, randomInt, timingSafeEqual } from 'node:crypto'

// -----------------------------------------------------------
// Receiver-OTP primitives. We NEVER persist the OTP itself — only a
// salted SHA-256 hash (peppered per-booking) goes to Redis, so a
// Redis dump cannot reveal live codes.
// -----------------------------------------------------------

/** Cryptographically-random 6-digit code, zero-padded. */
export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/** Salted hash bound to the booking id (+ optional env pepper). */
export function hashOtp(otp: string, bookingId: string): string {
  const pepper = process.env.POD_OTP_PEPPER ?? ''
  return createHash('sha256').update(`${bookingId}:${otp}:${pepper}`).digest('hex')
}

/** Constant-time hex-string comparison to avoid timing leaks. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}
