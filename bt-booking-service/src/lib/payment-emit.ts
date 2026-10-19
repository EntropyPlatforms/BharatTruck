import type { DbBooking } from './types.js'

// -----------------------------------------------------------
// emitTripCompleted — outbox/saga trigger for the complete→payout
// linkage (T-BE-4). When a booking reaches 'completed', best-effort
// notify bt-payment-service so it can pre-create a pending payout.
//
// Deliberately fire-and-forget and non-blocking: it must NEVER delay
// or fail the trip-completion response. Delivery is not guaranteed here
// — payment-service's settle path is idempotent + self-healing (it
// creates the payout if the event was missed), so a dropped emit only
// costs the pre-created 'pending' payout, never correctness. A durable
// outbox table + poller is the production hardening (see T-BE-4 report).
// Skips silently when PAYMENT_SERVICE_URL / INTERNAL_SERVICE_SECRET are
// unset (e.g. local/test), so completion works without payment-service.
// -----------------------------------------------------------

type Logger = { warn(obj: unknown, msg: string): void }

export function emitTripCompleted(booking: DbBooking, log?: Logger): void {
  const base = process.env.PAYMENT_SERVICE_URL
  const secret = process.env.INTERNAL_SERVICE_SECRET
  if (!base || !secret) return

  const amount = booking.final_price ?? booking.quoted_price

  // fleet_owner_id rides along so payment-service can settle to WHOEVER BID
  // (founder Q15): a fleet-won trip pays the fleet, not the driver at the
  // wheel. NULL on every solo booking, where the payee is the driver as before.
  void fetch(`${base}/internal/trip-completed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': secret },
    body: JSON.stringify({
      booking_id:     booking.id,
      driver_id:      booking.driver_id,
      fleet_owner_id: booking.fleet_owner_id ?? null,
      amount,
    }),
  }).catch((err) => {
    log?.warn({ err, booking_id: booking.id }, 'trip_completed emit failed (payout saga self-heals via settle)')
  })
}
