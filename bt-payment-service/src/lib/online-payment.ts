import type { BookingView } from './booking-client.js'
import type { PayoutRecord } from './payment-store.js'
import { PaymentError } from './errors.js'
import { emitTripEconomics } from './fleet-emit.js'
import { agreedPrice, payoutView, planPayoutWrites, resolveSettlement, type PaymentDeps } from './payment-service.js'
import { orderNote, type PaymentGateway, type RazorpayOrder } from './razorpay.js'

// -----------------------------------------------------------
// Online collection — closing a trip from a CAPTURED Razorpay payment.
//
// The difference from settle() (a settlement recorded by a person) is what is known
// about the carrier's money. settle() records that the carrier WAS paid, by cash/UPI/
// bank transfer, so its payout rows are 'recorded'. Here the SHIPPER has paid the
// platform's Razorpay account and nothing has been disbursed yet, so the payout rows are
// written 'pending' with no mode: the carrier is OWED this, and whoever disburses it
// (by hand today, Route later — D-12) flips the row. Saying 'recorded' here would tell a
// driver they had been paid when the money was still with the platform.
//
// Every caller reaches this with the payment already CONFIRMED against Razorpay —
// nothing here trusts a figure the browser sent.
// -----------------------------------------------------------

const PAISE = 100

/** The booking's agreed price in paise — what the order is created for and checked against. */
export function agreedPaise(booking: { quoted_price?: number | null; final_price?: number | null }): number | null {
  const agreed = agreedPrice(booking)
  return agreed === null ? null : Math.round(agreed * PAISE)
}

export async function recordOnlinePayment(
  booking: BookingView,
  paid: { amount: number; paymentId: string },
  payerUserId: string,
  deps: PaymentDeps,
) {
  const existing = await deps.store.getPayment(booking.id)

  // Idempotent: the verify call, the webhook and the page's own sync can all arrive for
  // one payment, in any order.
  if (booking.status === 'paid' && existing) {
    const payouts = await deps.store.getPayouts(booking.id)
    return { booking_id: booking.id, status: 'paid' as const, already_settled: true, payment: existing, ...payoutView(booking, payouts) }
  }
  if (booking.status !== 'completed') {
    throw new PaymentError(
      `A payment can only close a 'completed' trip (booking is '${booking.status}')`,
      'INVALID_STATE',
      409,
    )
  }

  if (!existing) {
    const share = booking.fleet_owner_id && booking.driver_id
      ? await deps.store.getDriverShare(booking.fleet_owner_id, booking.driver_id)
      : null
    const { payees, anomalies } = resolveSettlement(booking, paid.amount, share)
    for (const anomaly of anomalies) {
      deps.logger?.warn(
        { booking_id: booking.id, code: anomaly.code, driver_id: anomaly.driver_id, fleet_owner_id: anomaly.fleet_owner_id, amount: paid.amount },
        anomaly.message,
      )
    }
    if (payees.length === 0) {
      throw new PaymentError('Booking has no payee (neither a driver nor a fleet owner)', 'INVALID_STATE', 409)
    }

    // Owed, not paid — see the header. Same reconciliation and the same write ORDER as
    // settle(): payouts first, payment second, so a crash in between leaves no payments
    // row and the retry re-plans against whatever was written.
    const desired: PayoutRecord[] = payees.map((payee) => ({
      booking_id: booking.id,
      ...payee,
      mode: null,
      status: 'pending' as const,
      recorded_by: null,
    }))
    const plan = planPayoutWrites(booking.id, await deps.store.getPayouts(booking.id), desired)
    for (const row of plan.update) await deps.store.updatePayout(row, plan.keyByPayeeType)
    for (const key of plan.remove) await deps.store.deletePayout(key)
    for (const row of plan.insert) await deps.store.insertPayout(row)

    await deps.store.insertPayment({
      booking_id: booking.id,
      amount: paid.amount,
      mode: 'razorpay',
      reference: paid.paymentId,
      recorded_by: payerUserId,
      // The gateway's own word for money that has been taken, and one the live
      // payments_status_check allows.
      status: 'captured',
    })
  }

  try {
    await deps.booking.markPaid(booking.id, {
      amount: paid.amount,
      method: 'razorpay',
      payment_id: paid.paymentId,
      payout_status: 'pending',
    })
  } catch (err) {
    if (!(err instanceof PaymentError && err.httpStatus === 409)) throw err
  }

  if (booking.fleet_owner_id) emitTripEconomics(booking.id, deps.logger)

  const payment = existing ?? (await deps.store.getPayment(booking.id))
  const payouts = await deps.store.getPayouts(booking.id)
  return { booking_id: booking.id, status: 'paid' as const, already_settled: !!existing, payment, ...payoutView(booking, payouts) }
}

/**
 * Close the booking an order was created for, IF Razorpay says that order has a captured
 * payment of exactly the agreed amount. Returns null when there is no captured payment
 * yet (the caller decides whether that is an error).
 *
 * `booking` must be the booking the ORDER names (notes.booking_id) — the caller reads it;
 * this checks the pairing so an order for one load can never close another.
 */
export async function settleFromOrder(
  order: RazorpayOrder,
  booking: BookingView,
  gateway: PaymentGateway,
  deps: PaymentDeps,
  payerFallback: string,
) {
  if (orderNote(order, 'booking_id') !== booking.id) {
    throw new PaymentError('This payment order was not created for this booking', 'VALIDATION_ERROR', 400)
  }

  const captured = (await gateway.fetchOrderPayments(order.id)).find((p) => p.status === 'captured')
  if (!captured) return null

  // The amount is checked against the BOOKING, not against the order: the order was
  // created from the agreed price, but the price is the fact and the order is a copy.
  const due = agreedPaise(booking)
  if (due === null || captured.currency !== 'INR' || captured.amount !== due) {
    // Money has been taken and it is not the agreed amount. Do NOT close the trip on it;
    // this needs a person (refund or reconcile), and the log line carries everything they need.
    deps.logger?.warn(
      { booking_id: booking.id, order_id: order.id, payment_id: captured.id, captured_paise: captured.amount, currency: captured.currency, due_paise: due },
      'razorpay: captured payment does not match the agreed price — NOT settling; refund or reconcile by hand',
    )
    throw new PaymentError(
      'The amount paid does not match the agreed price for this booking. The payment has not been applied — contact support.',
      'AMOUNT_MISMATCH',
      422,
    )
  }

  return recordOnlinePayment(
    booking,
    { amount: captured.amount / PAISE, paymentId: captured.id },
    orderNote(order, 'payer_user_id') ?? payerFallback,
    deps,
  )
}
