import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { getRedis } from './redis.js'
import { FleetError } from './types.js'

// -----------------------------------------------------------
// invite-link — a shareable "join my fleet" link, with NO database table.
//
// THE LINK IS THE OWNER'S APPROVAL. An owner (or a manage_drivers delegate) makes a link and
// shares it however they like (WhatsApp, SMS); any driver who opens it and accepts joins the
// fleet as ACTIVE straight away. So the link is a bearer credential and is built like one:
//
//   token = base64url(payload) "." base64url(HMAC-SHA256(key, base64url(payload)))
//   payload = { v: 1, f: fleet_owners.id, n: random nonce, e: expiry (unix seconds) }
//
// STATELESS SIGNATURE, ONE REDIS KEY FOR REVOCATION. The signature proves the service minted
// the token and that nobody changed the fleet id or the expiry; the expiry (7 days) is enforced
// here, server-side. What a signature alone cannot do is "Make a new link" — so the CURRENT
// link of each fleet is kept in Redis (the same Redis the live map already uses), as
// fleet:{id}:invite_link = { n, e, by } with a TTL that ends when the link does. A token is
// only honoured while its nonce is that fleet's current one: making a new link overwrites the
// key and every older link stops working at once; turning the link off deletes it. If the key
// is ever lost (Redis flushed), links simply stop working and the owner makes a new one — the
// safe direction. A Redis error FAILS CLOSED (503): a link we cannot check is never accepted.
//
// THE KEY. Derived from JWT_SECRET (which this service already requires to boot) with a fixed
// label, so no new env var is needed and an invite token can never be confused with — or
// replayed as — a login JWT, which is signed with JWT_SECRET itself.
//
// NEVER LOG A TOKEN. Nothing here logs; callers receive the token only in request BODIES (not
// URLs), and the app keeps it in the URL fragment (/join#…), which browsers never send to any
// server — so it cannot land in gateway or Cloud Run request logs either.
// -----------------------------------------------------------

export const INVITE_LINK_TTL_DAYS = 7
const TTL_MS = INVITE_LINK_TTL_DAYS * 24 * 60 * 60 * 1000
const TOKEN_FORMAT = 1
const KEY_LABEL = 'bt-fleet-service/driver-invite-link/v1'
// A real token is ~140 characters; anything far longer is not one of ours and is refused before
// any decoding work is done on it.
export const MAX_TOKEN_LENGTH = 512

export type InviteLinkPayload = { v: 1; f: string; n: string; e: number }

/** The record kept per fleet: the current nonce, its expiry (unix s) and who made it (users.id). */
export type InviteLinkRecord = { n: string; e: number; by: string }

// ── Signing (pure) ────────────────────────────────────────────

function signingKey(): Buffer {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new FleetError('Invite links are not configured on this server', 'MISCONFIGURED', 500)
  return createHmac('sha256', secret).update(KEY_LABEL).digest()
}

function mac(body: string): Buffer {
  return createHmac('sha256', signingKey()).update(body).digest()
}

export function signInviteLink(payload: InviteLinkPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${mac(body).toString('base64url')}`
}

export type VerifyFailure = 'malformed' | 'bad_signature' | 'expired'
export type VerifyResult = { ok: true; payload: InviteLinkPayload } | { ok: false; reason: VerifyFailure }

const TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// verifyInviteLink — PURE apart from reading the key. Order matters: the signature is checked
// (in constant time) BEFORE the payload is parsed, so nothing an attacker writes is ever
// interpreted unless the service signed it; only then is the expiry looked at.
export function verifyInviteLink(token: unknown, nowMs = Date.now()): VerifyResult {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !TOKEN_SHAPE.test(token)) {
    return { ok: false, reason: 'malformed' }
  }
  const [body, sig] = token.split('.')
  const given = Buffer.from(sig, 'base64url')
  const expected = mac(body)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad_signature' }
  }

  let p: unknown
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { return { ok: false, reason: 'malformed' } }
  const payload = p as Partial<InviteLinkPayload> | null
  if (
    !payload || payload.v !== TOKEN_FORMAT ||
    typeof payload.f !== 'string' || !UUID.test(payload.f) ||
    typeof payload.n !== 'string' || payload.n.length < 16 ||
    typeof payload.e !== 'number' || !Number.isFinite(payload.e)
  ) {
    return { ok: false, reason: 'malformed' }
  }
  if (payload.e * 1000 <= nowMs) return { ok: false, reason: 'expired' }
  return { ok: true, payload: payload as InviteLinkPayload }
}

// ── The per-fleet "current link" store ────────────────────────

export interface InviteLinkStore {
  get(fleetOwnerId: string): Promise<InviteLinkRecord | null>
  set(fleetOwnerId: string, record: InviteLinkRecord, ttlMs: number): Promise<void>
  del(fleetOwnerId: string): Promise<void>
}

export const inviteLinkKey = (fleetOwnerId: string) => `fleet:${fleetOwnerId}:invite_link`

const redisStore: InviteLinkStore = {
  async get(id) {
    const raw = await getRedis().get(inviteLinkKey(id))
    if (!raw) return null
    try {
      const r = JSON.parse(raw) as InviteLinkRecord
      return typeof r?.n === 'string' && typeof r?.e === 'number' ? r : null
    } catch {
      return null
    }
  },
  async set(id, record, ttlMs) {
    await getRedis().set(inviteLinkKey(id), JSON.stringify(record), 'PX', Math.max(1, Math.ceil(ttlMs)))
  },
  async del(id) {
    await getRedis().del(inviteLinkKey(id))
  },
}

let store: InviteLinkStore = redisStore

/** Tests only: swap the Redis-backed store for an in-memory one. */
export function setInviteLinkStoreForTests(s: InviteLinkStore | null): void {
  store = s ?? redisStore
}

// Every store call goes through here so a Redis outage is one clear 503 — never a generic 500,
// and never a link accepted without its revocation check.
async function withStore<T>(fn: (s: InviteLinkStore) => Promise<T>): Promise<T> {
  try {
    return await fn(store)
  } catch (err) {
    if (err instanceof FleetError) throw err
    throw new FleetError('Invite links are unavailable right now — please try again in a minute', 'SERVICE_UNAVAILABLE', 503)
  }
}

export type InviteLinkView = { token: string; expires_at: string; created_by: string }

function view(fleetOwnerId: string, r: InviteLinkRecord): InviteLinkView {
  // Deterministic: the same record always re-signs to the same token, so the owner can be shown
  // their current link again without it changing.
  return {
    token: signInviteLink({ v: TOKEN_FORMAT, f: fleetOwnerId, n: r.n, e: r.e }),
    expires_at: new Date(r.e * 1000).toISOString(),
    created_by: r.by,
  }
}

/** The fleet's live link, or null when there is none (never made, expired, turned off). */
export async function getCurrentInviteLink(fleetOwnerId: string, nowMs = Date.now()): Promise<InviteLinkView | null> {
  const r = await withStore(s => s.get(fleetOwnerId))
  if (!r || r.e * 1000 <= nowMs) return null
  return view(fleetOwnerId, r)
}

/** Make a new link. Replaces — and so immediately invalidates — any earlier one. */
export async function createInviteLink(fleetOwnerId: string, createdBy: string, nowMs = Date.now()): Promise<InviteLinkView> {
  const record: InviteLinkRecord = {
    n: randomBytes(16).toString('base64url'),
    e: Math.floor((nowMs + TTL_MS) / 1000),
    by: createdBy,
  }
  await withStore(s => s.set(fleetOwnerId, record, record.e * 1000 - nowMs))
  return view(fleetOwnerId, record)
}

/** Turn the link off: every outstanding link for this fleet stops working. */
export async function revokeInviteLink(fleetOwnerId: string): Promise<void> {
  await withStore(s => s.del(fleetOwnerId))
}

export type ResolvedInviteLink = { fleetOwnerId: string; record: InviteLinkRecord; expiresAt: string }

// resolveInviteLink — token -> the fleet it admits to, or a FleetError the app can explain.
// Signature, then expiry, then "is this still the fleet's current link?".
export async function resolveInviteLink(token: unknown, nowMs = Date.now()): Promise<ResolvedInviteLink> {
  const v = verifyInviteLink(token, nowMs)
  if (!v.ok) {
    if (v.reason === 'expired') {
      throw new FleetError('This invite link has expired. Ask the fleet owner to send you a new one.', 'LINK_EXPIRED', 410)
    }
    throw new FleetError('This invite link is not valid. Check that you opened the whole link, or ask for a new one.', 'LINK_INVALID', 400)
  }
  const { f, n, e } = v.payload
  const current = await withStore(s => s.get(f))
  if (!current || current.n !== n || current.e !== e) {
    throw new FleetError('This invite link has been replaced or turned off. Ask the fleet owner for their latest link.', 'LINK_REPLACED', 410)
  }
  return { fleetOwnerId: f, record: current, expiresAt: new Date(e * 1000).toISOString() }
}
