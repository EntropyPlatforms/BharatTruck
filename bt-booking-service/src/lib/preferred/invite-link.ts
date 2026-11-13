// ============================================================
// src/lib/preferred/invite-link.ts
//
// A shipper's "work with me" link, with NO database table. The same design as the fleet's
// driver invite link (bt-fleet-service/src/lib/invite-link.ts), read that header for the full
// reasoning; in short:
//
//   token = base64url(payload) "." base64url(HMAC-SHA256(key, base64url(payload)))
//   payload = { v: 1, s: shipper users.id, n: random nonce, e: expiry (unix seconds) }
//
// THE LINK IS THE SHIPPER'S APPROVAL. Any fleet owner, or driver with their own truck, who
// opens it and accepts lands on that shipper's Preferred list (a row in
// shipper_preferred_carriers, migration 0044), exactly as if the shipper had starred them.
// Nothing else is granted: no load, no booking, no access to the shipper's data.
//
// ONE REDIS KEY PER SHIPPER for "make a new link" / "turn it off": shipper:{id}:carrier_invite
// = { n, e, by }. A token is honoured only while its nonce is the shipper's current one. A
// Redis error FAILS CLOSED (503). The signing key is derived from JWT_SECRET with its own label,
// so this token can never be replayed as a login JWT or as a fleet's driver-invite token.
//
// NEVER LOG A TOKEN: it travels only in request bodies, and the app keeps it in the URL
// fragment (/join/carrier#...), which browsers never send to a server.
// ============================================================

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { BookingError } from '../types.js'

export const CARRIER_INVITE_TTL_DAYS = 30
const TTL_MS = CARRIER_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000
const TOKEN_FORMAT = 1
const KEY_LABEL = 'bt-booking-service/shipper-carrier-invite/v1'
export const MAX_TOKEN_LENGTH = 512

export type CarrierInvitePayload = { v: 1; s: string; n: string; e: number }
export type CarrierInviteRecord = { n: string; e: number; by: string }

function signingKey(): Buffer {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new BookingError('Invite links are not configured on this server', 'INTERNAL', 500)
  return createHmac('sha256', secret).update(KEY_LABEL).digest()
}

const mac = (body: string) => createHmac('sha256', signingKey()).update(body).digest()

export function signCarrierInvite(payload: CarrierInvitePayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${mac(body).toString('base64url')}`
}

export type VerifyResult =
  | { ok: true; payload: CarrierInvitePayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' }

const TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Signature first (constant time), only then parse, only then expiry. */
export function verifyCarrierInvite(token: unknown, nowMs = Date.now()): VerifyResult {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !TOKEN_SHAPE.test(token)) {
    return { ok: false, reason: 'malformed' }
  }
  const [body, sig] = token.split('.')
  const given = Buffer.from(sig, 'base64url')
  const expected = mac(body)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'bad_signature' }

  let p: unknown
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { return { ok: false, reason: 'malformed' } }
  const payload = p as Partial<CarrierInvitePayload> | null
  if (
    !payload || payload.v !== TOKEN_FORMAT ||
    typeof payload.s !== 'string' || !UUID.test(payload.s) ||
    typeof payload.n !== 'string' || payload.n.length < 16 ||
    typeof payload.e !== 'number' || !Number.isFinite(payload.e)
  ) return { ok: false, reason: 'malformed' }
  if (payload.e * 1000 <= nowMs) return { ok: false, reason: 'expired' }
  return { ok: true, payload: payload as CarrierInvitePayload }
}

// ── The per-shipper "current link" store ──────────────────────

export interface CarrierInviteStore {
  get(shipperId: string): Promise<CarrierInviteRecord | null>
  set(shipperId: string, record: CarrierInviteRecord, ttlMs: number): Promise<void>
  del(shipperId: string): Promise<void>
}

export const carrierInviteKey = (shipperId: string) => `shipper:${shipperId}:carrier_invite`

// Lazy import: lib/redis.ts throws at import time without REDIS_URL, and the pure parts of this
// module (sign/verify) must stay importable by unit tests that have no Redis.
async function client() {
  return (await import('../redis.js')).redis
}

const redisStore: CarrierInviteStore = {
  async get(id) {
    const raw = await (await client()).get(carrierInviteKey(id))
    if (!raw) return null
    try {
      const r = JSON.parse(raw) as CarrierInviteRecord
      return typeof r?.n === 'string' && typeof r?.e === 'number' ? r : null
    } catch {
      return null
    }
  },
  async set(id, record, ttlMs) {
    await (await client()).set(carrierInviteKey(id), JSON.stringify(record), 'PX', Math.max(1, Math.ceil(ttlMs)))
  },
  async del(id) {
    await (await client()).del(carrierInviteKey(id))
  },
}

let store: CarrierInviteStore = redisStore

/** Tests only: swap the Redis-backed store for an in-memory one. */
export function setCarrierInviteStoreForTests(s: CarrierInviteStore | null): void {
  store = s ?? redisStore
}

async function withStore<T>(fn: (s: CarrierInviteStore) => Promise<T>): Promise<T> {
  try {
    return await fn(store)
  } catch (err) {
    if (err instanceof BookingError) throw err
    throw new BookingError('Invite links are unavailable right now. Please try again in a minute.', 'UPSTREAM_ERROR', 503)
  }
}

export type CarrierInviteView = { token: string; expires_at: string }

function view(shipperId: string, r: CarrierInviteRecord): CarrierInviteView {
  return {
    token: signCarrierInvite({ v: TOKEN_FORMAT, s: shipperId, n: r.n, e: r.e }),
    expires_at: new Date(r.e * 1000).toISOString(),
  }
}

export async function getCurrentCarrierInvite(shipperId: string, nowMs = Date.now()): Promise<CarrierInviteView | null> {
  const r = await withStore((s) => s.get(shipperId))
  if (!r || r.e * 1000 <= nowMs) return null
  return view(shipperId, r)
}

/** Make a new link; any earlier one stops working at once. */
export async function createCarrierInvite(shipperId: string, nowMs = Date.now()): Promise<CarrierInviteView> {
  const record: CarrierInviteRecord = {
    n: randomBytes(16).toString('base64url'),
    e: Math.floor((nowMs + TTL_MS) / 1000),
    by: shipperId,
  }
  await withStore((s) => s.set(shipperId, record, record.e * 1000 - nowMs))
  return view(shipperId, record)
}

export async function revokeCarrierInvite(shipperId: string): Promise<void> {
  await withStore((s) => s.del(shipperId))
}

/** token -> the shipper it is for, or a BookingError the app can show as is. */
export async function resolveCarrierInvite(token: unknown, nowMs = Date.now()): Promise<{ shipperId: string; expiresAt: string }> {
  const v = verifyCarrierInvite(token, nowMs)
  if (!v.ok) {
    if (v.reason === 'expired') {
      throw new BookingError('This invite link has expired. Ask the shipper to send you a new one.', 'VALIDATION_ERROR', 410)
    }
    throw new BookingError('This invite link is not valid. Check that you opened the whole link, or ask for a new one.', 'VALIDATION_ERROR', 400)
  }
  const { s, n, e } = v.payload
  const current = await withStore((st) => st.get(s))
  if (!current || current.n !== n || current.e !== e) {
    throw new BookingError('This invite link has been replaced or turned off. Ask the shipper for their latest link.', 'VALIDATION_ERROR', 410)
  }
  return { shipperId: s, expiresAt: new Date(e * 1000).toISOString() }
}
