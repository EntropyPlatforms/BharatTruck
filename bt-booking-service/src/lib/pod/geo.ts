// ============================================================
// src/lib/pod/geo.ts
//
// Responsibility: the distance maths the POD geofence gate needs, and the tuned
// thresholds it compares against. Kept tiny and pure so the gate logic is
// testable without a database or a clock.
//
// NO PostGIS (frozen contract §3.1 D-007). lat/lng are plain decimals and this is
// the same haversine the tracking-service evaluator uses on every GPS fix; the two
// must agree on what "at the drop" means, so the formula lives in one obvious place.
// ============================================================

const EARTH_RADIUS_M = 6_371_000

const toRad = (deg: number): number => (deg * Math.PI) / 180

// Great-circle distance in metres between two lat/lng points. Haversine is exact
// enough at freight-drop scale (sub-metre error over a few km) and needs no
// projection — which is the whole reason the schema can stay PostGIS-free.
export function haversineMeters(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const dLat = toRad(bLat - aLat)
  const dLng = toRad(bLng - aLng)
  const lat1 = toRad(aLat)
  const lat2 = toRad(bLat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

// -----------------------------------------------------------
// DROP_RADIUS_M — how close counts as "at the delivery address".
//
// 750 m, sitting deliberately between two numbers already in the system: the
// tracking evaluator's 50 m geofence floor (too tight — a parked truck's GPS
// jitters ±40 m and would flap in and out) and the 2 km near_drop ALERT
// (INDIA_FREIGHT_COMPLIANCE §-derived contract), which is a "getting close" nudge,
// not a "you have arrived" gate. 750 m absorbs consumer-GPS error while still being
// far too tight for the "driver phones ahead from 40 km away" hole this gate closes.
// Tunable after the first real drive, exactly like the alert thresholds.
// -----------------------------------------------------------
export const DROP_RADIUS_M = 750

// -----------------------------------------------------------
// NEAR_DROP_M — the corroboration band for the OTP gate.
//
// A live GPS fix between DROP_RADIUS_M and this value is treated as "at the dock,
// GPS drifting" ONLY when a 'drop' geofence-enter event already corroborates arrival
// (urban canyon / warehouse-roof multipath routinely pushes a parked truck a few
// hundred metres off). Beyond this, a live fix is taken at face value and the gate
// blocks — which is what shuts the "driver phones ahead from 40 km away" hole. 2 km
// matches the near_drop alert threshold in the frozen tracking contract, so the gate
// and the alert agree on what "nearly there" means.
// -----------------------------------------------------------
export const NEAR_DROP_M = 2000

// -----------------------------------------------------------
// MAX_FIX_AGE_MS — how recent a telemetry fix must be to be allowed to BLOCK.
//
// 10 minutes, and this one is a safety interlock rather than a tuning knob. The
// gate's blocking branch reasons "the truck is demonstrably somewhere else" — a
// claim that is only true of a fix taken moments ago. trip_telemetry.last_fix_at
// is whatever the evaluator last wrote, and it does NOT expire: a driver whose
// phone died 40 km short, or who lost signal in a tunnel and finished the last
// leg dark, leaves a last fix that is hours old and permanently far from the
// drop. Trusting it would hard-block a driver who is genuinely standing at the
// dock, with no way for them to clear it — the exact failure the degrade branch
// exists to avoid, arrived at from the other side.
//
// 10 minutes is ~50x the 10s GPS poll and ~50x the ~12s breadcrumb/evaluator
// cadence (BREADCRUMB_THROTTLE_SECONDS), so a live phone is never near it while
// one that has stopped reporting crosses it quickly. A fix older than this is
// treated as ABSENT: the gate falls through to the geofence-event branch and
// then to degrade, which is allow-but-flagged — never a silent pass.
// -----------------------------------------------------------
export const MAX_FIX_AGE_MS = 10 * 60 * 1000

// isFixFresh — may this fix's timestamp carry the weight of a BLOCK decision?
//
// A NULL/unparseable timestamp answers false on purpose. An undated fix cannot be
// shown to be recent, and the whole point of the age check is that only a fix we
// can PROVE is recent may deny a driver their delivery code. Unknown age therefore
// degrades exactly like an old one.
export function isFixFresh(atIso: string | null, now: number = Date.now()): boolean {
  if (!atIso) return false
  const t = new Date(atIso).getTime()
  if (!Number.isFinite(t)) return false
  // Future-dated fixes (a phone with a fast clock) are still fresh — the skew is a
  // signal recorded on the evidence row, not a reason to discard a live position.
  return now - t <= MAX_FIX_AGE_MS
}

// Result of comparing a fix against the drop. Kept as a coarse verdict because the
// evidence table stores exactly these three strings (pod_evidence.geofence_result).
export type GeofenceVerdict = 'inside' | 'outside' | 'unknown'

export function geofenceVerdict(distanceM: number | null): GeofenceVerdict {
  if (distanceM === null || !Number.isFinite(distanceM)) return 'unknown'
  return distanceM <= DROP_RADIUS_M ? 'inside' : 'outside'
}
