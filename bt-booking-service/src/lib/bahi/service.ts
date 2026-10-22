// -----------------------------------------------------------
// bahi/service — post each paid load into the Bahi Khata books of whoever linked Bahi, using
// ONLY Bahi's existing API (no Bahi change, no database migration here — see store.ts).
//
//   connect       Bahi login once (owner/manager). The password is used for that one call and
//                 dropped; only Bahi's rotating refresh token is kept, sealed.
//   onBookingPaid called from markBookingPaid; never throws.
//                   shipper  → purchase invoice from the carrier → submitted → paid   (posted)
//                   carrier  → sales invoice to the shipper → Bahi emails the shipper an
//                              approval link (Bahi requires it for every sales invoice) →
//                              once approved: submitted → paid                     (posted)
//   syncPending   finishes approvals that have landed, retries failures
// -----------------------------------------------------------

import { z } from 'zod'
import { supabase } from '../supabase.js'
import { BookingError, type BookingErrorCode } from '../types.js'
import { bahi, BahiError, type BahiPartyRow } from './client.js'
import { buildFreightBody, type BahiParty } from './posting.js'
import * as store from './store.js'

type Log = { info?: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void }

const GST_RATES = [0, 5, 12, 18, 28] as const
const gstRate = z.number().refine((n) => (GST_RATES as readonly number[]).includes(n), 'GST rate must be 0, 5, 12, 18 or 28')
const FREIGHT_ITEM = { name: 'Freight charges', hsn_sac: '996511' }
const PRIVILEGED = new Set(['ADMIN', 'MANAGER'])
const KEEPALIVE_MS = 15 * 24 * 3600_000 // Bahi refresh tokens live 30 days from their last use

export const ConnectBodySchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter the email you sign in to Bahi with'),
  password: z.string().min(1, 'Enter your Bahi password').max(128),
  gst_rate: gstRate.optional(),
})
export const SettingsBodySchema = z.object({ gst_rate: gstRate })

export type BahiConnectionView = {
  linked: boolean
  email: string | null
  company_name: string | null
  gstin: string | null
  gst_rate: number
  linked_at: string | null
  available: boolean
}
export type BahiPostingView = Pick<store.PostRecord, 'booking_id' | 'kind' | 'status' | 'bahi_number' | 'amount_inr' | 'note' | 'error' | 'updated_at'>

const nowIso = () => new Date().toISOString()
const toView = (p: store.PostRecord): BahiPostingView => ({
  booking_id: p.booking_id, kind: p.kind, status: p.status, bahi_number: p.bahi_number,
  amount_inr: p.amount_inr, note: p.note, error: p.error, updated_at: p.updated_at,
})
const linkError = (msg: string, status = 400) => new BookingError(msg, 'BAHI_LINK' as BookingErrorCode, status)

// ── link ──────────────────────────────────────────────────────────────────

export async function connect(userId: string, body: { email: string; password: string; gst_rate?: number }): Promise<BahiConnectionView> {
  if (!store.bahiStorageConfigured()) store.seal('') // throws the NOT_CONFIGURED explanation
  let tokens
  try {
    tokens = await bahi.login(body.email, body.password)
  } catch (err) {
    if (err instanceof BahiError) throw linkError(err.httpStatus === 401 ? 'Bahi did not accept that email and password.' : err.message, err.httpStatus === 401 ? 400 : 502)
    throw err
  }
  if (!tokens.refresh_token) throw linkError('This Bahi deployment does not issue refresh tokens, so BharatTruck cannot stay linked.', 502)
  if (!PRIVILEGED.has(String(tokens.user?.role ?? '').toUpperCase())) {
    throw linkError('Link Bahi with an owner or manager login — Bahi only lets those record payments.')
  }
  const company = await bahi.company(tokens.access_token).catch(() => ({ name: null, gstin: null }))
  const at = nowIso()
  await store.putConn(userId, {
    refresh_sealed: store.seal(tokens.refresh_token),
    email: body.email,
    company_name: company.name,
    gstin: company.gstin,
    gst_rate: body.gst_rate ?? 0,
    linked_at: at,
    refreshed_at: at,
  })
  return connectionView(userId)
}

/** A fresh access token; rotates and re-seals the refresh token. Caller must hold the lock. */
async function accessToken(userId: string): Promise<string> {
  const conn = await store.getConn(userId)
  if (!conn) throw linkError('Bahi is not linked on this account', 404)
  try {
    const t = await bahi.refresh(store.unseal(conn.refresh_sealed))
    await store.putConn(userId, { ...conn, refresh_sealed: store.seal(t.refresh_token), refreshed_at: nowIso() })
    return t.access_token
  } catch (err) {
    if (err instanceof BahiError && (err.httpStatus === 401 || err.httpStatus === 403)) {
      throw linkError('The Bahi link has expired (unused for 30 days, or signed out). Link Bahi again in Settings.', 409)
    }
    throw err
  }
}

export async function connectionView(userId: string): Promise<BahiConnectionView> {
  let conn = await store.getConn(userId).catch(() => null)
  // Keep the link alive: Bahi's refresh token lapses 30 days after its last use.
  if (conn && Date.now() - Date.parse(conn.refreshed_at) > KEEPALIVE_MS) {
    await store.withLock(userId, () => accessToken(userId)).catch(() => null)
    conn = await store.getConn(userId).catch(() => conn)
  }
  return {
    linked: !!conn,
    email: conn?.email ?? null,
    company_name: conn?.company_name ?? null,
    gstin: conn?.gstin ?? null,
    gst_rate: conn?.gst_rate ?? 0,
    linked_at: conn?.linked_at ?? null,
    available: store.bahiStorageConfigured(),
  }
}

export async function updateSettings(userId: string, body: { gst_rate: number }): Promise<BahiConnectionView> {
  const conn = await store.getConn(userId)
  if (!conn) throw linkError('Bahi is not linked on this account', 404)
  await store.putConn(userId, { ...conn, gst_rate: body.gst_rate })
  return connectionView(userId)
}

export async function disconnect(userId: string): Promise<void> {
  await store.delConn(userId)
}

export async function recentPostings(userId: string): Promise<BahiPostingView[]> {
  return (await store.recentPosts(userId).catch(() => [])).map(toView)
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
  return {
    userId: u.id,
    name: (nameOverride || u.full_name || u.email || 'BharatTruck user').trim(),
    gstin: (gstinOverride || u.gstin || null)?.toUpperCase() ?? null,
    email: u.email,
    phone: u.phone_number,
  }
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

// ── posting through Bahi's API ────────────────────────────────────────────

async function ensureParty(t: string, p: BahiParty, role: 'CUSTOMER' | 'SUPPLIER'): Promise<string> {
  const all = await bahi.parties(t)
  const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()
  const hit: BahiPartyRow | undefined =
    (p.gstin ? all.find((x) => (x.gstin ?? '').toUpperCase() === p.gstin) : undefined) ??
    all.find((x) => norm(x.legal_name) === norm(p.name) && (!x.gstin || !p.gstin) && norm(x.email) === norm(p.email))
  if (hit) return hit.id
  const created = await bahi.createParty(t, {
    legal_name: p.name, gstin: p.gstin, email: p.email, phone: p.phone,
    party_type: p.gstin ? 'ORGANIZATION' : 'INDIVIDUAL', role_type: role,
  })
  return created.id
}

async function ensureFreightItem(t: string, rate: number): Promise<string> {
  const hit = (await bahi.items(t)).find((i) => i.name === FREIGHT_ITEM.name && i.hsn_sac === FREIGHT_ITEM.hsn_sac && Number(i.is_stock_item) === 0)
  if (hit) return hit.id
  return (await bahi.createItem(t, { name: FREIGHT_ITEM.name, hsn_sac: FREIGHT_ITEM.hsn_sac, stock_uom: 'TRIP', gst_rate: rate, is_stock_item: false })).id
}

const requestId = (rec: Pick<store.PostRecord, 'kind' | 'booking_id'>) => `BT-${rec.kind}-${rec.booking_id}`

async function submitAndPay(t: string, rec: store.PostRecord): Promise<store.PostRecord> {
  try {
    await bahi.submit(t, rec.bahi_txn_id!)
  } catch (err) {
    // A resumed post may already be submitted; Bahi says so, and the payment below decides.
    if (!(err instanceof BahiError && /already submitted/i.test(err.message))) throw err
  }
  if (rec.pay) {
    await bahi.pay(t, {
      invoice_id: rec.bahi_txn_id!, amount: rec.pay.amount, payment_type: rec.kind === 'income' ? 'RECEIVE' : 'PAY',
      mode: rec.pay.mode, request_id: requestId(rec), payment_date: rec.pay.date, reference: rec.pay.reference,
      note: `BharatTruck load ${rec.booking_id}`,
    })
  }
  return { ...rec, status: 'posted', note: null, error: null }
}

/** Move one record forward as far as Bahi allows right now. Caller holds the lock. */
async function advance(t: string, rec: store.PostRecord): Promise<store.PostRecord> {
  if (rec.status === 'posted' || !rec.bahi_txn_id) return rec
  if (rec.kind === 'expense') return submitAndPay(t, rec)
  const approval = await bahi.approval(t, rec.bahi_txn_id)
  if (approval?.status === 'APPROVED') return submitAndPay(t, rec)
  if (approval?.status === 'PENDING') return { ...rec, status: 'awaiting_approval', error: null }
  if (approval && ['REJECTED', 'EXPIRED', 'REVOKED'].includes(approval.status)) {
    return { ...rec, status: 'draft', error: null, note: `The shipper's approval is ${approval.status.toLowerCase()} — resend it from the invoice in Bahi.` }
  }
  // No approval request yet (e.g. the send failed last time): send it now.
  if (!rec.approval_email) return { ...rec, status: 'draft', note: 'The shipper has no email, so Bahi cannot ask them to approve. Submit it in Bahi yourself.' }
  try {
    await bahi.sendApproval(t, rec.bahi_txn_id, rec.approval_email)
  } catch (err) {
    // 502 = the request was created but Bahi's email failed; it can be resent from Bahi.
    if (!(err instanceof BahiError && err.httpStatus === 502)) throw err
    return { ...rec, status: 'awaiting_approval', note: `Approval created but Bahi could not email ${rec.approval_email} — resend it from Bahi.` }
  }
  return { ...rec, status: 'awaiting_approval', error: null, note: `Approval emailed to ${rec.approval_email}; it posts with its payment once they approve.` }
}

export type PaidDetail = { amount?: number | null; method?: string | null; paymentId?: string | null }
type SideResult = store.PostStatus | 'skipped' | 'busy'

async function postSide(b: BookingLike, kind: 'income' | 'expense', self: BahiParty, other: BahiParty, detail: PaidDetail): Promise<SideResult> {
  const conn = await store.getConn(self.userId)
  if (!conn) return 'skipped'
  const existing = await store.getPost(b.id, kind)
  if (existing?.status === 'posted') return 'posted'
  const paid = Number(detail.amount ?? b.final_price ?? b.quoted_price ?? 0)
  if (!(paid > 0)) return 'skipped'

  const outcome = await store.withLock(self.userId, async (): Promise<SideResult> => {
    let rec: store.PostRecord = existing ?? {
      booking_id: b.id, user_id: self.userId, kind, status: 'failed', bahi_txn_id: null, bahi_number: null,
      amount_inr: null, pay: null, approval_email: kind === 'income' ? other.email : null, note: null, error: null, attempts: 0, updated_at: nowIso(),
    }
    rec = { ...rec, attempts: rec.attempts + 1 }
    try {
      const t = await accessToken(self.userId)
      if (!rec.bahi_txn_id) {
        const body = buildFreightBody({
          kind, bookingId: b.id, source: b.source_address ?? null, destination: b.destination_address ?? null,
          weightKg: b.weight_kg ?? null, counterparty: other, paid, gstRate: conn.gst_rate, method: detail.method ?? null, paymentId: detail.paymentId ?? null,
        })
        const partyId = await ensureParty(t, other, kind === 'income' ? 'CUSTOMER' : 'SUPPLIER')
        const itemId = await ensureFreightItem(t, conn.gst_rate)
        const txn = await bahi.createTransaction(t, {
          txn_type: kind === 'income' ? 'SINV' : 'PI', party_id: partyId, date: body.date,
          items: [{ item_id: itemId, qty: 1, rate: body.amount, gst_rate: body.gst_rate }],
        })
        const full = await bahi.transaction(t, txn.id).catch(() => ({} as Record<string, unknown>))
        rec = {
          ...rec, bahi_txn_id: txn.id, bahi_number: (full.naming_series as string) ?? null, amount_inr: Number(txn.grand_total),
          pay: { amount: Number(txn.grand_total), date: body.payment.date, reference: body.payment.reference, mode: body.payment.mode }, status: 'draft',
        }
        await store.putPost({ ...rec, updated_at: nowIso() }) // the draft exists in Bahi now: never create it twice
      }
      rec = await advance(t, rec)
    } catch (err) {
      rec = { ...rec, status: 'failed', error: (err instanceof Error ? err.message : String(err)).slice(0, 300) }
    }
    await store.putPost({ ...rec, updated_at: nowIso() })
    return rec.status
  })
  return outcome ?? 'busy'
}

/** Post a just-paid load to whichever side linked Bahi. Never throws. */
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

/** Finish approvals that have landed and retry failures, for one account. */
export async function syncPending(userId: string): Promise<BahiPostingView[]> {
  if (!(await store.getConn(userId))) throw linkError('Bahi is not linked on this account', 404)
  const open = (await store.recentPosts(userId, 50)).filter((p) => p.status === 'awaiting_approval' || (p.status === 'failed' && p.bahi_txn_id))
  if (open.length) {
    const done = await store.withLock(userId, async () => {
      const t = await accessToken(userId)
      for (const p of open) {
        let rec: store.PostRecord
        try { rec = await advance(t, { ...p, attempts: p.attempts + 1 }) } catch (err) { rec = { ...p, attempts: p.attempts + 1, status: 'failed', error: (err as Error).message.slice(0, 300) } }
        await store.putPost({ ...rec, updated_at: nowIso() })
      }
      return true
    })
    if (done === null) throw linkError('Bahi is busy with another post for this account — try again in a moment.', 409)
  }
  return recentPostings(userId)
}

/** The caller re-posts THEIR side of one paid load. */
export async function retryForUser(b: BookingLike & { status: string }, userId: string): Promise<BahiPostingView[]> {
  if (b.status !== 'paid') throw new BookingError('Only a paid load can be posted to Bahi', 'INVALID_TRANSITION', 409)
  const { shipper, carrier } = await bookingParties(b)
  if (!shipper || !carrier) throw new BookingError('This load has no carrier yet', 'INVALID_TRANSITION', 409)
  const detail: PaidDetail = {}
  const { data: pay } = await supabase.from('payments').select('amount, payment_method, gateway_txn_id').eq('booking_id', b.id).order('created_at', { ascending: false }).limit(1).maybeSingle()
  const p = pay as { amount?: number | string; payment_method?: string | null; gateway_txn_id?: string | null } | null
  if (p?.amount != null) { detail.amount = Number(p.amount); detail.method = p.payment_method ?? null; detail.paymentId = p.gateway_txn_id ?? null }
  let r: SideResult
  if (userId === carrier.userId) r = await postSide(b, 'income', carrier, shipper, detail)
  else if (userId === shipper.userId) r = await postSide(b, 'expense', shipper, carrier, detail)
  else throw new BookingError('You are not a party to this load', 'FORBIDDEN', 403)
  if (r === 'skipped') throw linkError('Link Bahi in Settings first', 409)
  if (r === 'busy') throw linkError('Bahi is busy with another post for this account — try again in a moment.', 409)
  return (await recentPostings(userId)).filter((x) => x.booking_id === b.id)
}
