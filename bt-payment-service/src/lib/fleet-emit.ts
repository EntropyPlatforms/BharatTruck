// -----------------------------------------------------------
// emitTripEconomics — outbox/saga trigger for the per-asset P&L roll-up.
// Once a fleet trip settles (completed → paid), the revenue side of that
// truck's economics is finally known, so best-effort ask bt-fleet-service
// to fold the trip into `trip_economics`.
//
// Same shape as bt-booking-service's emitTripCompleted: fire-and-forget and
// non-blocking. Money is already durably recorded by the time this runs, and
// analytics must NEVER be able to fail or roll back a settlement — a dropped
// emit only delays a reporting number. Skips silently when FLEET_SERVICE_URL /
// INTERNAL_SERVICE_SECRET are unset (local/test, or before fleet-service is
// deployed), so settlement works without bt-fleet-service present.
// -----------------------------------------------------------

type Logger = { warn(obj: unknown, msg: string): void }

export function emitTripEconomics(bookingId: string, log?: Logger): void {
  const base = process.env.FLEET_SERVICE_URL
  const secret = process.env.INTERNAL_SERVICE_SECRET
  if (!base || !secret) return

  void fetch(`${base}/internal/trip-economics/${bookingId}`, {
    method: 'POST',
    headers: { 'x-internal-secret': secret },
  })
    .then((res) => {
      // A non-2xx is a delivery failure too — fetch only rejects on transport errors.
      if (!res.ok) log?.warn({ status: res.status, booking_id: bookingId }, 'trip-economics roll-up rejected (settlement unaffected)')
    })
    .catch((err) => {
      log?.warn({ err, booking_id: bookingId }, 'trip-economics roll-up emit failed (settlement unaffected)')
    })
}
