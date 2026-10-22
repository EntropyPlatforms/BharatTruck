// -----------------------------------------------------------
// bahi/store — no database migration: the Bahi link lives in the booking service's Redis.
//
//   bahi:conn:{userId}            the link: Bahi's REFRESH token (AES-256-GCM sealed), the Bahi
//                                 login email, company, GST rate. The password is never stored.
//   bahi:post:{bookingId}:{kind}  what was posted for one side of one load (dedupe + status)
//   bahi:recent:{userId}          sorted set of that account's postings, newest first (≤ 50)
//   bahi:lock:{userId}            30 s lock: Bahi rotates the refresh token on every use, so two
//                                 concurrent refreshes would invalidate each other
//
// No TTL on conn/post: the instance is the TLS endpoint the location pipeline already relies
// on. If it were ever flushed, an account simply links again; a lost post record cannot
// double-book a PAID load because Bahi's payment is idempotent on our request_id.
// -----------------------------------------------------------

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { BookingError, type BookingErrorCode } from '../types.js'

export type RedisLike = {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>
  del(key: string): Promise<unknown>
  zadd(key: string, score: number, member: string): Promise<unknown>
  zrevrange(key: string, start: number, stop: number): Promise<string[]>
  zremrangebyrank(key: string, start: number, stop: number): Promise<unknown>
}

let injected: RedisLike | null = null
/** Tests only: replace the Redis client. */
export function __setBahiRedisForTests(r: RedisLike | null) { injected = r }
// Lazy: lib/redis.ts connects at import, which must not happen in tests or on a cold path.
async function redis(): Promise<RedisLike> {
  if (injected) return injected
  return (await import('../redis.js')).redis as unknown as RedisLike
}

// ── sealing ───────────────────────────────────────────────────────────────

const keyHex = () => (process.env.BAHI_CREDENTIALS_KEY ?? process.env.EWB_CREDENTIALS_KEY ?? '').trim()
export const bahiStorageConfigured = () => /^[0-9a-fA-F]{64}$/.test(keyHex())

function key(): Buffer {
  if (!bahiStorageConfigured()) {
    throw new BookingError('Bahi linking is not switched on: BAHI_CREDENTIALS_KEY (32-byte hex) is not set', 'NOT_CONFIGURED' as BookingErrorCode, 503)
  }
  return Buffer.from(keyHex(), 'hex')
}
export function seal(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`
}
export function unseal(stored: string): string {
  const [iv, tag, enc] = stored.split(':')
  if (!iv || !tag || !enc) throw new BookingError('The stored Bahi link is unreadable — link Bahi again in Settings', 'INTERNAL', 500)
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'))
  d.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8')
}

// ── records ───────────────────────────────────────────────────────────────

export type ConnRecord = {
  refresh_sealed: string
  email: string
  company_name: string | null
  gstin: string | null
  gst_rate: number
  linked_at: string
  refreshed_at: string
}

export type PostStatus = 'posted' | 'awaiting_approval' | 'draft' | 'failed'
export type PostRecord = {
  booking_id: string
  user_id: string
  kind: 'income' | 'expense'
  status: PostStatus
  bahi_txn_id: string | null
  bahi_number: string | null
  amount_inr: number | null
  /** What the Bahi payment must carry, kept so an approval that lands later settles the same amount. */
  pay: { amount: number; date: string; reference: string | null; mode: string } | null
  approval_email: string | null
  note: string | null
  error: string | null
  attempts: number
  updated_at: string
}

const connKey = (u: string) => `bahi:conn:${u}`
const postKey = (b: string, k: string) => `bahi:post:${b}:${k}`
const recentKey = (u: string) => `bahi:recent:${u}`
const lockKey = (u: string) => `bahi:lock:${u}`

export async function getConn(userId: string): Promise<ConnRecord | null> {
  const raw = await (await redis()).get(connKey(userId))
  return raw ? (JSON.parse(raw) as ConnRecord) : null
}
export async function putConn(userId: string, c: ConnRecord) { await (await redis()).set(connKey(userId), JSON.stringify(c)) }
export async function delConn(userId: string) { await (await redis()).del(connKey(userId)) }

export async function getPost(bookingId: string, kind: string): Promise<PostRecord | null> {
  const raw = await (await redis()).get(postKey(bookingId, kind))
  return raw ? (JSON.parse(raw) as PostRecord) : null
}
export async function putPost(p: PostRecord) {
  const r = await redis()
  await r.set(postKey(p.booking_id, p.kind), JSON.stringify(p))
  await r.zadd(recentKey(p.user_id), Date.now(), `${p.booking_id}:${p.kind}`)
  await r.zremrangebyrank(recentKey(p.user_id), 0, -51)
}
export async function recentPosts(userId: string, limit = 20): Promise<PostRecord[]> {
  const members = await (await redis()).zrevrange(recentKey(userId), 0, limit - 1)
  const out: PostRecord[] = []
  for (const m of members) {
    const i = m.lastIndexOf(':')
    const p = await getPost(m.slice(0, i), m.slice(i + 1))
    if (p) out.push(p)
  }
  return out
}

/** Run fn holding the account's lock; null when another run holds it. */
export async function withLock<T>(userId: string, fn: () => Promise<T>): Promise<T | null> {
  const r = await redis()
  const token = randomBytes(8).toString('hex')
  const ok = await r.set(lockKey(userId), token, 'EX', 30, 'NX')
  if (ok !== 'OK') return null
  try { return await fn() } finally {
    if ((await r.get(lockKey(userId))) === token) await r.del(lockKey(userId))
  }
}
