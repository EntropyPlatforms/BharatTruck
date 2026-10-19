// ============================================================
// src/lib/pod/service.ts
//
// Responsibility: the POD hardening business logic that sits on top of the existing
// receiver-OTP flow — evidence capture, the geofence-gated OTP decision, structured
// discrepancy capture, and the delivery_asserted assertion. Authorization and the
// booking/driver identity resolution reuse the base repository (the same drivers.id-
// not-users.id contract getPodContext uses); the POD tables go through pod/repository.
//
// FOUNDER RULE, load-bearing here: "idempotency at each state, no first this then this
// unless that's how it works." So capture and discrepancy are idempotent on resubmit
// (the DB unique keys converge a retry onto the same row), and NO artificial ordering
// is imposed — the ONE real-world sequence enforced is that a delivery cannot be
// asserted before anything was photographed, because an assertion with no evidence is
// the exact hole this whole slice exists to close.
// ============================================================

import { z } from 'zod'
import { can, relationsToBooking, resolvePersonas, type BookingRelation } from '@bharattruck/shared/personas'
import { canFleetAccessBooking, resolveFleetOwnerByUserId } from '@bharattruck/shared/fleet'
import type { AuthenticatedUser, BookingStatus, BookingWithProfiles } from '../types.js'
import { emitAssignmentRelease } from '../fleet-emit.js'
import { BookingError } from '../types.js'
import { assertValidTransition } from '../state.js'
import * as repo from '../repository.js'
import { supabase } from '../supabase.js'
import * as podRepo from './repository.js'
import { defaultEvidenceStorage, signedEvidenceUrl, type EvidenceStorage } from './storage.js'
import { DROP_RADIUS_M, NEAR_DROP_M, geofenceVerdict, haversineMeters, isFixFresh } from './geo.js'

type Logger = { warn(obj: unknown, msg: string): void }

// The claim clocks (§5.7). 180-day pre-suit notice runs from BOOKING; 7-day insurance
// intimation from DELIVERY. Named constants so the legal source is obvious at the math.
const CLAIM_NOTICE_DAYS = 180 // Carriage by Road Act s.16 — from date of booking
const INSURANCE_INTIMATION_DAYS = 7 // policy terms — from date of delivery
const DAY_MS = 24 * 60 * 60 * 1000

// -----------------------------------------------------------
// Request schemas. Camera-only is enforced HERE as well as at the DB CHECK — a
// gallery import must be refused before it ever reaches storage, with a message the
// driver app can show, not a raw constraint violation.
// -----------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/

export const EvidenceCaptureSchema = z.object({
  // The on-device SHA-256, lowercase hex. Stored verbatim — the app's hash IS the
  // integrity anchor, never recomputed server-side (§5.4 rule 2).
  sha256_original: z.string().regex(HEX64, 'sha256_original must be 64 lowercase hex chars'),
  // 🔴 Camera-only. The enum has exactly one member so a gallery import cannot be
  // encoded at all; the field exists so the control is explicit and auditable.
  capture_method: z.literal('camera'),
  // Device clock as a CLAIM. Optional — a photo with no device time still captures,
  // it just carries no skew signal.
  captured_at_device: z.string().datetime().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  gps_accuracy_m: z.number().nonnegative().optional(),
  gps_source: z.string().optional(),
  mock_location_detected: z.boolean().optional(),
  device_id: z.string().optional(),
  os_version: z.string().optional(),
  app_version: z.string().optional(),
  lr_number: z.string().optional(),
  exif_raw: z.record(z.unknown()).optional(),
  content_type: z.string().optional(),
  // Which required delivery shot this is (migration 0039). The verified-delivery flow sends
  // 'signed_invoice' and 'vehicle'; a legacy generic capture may omit it (recorded as null).
  kind: z.enum(['signed_invoice', 'vehicle', 'goods', 'other']).optional(),
  // The photo bytes, base64 (no data: URL prefix), same transport the OCR endpoints use.
  // Optional: a metadata-only capture still records (storage no_op). When present, the service
  // uploads the bytes to the private bucket and stamps sha256_received.
  image_base64: z.string().optional(),
}).strict() // reject unknown keys — nothing about a capture is a free-for-all

export type EvidenceCaptureBody = z.infer<typeof EvidenceCaptureSchema>

export const DiscrepancySchema = z.object({
  // The driver reports ONLY the actual. There is deliberately no expected_quantity
  // here; .strict() below turns any attempt to send one into a 400. That is the anti-
  // pilferage control — the expected side is server-held (§5.7).
  actual_quantity: z.number().nonnegative(),
  reason: z.enum(['shortage', 'damage', 'wrong_goods', 'refusal', 'partial_acceptance']),
  quantity_unit: z.string().optional(),
  // The geofenced+timestamped photo. A pod_evidence id captured earlier on this trip.
  evidence_id: z.string().uuid().optional(),
}).strict()

export type DiscrepancyBody = z.infer<typeof DiscrepancySchema>

export const AssertDeliverySchema = z.object({
  assert_reason: z.enum([
    'no_smartphone', 'night_delivery', 'warehouse_handoff',
    'receiver_refused_confirm', 'no_receiver_present', 'other',
  ]),
}).strict()

export type AssertDeliveryBody = z.infer<typeof AssertDeliverySchema>

// -----------------------------------------------------------
// resolveAssignedDriver — the shared precondition for every driver-side POD action:
// the caller is a driver, the booking exists, and it is THIS driver's booking. Mirrors
// getPodContext exactly (assigned-driver-only, 404 to hide ids from non-owners), so the
// evidence/discrepancy/assert endpoints authorize identically to the OTP request.
// -----------------------------------------------------------

async function resolveAssignedDriver(
  bookingId: string,
  actor: AuthenticatedUser,
): Promise<{ booking: BookingWithProfiles; driverId: string }> {
  const snapshot = await resolvePersonas(supabase, actor.userId, actor.role)
  if (!can(snapshot, 'drive') || !snapshot.driver_id) {
    throw new BookingError('Only the assigned driver can perform this POD action', 'FORBIDDEN', 403)
  }
  const booking = await repo.getBookingById(bookingId)
  if (!booking) {
    throw new BookingError(`Booking ${bookingId} not found`, 'NOT_FOUND', 404)
  }
  if (booking.driver_id !== snapshot.driver_id) {
    throw new BookingError('You are not assigned to this booking', 'FORBIDDEN', 403)
  }
  return { booking, driverId: snapshot.driver_id }
}

// -----------------------------------------------------------
// evaluateOtpGate — the geofence gate the OTP issuance hangs on (§5.5, D-14).
//
// It answers PASS / BLOCK / DEGRADE, never silently allowing a code to issue 40 km
// out and never hard-blocking a legitimate delivery where tracking simply was not
// running:
//   * FRESH live fix within the drop radius       → PASS
//   * FRESH live fix in the corroboration band AND
//     a 'drop' geofence-enter already recorded    → PASS (dock-scale GPS drift)
//   * FRESH live fix beyond that                  → BLOCK (this is the 40 km hole)
//   * STALE live fix (any distance)               → ignored entirely; falls through
//   * no usable fix but a 'drop' enter on record  → PASS (arrived; no live fix to lean on)
//   * no signal at all                            → DEGRADE (allow, flagged weaker)
//
// "FRESH" is load-bearing and is why isFixFresh exists: trip_telemetry.last_fix_at
// never expires, so an hours-old fix left behind by a dead phone would otherwise
// block a driver who is standing at the dock, permanently and with no way out. A
// stale fix is treated as no fix at all — see MAX_FIX_AGE_MS in geo.ts.
//
// Any read failure resolves toward DEGRADE, not an exception: the gate is an added
// control and must never convert a POD request that worked into a 500.
// -----------------------------------------------------------

export type OtpGateDecision = 'pass' | 'block' | 'degrade'

export type OtpGateResult = {
  decision: OtpGateDecision
  verdict: 'inside' | 'outside' | 'unknown'
  distance_m: number | null
  source: 'telemetry' | 'geofence_event' | 'none'
  // Whether this decision is ENFORCED or merely observed — see geofenceGateEnforced.
  // The caller refuses issuance only on decision==='block' AND enforced===true; the
  // audit line is written either way.
  enforced: boolean
}

// -----------------------------------------------------------
// POD_GEOFENCE_GATE — the kill switch, DEFAULT OFF.
//
// WHY OFF BY DEFAULT: applying migration 0025 is what makes podFeatureAvailable()
// answer true, and that alone would arm a hard 409 across the LIVE POD path — the
// only path a trip has to reach 'completed' — on thresholds (DROP_RADIUS_M,
// MAX_FIX_AGE_MS) that have never been measured against a real drive. Coupling
// "the tables exist" to "the gate refuses deliveries" makes the migration itself
// the risky act, with no lever short of rolling back schema. This is that lever:
// apply 0025 whenever it is convenient, watch the audit trail, and turn the gate
// on deliberately once the first real corridor drive says the numbers are right.
//
// OFF DOES NOT MEAN BLIND. The gate still runs, still resolves a full decision,
// and still writes its otp_gate_pass / otp_gate_block / otp_gate_degraded audit
// line carrying enforced=false — so the very first thing anyone asks ("how often
// WOULD this have blocked a real driver?") is answerable from production data
// before the switch is ever flipped. A kill switch that also blinds you buys
// nothing: you would flip it on with exactly as little evidence as you had today.
//
// Read per call, not cached at module load, so a Cloud Run revision can be
// toggled by env alone and the tests can exercise both positions in one process
// (the same shape storage.ts uses for POD_EVIDENCE_BUCKET).
// -----------------------------------------------------------
const GEOFENCE_GATE_ENV = 'POD_GEOFENCE_GATE'

export function geofenceGateEnforced(): boolean {
  const raw = process.env[GEOFENCE_GATE_ENV]?.trim().toLowerCase()
  // Explicit opt-in only. Anything else — unset, empty, 'false', a typo — is OFF,
  // because the failure mode of guessing wrong here is refusing real deliveries.
  return raw === 'on' || raw === 'true' || raw === '1'
}

// dropGeofencePoint — the point the POD geofence measures against. When the shipper dragged an
// exact-gate pin (migration 0035, dest_gate_lat/lng) it is used; otherwise the geocoded/typed
// drop address (dest_lat/lng). Distance and pricing still use the address pin — only the
// geofence prefers the gate, because an address centroid can sit a few hundred metres from the
// real gate and that gap is what leaves a driver blocked outside the fence (D-020). Guards null
// explicitly: Number(null) is 0, which would silently pin the gate to the Gulf of Guinea.
function dropGeofencePoint(booking: BookingWithProfiles): { lat: number; lng: number } {
  const gLat = booking.dest_gate_lat
  const gLng = booking.dest_gate_lng
  if (gLat != null && gLng != null && Number.isFinite(Number(gLat)) && Number.isFinite(Number(gLng))) {
    return { lat: Number(gLat), lng: Number(gLng) }
  }
  return { lat: booking.dest_lat, lng: booking.dest_lng }
}

export async function evaluateOtpGate(
  booking: BookingWithProfiles,
  log?: Logger,
): Promise<OtpGateResult> {
  const enforced = geofenceGateEnforced()
  try {
    const telem = await podRepo.getTelemetryLastFix(booking.id)
    const drop = dropGeofencePoint(booking)
    const haveDest = Number.isFinite(drop.lat) && Number.isFinite(drop.lng)

    // A fix we cannot show is recent is not evidence of where the truck is NOW, so it
    // is dropped here rather than inside the branches — the fall-through below then
    // reaches the geofence-event / degrade paths exactly as if telemetry never ran.
    if (telem && !isFixFresh(telem.at)) {
      log?.warn(
        { booking_id: booking.id, last_fix_at: telem.at },
        'OTP geofence gate ignoring a stale telemetry fix — falling through to corroboration',
      )
    } else if (telem && haveDest) {
      const d = haversineMeters(telem.lat, telem.lng, drop.lat, drop.lng)
      if (d <= DROP_RADIUS_M) {
        return { decision: 'pass', verdict: 'inside', distance_m: d, source: 'telemetry', enforced }
      }
      if (d <= NEAR_DROP_M && (await podRepo.hasDropEnterEvent(booking.id))) {
        return { decision: 'pass', verdict: 'inside', distance_m: d, source: 'telemetry', enforced }
      }
      // A fresh fix clearly away from the drop. Do not let a stale enter event override
      // it — issuing the code while the truck is demonstrably elsewhere is the fraud.
      return { decision: 'block', verdict: 'outside', distance_m: d, source: 'telemetry', enforced }
    }

    if (await podRepo.hasDropEnterEvent(booking.id)) {
      return { decision: 'pass', verdict: 'inside', distance_m: null, source: 'geofence_event', enforced }
    }

    return { decision: 'degrade', verdict: 'unknown', distance_m: null, source: 'none', enforced }
  } catch (err) {
    // No signal we can trust → degrade, never fail the caller's POD request.
    log?.warn({ err, booking_id: booking.id }, 'OTP geofence gate read failed — degrading')
    return { decision: 'degrade', verdict: 'unknown', distance_m: null, source: 'none', enforced }
  }
}

// -----------------------------------------------------------
// captureEvidence — a camera capture at the drop. Records metadata, hands the bytes to
// the (currently inert) WORM store, and audits. Idempotent on (booking, hash).
// -----------------------------------------------------------

// The statuses in which the trip is still LIVE ON THE GROUND — the truck is at or
// approaching the drop and the driver is still working the delivery. Deliberately
// the same set the location routes track through (see LOCATION_TRACKED_STATUSES in
// routes/location.ts): a driver who asserts delivery and then finds the receiver
// after all, or who is asked by ops for one more photo of a damaged pallet, is in
// the same physical situation they were a minute earlier. Two lists that disagree
// would mean the camera works while the GPS trail that dates it has gone dark.
const EVIDENCE_CAPTURABLE: BookingStatus[] = ['in_transit', 'delivery_asserted']

export type CaptureResult = {
  evidence_id: string
  booking_id: string
  kind: string | null
  sha256_original: string
  sha256_received: string | null
  captured_at_server: string
  clock_skew_seconds: number | null
  geofence_result: string
  geofence_distance_m: number | null
  mock_location_detected: boolean
  storage_status: string
  created: boolean
}

export async function captureEvidence(
  bookingId: string,
  actor: AuthenticatedUser,
  body: EvidenceCaptureBody,
  log?: Logger,
  storage: EvidenceStorage = defaultEvidenceStorage(),
): Promise<CaptureResult> {
  const { booking, driverId } = await resolveAssignedDriver(bookingId, actor)

  if (!EVIDENCE_CAPTURABLE.includes(booking.status)) {
    throw new BookingError(
      `POD evidence can only be captured while the trip is ${EVIDENCE_CAPTURABLE.join(' or ')} (booking is '${booking.status}')`,
      'INVALID_TRANSITION',
      409,
    )
  }

  // Server time is authoritative; the device time is a claim; the gap is the signal.
  const serverNow = new Date()
  let skew: number | null = null
  if (body.captured_at_device) {
    const deviceMs = new Date(body.captured_at_device).getTime()
    if (Number.isFinite(deviceMs)) {
      // Signed: device ahead of the server is positive (matches the column comment).
      skew = Math.round((deviceMs - serverNow.getTime()) / 1000)
    }
  }

  // Geofence the capture against the Rule 46(o) delivery address — the dragged gate pin when
  // the shipper set one (migration 0035), else the drop address.
  let distanceM: number | null = null
  const capDrop = dropGeofencePoint(booking)
  if (
    body.lat !== undefined && body.lng !== undefined &&
    Number.isFinite(capDrop.lat) && Number.isFinite(capDrop.lng)
  ) {
    distanceM = haversineMeters(body.lat, body.lng, capDrop.lat, capDrop.lng)
  }
  const verdict = geofenceVerdict(distanceM)

  const { row, created } = await podRepo.insertEvidence({
    booking_id: bookingId,
    driver_id: driverId,
    sha256_original: body.sha256_original,
    kind: body.kind ?? null,
    capture_method: body.capture_method,
    captured_at_device: body.captured_at_device ?? null,
    clock_skew_seconds: skew,
    lat: body.lat ?? null,
    lng: body.lng ?? null,
    gps_accuracy_m: body.gps_accuracy_m ?? null,
    gps_source: body.gps_source ?? null,
    mock_location_detected: body.mock_location_detected ?? false,
    geofence_distance_m: distanceM,
    geofence_result: verdict,
    device_id: body.device_id ?? null,
    os_version: body.os_version ?? null,
    app_version: body.app_version ?? null,
    lr_number: body.lr_number ?? null,
    exif_raw: body.exif_raw ?? null,
  })

  // Decode the uploaded bytes once (base64 → Buffer); null for a metadata-only capture.
  const bytes = body.image_base64 ? Buffer.from(body.image_base64, 'base64') : null
  let sha256Received: string | null = row.sha256_received

  // Only the FIRST insert stores bytes / audits a capture — a resubmit already did.
  if (created) {
    const stored = await storage.store(
      { bookingId, evidenceId: row.id, sha256Original: row.sha256_original, contentType: body.content_type ?? null },
      bytes,
      log,
    )
    await podRepo.updateEvidenceStorage(row.id, stored.status, stored.originalBytesUri, stored.sha256Received)
    row.storage_status = stored.status
    sha256Received = stored.sha256Received ?? sha256Received
    await podRepo.appendAudit(
      {
        booking_id: bookingId,
        evidence_id: row.id,
        action: 'evidence_captured',
        actor_user_id: actor.userId,
        actor_role: actor.role,
        detail: {
          kind: body.kind ?? null,
          geofence_result: verdict,
          clock_skew_seconds: skew,
          mock_location_detected: body.mock_location_detected ?? false,
          storage_status: stored.status,
          // Whether the server's hash of the arrived bytes matched the device claim (null when
          // nothing was uploaded). A false here is a byte-integrity red flag for the verifier.
          hash_verified: sha256Received !== null ? sha256Received === row.sha256_original : null,
        },
      },
      log,
    )
  }

  return {
    evidence_id: row.id,
    booking_id: bookingId,
    kind: row.kind,
    sha256_original: row.sha256_original,
    sha256_received: sha256Received,
    captured_at_server: row.captured_at_server,
    clock_skew_seconds: skew,
    geofence_result: verdict,
    geofence_distance_m: distanceM,
    mock_location_detected: body.mock_location_detected ?? false,
    storage_status: row.storage_status,
    created,
  }
}

// -----------------------------------------------------------
// Claim clocks (§5.7). Pure — computes the two deadlines from the two anchor dates so
// the same maths is testable in isolation and shown identically in every response.
// -----------------------------------------------------------

export type ClaimClocks = {
  booking_date: string | null
  delivery_date: string | null
  claim_notice_deadline: string | null // 180 days from booking (pre-suit notice)
  insurance_intimation_deadline: string | null // 7 days from delivery
  claim_notice_days: number
  insurance_intimation_days: number
}

export function computeClaimClocks(bookingDateIso: string | null, deliveryDateIso: string | null): ClaimClocks {
  const plusDays = (iso: string | null, days: number): string | null => {
    if (!iso) return null
    const t = new Date(iso).getTime()
    if (!Number.isFinite(t)) return null
    return new Date(t + days * DAY_MS).toISOString()
  }
  return {
    booking_date: bookingDateIso,
    delivery_date: deliveryDateIso,
    claim_notice_deadline: plusDays(bookingDateIso, CLAIM_NOTICE_DAYS),
    insurance_intimation_deadline: plusDays(deliveryDateIso, INSURANCE_INTIMATION_DAYS),
    claim_notice_days: CLAIM_NOTICE_DAYS,
    insurance_intimation_days: INSURANCE_INTIMATION_DAYS,
  }
}

// -----------------------------------------------------------
// submitDiscrepancy — structured shortage/damage capture (§5.7). Idempotent on booking.
// -----------------------------------------------------------

// Same live-on-the-ground window as EVIDENCE_CAPTURABLE, and for the same reason:
// the shortage is usually found while unloading, which can straddle the assertion.
const DISCREPANCY_LOGGABLE: BookingStatus[] = ['in_transit', 'delivery_asserted']

export type DiscrepancyResult = {
  discrepancy_id: string
  booking_id: string
  expected_quantity: number | null
  actual_quantity: number
  delta: number | null
  reason: string
  evidence_id: string | null
  driver_ack_at: string
  consignee_ack_at: string | null
  claim_clocks: ClaimClocks
  created: boolean
}

export async function submitDiscrepancy(
  bookingId: string,
  actor: AuthenticatedUser,
  body: DiscrepancyBody,
  log?: Logger,
): Promise<DiscrepancyResult> {
  const { booking, driverId } = await resolveAssignedDriver(bookingId, actor)

  if (!DISCREPANCY_LOGGABLE.includes(booking.status)) {
    throw new BookingError(
      `A discrepancy can only be logged while the trip is ${DISCREPANCY_LOGGABLE.join(' or ')} (booking is '${booking.status}')`,
      'INVALID_TRANSITION',
      409,
    )
  }

  // 🔴 EXPECTED IS SERVER-HELD. Read it off the booking, never off the wire (the schema
  // already refuses a client-sent expected_quantity). A NULL here means no server-held
  // count was ever set — the delta is then uncomputable and the record says so, which
  // is honest rather than inventing a baseline the driver could have shaped.
  const expected = booking.pod_expected_quantity ?? null
  const delta = expected === null ? null : body.actual_quantity - expected

  // Mandatory geofenced photo when the counts differ — and for damage regardless of
  // count, because damaged-but-complete cargo is a discrepancy a number cannot show.
  // delta === null (no server-held expected) is treated as "not reconciled" and also
  // requires the photo: a discrepancy claim with no image is the weak POD §5.5 warns of.
  const photoRequired = delta === null || delta !== 0 || body.reason === 'damage'
  let evidenceId: string | null = null
  if (photoRequired) {
    if (!body.evidence_id) {
      throw new BookingError(
        'A geofenced delivery photo is required for this discrepancy — capture evidence first',
        'VALIDATION_ERROR',
        400,
      )
    }
    const ev = await podRepo.getEvidenceById(body.evidence_id)
    if (!ev || ev.booking_id !== bookingId) {
      throw new BookingError('evidence_id does not reference a photo captured on this booking', 'VALIDATION_ERROR', 400)
    }
    evidenceId = ev.id
  }

  // Delivery is happening now (the driver is at the drop logging the note); the
  // insurance clock starts here. The booking date is the s.16 anchor.
  const nowIso = new Date().toISOString()
  const bookingDate = booking.created_at ? new Date(booking.created_at).toISOString() : null

  const { row, created } = await podRepo.insertDiscrepancy({
    booking_id: bookingId,
    expected_quantity: expected,
    actual_quantity: body.actual_quantity,
    delta,
    quantity_unit: body.quantity_unit ?? booking.pod_quantity_unit ?? null,
    reason: body.reason,
    evidence_id: evidenceId,
    driver_id: driverId,
    booking_date: bookingDate,
    delivery_date: nowIso,
  })

  if (created) {
    await podRepo.appendAudit(
      {
        booking_id: bookingId,
        evidence_id: evidenceId,
        action: 'discrepancy_logged',
        actor_user_id: actor.userId,
        actor_role: actor.role,
        detail: { reason: body.reason, expected_quantity: expected, actual_quantity: body.actual_quantity, delta },
      },
      log,
    )
  }

  return {
    discrepancy_id: row.id,
    booking_id: bookingId,
    expected_quantity: row.expected_quantity,
    actual_quantity: row.actual_quantity,
    delta: row.delta,
    reason: row.reason,
    evidence_id: row.evidence_id,
    driver_ack_at: row.driver_ack_at,
    consignee_ack_at: row.consignee_ack_at,
    claim_clocks: computeClaimClocks(row.booking_date, row.delivery_date),
    created,
  }
}

// -----------------------------------------------------------
// assertDelivery — the no-confirmation branch. Driver captured evidence, the receiver
// cannot confirm, so the trip moves in_transit → delivery_asserted (NOT completed) and
// pod_state records pod_strength='asserted'. Ops closes it later. Idempotent: asserting
// an already-asserted trip returns the existing state.
//
// THE ONE REAL SEQUENCE ENFORCED: at least one photo must already exist. Everything
// else is idempotent and orderless per the founder rule — but a delivery asserted with
// nothing captured is precisely the unprovable claim this slice exists to prevent.
// -----------------------------------------------------------

export type AssertResult = {
  booking_id: string
  status: BookingStatus
  pod_strength: 'asserted'
  assert_reason: string
  asserted_at: string | null
  created: boolean
}

export async function assertDelivery(
  bookingId: string,
  actor: AuthenticatedUser,
  body: AssertDeliveryBody,
  log?: Logger,
): Promise<AssertResult> {
  const { booking, driverId } = await resolveAssignedDriver(bookingId, actor)

  // Idempotent no-op: already asserted → return the existing record unchanged.
  if (booking.status === 'delivery_asserted') {
    const state = await podRepo.getPodState(bookingId)
    return {
      booking_id: bookingId,
      status: booking.status,
      pod_strength: 'asserted',
      assert_reason: state?.assert_reason ?? body.assert_reason,
      asserted_at: state?.asserted_at ?? null,
      created: false,
    }
  }

  // Inert without 0025: the delivery_asserted enum value and pod_state do not exist
  // there, so refuse cleanly with a 503 up front rather than letting the transition
  // fail deep in the repository as an opaque 500. (transitionBookingStatus wraps DB
  // errors as a bare Error, so the enum-missing code cannot be recovered downstream.)
  if (!(await podRepo.podFeatureAvailable(log))) {
    throw new BookingError(
      'Delivery assertion is not enabled on this environment yet — migration 0025 has not been applied',
      'UPSTREAM_ERROR',
      503,
    )
  }

  // Evidence-before-assertion is the real-world precondition.
  if (!(await podRepo.hasEvidence(bookingId))) {
    throw new BookingError(
      'Capture at least one delivery photo before asserting delivery — an assertion with no evidence cannot stand',
      'VALIDATION_ERROR',
      400,
    )
  }

  // Server-side state-machine guard (in_transit → delivery_asserted).
  assertValidTransition(booking.status, 'delivery_asserted')

  const updated = await repo.transitionBookingStatus(bookingId, driverId, booking.status, 'delivery_asserted')
  if (!updated) {
    throw new BookingError(
      "Booking could not be asserted — its status changed concurrently",
      'INVALID_TRANSITION',
      409,
    )
  }

  await podRepo.setAsserted(bookingId, driverId, body.assert_reason)
  await podRepo.appendAudit(
    {
      booking_id: bookingId,
      action: 'delivery_asserted',
      actor_user_id: actor.userId,
      actor_role: actor.role,
      detail: { assert_reason: body.assert_reason },
    },
    log,
  )

  // FB-01: free truck at delivery_asserted (trip end), not only at paid.
  emitAssignmentRelease(bookingId, log)

  return {
    booking_id: bookingId,
    status: 'delivery_asserted',
    pod_strength: 'asserted',
    assert_reason: body.assert_reason,
    asserted_at: new Date().toISOString(),
    created: true,
  }
}

// -----------------------------------------------------------
// getPodRecord — the READ half of the POD ledger, and the only way anyone outside
// this service can tell a CONFIRMED delivery from an ASSERTED one.
//
// Without it, migration 0025 writes proof nobody can look at: pod_strength decides
// which proof a claim adjuster is holding (§6.3) and ops closes delivery_asserted
// trips, so ops needs to see the difference before they close one. It also makes the
// 'evidence_access' audit action real — §5.4 rule 5 wants reads on the trail, not
// just writes, because "who looked at this photo, and when" is part of what makes the
// hash and the timestamps credible in a dispute.
//
// AUTHORIZATION IS RELATION-TO-OBJECT, NOT ROLE (D-27). The same relationsToBooking()
// gate consignee/service.ts and getBooking use: shipper, carrier, assigned driver,
// claimed consignee — plus ops/admin, who hold no relation by construction and are
// carved out explicitly. An empty relation set is observer-only and gets a 404 rather
// than a 403, matching getBooking: a stranger must not be able to probe which booking
// ids exist by reading the difference between the two.
// -----------------------------------------------------------

// The relations that see FORENSIC detail — the WORM storage handle, the raw EXIF, the
// device fingerprint, the precise fix, and the fraud signals (mock_location_detected,
// clock_skew_seconds).
//
// THE DECISION, stated so widening it cannot happen by accident:
//   * ops/admin and the SHIPPER get it. They are the parties who prosecute or defend a
//     claim about this consignment, and the storage URI is the handle an export or a
//     legal hold resolves against. The shipper paid for the carriage and is the one who
//     must be able to say "produce the original bytes".
//   * the CARRIER, the assigned DRIVER and the CONSIGNEE do not. Two separate reasons,
//     both deliberate. The fraud signals are DETECTION OUTPUT aimed at the capturing
//     side: handing a driver the list of which of their photos tripped the mock-location
//     or clock-skew check teaches them precisely what to change next time, which is how
//     a control gets defeated by its own transparency. And the consignee is downstream
//     of the carriage — they are a stakeholder in the shipment, not in its forensics
//     (the same line seesCommercialsOnBooking draws for money).
//   * NOBODY gets a raw object URI they could hand on. Everyone still sees
//     storage_status, so "was the original retained?" is answerable without it.
//
// This is deliberately the tight end of the range. Widening it — a fleet owner
// defending their driver has a real claim — should be a decision with a reason, not a
// field that quietly appeared in a payload.
const POD_FORENSIC_RELATIONS: BookingRelation[] = ['shipper']

// What every party to the consignment sees: the durable proof facts. This is enough to
// answer "is there evidence, when was it taken, was it at the drop, and is the original
// retained" — which is the whole question a non-adjudicating party has.
export type PodEvidenceView = {
  evidence_id: string
  kind: string | null
  captured_at_server: string
  capture_method: string
  sha256_original: string
  geofence_result: string
  geofence_distance_m: number | null
  storage_status: string
  lr_number: string | null
  // A short-lived signed URL to view the retained photo, or null when nothing was stored
  // (inert/no_op). Derived from the stored handle; the raw object URI stays forensic-only.
  image_url: string | null
}

// The adjudicating tier, merged onto the view above for POD_FORENSIC_RELATIONS.
export type PodEvidenceForensics = {
  captured_at_device: string | null
  clock_skew_seconds: number | null
  lat: number | null
  lng: number | null
  gps_accuracy_m: number | null
  gps_source: string | null
  mock_location_detected: boolean
  sha256_received: string | null
  original_bytes_uri: string | null
  device_id: string | null
  os_version: string | null
  app_version: string | null
  exif_raw: Record<string, unknown> | null
}

export type PodDiscrepancyView = {
  discrepancy_id: string
  expected_quantity: number | null
  actual_quantity: number
  delta: number | null
  quantity_unit: string | null
  reason: string
  evidence_id: string | null
  driver_ack_at: string
  consignee_ack_at: string | null
  consignee_ack_via: string | null
  consignee_user_id: string | null
  claim_clocks: ClaimClocks
}

export type PodRecord = {
  booking_id: string
  status: BookingStatus
  viewer_relations: BookingRelation[]
  // false on a database without migration 0025: the tables are not there, so the
  // record reads as "no POD hardening here" instead of failing. A trip completed by
  // the email OTP still answers, with an empty evidence list and a null strength.
  pod_hardening_available: boolean
  pod_strength: 'confirmed' | 'asserted' | null
  confirmed_at: string | null
  confirmed_via: string | null
  asserted_at: string | null
  assert_reason: string | null
  closed_by_ops_at: string | null
  // The fleet owner's review of the delivery evidence (migration 0039).
  fleet_review_status: 'pending' | 'approved' | 'rejected' | null
  fleet_reviewed_at: string | null
  fleet_review_note: string | null
  evidence: Array<PodEvidenceView & Partial<PodEvidenceForensics>>
  discrepancy: PodDiscrepancyView | null
}

export async function getPodRecord(
  bookingId: string,
  actor: AuthenticatedUser,
  log?: Logger,
): Promise<PodRecord> {
  const booking = await repo.getBookingById(bookingId)
  if (!booking) {
    throw new BookingError(`Booking ${bookingId} not found`, 'NOT_FOUND', 404)
  }

  // Ops/admin hold no relation to a booking by construction — they act for the platform
  // on both parties' behalf — so they are carved out before the relation set is resolved
  // rather than being bent into one. Same carve-out attachConsignees and listBookings make.
  const isOps = actor.role === 'admin'
  let relations: BookingRelation[] = []
  if (!isOps) {
    const snapshot = await resolvePersonas(supabase, actor.userId, actor.role)
    relations = relationsToBooking(booking, snapshot)
    if (relations.length === 0) {
      throw new BookingError(`Booking ${bookingId} not found`, 'NOT_FOUND', 404)
    }
  }

  const forensic = isOps || relations.some(r => POD_FORENSIC_RELATIONS.includes(r))

  // All three reads degrade to "nothing recorded" on a pre-0025 database (the READ half
  // of the missing-relation contract), so this endpoint answers for every booking that
  // exists, not only for the ones the hardening has touched.
  const available = await podRepo.podFeatureAvailable(log)
  const [state, evidence, discrepancy] = await Promise.all([
    podRepo.getPodState(bookingId),
    podRepo.listEvidence(bookingId),
    podRepo.getDiscrepancy(bookingId),
  ])

  // §5.4 rule 5 — the read goes on the append-only trail with the relation that
  // authorized it, so a later "who saw this evidence" question has an answer. Written
  // AFTER authorization so a rejected probe leaves no line, and best-effort, so a full
  // audit table can never make the evidence unreadable.
  await podRepo.appendAudit(
    {
      booking_id: bookingId,
      action: 'evidence_access',
      actor_user_id: actor.userId,
      actor_role: actor.role,
      detail: {
        relations: isOps ? ['ops'] : relations,
        forensic,
        evidence_count: evidence.length,
      },
    },
    log,
  )

  return {
    booking_id: bookingId,
    status: booking.status,
    viewer_relations: relations,
    pod_hardening_available: available,
    pod_strength: state?.pod_strength ?? null,
    confirmed_at: state?.confirmed_at ?? null,
    confirmed_via: state?.confirmed_via ?? null,
    asserted_at: state?.asserted_at ?? null,
    assert_reason: state?.assert_reason ?? null,
    closed_by_ops_at: state?.closed_by_ops_at ?? null,
    fleet_review_status: state?.fleet_review_status ?? null,
    fleet_reviewed_at: state?.fleet_reviewed_at ?? null,
    fleet_review_note: state?.fleet_review_note ?? null,
    evidence: await Promise.all(evidence.map(async (row) => {
      const base: PodEvidenceView = {
        evidence_id: row.id,
        kind: row.kind,
        captured_at_server: row.captured_at_server,
        capture_method: row.capture_method,
        sha256_original: row.sha256_original,
        geofence_result: row.geofence_result,
        geofence_distance_m: row.geofence_distance_m,
        storage_status: row.storage_status,
        lr_number: row.lr_number,
        // Signed view of the retained photo for any authorized viewer — the fleet owner verifies
        // from this. Short TTL; regenerated each read. Null when nothing was stored.
        image_url: await signedEvidenceUrl(row.original_bytes_uri),
      }
      if (!forensic) return base
      return {
        ...base,
        captured_at_device: row.captured_at_device,
        clock_skew_seconds: row.clock_skew_seconds,
        lat: row.lat,
        lng: row.lng,
        gps_accuracy_m: row.gps_accuracy_m,
        gps_source: row.gps_source,
        mock_location_detected: row.mock_location_detected,
        sha256_received: row.sha256_received,
        original_bytes_uri: row.original_bytes_uri,
        device_id: row.device_id,
        os_version: row.os_version,
        app_version: row.app_version,
        exif_raw: row.exif_raw,
      }
    })),
    discrepancy: discrepancy
      ? {
          discrepancy_id: discrepancy.id,
          expected_quantity: discrepancy.expected_quantity,
          actual_quantity: discrepancy.actual_quantity,
          delta: discrepancy.delta,
          quantity_unit: discrepancy.quantity_unit,
          reason: discrepancy.reason,
          evidence_id: discrepancy.evidence_id,
          driver_ack_at: discrepancy.driver_ack_at,
          consignee_ack_at: discrepancy.consignee_ack_at,
          consignee_ack_via: discrepancy.consignee_ack_via,
          consignee_user_id: discrepancy.consignee_user_id ?? null,
          claim_clocks: computeClaimClocks(discrepancy.booking_date, discrepancy.delivery_date),
        }
      : null,
  }
}

// -----------------------------------------------------------
// setExpectedQuantity — the shipper/ops write path for the server-held expected count.
// Mirrors setReceiverEmail exactly: the OWNING shipper or ops, non-terminal bookings
// only, and DELIBERATELY NOT the driver — the driver reporting both the expected AND
// the actual is the pilferage hole (§5.7). Kept here so the "server-held" claim is
// backed by a real, driver-inaccessible write path.
// -----------------------------------------------------------

const EXPECTED_QTY_EDITABLE: BookingStatus[] = ['pending', 'negotiating', 'accepted', 'in_transit']

export async function setExpectedQuantity(
  bookingId: string,
  quantity: number,
  unit: string | null,
  actor: AuthenticatedUser,
): Promise<BookingWithProfiles> {
  const booking = await repo.getBookingById(bookingId)
  if (!booking) {
    throw new BookingError(`Booking ${bookingId} not found`, 'NOT_FOUND', 404)
  }

  // WHO: owning shipper relation or ops — never JWT role (D-27). A distributor
  // holding a fleet_owner-role token who POSTED this load passes; the driver never does.
  if (actor.role !== 'admin') {
    const snapshot = await resolvePersonas(supabase, actor.userId, actor.role)
    if (!relationsToBooking(booking, snapshot).includes('shipper')) {
      throw new BookingError(
        'Only the shipper who owns this booking (or ops) can set the expected quantity — never the driver',
        'FORBIDDEN',
        403,
      )
    }
  }

  if (!EXPECTED_QTY_EDITABLE.includes(booking.status)) {
    throw new BookingError(
      `The expected quantity cannot be changed on a '${booking.status}' booking`,
      'INVALID_TRANSITION',
      409,
    )
  }

  const updated = await podRepo.setExpectedQuantity(bookingId, quantity, unit, EXPECTED_QTY_EDITABLE)
  if (!updated) {
    throw new BookingError(
      'Booking could not be updated — its status changed concurrently',
      'INVALID_TRANSITION',
      409,
    )
  }
  return updated
}

// -----------------------------------------------------------
// Fleet-owner verification (migration 0039). The carrier reviews its driver's delivery
// evidence — the two typed geotagged photos — and APPROVES or REJECTS it. This is a NEW
// verification actor, distinct from the receiver OTP (which confirms) and the ops close
// (which merely closes an asserted trip): the fleet owner attesting the proof their own
// driver captured. Gated by canFleetAccessBooking (the owner or a delegated member),
// never by a JWT role (D-27) — and never the driver, who cannot mark their own proof good.
// -----------------------------------------------------------

export const VerifyDeliverySchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().max(500).optional(),
}).strict()

export type VerifyDeliveryBody = z.infer<typeof VerifyDeliverySchema>

export type VerifyResult = {
  booking_id: string
  fleet_review_status: 'approved' | 'rejected'
  fleet_reviewed_at: string
  note: string | null
  created: boolean
}

// A fleet owner (or delegate) who can reach this booking, or ops. A stranger gets a 404, not a
// 403 — the same id-hiding carve-out getPodRecord uses.
async function assertFleetReviewer(bookingId: string, actor: AuthenticatedUser): Promise<BookingWithProfiles> {
  const booking = await repo.getBookingById(bookingId)
  if (!booking) throw new BookingError(`Booking ${bookingId} not found`, 'NOT_FOUND', 404)
  if (actor.role === 'admin') return booking
  const fleetOwner = await resolveFleetOwnerByUserId(supabase, actor.userId)
  if (!fleetOwner || !(await canFleetAccessBooking(supabase, fleetOwner.id, booking))) {
    throw new BookingError(`Booking ${bookingId} not found`, 'NOT_FOUND', 404)
  }
  return booking
}

export async function verifyDelivery(
  bookingId: string,
  actor: AuthenticatedUser,
  body: VerifyDeliveryBody,
  log?: Logger,
): Promise<VerifyResult> {
  await assertFleetReviewer(bookingId, actor)

  const state = await podRepo.getPodState(bookingId)
  if (!state) {
    throw new BookingError('There is no delivery evidence to review on this booking yet', 'INVALID_TRANSITION', 409)
  }

  const target: 'approved' | 'rejected' = body.decision === 'approve' ? 'approved' : 'rejected'

  // Idempotent on the SAME decision (a double-tap returns the existing record). A DIFFERENT
  // decision after one was made is refused — a verdict is changed by a fresh review with a
  // reason, not silently flipped on a retry.
  if (state.fleet_review_status === target) {
    return {
      booking_id: bookingId,
      fleet_review_status: target,
      fleet_reviewed_at: state.fleet_reviewed_at ?? new Date().toISOString(),
      note: state.fleet_review_note,
      created: false,
    }
  }
  if (state.fleet_review_status === 'approved' || state.fleet_review_status === 'rejected') {
    throw new BookingError(
      `This delivery was already ${state.fleet_review_status} — it cannot be changed to ${target}`,
      'INVALID_TRANSITION',
      409,
    )
  }

  await podRepo.setFleetReview(bookingId, target, actor.userId, body.note ?? null)
  await podRepo.appendAudit(
    {
      booking_id: bookingId,
      action: target === 'approved' ? 'evidence_approved' : 'evidence_rejected',
      actor_user_id: actor.userId,
      actor_role: actor.role,
      detail: { note: body.note ?? null },
    },
    log,
  )

  return {
    booking_id: bookingId,
    fleet_review_status: target,
    fleet_reviewed_at: new Date().toISOString(),
    note: body.note ?? null,
    created: true,
  }
}

// listFleetPodPending — the fleet owner's review queue: deliveries owned by their fleet whose
// evidence is awaiting a decision. Owner-scoped; a caller who owns no fleet gets an empty queue.
export type FleetPendingResult = { pending: podRepo.FleetPendingRow[] }

export async function listFleetPodPending(actor: AuthenticatedUser): Promise<FleetPendingResult> {
  const fleetOwner = await resolveFleetOwnerByUserId(supabase, actor.userId)
  if (!fleetOwner) return { pending: [] }
  const pending = await podRepo.listPendingFleetReview(fleetOwner.id)
  return { pending }
}
