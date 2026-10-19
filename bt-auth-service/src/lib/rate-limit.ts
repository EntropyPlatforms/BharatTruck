import type { Redis } from 'ioredis'

// -----------------------------------------------------------
// Redis counter primitives for the auth throttles.
//
// Two shapes, because the two jobs count different things:
//
//   consume()        — every call counts. For actions that are themselves the
//                      cost (sending an email), where a "successful" call is
//                      exactly what we are limiting.
//   recordFailure()  — only failures count, and a success wipes the slate. For
//                      password login, where a legitimate user typing their
//                      password correctly must never be throttled.
//
// Deliberately not a Lua script or a sliding window: INCR + EXPIRE is what the
// pre-existing /send-otp and /forgot-password guards already use, it is atomic
// enough for a fixed window (worst case an attacker straddles two windows and
// gets 2x the limit for one burst), and matching the established pattern beats
// introducing a second mechanism to reason about.
//
// No fail-open handling: a Redis outage throws, and the route 500s. That is
// already the de-facto behaviour of every auth path here — login cannot issue a
// refresh token without Redis either — so swallowing errors would only buy an
// attacker a rate-limit bypass by knocking Redis over.
// -----------------------------------------------------------

export type RateVerdict = {
  allowed: boolean
  /** Attempts used in the current window, including this one. */
  count: number
  /** Seconds until the window resets. 0 while still allowed. */
  retryAfterS: number
}

/** Count this call against `key`. Allowed while the window total is <= limit. */
export async function consume(redis: Redis, key: string, limit: number, windowS: number): Promise<RateVerdict> {
  const count = await redis.incr(key)
  // Only the call that created the key sets the TTL, so a burst cannot keep
  // pushing the expiry out and turn a fixed window into a permanent block.
  if (count === 1) await redis.expire(key, windowS)
  if (count <= limit) return { allowed: true, count, retryAfterS: 0 }
  const ttl = await redis.ttl(key)
  return { allowed: false, count, retryAfterS: ttl > 0 ? ttl : windowS }
}

/** Read the failure tally without spending an attempt. */
export async function isLockedOut(redis: Redis, key: string, limit: number): Promise<RateVerdict> {
  const raw = await redis.get(key)
  const count = raw ? Number(raw) : 0
  if (count < limit) return { allowed: true, count, retryAfterS: 0 }
  const ttl = await redis.ttl(key)
  return { allowed: false, count, retryAfterS: ttl > 0 ? ttl : 0 }
}

/** Charge one failure against `key`, starting the window if this is the first. */
export async function recordFailure(redis: Redis, key: string, windowS: number): Promise<number> {
  const count = await redis.incr(key)
  if (count === 1) await redis.expire(key, windowS)
  return count
}

/** Wipe the tally — call on the success that proves the actor is legitimate. */
export async function clearFailures(redis: Redis, key: string): Promise<void> {
  await redis.del(key)
}

/** Read a positive integer from the environment, falling back when unset/invalid. */
export function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isInteger(v) && v > 0 ? v : fallback
}
