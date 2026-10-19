// -----------------------------------------------------------
// emitNotification — queue a fleet-domain notification.
//
// bt-fleet-service owns invites but has no outbox or dispatcher of its own, so the
// event is posted to bt-booking-service, which resolves the audience (drivers.id ->
// users.id -> email, or fleet_owners.id -> the owner's address) and queues it.
// Centralising that resolution is the point: getting the drivers.id/users.id hop
// wrong does not error, it silently resolves nobody.
//
// Deliberately fire-and-forget and non-blocking, matching the existing cross-service
// emit helpers (bt-booking-service/src/lib/payment-emit.ts,
// bt-payment-service/src/lib/fleet-emit.ts): an invite must not fail because a
// notification could not be queued. Skips silently when BOOKING_SERVICE_URL /
// INTERNAL_SERVICE_SECRET are unset (local/test), so invites work without the
// booking service running at all.
//
// Idempotency lives downstream: every event carries an invite id, and the outbox's
// unique dedupe_key absorbs a repeated emit.
// -----------------------------------------------------------

type Logger = { warn(obj: unknown, msg: string): void }

export type FleetNotification =
  | {
      event: 'fleet_invite'
      invite_id: string
      driver_id: string
      fleet_owner_id: string
    }
  | {
      event: 'fleet_invite_answered'
      invite_id: string
      driver_id: string
      fleet_owner_id: string
      response: 'accepted' | 'declined'
    }

export function emitNotification(payload: FleetNotification, log?: Logger): void {
  const base = process.env.BOOKING_SERVICE_URL
  const secret = process.env.INTERNAL_SERVICE_SECRET
  if (!base || !secret) return

  void fetch(`${base}/internal/notifications`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': secret },
    body: JSON.stringify(payload),
  }).catch((err) => {
    log?.warn(
      { err, event: payload.event, invite_id: payload.invite_id },
      'fleet notification emit failed (fleet operation unaffected)',
    )
  })
}
