// -----------------------------------------------------------
// emitAssignmentRelease — outbox/saga trigger to free truck/driver on trip end.
// When a booking reaches 'completed' or 'delivery_asserted', best-effort ask
// bt-fleet-service to stamp released_at on its vehicle_assignments row.
//
// Same shape as emitTripCompleted / bt-payment-service's fleet-emit: fire-and-forget
// and non-blocking. The trip transition must NEVER fail because fleet-service is
// down or unset — a dropped emit only delays the UI showing the truck free until
// listLiveAssignments sweeps or the paid roll-up retries. Skips silently when
// FLEET_SERVICE_URL / INTERNAL_SERVICE_SECRET are unset (local/test, or before
// fleet-service is deployed).
// -----------------------------------------------------------

type Logger = { warn(obj: unknown, msg: string): void }

export function emitAssignmentRelease(bookingId: string, log?: Logger): void {
  const base = process.env.FLEET_SERVICE_URL
  const secret = process.env.INTERNAL_SERVICE_SECRET
  if (!base || !secret) return

  void fetch(`${base}/internal/assignments/release/${bookingId}`, {
    method: 'POST',
    headers: { 'x-internal-secret': secret },
  })
    .then((res) => {
      if (!res.ok) {
        log?.warn(
          { status: res.status, booking_id: bookingId },
          'assignment release emit rejected (trip transition unaffected)',
        )
      }
    })
    .catch((err) => {
      log?.warn(
        { err, booking_id: bookingId },
        'assignment release emit failed (trip transition unaffected)',
      )
    })
}
