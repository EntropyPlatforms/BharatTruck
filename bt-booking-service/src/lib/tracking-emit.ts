// -----------------------------------------------------------
// emitLocationFix — hands an already-ingested GPS fix to bt-tracking-service's
// evaluator (D-014) so it can derive geofence crossings, route alerts and trip
// telemetry from it.
//
// WHY THE EVALUATION LIVES OVER THERE, NOT HERE: the frozen contract keeps raw GPS
// ingestion in this service (§3.1 §1, D-007) and derived geometry in
// bt-tracking-service (D-001). This emit is the seam between the two. Nothing about
// geofences, polylines or alert thresholds belongs in booking-service — it owns the
// fix, not what the fix means.
//
// Deliberately fire-and-forget, mirroring emitTripCompleted: the live position and the
// breadcrumb are already durably written before this runs, so a dropped emit costs only
// derived data, and the very next fix (~12 s later) recomputes it all from the stored
// telemetry row. It must NEVER delay or fail a GPS ingest — a driver on a patchy 4G
// connection needs /location/update to stay fast and always succeed.
//
// Skips silently when TRACKING_SERVICE_URL / INTERNAL_SERVICE_SECRET are unset, so local
// dev and the existing test suites run without bt-tracking-service present.
// -----------------------------------------------------------

type Logger = { warn(obj: unknown, msg: string): void }

export interface LocationFix {
  booking_id: string
  driver_id: string
  vehicle_id: string | null
  lat: number
  lng: number
  speed_kmh: number | null
  heading: number | null
  recorded_at: string
}

export function emitLocationFix(fix: LocationFix, log?: Logger): void {
  const base = process.env.TRACKING_SERVICE_URL
  const secret = process.env.INTERNAL_SERVICE_SECRET
  if (!base || !secret) return

  void fetch(`${base}/internal/evaluate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': secret },
    body: JSON.stringify(fix),
  }).catch((err) => {
    log?.warn(
      { err, booking_id: fix.booking_id },
      'Location fix evaluation emit failed (live tracking unaffected; next fix recomputes)',
    )
  })
}
