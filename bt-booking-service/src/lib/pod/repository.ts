// ============================================================
// src/lib/pod/repository.ts
//
// Responsibility: the ONLY path between the POD hardening (migration 0025) and its
// four tables — pod_evidence, pod_state, pod_discrepancies, pod_audit_log — plus the
// two read-only geofence tables from 0019 the OTP gate consults.
//
// MISSING-RELATION CONTRACT, identical to fleet.ts and documents/repository.ts:
// migrations are applied BY HAND while CD deploys this service on merge, so this code
// runs against a pre-0025 database for a window. The split is deliberate:
//
//   * FEATURE PROBE + READS answer "no POD hardening here" (feature off, no evidence,
//     no geofence gate). This is what makes the existing email-OTP POD behave EXACTLY
//     as today on a database without 0025 — the whole non-negotiable of this slice.
//   * BEST-EFFORT WRITES that ride EXISTING paths (audit log; the pod_state 'confirmed'
//     stamp and consignee-ack that hang off completeBookingViaPod) SWALLOW a missing
//     relation and move on — the trip already completed upstream; a POD-ledger row is a
//     consequence, never a blocker (the emit.ts `safely` contract).
//   * PRIMARY WRITES reachable only from the NEW endpoints (capture, discrepancy) fail
//     LOUD with a 503 — silently pretending to store legal evidence is far worse than an
//     error the operator can read (documents/repository.ts precedent).
// ============================================================

import { supabase } from '../supabase.js'
import { BookingError } from '../types.js'
import type { BookingStatus, BookingWithProfiles } from '../types.js'

// PostgREST reports an unknown table as 42P01 (Postgres) or PGRST205 (schema-cache
// miss). Both mean "migration 0025 has not been applied to this database yet."
const MISSING_RELATION_CODES = new Set(['42P01', 'PGRST205'])
// An unknown COLUMN (bookings.pod_expected_quantity before 0025) surfaces as 42703
// or the PostgREST schema-cache variant PGRST204 — same "0025 not applied" meaning,
// but on a column of an existing table rather than a whole missing table.
const MISSING_COLUMN_CODES = new Set(['42703', 'PGRST204'])
// 23505 unique_violation — the idempotency signal on pod_evidence(booking_id,
// sha256_original) and pod_discrepancies(booking_id): a resubmit, not a fault.
const UNIQUE_VIOLATION = '23505'

type DbError = { code?: string; message?: string } | null

function isMissingRelation(error: DbError): boolean {
  return !!error?.code && MISSING_RELATION_CODES.has(error.code)
}

function isMissingColumn(error: DbError): boolean {
  return !!error?.code && MISSING_COLUMN_CODES.has(error.code)
}

function isUniqueViolation(error: DbError): boolean {
  return error?.code === UNIQUE_VIOLATION
}

// The 503 every primary write raises when 0025 is not yet applied. Verbatim shape of
// the documents-repository "feature not enabled here" refusal.
// UPSTREAM_ERROR/503, the exact shape documents/repository.ts uses for a write against
// a database where the migration has not landed — a loud, readable "not enabled here"
// rather than a 500 that pretends nothing was expected to work.
function podNotEnabled(what: string): BookingError {
  return new BookingError(
    `POD evidence capture is not enabled on this environment yet (${what}) — migration 0025 has not been applied`,
    'UPSTREAM_ERROR',
    503,
  )
}

// -----------------------------------------------------------
// podFeatureAvailable — is migration 0025 live on this database?
//
// Conservative BY DESIGN: a missing relation, OR any other error we cannot classify,
// answers `false`. The geofence gate and the strength ledger are ADDED controls; if we
// cannot confirm the schema is there, we must not let that turn a POD request that
// worked yesterday into a 500. Feature-off degrades to exactly today's behaviour.
// -----------------------------------------------------------

export async function podFeatureAvailable(
  log?: { warn(obj: unknown, msg: string): void },
): Promise<boolean> {
  const { error } = await supabase.from('pod_evidence').select('id').limit(1)
  if (!error) return true
  if (!isMissingRelation(error)) {
    log?.warn({ err: error }, 'pod feature probe failed — treating POD hardening as unavailable')
  }
  return false
}

// -----------------------------------------------------------
// Evidence
// -----------------------------------------------------------

export type EvidenceInsert = {
  booking_id: string
  driver_id: string | null
  sha256_original: string
  // Which required delivery shot this is (migration 0039): 'signed_invoice' | 'vehicle' |
  // 'goods' | 'other'. Null for a legacy/generic capture — the DB CHECK allows null.
  kind: string | null
  capture_method: string
  captured_at_device: string | null
  clock_skew_seconds: number | null
  lat: number | null
  lng: number | null
  gps_accuracy_m: number | null
  gps_source: string | null
  mock_location_detected: boolean
  geofence_distance_m: number | null
  geofence_result: string
  device_id: string | null
  os_version: string | null
  app_version: string | null
  lr_number: string | null
  exif_raw: Record<string, unknown> | null
}

export type EvidenceRow = EvidenceInsert & {
  id: string
  captured_at_server: string
  sha256_received: string | null
  original_bytes_uri: string | null
  storage_status: string
  created_at: string
}

// insertEvidence — idempotent on (booking_id, sha256_original). A retry of the same
// capture converges on the SAME row rather than minting a second: on the unique
// violation we read the existing row back and return it, so the driver's flaky-network
// retry is a no-op, not a duplicate. Missing relation → 503 (endpoint inert pre-0025).
export async function insertEvidence(row: EvidenceInsert): Promise<{ row: EvidenceRow; created: boolean }> {
  const { data, error } = await supabase.from('pod_evidence').insert(row).select('*').maybeSingle()

  if (error) {
    if (isUniqueViolation(error)) {
      const existing = await getEvidenceByHash(row.booking_id, row.sha256_original)
      if (existing) return { row: existing, created: false }
      // Lost the race but the row is not readable back — surface as a conflict, not a 500.
      throw new BookingError('POD evidence already recorded for this capture', 'CONFLICT', 409)
    }
    if (isMissingRelation(error)) throw podNotEnabled('capture')
    throw new Error(`pod_evidence insert failed: ${error.message}`)
  }
  return { row: data as EvidenceRow, created: true }
}

export async function getEvidenceByHash(bookingId: string, sha256: string): Promise<EvidenceRow | null> {
  const { data, error } = await supabase
    .from('pod_evidence')
    .select('*')
    .eq('booking_id', bookingId)
    .eq('sha256_original', sha256)
    .maybeSingle()
  if (error) {
    if (isMissingRelation(error)) return null
    throw new Error(`pod_evidence read failed: ${error.message}`)
  }
  return data as EvidenceRow | null
}

export async function getEvidenceById(id: string): Promise<EvidenceRow | null> {
  const { data, error } = await supabase.from('pod_evidence').select('*').eq('id', id).maybeSingle()
  if (error) {
    if (isMissingRelation(error)) return null
    throw new Error(`pod_evidence read failed: ${error.message}`)
  }
  return data as EvidenceRow | null
}

// hasEvidence — does the trip carry at least one captured photo? The assert-delivery
// gate: a driver cannot assert a delivery they photographed nothing of.
export async function hasEvidence(bookingId: string): Promise<boolean> {
  const { data, error } = await supabase.from('pod_evidence').select('id').eq('booking_id', bookingId).limit(1)
  if (error) {
    if (isMissingRelation(error)) return false
    throw new Error(`pod_evidence count failed: ${error.message}`)
  }
  return (data?.length ?? 0) > 0
}

// listEvidence — every capture on a trip, newest first (the pod_evidence_booking_idx
// order). A READ, so a pre-0025 database answers "no evidence" rather than raising:
// the POD read endpoint must still describe an OTP-completed trip on a database where
// the hardening has not landed, which is the whole missing-relation contract above.
export async function listEvidence(bookingId: string): Promise<EvidenceRow[]> {
  const { data, error } = await supabase
    .from('pod_evidence')
    .select('*')
    .eq('booking_id', bookingId)
    .order('created_at', { ascending: false })
  if (error) {
    if (isMissingRelation(error)) return []
    throw new Error(`pod_evidence list failed: ${error.message}`)
  }
  return (data ?? []) as EvidenceRow[]
}

// updateEvidenceStorage — record where the WORM store put the bytes (or that it
// no-op'd). Best-effort: the evidence row already exists and is the durable record;
// the storage outcome is metadata on top of it.
export async function updateEvidenceStorage(
  id: string,
  storageStatus: string,
  originalBytesUri: string | null,
  sha256Received: string | null,
): Promise<void> {
  const patch: Record<string, unknown> = { storage_status: storageStatus, original_bytes_uri: originalBytesUri }
  // Only stamp sha256_received when the server actually hashed arrived bytes — a metadata-only
  // (no_op) capture leaves it null rather than overwriting a real hash with nothing.
  if (sha256Received !== null) patch.sha256_received = sha256Received
  const { error } = await supabase.from('pod_evidence').update(patch).eq('id', id)
  if (error && !isMissingRelation(error)) {
    throw new Error(`pod_evidence storage update failed: ${error.message}`)
  }
}

// -----------------------------------------------------------
// pod_state — the proof-strength ledger.
// -----------------------------------------------------------

export type PodStateRow = {
  booking_id: string
  pod_strength: 'confirmed' | 'asserted'
  confirmed_at: string | null
  confirmed_via: string | null
  asserted_at: string | null
  asserted_by_driver_id: string | null
  assert_reason: string | null
  closed_by_ops_at: string | null
  closed_by_ops_user_id: string | null
  // Fleet-owner review of the delivery evidence (migration 0039). 'pending' is stamped when the
  // driver asserts/completes; the owner then approves/rejects on their dashboard.
  fleet_review_status: 'pending' | 'approved' | 'rejected' | null
  fleet_reviewed_by: string | null
  fleet_reviewed_at: string | null
  fleet_review_note: string | null
}

export async function getPodState(bookingId: string): Promise<PodStateRow | null> {
  const { data, error } = await supabase.from('pod_state').select('*').eq('booking_id', bookingId).maybeSingle()
  if (error) {
    if (isMissingRelation(error)) return null
    throw new Error(`pod_state read failed: ${error.message}`)
  }
  return data as PodStateRow | null
}

// setAsserted — the evidence-only tier. This is a PRIMARY write (only the new
// assert-delivery endpoint reaches it), so a missing relation is a 503, not a shrug.
export async function setAsserted(
  bookingId: string,
  driverId: string | null,
  reason: string | null,
): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await supabase.from('pod_state').upsert(
    {
      booking_id: bookingId,
      pod_strength: 'asserted',
      asserted_at: now,
      asserted_by_driver_id: driverId,
      assert_reason: reason,
      // Enter the fleet owner's review queue (migration 0039). Only ever set on the first
      // assertion — assertDelivery returns early on an already-asserted trip, so this never
      // rewinds an approved/rejected decision back to pending.
      fleet_review_status: 'pending',
      updated_at: now,
    },
    { onConflict: 'booking_id' },
  )
  if (error) {
    if (isMissingRelation(error)) throw podNotEnabled('assert')
    throw new Error(`pod_state assert upsert failed: ${error.message}`)
  }
}

// setConfirmed — the OTP-confirmed tier, stamped as a CONSEQUENCE of an already-
// completed trip (completeBookingViaPod). BEST-EFFORT: swallow a missing relation so
// the existing OTP completion is byte-identical on a pre-0025 database. Never
// overwrites an existing row's strength downward — a booking already 'asserted' that
// somehow also gets an OTP stays as it was recorded; we only fill a fresh row.
export async function setConfirmedBestEffort(
  bookingId: string,
  via: string,
  log?: { warn(obj: unknown, msg: string): void },
): Promise<void> {
  const existing = await getPodStateSafe(bookingId, log)
  if (existing) return // already has a strength on record — do not rewrite it
  const now = new Date().toISOString()
  const { error } = await supabase.from('pod_state').upsert(
    {
      booking_id: bookingId,
      pod_strength: 'confirmed',
      confirmed_at: now,
      confirmed_via: via,
      // A receiver-confirmed delivery still enters the fleet owner's review queue — the owner
      // reviews their driver's captured photos regardless of how the trip closed. Only set on
      // the fresh row (this branch runs only when no pod_state existed).
      fleet_review_status: 'pending',
      updated_at: now,
    },
    { onConflict: 'booking_id' },
  )
  if (error && !isMissingRelation(error)) {
    log?.warn({ err: error, booking_id: bookingId }, 'pod_state confirm stamp failed (trip already completed)')
  }
}

async function getPodStateSafe(
  bookingId: string,
  log?: { warn(obj: unknown, msg: string): void },
): Promise<PodStateRow | null> {
  try {
    return await getPodState(bookingId)
  } catch (err) {
    log?.warn({ err, booking_id: bookingId }, 'pod_state read failed (best-effort)')
    return null
  }
}

// markOpsClosed — ops closed a delivery_asserted trip. Stamps who/when; pod_strength
// is left as-is ('asserted'), the whole point of the ledger. Best-effort.
export async function markOpsClosedBestEffort(
  bookingId: string,
  opsUserId: string,
  log?: { warn(obj: unknown, msg: string): void },
): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('pod_state')
    .update({ closed_by_ops_at: now, closed_by_ops_user_id: opsUserId, updated_at: now })
    .eq('booking_id', bookingId)
  if (error && !isMissingRelation(error)) {
    log?.warn({ err: error, booking_id: bookingId }, 'pod_state ops-close stamp failed')
  }
}

// setFleetReview — the fleet owner's approve/reject decision on a delivery's evidence
// (migration 0039). A PRIMARY write behind the new verify endpoint, so a missing relation is a
// 503, not a shrug. The caller has already read pod_state and confirmed it is 'pending', so the
// row exists; this stamps the verdict, the reviewer and the moment.
export async function setFleetReview(
  bookingId: string,
  status: 'approved' | 'rejected',
  reviewerUserId: string,
  note: string | null,
): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('pod_state')
    .update({
      fleet_review_status: status,
      fleet_reviewed_by: reviewerUserId,
      fleet_reviewed_at: now,
      fleet_review_note: note,
      updated_at: now,
    })
    .eq('booking_id', bookingId)
  if (error) {
    if (isMissingRelation(error)) throw podNotEnabled('fleet-review')
    throw new Error(`pod_state fleet-review update failed: ${error.message}`)
  }
}

export type FleetPendingRow = {
  booking_id: string
  pod_strength: 'confirmed' | 'asserted'
  asserted_at: string | null
  confirmed_at: string | null
  status: BookingStatus
  source_address: string
  destination_address: string
  shipper_name: string
  driver_id: string | null
}

// listPendingFleetReview — the fleet owner's review queue: deliveries owned by THIS fleet whose
// evidence is awaiting review. A READ, so a pre-0025 database answers "nothing pending" rather
// than raising. The bookings embed is an INNER join filtered on fleet_owner_id, so a delivery
// on someone else's fleet can never leak into this owner's queue.
type RawPendingRow = {
  booking_id: string
  pod_strength: 'confirmed' | 'asserted'
  asserted_at: string | null
  confirmed_at: string | null
  bookings: {
    id: string
    fleet_owner_id: string | null
    status: BookingStatus
    source_address: string
    destination_address: string
    shipper_name: string
    driver_id: string | null
  }
}

export async function listPendingFleetReview(fleetOwnerId: string): Promise<FleetPendingRow[]> {
  const { data, error } = await supabase
    .from('pod_state')
    .select(
      'booking_id, pod_strength, asserted_at, confirmed_at, ' +
        'bookings!inner(id, fleet_owner_id, status, source_address, destination_address, shipper_name, driver_id)',
    )
    .eq('fleet_review_status', 'pending')
    .eq('bookings.fleet_owner_id', fleetOwnerId)
    .order('asserted_at', { ascending: false, nullsFirst: false })
  if (error) {
    if (isMissingRelation(error)) return []
    throw new Error(`pod_state pending-review list failed: ${error.message}`)
  }
  return ((data ?? []) as unknown as RawPendingRow[]).map((r) => ({
    booking_id: r.booking_id,
    pod_strength: r.pod_strength,
    asserted_at: r.asserted_at,
    confirmed_at: r.confirmed_at,
    status: r.bookings.status,
    source_address: r.bookings.source_address,
    destination_address: r.bookings.destination_address,
    shipper_name: r.bookings.shipper_name,
    driver_id: r.bookings.driver_id,
  }))
}

// -----------------------------------------------------------
// Discrepancies
// -----------------------------------------------------------

export type DiscrepancyInsert = {
  booking_id: string
  expected_quantity: number | null
  actual_quantity: number
  delta: number | null
  quantity_unit: string | null
  reason: string
  evidence_id: string | null
  driver_id: string | null
  booking_date: string | null
  delivery_date: string | null
}

export type DiscrepancyRow = DiscrepancyInsert & {
  id: string
  driver_ack_at: string
  consignee_ack_at: string | null
  consignee_ack_via: string | null
  // users.id of the party who acknowledged as consignee, when that party has CLAIMED
  // an account (bookings.consignee_user_id, migration 0026). NULL for the unclaimed
  // consignee — which is most of them, and whose access path is the OTP, not a login.
  consignee_user_id: string | null
  created_at: string
  updated_at: string
}

// insertDiscrepancy — idempotent on booking_id (one discrepancy note per delivery,
// like one note on the LR). A resubmit converges on the existing row.
export async function insertDiscrepancy(row: DiscrepancyInsert): Promise<{ row: DiscrepancyRow; created: boolean }> {
  const { data, error } = await supabase.from('pod_discrepancies').insert(row).select('*').maybeSingle()
  if (error) {
    if (isUniqueViolation(error)) {
      const existing = await getDiscrepancy(row.booking_id)
      if (existing) return { row: existing, created: false }
      throw new BookingError('Discrepancy already recorded for this booking', 'CONFLICT', 409)
    }
    if (isMissingRelation(error)) throw podNotEnabled('discrepancy')
    throw new Error(`pod_discrepancies insert failed: ${error.message}`)
  }
  return { row: data as DiscrepancyRow, created: true }
}

export async function getDiscrepancy(bookingId: string): Promise<DiscrepancyRow | null> {
  const { data, error } = await supabase.from('pod_discrepancies').select('*').eq('booking_id', bookingId).maybeSingle()
  if (error) {
    if (isMissingRelation(error)) return null
    throw new Error(`pod_discrepancies read failed: ${error.message}`)
  }
  return data as DiscrepancyRow | null
}

// stampConsigneeAck — the second half of the dual acknowledgement, landed when the
// consignee verifies the OTP (rides completeBookingViaPod). Best-effort; a delivery
// with no discrepancy simply has nothing to stamp.
//
// consigneeUserId is bookings.consignee_user_id (migration 0026) and is what turns
// "someone acknowledged" into "THIS party acknowledged". A joint damage certificate
// names both signatories; an ack row that records only a timestamp names one. NULL is
// the honest answer for an unclaimed consignee — they hold no account, and the OTP
// they entered is the identity evidence — so the column is nullable and never guessed.
export async function stampConsigneeAckBestEffort(
  bookingId: string,
  via: string,
  consigneeUserId: string | null,
  log?: { warn(obj: unknown, msg: string): void },
): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('pod_discrepancies')
    .update({
      consignee_ack_at: now,
      consignee_ack_via: via,
      consignee_user_id: consigneeUserId,
      delivery_date: now,
      updated_at: now,
    })
    .eq('booking_id', bookingId)
    .is('consignee_ack_at', null)
  if (error && !isMissingRelation(error)) {
    log?.warn({ err: error, booking_id: bookingId }, 'consignee-ack stamp failed (trip already completed)')
  }
}

// -----------------------------------------------------------
// Audit log — append-only, best-effort. A failure to log must never fail the
// operation being logged, but it is warned, never silently swallowed.
// -----------------------------------------------------------

export type AuditEntry = {
  booking_id: string
  evidence_id?: string | null
  action: string
  actor_user_id?: string | null
  actor_role?: string | null
  detail?: Record<string, unknown>
}

export async function appendAudit(
  entry: AuditEntry,
  log?: { warn(obj: unknown, msg: string): void },
): Promise<void> {
  const { error } = await supabase.from('pod_audit_log').insert({
    booking_id: entry.booking_id,
    evidence_id: entry.evidence_id ?? null,
    action: entry.action,
    actor_user_id: entry.actor_user_id ?? null,
    actor_role: entry.actor_role ?? null,
    detail: entry.detail ?? {},
  })
  if (error && !isMissingRelation(error)) {
    log?.warn({ err: error, booking_id: entry.booking_id, action: entry.action }, 'pod audit append failed')
  }
}

// -----------------------------------------------------------
// Geofence reads — the 0019 tables (present independently of 0025). These feed the
// OTP gate: has the truck reached the drop, and where is its last live fix?
// -----------------------------------------------------------

// A 'drop' geofence ENTER event means the truck reached the delivery fence at some
// point. Used as corroboration when there is no live telemetry to lean on.
export async function hasDropEnterEvent(bookingId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('geofence_events')
    .select('id')
    .eq('booking_id', bookingId)
    .eq('kind', 'drop')
    .eq('event', 'enter')
    .limit(1)
  if (error) {
    if (isMissingRelation(error)) return false
    throw new Error(`geofence_events read failed: ${error.message}`)
  }
  return (data?.length ?? 0) > 0
}

// The truck's last known position from the per-trip telemetry rollup. NULL when the
// tracking evaluator never ran for this trip (no signal → the gate degrades).
export async function getTelemetryLastFix(
  bookingId: string,
): Promise<{ lat: number; lng: number; at: string | null } | null> {
  const { data, error } = await supabase
    .from('trip_telemetry')
    .select('last_lat, last_lng, last_fix_at')
    .eq('booking_id', bookingId)
    .maybeSingle()
  if (error) {
    if (isMissingRelation(error)) return null
    throw new Error(`trip_telemetry read failed: ${error.message}`)
  }
  if (!data || data.last_lat === null || data.last_lng === null) return null
  return { lat: data.last_lat as number, lng: data.last_lng as number, at: (data.last_fix_at as string) ?? null }
}

// -----------------------------------------------------------
// setExpectedQuantity — write the server-held expected count onto the booking.
//
// A PRIMARY write behind the shipper/ops endpoint. The status `in` filter is the same
// optimistic guard setReceiverEmail uses. A missing COLUMN (pre-0025) is turned into a
// 503 rather than a raw 500 — the endpoint is inert until the migration lands, exactly
// like the evidence endpoints, and for the same reason.
// -----------------------------------------------------------

export async function setExpectedQuantity(
  bookingId: string,
  quantity: number,
  unit: string | null,
  allowedStatuses: BookingStatus[],
): Promise<BookingWithProfiles | null> {
  const { data, error } = await supabase
    .from('bookings')
    .update({ pod_expected_quantity: quantity, pod_quantity_unit: unit, updated_at: new Date().toISOString() })
    .eq('id', bookingId)
    .in('status', allowedStatuses)
    .select('*')
    .maybeSingle()

  if (error) {
    if (isMissingColumn(error)) throw podNotEnabled('expected-quantity')
    throw new Error(`bookings expected-quantity update failed: ${error.message}`)
  }
  return data as BookingWithProfiles | null
}
