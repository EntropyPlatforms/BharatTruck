import { getSupabase } from './supabase.js'

// -----------------------------------------------------------
// PaymentStore — durable money records (payments + payouts, migration
// 011). Injected as a dependency so it is faked in tests. Unlike the
// best-effort breadcrumb/POD writes, money writes are HARD: a failure
// must surface (never silently "succeed"), so settle() lets store
// errors propagate.
//
// Payout writes are READ-THEN-INSERT-OR-UPDATE, never ON CONFLICT.
// PostgREST's `on_conflict=` has to name a real unique constraint, so an
// upsert inferring on (booking_id, payee_type) raises 42P10 against any
// schema where migration 0023 has not been applied yet — and migrations in
// this project are applied BY HAND while .github/workflows/deploy.yml
// auto-deploys this service on any bt-payment-service/** change. Inferring
// would therefore make EVERY settlement 500 between the merge and the
// migration. Deciding insert-vs-update from the rows we already have to read
// (settle() reconciles the payee set anyway) removes that coupling outright:
// the same code runs unchanged on the pre-0023 and post-0023 schema.
//
// The uniqueness constraint is still the real guard, it is just no longer the
// thing the QUERY depends on: two racing settles both read "no row" and both
// INSERT, and the constraint turns the loser into a 23505 rather than a second
// payout row. That surfaces as a 500 with no payments row written, so the
// retry re-reads and takes the UPDATE branch. Losing the race is a retry;
// losing the constraint would be a double payout.
// -----------------------------------------------------------

export type PaymentMode = 'cash' | 'upi' | 'direct'

// freight_term — how the freight is billed on a booking's lorry receipt
// (migration 0024). Only 'TO_PAY' matters to settlement authorization: it is the
// consignee-pays consignment, the one case where the RECEIVER, not the shipper,
// is the paying party and may therefore record the settlement (D-22 consignee).
export type FreightTerm = 'PAID' | 'TO_PAY' | 'TO_BE_BILLED'

// status MUST be a value the live payments_status_check allows
// (pending|captured|settled|failed|refunded). A cash settlement is terminal, so
// 'settled'. It is NOT 'recorded' — that violated the constraint and 500'd every
// settlement (payouts use a separate, laxer status vocabulary; see payment-service.ts).
export const PAYMENT_STATUS_SETTLED = 'settled' as const

// An ONLINE collection (lib/online-payment.ts) is mode 'razorpay' / status 'captured',
// with the gateway's payment id as the reference. 'razorpay' is deliberately NOT a
// PaymentMode: that type is also `payouts.mode`, whose CHECK allows only cash|upi|direct.
export type PaymentRecord = {
  booking_id: string
  amount: number
  mode: PaymentMode | 'razorpay'
  reference: string | null
  recorded_by: string
  status: 'settled' | 'captured'
}

// The payout goes to WHOEVER MADE THE WINNING BID (founder Q15): a solo
// driver, or the fleet owner who bid on their fleet's behalf. Migration 016
// enforces the pairing with a CHECK (payee_type='driver' ⇒ driver_id NOT NULL,
// 'fleet_owner' ⇒ fleet_owner_id NOT NULL), so the two fields are never set
// independently — always build this via resolvePayees().
export type PayoutPayee =
  | { payee_type: 'driver'; driver_id: string; fleet_owner_id: null }
  | { payee_type: 'fleet_owner'; driver_id: null; fleet_owner_id: string }

export type PayoutRecord = PayoutPayee & {
  booking_id: string
  amount: number
  mode: PaymentMode | null
  status: 'pending' | 'recorded'
  recorded_by: string | null
}

// 23505 — unique_violation. On `payouts` it means one of exactly two things,
// and the message says both because they need very different responses:
// another settle raced us onto the same (booking_id, payee_type) row (retry
// heals it), or the table still carries migration 011's UNIQUE(booking_id) and
// physically cannot hold the second row of a D-7 split (apply 0023). Never
// swallowed on the settle path — a swallowed one is a payee silently unpaid.
const UNIQUE_VIOLATION = '23505'

// Postgres/PostgREST codes that mean "this schema predates the column/table",
// as opposed to "the query failed". Only the former may be swallowed: a
// pre-0022 database has no revenue_share_pct and must keep behaving exactly as
// it does today (share 0 = salaried), whereas a transport or permission failure
// that we silently read as 0 would quietly pay a split driver nothing.
const SCHEMA_ABSENT_CODES = new Set(['42703', '42P01', 'PGRST204', 'PGRST205'])

// PAYEE-ROW ADDRESSING — how a single payout row is named in a WHERE clause.
//
// `payee_type` arrives in migration 0016 and cannot be referenced before it:
// PostgREST rejects a filter on a column the table does not have (42703). But
// on a POST-0016 table booking_id alone addresses BOTH rows of a split, so
// filtering on it alone would update or delete the wrong payee.
//
// So the caller passes which addressing the live table supports, and it is not
// a guess: settle() reads the booking's payouts with select('*') first, and a
// returned row that carries a `payee_type` key IS the proof that the column
// exists. Deriving it from the data avoids a schema probe and cannot drift.
export type PayoutKey = { bookingId: string; payeeType: PayoutPayee['payee_type']; keyByPayeeType: boolean }

// DriverShare — what the winning carrier's affiliation records say about the driver
// who actually RAN the trip. Not a bare percentage, because the ways of arriving at
// 0 are not the same fact and must not be paid out as if they were (D-24):
//
//   'affiliated' — a fleet_drivers row governs the pairing. share_pct 0 means
//                  SALARIED: the owner keeps the freight and pays the driver off
//                  the platform. That is all 620 live rows.
//   'none'       — no fleet_drivers row pairs this driver with this carrier at all.
//                  The truck ran, the driver ran it, and the two parties have no
//                  standing term between them — D-24's sub-contracted case. There
//                  is nothing to split on, which is an ANOMALY, not a salary.
//   'unknown'    — the schema cannot answer: a database predating migration 0022
//                  has no revenue_share_pct column, and on it every fleet trip is
//                  salaried. That is today's behaviour, so it must stay silent —
//                  flagging an anomaly on every fleet settlement would be noise.
export type DriverShare = {
  affiliation: 'affiliated' | 'none' | 'unknown'
  /** The driver's cut of a fleet-won trip, 0..100. 0 on every branch with nothing to read. */
  share_pct: number
  /** The governing affiliation's status ('active'|'suspended'|'left'); null when there is no row. */
  status: string | null
}

export interface PaymentStore {
  getPayment(bookingId: string): Promise<PaymentRecord | null>
  insertPayment(row: PaymentRecord): Promise<void>
  /** Every payee on this booking. 0..2 rows: the bidder, plus the D-7 split driver. */
  getPayouts(bookingId: string): Promise<PayoutRecord[]>
  /** settle path — a payee that has no row yet. Raises on 23505 (see UNIQUE_VIOLATION). */
  insertPayout(row: PayoutRecord): Promise<void>
  /** settle path — overwrite the row this payee already has (amount, mode, status, recorder). */
  updatePayout(row: PayoutRecord, keyByPayeeType: boolean): Promise<void>
  /** settle path — drop the row of a payee this settlement does not pay. */
  deletePayout(key: PayoutKey): Promise<void>
  /** saga path — create a 'pending' payout only if none exists yet. */
  insertPendingPayoutIfAbsent(row: PayoutRecord): Promise<void>
  /** D-7/D-24 — the executing driver's cut of a fleet-won trip, and whether an affiliation backs it. */
  getDriverShare(fleetOwnerId: string, driverId: string): Promise<DriverShare>
  /**
   * D-22 — the booking's freight billing term, off its lorry receipt. Drives the
   * consignee-pays settlement gate. null when the booking has no LR yet (or the
   * schema predates 0024), which authorizes NOBODY new — a safe deny.
   */
  getFreightTerm(bookingId: string): Promise<FreightTerm | null>
}

// wirePayout — the row as it goes over the wire to PostgREST.
//
// A DRIVER payout writes the EXACT pre-fleet column set. `payee_type` and
// `fleet_owner_id` arrive in migration 0016, and 0016 is NOT a prerequisite for a
// solo-driver settlement — which is 100% of settlements today. PostgREST rejects
// the entire write when the payload names a column the table does not have
// (PGRST204 / 42703), so sending them unconditionally would break the only
// settlement path that currently exists. `payouts.payee_type` defaults to
// 'driver' once 0016 lands, so omitting it is correct on both schemas.
//
// A FLEET payout necessarily runs on a post-0016 database — a fleet booking
// cannot exist without that migration — so it sends both columns.
//
// The D-7 split's DRIVER row rides the same branch and stays correct there:
// `payouts.payee_type` defaults to 'driver', so the omitted column lands as
// exactly the value `payouts_one_per_payee` and every later read needs it to be
// — including the reconciliation read that decides insert vs update vs delete.
export function wirePayout(row: PayoutRecord): Record<string, unknown> {
  const { payee_type, fleet_owner_id, ...base } = row
  return payee_type === 'fleet_owner' ? { ...base, payee_type, fleet_owner_id } : base
}

export class SupabasePaymentStore implements PaymentStore {
  async getPayment(bookingId: string): Promise<PaymentRecord | null> {
    const { data, error } = await getSupabase().from('payments').select('*').eq('booking_id', bookingId).maybeSingle()
    if (error) throw new Error(`payments read failed: ${error.message}`)
    return (data as PaymentRecord) ?? null
  }

  async insertPayment(row: PaymentRecord): Promise<void> {
    const { error } = await getSupabase().from('payments').insert(row)
    if (error) throw new Error(`payments insert failed: ${error.message}`)
  }

  // NOT maybeSingle(). A split booking has two payout rows and maybeSingle()
  // fails outright (PGRST116) rather than returning either of them, so keeping
  // it would turn the first split settlement into a 500 on the read-back.
  async getPayouts(bookingId: string): Promise<PayoutRecord[]> {
    const { data, error } = await getSupabase().from('payouts').select('*').eq('booking_id', bookingId)
    if (error) throw new Error(`payouts read failed: ${error.message}`)
    return (data as PayoutRecord[]) ?? []
  }

  async insertPayout(row: PayoutRecord): Promise<void> {
    const { error } = await getSupabase().from('payouts').insert(wirePayout(row))
    if (!error) return
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      // Spelled out because the two causes are indistinguishable from the code
      // alone and the operator response is opposite: wait-and-retry vs apply a
      // migration. Whoever reads this in a log should not have to guess.
      throw new Error(
        `payouts insert hit a unique violation for booking ${row.booking_id} payee ${row.payee_type}: ` +
        'either a concurrent settle already wrote this payee (retry heals it), or public.payouts still ' +
        'carries migration 011\'s UNIQUE(booking_id) and cannot hold the second row of a D-7 split ' +
        `(apply supabase/migrations/0023_payout_split.sql). Underlying: ${error.message}`,
      )
    }
    throw new Error(`payouts insert failed: ${error.message}`)
  }

  async updatePayout(row: PayoutRecord, keyByPayeeType: boolean): Promise<void> {
    let q = getSupabase().from('payouts').update(wirePayout(row)).eq('booking_id', row.booking_id)
    if (keyByPayeeType) q = q.eq('payee_type', row.payee_type)
    const { error } = await q
    if (error) throw new Error(`payouts update failed: ${error.message}`)
  }

  async deletePayout(key: PayoutKey): Promise<void> {
    let q = getSupabase().from('payouts').delete().eq('booking_id', key.bookingId)
    if (key.keyByPayeeType) q = q.eq('payee_type', key.payeeType)
    const { error } = await q
    if (error) throw new Error(`payouts delete failed: ${error.message}`)
  }

  // saga path — "create it if it is not there". Read-then-insert for the same
  // reason as the settle path (no ON CONFLICT inference, so no 0023 coupling),
  // but a 23505 IS swallowed here, unlike on the settle path: losing the race
  // means somebody else created the very row this call wanted to exist, which
  // is success. This row is provisional and settle() reconciles it either way.
  async insertPendingPayoutIfAbsent(row: PayoutRecord): Promise<void> {
    const existing = await this.getPayouts(row.booking_id)
    if (existing.some((r) => (r.payee_type ?? 'driver') === row.payee_type)) return

    const { error } = await getSupabase().from('payouts').insert(wirePayout(row))
    if (!error || (error as { code?: string }).code === UNIQUE_VIOLATION) return
    throw new Error(`payouts pending-insert failed: ${error.message}`)
  }

  // D-7 — the driver's share of a fleet-won trip, read off the AFFILIATION
  // (fleet_drivers), which is where the standing employment term lives; it is
  // deliberately not per-trip and not per-truck.
  //
  // Row choice matters because affiliations accumulate history: a driver holds
  // at most one live row but any number of closed ones. An 'active' row is the
  // governing agreement and wins outright. Otherwise the newest row for the
  // pair is used, which is what pays a driver who completed the trip and then
  // left the fleet before settlement — the alternative silently hands their cut
  // to the owner. 'pending'/'rejected' are excluded: an invite that was never
  // accepted agreed no terms.
  //
  // D-24 — "which row governs" and "is there a row at all" are answered
  // SEPARATELY. This used to return a bare number, so no-affiliation collapsed
  // into the salaried 0 and a driver executing a trip for a fleet they do not
  // belong to was paid nothing, silently. The caller cannot act on a fact this
  // method throws away, so it is carried out instead.
  async getDriverShare(fleetOwnerId: string, driverId: string): Promise<DriverShare> {
    const { data, error } = await getSupabase()
      .from('fleet_drivers')
      .select('status, revenue_share_pct')
      .eq('fleet_owner_id', fleetOwnerId)
      .eq('driver_id', driverId)
      .in('status', ['active', 'suspended', 'left'])
      .order('updated_at', { ascending: false })

    if (error) {
      // A database that predates migration 0022 has no revenue_share_pct at
      // all, and on it EVERY booking is salaried — which is today's behaviour
      // and must stay reachable. Anything else is a real failure and propagates
      // (the payout write is the first write, so settle() leaves no trace and
      // the retry replays cleanly).
      if (SCHEMA_ABSENT_CODES.has((error as { code?: string }).code ?? '')) {
        return { affiliation: 'unknown', share_pct: 0, status: null }
      }
      throw new Error(`fleet_drivers read failed: ${error.message}`)
    }

    const rows = (data as Array<{ status: string; revenue_share_pct: number | null }>) ?? []
    const governing = rows.find((r) => r.status === 'active') ?? rows[0]
    // No row at all — the fact the old bare-number return destroyed. A driver whose
    // only link to this fleet is an invite they never accepted lands here too, since
    // 'pending'/'rejected' are filtered out above, and that is the right reading: an
    // unaccepted invite is no more a wage agreement than no invite at all.
    if (!governing) return { affiliation: 'none', share_pct: 0, status: null }

    const pct = Number(governing.revenue_share_pct ?? 0)
    return { affiliation: 'affiliated', share_pct: Number.isFinite(pct) ? pct : 0, status: governing.status }
  }

  // D-22 — the freight term off the booking's lorry receipt. One LR per booking
  // (documents converge on the single document the consignee holds), so
  // maybeSingle(). Read only when a consignee is asking to settle, so it costs
  // one indexed lookup on that path alone.
  async getFreightTerm(bookingId: string): Promise<FreightTerm | null> {
    const { data, error } = await getSupabase()
      .from('lorry_receipts')
      .select('freight_term')
      .eq('booking_id', bookingId)
      .maybeSingle()

    if (error) {
      // A database predating migration 0024 has no lorry_receipts table / column
      // at all; on it there is no consignee-pays term to honour, which is a safe
      // DENY rather than a failure. Mirrors getDriverShare's schema-absent branch.
      if (SCHEMA_ABSENT_CODES.has((error as { code?: string }).code ?? '')) return null
      throw new Error(`lorry_receipts read failed: ${error.message}`)
    }
    return (data as { freight_term?: FreightTerm } | null)?.freight_term ?? null
  }
}

export function defaultPaymentStore(): PaymentStore {
  return new SupabasePaymentStore()
}
