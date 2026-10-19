import type { BookingClient, BookingView } from './booking-client.js'
import type { DriverShare, PaymentStore, PaymentMode, PayoutPayee, PayoutRecord, PayoutKey } from './payment-store.js'
import { PaymentError } from './errors.js'
import { emitTripEconomics } from './fleet-emit.js'
import type { AuthenticatedUser } from '../plugins/auth.js'
import { relationsToBooking, type PersonaSnapshot, type ViewerBooking } from '@bharattruck/shared/personas'
import type { UserRole } from '@bharattruck/shared/auth'

// -----------------------------------------------------------
// PaymentService — cash-recorded settlement (no escrow). The ONLINE collection
// (Razorpay checkout) lives beside it in online-payment.ts and reuses the payee
// resolution + payout reconciliation below.
// Records a direct/UPI/cash settlement against a COMPLETED booking,
// records the payout(s) — one per payee, since a fleet trip may split
// the freight with its driver (D-7) — and asks booking-service to run
// completed → paid. Fully idempotent + self-healing: a retried settle
// never double-records and heals a partial (payment recorded but the
// paid-flip lost). Deps are injected for verification.
// -----------------------------------------------------------

export type PaymentDeps = {
  booking: BookingClient
  store: PaymentStore
  // Resolve the caller's emergent-persona snapshot (@bharattruck/shared) so
  // settlement authorizes on RELATION-TO-BOOKING, never the JWT role string
  // (D-27). Injected for verification; the routes bind it to the service-role
  // client. The saga path (onTripCompleted) never calls it, but shares this type.
  resolvePersonas: (userId: string, primaryPersona: UserRole) => Promise<PersonaSnapshot>
  logger?: { warn(obj: unknown, msg: string): void }
}

export type SettleArgs = {
  bookingId: string
  amount: number
  mode: PaymentMode
  reference: string | null
}

// agreedPrice — what this booking is contractually worth, using the SAME
// precedence as every other consumer of a booking's money (booking-service's
// mark-paid receipt and payment-emit both read `final_price ?? quoted_price`):
// a negotiated/auction-won price supersedes the original quote.
//
// Returns null when the booking names no usable price at all. That is not a
// settlement blocker — refusing to settle a priced-at-nothing booking would
// strand the trip in `completed` forever with no operator recourse, which is
// exactly the kind of dead-end the receiver-email gap already taught us to
// avoid. Callers skip reconciliation and log instead.
export function agreedPrice(booking: { quoted_price?: number | null; final_price?: number | null }): number | null {
  const agreed = booking.final_price ?? booking.quoted_price
  return typeof agreed === 'number' && Number.isFinite(agreed) && agreed > 0 ? agreed : null
}

// Whole rupees everywhere upstream (the pricing engine Math.ceil()s every
// component), so this only absorbs float representation noise — never a real
// discount. One paisa.
const AMOUNT_EPSILON = 0.01

// A payee and what they are owed out of one settlement. Deliberately free of
// booking_id/mode/status so a later disbursement layer (Razorpay Route, D-12 —
// NOT this slice) can consume the same shape without going near the ledger.
export type PayoutSplit = PayoutPayee & { amount: number }

// resolvePayees — who gets paid, and how much, for ONE settled trip.
//
// The contract with the shipper is still with WHOEVER MADE THE BID (Q15): a
// solo driver, or the fleet owner who bid on their fleet's behalf. What D-7
// adds is that the bid money may then be shared with the driver who actually
// ran the trip, per `fleet_drivers.revenue_share_pct` — a standing term of the
// affiliation, set by the owner.
//
//   solo booking                 -> [driver 100%]
//   fleet booking, share = 0     -> [fleet_owner 100%]   (salaried; today's behaviour)
//   fleet booking, share = 30    -> [fleet_owner 70%, driver 30%]
//   fleet booking, share = 100   -> [driver 100%]
//
// Returns [] when the booking names no bidder at all; callers decide whether
// that is fatal. A payee whose share works out to nothing is dropped rather
// than written as a ₹0 row — an empty payout is not a fact about the trip, it
// is noise in the ledger and a disbursement the bank would reject.
//
// `driverSharePct` is a parameter, not a lookup, so this stays pure: the whole
// split is testable without a database, and the caller decides whether reading
// the affiliation is even appropriate (the saga path deliberately does not —
// see onTripCompleted).
export function resolvePayees(
  booking: { driver_id: string | null; fleet_owner_id?: string | null },
  amount: number,
  driverSharePct = 0,
): PayoutSplit[] {
  if (booking.fleet_owner_id) {
    const owner: PayoutPayee = { payee_type: 'fleet_owner', fleet_owner_id: booking.fleet_owner_id, driver_id: null }

    // Clamped rather than trusted: the DB CHECK holds 0..100 today, but this
    // number decides who gets the money and a bad one would either overpay the
    // driver or hand the owner a negative payout.
    const pct = Number.isFinite(driverSharePct) ? Math.min(Math.max(driverSharePct, 0), 100) : 0
    if (pct === 0 || !booking.driver_id) return [{ ...owner, amount }]

    // Split in whole PAISE, which is the precision `payouts.amount numeric(12,2)`
    // actually stores. Doing it in rupee floats lets a 33.33% share land on a
    // fraction of a paisa that the column then rounds independently per row —
    // and two independently-rounded rows do not have to add up.
    const totalPaise = Math.round(amount * 100)
    const driverPaise = Math.round((totalPaise * pct) / 100)

    // The OWNER absorbs the rounding remainder — always, in the same direction.
    // Two reasons. The driver's cut is the number they were promised and can
    // check on a calculator, so it is the one that should be exact; and the
    // owner set the split, holds the shipper relationship and is the residual
    // claimant on the trip, so the sub-paisa belongs on their side of the line.
    // Taking it as a subtraction (not a second rounding) is what makes the two
    // rows sum to the settled amount exactly rather than usually.
    const ownerPaise = totalPaise - driverPaise
    if (ownerPaise === 0) return [{ payee_type: 'driver', driver_id: booking.driver_id, fleet_owner_id: null, amount }]

    return [
      { ...owner, amount: ownerPaise / 100 },
      { payee_type: 'driver', driver_id: booking.driver_id, fleet_owner_id: null, amount: driverPaise / 100 },
    ]
  }

  // No fleet: the driver bid and the driver is paid, at the settled amount
  // untouched — no paise round-trip, so this stays byte-identical to pre-split.
  if (booking.driver_id) {
    return [{ payee_type: 'driver', driver_id: booking.driver_id, fleet_owner_id: null, amount }]
  }
  return []
}

// A fact about a settlement that is not a failure — the money is recorded and the
// trip closes — but that nobody may be left to discover from the ledger weeks
// later. Returned to the caller as well as logged, because the ledger records
// amounts, not the facts we were missing when we wrote them: an anomaly that lived
// only in a log line is invisible to the console that recorded the settlement.
export type SettlementAnomaly = {
  code: 'UNAFFILIATED_EXECUTING_DRIVER'
  message: string
  driver_id: string
  fleet_owner_id: string
}

// resolveSettlement — the payees for one settled trip, plus anything about the
// affiliation those payees were derived from that an operator has to be told.
//
// D-24: the CARRIER that won the work and the TRUCK + DRIVER that executed it are
// separate facts, and no code may assume they coincide. The contract payee is
// correctly the winning carrier — the platform pays whoever won the work — but the
// D-7 split is a term of the executing driver's AFFILIATION with that carrier, and
// this is the seam where the two meet.
//
// `affiliation: 'none'` means there is no such term because there is no such
// relationship. The old code read that as a share of 0 and paid the driver nothing:
// no row, no error, no log, indistinguishable in the ledger from a salaried trip
// the owner is meant to keep. A silent zero-rupee payout is the worst failure a
// freight platform has, because the only party who notices is the one who drove.
//
// The payout POLICY is deliberately unchanged — what a sub-contracted driver is
// owed is post-MVP and is not this function's to invent, so the carrier is still
// paid the whole freight — but the settlement now says out loud which fact it was
// missing when it decided that.
//
// Pure, for the same reason resolvePayees is: the split AND the anomaly are
// exercisable without a database.
export function resolveSettlement(
  booking: { driver_id: string | null; fleet_owner_id?: string | null },
  amount: number,
  share: DriverShare | null,
): { payees: PayoutSplit[]; anomalies: SettlementAnomaly[] } {
  const payees = resolvePayees(booking, amount, share?.share_pct ?? 0)

  // Only a fleet trip WITH an executing driver can have a missing affiliation: a
  // solo booking has no carrier to be unaffiliated from, and a fleet booking with no
  // driver assigned has nobody whose cut could have gone missing.
  if (share?.affiliation !== 'none' || !booking.fleet_owner_id || !booking.driver_id) {
    return { payees, anomalies: [] }
  }

  return {
    payees,
    anomalies: [
      {
        code: 'UNAFFILIATED_EXECUTING_DRIVER',
        driver_id: booking.driver_id,
        fleet_owner_id: booking.fleet_owner_id,
        message:
          `Driver ${booking.driver_id} executed this trip for fleet ${booking.fleet_owner_id} but holds no ` +
          'affiliation with it, so there is no revenue-share term to split on. The entire settled amount is ' +
          'recorded to the fleet and NO driver payout is written — this is NOT a salaried trip. Settle the ' +
          "driver's cut off-platform, or record the affiliation so the next trip splits.",
      },
    ],
  }
}

// planPayoutWrites — turn "these are the payees" into "do exactly this to the
// booking's payout rows". Pure, so the reconciliation is testable without a
// database and without a settlement.
//
// The bug this exists to kill: settle() used to UPSERT only the rows it had
// just computed, which silently assumed the computed set could never SHRINK.
// It can. The saga (onTripCompleted) pre-creates a 'pending' row for the
// bidder; a share of 100 then resolves to the driver alone, so nothing ever
// overwrites the owner's stale pending row. The booking ends up holding payout
// rows that sum to TWICE the settlement, and the back-compat `payout` wire
// field — the number the shipper app renders — hands back the stale 'pending'
// row. Reconciling the FULL set is the only thing that closes that: a payee
// who no longer has a share loses their row.
//
// Deleting rather than zeroing is deliberate and matches resolvePayees, which
// drops a zero-share payee instead of writing a ₹0 row: a payout row asserts
// "this party is owed this money for this trip", and for a dropped payee that
// assertion is simply false. Nothing has been disbursed — the pilot is
// record-only (D-12) — so there is no transfer to reverse, only a wrong claim
// to withdraw.
//
// Idempotent by construction: it is a function of (what is there, what should
// be there), so replaying it once everything matches yields an empty plan.
export type PayoutPlan = {
  insert: PayoutRecord[]
  update: PayoutRecord[]
  remove: PayoutKey[]
  /** Whether an UPDATE/DELETE may filter on payee_type (migration 0016). See PayoutKey. */
  keyByPayeeType: boolean
}

export function planPayoutWrites(bookingId: string, existing: PayoutRecord[], desired: PayoutRecord[]): PayoutPlan {
  // Which addressing the live table supports, read off the rows themselves
  // rather than guessed: getPayouts() selects '*', so a row carrying a
  // `payee_type` key proves migration 0016 has landed. With no rows there is
  // nothing to address — every desired row is an INSERT — so the value is moot.
  const keyByPayeeType = existing.some((r) => 'payee_type' in r)
  // A pre-0016 row predates the column and IS the driver's, which is what the
  // column's own DEFAULT says too.
  const typeOf = (r: PayoutRecord) => r.payee_type ?? 'driver'

  return {
    keyByPayeeType,
    insert: desired.filter((d) => !existing.some((e) => typeOf(e) === d.payee_type)),
    update: desired.filter((d) => existing.some((e) => typeOf(e) === d.payee_type)),
    remove: existing
      .filter((e) => !desired.some((d) => d.payee_type === typeOf(e)))
      .map((e) => ({ bookingId, payeeType: typeOf(e), keyByPayeeType })),
  }
}

// toViewerBooking — the booking as @bharattruck/shared's relation resolver reads
// it. Only the freight-PARTY columns matter to relationsToBooking; the price and
// status the settlement flow uses live elsewhere on BookingView. consignee_user_id
// is the D-22 receiving party and is absent on a pre-0026 booking read, in which
// case no consignee relation resolves and the consignee-pays path never opens.
function toViewerBooking(booking: BookingView): ViewerBooking {
  return {
    shipper_id: booking.shipper_id,
    fleet_owner_id: booking.fleet_owner_id ?? null,
    driver_id: booking.driver_id,
    consignee_user_id: booking.consignee_user_id ?? null,
  }
}

// assertSettlementParty — WHO may record or read a booking's settlement.
//
// Relation-to-object, never the JWT role string (D-27). booking-service has
// already enforced READ access on the getBooking that produced `booking` (a
// shipper reading someone else's booking → 403, a stranger → 404); this is the
// money-party decision layered on top:
//   • ops/admin — an internal operator, NOT one of the emergent personas, so it
//     keeps its own gate, the same ops-actor exception bt-booking-service draws.
//   • the SHIPPER — the party who posted the load is the payer.
//   • a claimed CONSIGNEE — but ONLY on the consignee-pays case: a booking whose
//     lorry receipt carries freight_term 'TO_PAY' (migration 0024). On any other
//     term the receiver owes nothing on this consignment and must not be able to
//     close it out. freight_term rides on the LR, not the booking, so it is read
//     only when a consignee is actually asking — the shipper/ops paths never pay
//     for the lookup, and a booking with no LR yet reads as "not to-pay" (deny).
//
// A driver — solo or fleet — holds the carrier/driver relation, neither of which
// is settled here, so they are refused exactly as the old role gate refused them.
export async function assertSettlementParty(
  booking: BookingView,
  actor: AuthenticatedUser,
  deps: PaymentDeps,
): Promise<void> {
  if (actor.role === 'admin') return

  const snapshot = await deps.resolvePersonas(actor.userId, actor.role)
  const relations = relationsToBooking(toViewerBooking(booking), snapshot)

  if (relations.includes('shipper')) return
  if (relations.includes('consignee') && (await deps.store.getFreightTerm(booking.id)) === 'TO_PAY') return

  throw new PaymentError(
    'Only the paying shipper, a to-pay consignee, or ops can record a settlement',
    'FORBIDDEN',
    403,
  )
}

export async function settle(args: SettleArgs, actor: AuthenticatedUser, bearer: string, deps: PaymentDeps) {
  // Read the booking with the actor's JWT FIRST — booking-service enforces READ
  // access (a shipper reading someone else's booking → 403, a stranger → 404),
  // which is the first half of authorization. WHO MAY SETTLE is then a
  // relation-to-object decision on the booking we just read (D-27), never the JWT
  // role string: the paying shipper, a to-pay consignee, or ops.
  const booking = await deps.booking.getBooking(args.bookingId, bearer)
  await assertSettlementParty(booking, actor, deps)
  const existing = await deps.store.getPayment(args.bookingId)

  // Anomalies belong to the settlement that RESOLVED the payees, which is the one
  // that read the affiliation — every other path here resolves nothing and so
  // asserts nothing new about it. The log line written below is the durable record.
  const anomalies: SettlementAnomaly[] = []

  // Idempotent full-retry: already settled + already flipped to paid.
  if (booking.status === 'paid' && existing) {
    const payouts = await deps.store.getPayouts(args.bookingId)
    return { booking_id: args.bookingId, status: 'paid', already_settled: true, payment: existing, anomalies, ...payoutView(booking, payouts) }
  }

  if (booking.status !== 'completed') {
    throw new PaymentError(
      `Settlement can only be recorded for a 'completed' trip (booking is '${booking.status}')`,
      'INVALID_STATE',
      409,
    )
  }

  // ── Money integrity ───────────────────────────────────────────────────────
  // The settled amount is caller-supplied, so without this a shipper could POST
  // amount: 1 against a ₹36,000 trip: the booking would flip to 'paid', the
  // payout would be written for ₹1, and the driver/fleet would carry the loss
  // with the platform's own records agreeing that they were paid in full.
  //
  // The split is deliberate and mirrors the authorization split above:
  //   • A SHIPPER is a party to the deal, so they may only confirm the price
  //     that was agreed. They cannot self-discount.
  //   • ADMIN/OPS may record a different figure, because real cash settlements
  //     genuinely differ — detention, a damage deduction, a part payment the
  //     shipper and carrier settled between themselves. Removing that escape
  //     hatch would strand those trips in `completed` with no way to close
  //     them. It is logged so the deviation is visible in the ledger.
  //
  // Checked BEFORE the writes and on every call (not just the first): a heal
  // retry carrying a wrong amount would otherwise slip through `existing` and
  // put the wrong number on the shipper's receipt via markPaid.
  const agreed = agreedPrice(booking)
  if (agreed === null) {
    deps.logger?.warn(
      { booking_id: args.bookingId, amount: args.amount },
      'booking carries no usable price; settling without amount reconciliation',
    )
  } else if (Math.abs(args.amount - agreed) > AMOUNT_EPSILON) {
    if (actor.role === 'admin') {
      deps.logger?.warn(
        { booking_id: args.bookingId, amount: args.amount, agreed_price: agreed, actor: actor.userId },
        'ops override: settled amount differs from the agreed price',
      )
    } else {
      throw new PaymentError(
        `Settled amount ₹${args.amount} does not match the agreed price ₹${agreed} for this booking`,
        'AMOUNT_MISMATCH',
        422,
      )
    }
  }

  // Record the money (hard write — must persist). Skip if already recorded
  // (idempotent) and fall through to healing the paid-flip below.
  if (!existing) {
    // Resolved BEFORE the payment insert: a booking with no payee cannot be
    // paid out, and migration 016's CHECK would reject the payout row anyway —
    // better to refuse up front than to record money we cannot disburse.
    //
    // The D-7 share — and, since D-24, whether an affiliation backs it at all —
    // is read here and only here. It governs how the freight is divided, so it
    // must be the share in force when the money is recorded — not one cached
    // from trip completion, by which time the owner may have renegotiated it.
    // Reading it costs one indexed lookup on a path that already makes two
    // cross-service HTTP calls.
    const share = booking.fleet_owner_id && booking.driver_id
      ? await deps.store.getDriverShare(booking.fleet_owner_id, booking.driver_id)
      : null
    // pilot: no platform fee — the payees split the whole settled amount
    const { payees, anomalies: resolved } = resolveSettlement(booking, args.amount, share)
    anomalies.push(...resolved)
    for (const anomaly of resolved) {
      // warn, not error: nothing failed and the settlement proceeds. But it carries
      // every id somebody needs to chase the driver's money without first having to
      // work out which trip the log line is about — a settlement that pays the
      // executing driver ₹0 is exactly the event nobody may have to reconstruct.
      deps.logger?.warn(
        {
          booking_id: args.bookingId,
          code: anomaly.code,
          driver_id: anomaly.driver_id,
          fleet_owner_id: anomaly.fleet_owner_id,
          amount: args.amount,
          actor: actor.userId,
        },
        anomaly.message,
      )
    }
    if (payees.length === 0) {
      throw new PaymentError('Booking has no payee (neither a driver nor a fleet owner)', 'INVALID_STATE', 409)
    }

    const desired: PayoutRecord[] = payees.map((payee) => ({
      booking_id: args.bookingId,
      ...payee,
      mode: args.mode,
      status: 'recorded' as const,
      recorded_by: actor.userId,
    }))

    // ORDER MATTERS: payouts FIRST, payment second.
    //
    // `existing` (the payments row) is what short-circuits this whole block on a
    // retry. If the payment were written first and a payout write then failed,
    // the retry would find `existing` non-null, skip the block entirely, flip the
    // booking to 'paid' and return 200 — leaving the payee's payout row missing
    // forever, recoverable only by hand. Writing the payouts first inverts that:
    // a failure here leaves NO payments row, so the retry re-runs every write.
    //
    // A split writes the payees one row at a time and is therefore not atomic
    // ACROSS them — which the same inversion covers, because the plan below is a
    // function of what is currently in the table: a crash halfway leaves no
    // payments row, and the retry re-plans against the rows it already wrote and
    // finishes the job. That, plus UNIQUE(booking_id, payee_type) from 0023
    // catching a concurrent writer, is what stops a replay from double-paying.
    const plan = planPayoutWrites(args.bookingId, await deps.store.getPayouts(args.bookingId), desired)

    for (const row of plan.update) await deps.store.updatePayout(row, plan.keyByPayeeType)

    // The reconciliation itself: a party this settlement does not pay must not
    // keep a row from a previous, differently-shaped attempt (a share
    // renegotiated to 100 between the saga's pre-create and settlement, or
    // between a crashed settle and its retry).
    //
    // DELETES BEFORE INSERTS, so that the number of rows never transiently
    // EXCEEDS what the booking ends up with. On a schema that still carries
    // migration 011's UNIQUE(booking_id) — which this service must settle
    // against, since deploy.yml ships it on merge and 0023 is applied by hand
    // afterwards — inserting the new payee while the old one is still there
    // would trip that constraint on a settlement the table can perfectly well
    // hold (one payee, just a different one than last time).
    //
    // The window this opens, where a booking momentarily has no payout row, is
    // not observable as a settled trip: the payments row is still unwritten and
    // the booking is still 'completed', so a crash inside it reads as an
    // unfinished settlement, which is what it is, and the retry re-plans against
    // whatever survived and finishes.
    for (const key of plan.remove) await deps.store.deletePayout(key)
    for (const row of plan.insert) await deps.store.insertPayout(row)

    await deps.store.insertPayment({
      booking_id: args.bookingId,
      amount: args.amount,
      mode: args.mode,
      reference: args.reference,
      recorded_by: actor.userId,
      // 'settled' — NOT 'recorded'. The live payments table carries
      // CHECK (status IN ('pending','captured','settled','failed','refunded'))
      // from its original gateway-style schema; 'recorded' violated it and every
      // cash settlement 500'd on the payments insert (payments_status_check),
      // which is why payments has zero rows in prod. The payouts table uses a
      // different vocabulary that DOES allow 'recorded', so the payout wrote and
      // the payment did not — the drift is per-table. 'settled' is the terminal
      // state in the payments vocabulary. (The Map-backed test fake never enforced
      // the CHECK, so this passed CI — see the added assertion in payment.e2e.mts.)
      status: 'settled',
    })
  }

  // Flip completed → paid (state machine stays in booking-service). A 409
  // means it is already paid (concurrent/retry) — that is success here.
  try {
    // `mode` is the payments vocabulary for how it was paid (cash/UPI/direct) and
    // `reference` is the operator-supplied receipt handle — both are what a shipper
    // needs to recognise the payment on their own records. `payment`/`payout` are
    // read back further down, after this flip, so they are deliberately not used here.
    await deps.booking.markPaid(args.bookingId, {
      amount: args.amount,
      method: args.mode,
      payment_id: args.reference ?? undefined,
    })
  } catch (err) {
    if (!(err instanceof PaymentError && err.httpStatus === 409)) throw err
  }

  // Revenue is now known, so fold the trip into the owner's per-asset P&L.
  // Fleet-only: a solo-driver booking has no fleet assets to roll up, and this
  // path must stay byte-identical to the pre-fleet behaviour for those.
  if (booking.fleet_owner_id) emitTripEconomics(args.bookingId, deps.logger)

  const payment = existing ?? (await deps.store.getPayment(args.bookingId))
  const payouts = await deps.store.getPayouts(args.bookingId)
  return { booking_id: args.bookingId, status: 'paid', already_settled: !!existing, payment, anomalies, ...payoutView(booking, payouts) }
}

// payoutView — the settlement's payouts, shaped for the wire.
//
// `payouts` (the full list) is the new truth. `payout` stays because the
// shipper app already reads it as a single object (shipper/src/lib/api.ts
// PaymentStatus); dropping it would blank the settlement panel on a deploy
// this slice is not allowed to coordinate with. It names the BIDDER's row —
// the party the shipper actually contracted with — so the number the shipper
// sees keeps meaning what it meant before splits existed, rather than becoming
// whichever row the database happened to return first.
export function payoutView(
  booking: { fleet_owner_id?: string | null },
  payouts: PayoutRecord[],
): { payout: PayoutRecord | null; payouts: PayoutRecord[] } {
  const bidderType = booking.fleet_owner_id ? 'fleet_owner' : 'driver'
  return { payout: payouts.find((p) => p.payee_type === bidderType) ?? payouts[0] ?? null, payouts }
}

// -----------------------------------------------------------
// onTripCompleted — outbox/saga consumer. When a trip completes,
// booking-service best-effort emits `trip_completed`; this idempotently
// pre-creates a 'pending' payout for the bidder (retriable, at most one
// payout per payee per booking). NOT a cross-service RPC coupling tables. The
// settle path is self-healing, so a lost event never blocks settlement.
// -----------------------------------------------------------

export async function onTripCompleted(
  args: { booking_id: string; driver_id: string | null; fleet_owner_id?: string | null; amount: number },
  deps: PaymentDeps,
) {
  // No D-7 share here on purpose — the pre-created row is the BIDDER's, exactly
  // as before splits existed. The amount is provisional (it is the trip's price;
  // ops may settle a different figure) and the share is read at settlement, not
  // at completion, so splitting here would be a provisional split of a
  // provisional number against a term that may still change.
  //
  // Passing 0 keeps this path emitting exactly one row. That row is NOT assumed
  // to be one settle() will keep: settle() reconciles the booking's whole payout
  // set against the payees it resolves, so a bidder row that turns out to be
  // owed nothing (share = 100 hands the freight to the driver) is removed rather
  // than stranded at 'pending'. Getting that wrong is what let a booking hold
  // rows summing to twice the settlement.
  const [payee] = resolvePayees(args, args.amount, 0)
  if (!payee) {
    // Nothing to pre-create — settle() resolves the payee from the booking
    // itself and self-heals, so a payee-less event costs nothing but a log line.
    deps.logger?.warn({ booking_id: args.booking_id }, 'trip_completed carried no payee; skipping pending payout')
    return { booking_id: args.booking_id, payout_pending: false }
  }

  await deps.store.insertPendingPayoutIfAbsent({
    booking_id: args.booking_id,
    ...payee,
    mode: null,
    status: 'pending',
    recorded_by: null,
  })
  return { booking_id: args.booking_id, payout_pending: true }
}
