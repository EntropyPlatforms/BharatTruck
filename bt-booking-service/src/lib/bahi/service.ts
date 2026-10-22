// -----------------------------------------------------------
// bahi/service — link an account to its Bahi Khata books, and post each paid load there.
//
//   connect     paste a Bahi integration token → pinged, then stored encrypted
//   onPaid      called from markBookingPaid: carrier gets freight income, shipper a freight
//               expense, each ONLY if that account has linked Bahi. Never throws — a payment
//               must not fail because someone's accounting books were unreachable.
//   retry       the account re-posts its own side of one load (Bahi dedupes on the booking id)
//
// Both tables arrive with migration 0043. Until it is applied every read answers "not
// linked" and onPaid does nothing, so this code can deploy ahead of the migration.
// -----------------------------------------------------------

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { supabase } from '../supabase.js'
import { BookingError, type BookingErrorCode } from '../types.js'
import { BahiError, pingBahi, postFreightToBahi } from './client.js'
import { buildFreightBody, type BahiParty } from './posting.js'

type Log = { info?: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void }

const GST_RATES = [0, 5, 12, 18, 28] as const

export const ConnectBodySchema = z.object({
  token: z.string().trim().regex(/^bahi_it_[A-Za-z0-9_-]{32,100}$/, 'Paste the Bahi integration token (it starts with bahi_it_)'),
  gst_rate: z.number().refine((n) => (GST_RATES as readonly number[]).includes(n), 'GST rate must be 0, 5, 12, 18 or 28').default(0),
})
export const SettingsBodySchema = z.object({
  gst_rate: z.number().refine((n) => (GST_RATES as readonly number[]).includes(n), 'GST rate must be 0, 5, 12, 18 or 28'),
})

export type BahiConnectionView = {
  linked: boolean
  company_name: string | null
  gstin: string | null
  gst_rate: number
  linked_at: string | null
  /** False when this deployment cannot store a token (no key) — the card says so instead of failing on save. */
  available: boolean
}

export type BahiPostingView = {
  booking_id: string
  kind: 'income' | 'expense'
  status: 'posted' | 'draft' | 'failed'
  bahi_number: string | null
  bahi_status: string | null
  amount_inr: number | null
  note: string | null
  error: string | null
  updated_at: string
}

// ── token encryption ──────────────────────────────────────────────────────

function keyHex(): string {
  return (process.env.BAHI_CREDENTIALS_KEY ?? process.env.EWB_CREDENTIALS_KEY ?? '').trim()
}
export const bahiStorageConfigured = () => /^[0-9a-fA-F]{64}$/.test(keyHex())

function key(): Buffer {
  if (!bahiStorageConfigured()) {
    throw new BookingError('Bahi linking is not switched on: BAHI_CREDENTIALS_KEY (32-byte hex) is not set', 'NOT_CONFIGURED' as BookingErrorCode, 503)
  }
  return Buffer.from(keyHex(), 'hex')
}

export function sealToken(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`
}

export function openToken(stored: string): string {
  const [iv, tag, enc] = stored.split(':')
  if (!iv || !tag || !enc) throw new BookingError('The stored Bahi token is unreadable — link Bahi again in Settings', 'INTERNAL', 500)
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(enc, 'base64')), decipher.final()]).toString('utf8')
}

// ── storage ───────────────────────────────────────────────────────────────

const missingTable = (error: { code?: string } | null) => error?.code === '42P01' || error?.code === 'PGRST205'

type ConnectionRow = { user_id: string; token_enc: string; company_name: string | null; gstin: string | null; gst_rate: number | string; created_at: string }

async function connectionRow(userId: string): Promise<ConnectionRow | null> {
  const { data, error } = await supabase.from('bahi_connections').select('user_id, token_enc, company_name, gstin, gst_rate, created_at').eq('user_id', userId).maybeSingle()
  if (error) {
    if (missingTable(error)) return null
    throw new Error(`bahi_connections read failed: ${error.message}`)
  }
  return (data as ConnectionRow | null) ?? null
}

export async function connectionView(userId: string): Promise<BahiConnectionView> {
  const row = await connectionRow(userId)
  return {
    linked: !!row,
    company_name: row?.company_name ?? null,
    gstin: row?.gstin ?? null,
    gst_rate: row ? Number(row.gst_rate) : 0,
    linked_at: row?.created_at ?? null,
    available: bahiStorageConfigured(),
  }
}

export async function connect(userId: string, body: { token: string; gst_rate?: number }): Promise<BahiConnectionView> {
  let ping
  try {
    ping = await pingBahi(body.token)
  } catch (err) {
    if (err instanceof BahiError) throw err.toBookingError()
    throw err
  }
  const { error } = await supabase.from('bahi_connections').upsert({
    user_id: userId,
    token_enc: sealToken(body.token),
    company_name: ping.company_name,
    gstin: ping.gstin,
    gst_rate: body.gst_rate ?? 0,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' })
  if (error) {
    if (missingTable(error)) throw new BookingError('Bahi linking is not available yet (migration 0043 not applied)', 'NOT_CONFIGURED' as BookingErrorCode, 503)
    throw new Error(`bahi_connections write failed: ${error.message}`)
  }
  return connectionView(userId)
}

export async function updateSettings(userId: string, body: z.infer<typeof SettingsBodySchema>): Promise<BahiConnectionView> {
  const { data, error } = await supabase.from('bahi_connections').update({ gst_rate: body.gst_rate, updated_at: new Date().toISOString() }).eq('user_id', userId).select('user_id')
  if (error) throw new Error(`bahi_connections update failed: ${error.message}`)
  if (!data?.length) throw new BookingError('Bahi is not linked on this account', 'NOT_FOUND', 404)
  return connectionView(userId)
}

export async function disconnect(userId: string): Promise<void> {
  const { error } = await supabase.from('bahi_connections').delete().eq('user_id', userId)
  if (error && !missingTable(error)) throw new Error(`bahi_connections delete failed: ${error.message}`)
}

export async function recentPostings(userId: string, limit = 20): Promise<BahiPostingView[]> {
  const { data, error } = await supabase.from('bahi_postings')
    .select('booking_id, kind, status, bahi_number, bahi_status, amount_inr, note, error, updated_at')
    .eq('user_id', userId).order('updated_at', { ascending: false }).limit(limit)
  if (error) {
    if (missingTable(error)) return []
    throw new Error(`bahi_postings read failed: ${error.message}`)
  }
  return ((data ?? []) as BahiPostingView[]).map((p) => ({ ...p, amount_inr: p.amount_inr == null ? null : Number(p.amount_inr) }))
}

async function recordPosting(row: {
  booking_id: string; user_id: string; kind: 'income' | 'expense'; status: 'posted' | 'draft' | 'failed'
  bahi_txn_id?: string | null; bahi_number?: string | null; bahi_status?: string | null; amount_inr?: number | null; note?: string | null; error?: string | null
}) {
  const { data: prior } = await supabase.from('bahi_postings').select('attempts').eq('booking_id', row.booking_id).eq('user_id', row.user_id).eq('kind', row.kind).maybeSingle()
  const { error } = await supabase.from('bahi_postings').upsert({
    ...row,
    attempts: ((prior as { attempts?: number } | null)?.attempts ?? 0) + 1,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'booking_id,user_id,kind' })
  if (error && !missingTable(error)) throw new Error(`bahi_postings write failed: ${error.message}`)
}

// ── who is on the load ────────────────────────────────────────────────────

type BookingLike = {
  id: string; shipper_id: string; driver_id: string | null; fleet_owner_id?: string | null
  source_address?: string | null; destination_address?: string | null; weight_kg?: number | null
  final_price?: number | null; quoted_price?: number | null
}

async function userParty(userId: string | null | undefined, nameOverride?: string | null, gstinOverride?: string | null): Promise<BahiParty | null> {
  if (!userId) return null
  const { data, error } = await supabase.from('users').select('id, full_name, email, phone_number, gstin').eq('id', userId).maybeSingle()
  if (error) throw new Error(`users select failed: ${error.message}`)
  const u = data as { id: string; full_name: string | null; email: string | null; phone_number: string | null; gstin: string | null } | null
  if (!u) return null
  const name = (nameOverride || u.full_name || u.email || 'BharatTruck user').trim()
  return { userId: u.id, name, gstin: (gstinOverride || u.gstin || null)?.toUpperCase() ?? null, email: u.email, phone: u.phone_number }
}

export async function bookingParties(b: BookingLike): Promise<{ shipper: BahiParty | null; carrier: BahiParty | null }> {
  const shipper = await userParty(b.shipper_id)
  let carrier: BahiParty | null = null
  if (b.fleet_owner_id) {
    const { data } = await supabase.from('fleet_owners').select('user_id, company_name, gstin').eq('id', b.fleet_owner_id).maybeSingle()
    const o = data as { user_id: string; company_name: string | null; gstin: string | null } | null
    carrier = o ? await userParty(o.user_id, o.company_name, o.gstin) : null
  } else if (b.driver_id) {
    const { data } = await supabase.from('drivers').select('user_id').eq('id', b.driver_id).maybeSingle()
    carrier = await userParty((data as { user_id: string } | null)?.user_id)
  }
  return { shipper, carrier }
}

// ── posting ───────────────────────────────────────────────────────────────

export type PaidDetail = { amount?: number | null; method?: string | null; paymentId?: string | null }

async function postSide(b: BookingLike, kind: 'income' | 'expense', self: BahiParty, other: BahiParty, detail: PaidDetail): Promise<BahiPostingView['status'] | 'skipped'> {
  const conn = await connectionRow(self.userId)
  if (!conn) return 'skipped'
  const paid = Number(detail.amount ?? b.final_price ?? b.quoted_price ?? 0)
  if (!(paid > 0)) return 'skipped'
  const body = buildFreightBody({
    kind, bookingId: b.id, source: b.source_address ?? null, destination: b.destination_address ?? null,
    weightKg: b.weight_kg ?? null, counterparty: other, paid, gstRate: Number(conn.gst_rate), method: detail.method ?? null, paymentId: detail.paymentId ?? null,
  })
  try {
    const res = await postFreightToBahi(openToken(conn.token_enc), body)
    const status = res.status === 'DRAFT' ? 'draft' : 'posted'
    await recordPosting({ booking_id: b.id, user_id: self.userId, kind, status, bahi_txn_id: res.txn_id, bahi_number: res.number, bahi_status: res.status, amount_inr: res.grand_total, note: res.note ?? null, error: null })
    return status
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await recordPosting({ booking_id: b.id, user_id: self.userId, kind, status: 'failed', amount_inr: paid, error: message.slice(0, 300) })
    return 'failed'
  }
}

/** Post a just-paid load to whichever side has linked Bahi. Never throws. */
export async function onBookingPaid(b: BookingLike, detail: PaidDetail, log?: Log): Promise<void> {
  try {
    const { shipper, carrier } = await bookingParties(b)
    if (!shipper || !carrier) return
    const [income, expense] = await Promise.all([
      postSide(b, 'income', carrier, shipper, detail),
      postSide(b, 'expense', shipper, carrier, detail),
    ])
    if (income !== 'skipped' || expense !== 'skipped') log?.info?.({ booking_id: b.id, income, expense }, 'bahi: freight posted')
  } catch (err) {
    log?.warn({ err, booking_id: b.id }, 'bahi: posting skipped after an error')
  }
}

/** The caller re-posts THEIR side of one load. */
export async function retryForUser(b: BookingLike & { status: string }, userId: string): Promise<BahiPostingView[]> {
  if (b.status !== 'paid') throw new BookingError('Only a paid load can be posted to Bahi', 'INVALID_TRANSITION', 409)
  const { shipper, carrier } = await bookingParties(b)
  if (!shipper || !carrier) throw new BookingError('This load has no carrier yet', 'INVALID_TRANSITION', 409)
  const detail: PaidDetail = {}
  // The recorded settlement, when there is one, so a retry posts the same amount and reference.
  const { data: pay } = await supabase.from('payments').select('amount, payment_method, gateway_txn_id').eq('booking_id', b.id).order('created_at', { ascending: false }).limit(1).maybeSingle()
  const p = pay as { amount?: number | string; payment_method?: string | null; gateway_txn_id?: string | null } | null
  if (p?.amount != null) { detail.amount = Number(p.amount); detail.method = p.payment_method ?? null; detail.paymentId = p.gateway_txn_id ?? null }
  if (userId === carrier.userId) await postSide(b, 'income', carrier, shipper, detail)
  else if (userId === shipper.userId) await postSide(b, 'expense', shipper, carrier, detail)
  else throw new BookingError('You are not a party to this load', 'FORBIDDEN', 403)
  return (await recentPostings(userId, 50)).filter((x) => x.booking_id === b.id)
}
