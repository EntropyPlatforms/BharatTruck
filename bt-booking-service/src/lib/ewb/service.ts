// -----------------------------------------------------------
// ewb/service — e-way bills GENERATED and MAINTAINED on NIC's portal from the app, through
// the GSP (Sandbox), in the shipper's own name.
//
// Before this the app only RECORDED a bill someone had generated on the portal. Now:
//   generate       Part A + Part B from the booking, the LR / invoice and a short form
//   updateVehicle  Part B again when the truck changes (NIC: by the generator while no
//                  transporter is assigned, else by the transporter)
//   extend         validity, in the 8-hour window either side of expiry
//   cancel         on the portal, within 24 h of generation (generator only)
//   sync           re-read the bill from the portal (validity, status) into our record
//   pdfUrl         a fresh download link for the portal's PDF
//
// WHO: the bill is raised under the SHIPPER's GSTIN with the SHIPPER's portal API login
// (eway_portal_credentials), so every call here requires the actor to be that shipper (or
// ops). A carrier updating Part B with its own transporter login is a later addition.
//
// Every portal answer that changes a bill is written to eway_bill_records exactly as the
// portal states it — valid_upto is NEVER computed here (rules.ts / §4.4).
// -----------------------------------------------------------

import { relationsToBooking, resolvePersonas } from '@bharattruck/shared/personas'
import { z } from 'zod'
import { BookingError, type AuthenticatedUser } from '../types.js'
import * as repo from '../repository.js'
import { supabase } from '../supabase.js'
import * as docs from '../documents/repository.js'
import { isStandingEwayBill } from '../documents/rules.js'
import { ewbSandbox, EwbSandboxClient } from './sandbox.js'
import * as creds from './credentials.js'
import { buildGeneratePayload, EwbError, nicData, nicDateTimeToIso, normaliseVehicleNo, type GenerateInput, type PartyFacts } from './nic.js'

const CONSIGNOR = '/gst/compliance/e-way-bill/consignor'
const TAXPAYER = '/gst/compliance/e-way-bill/tax-payer'

// ── schemas ───────────────────────────────────────────────────

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

export const PortalCredentialsBodySchema = z.object({
  gstin:    z.string().trim().toUpperCase().regex(GSTIN_RE, 'gstin must be a 15-character GSTIN'),
  username: z.string().trim().min(3).max(60),
  password: z.string().min(4).max(100),
})

export const GenerateEwayBillBodySchema = z.object({
  document_number:          z.string().trim().min(1).max(16),
  document_date:            z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'document_date must be yyyy-mm-dd'),
  consignee_name:           z.string().trim().min(2).max(100),
  consignee_gstin:          z.string().trim().toUpperCase().max(15).optional().nullable(),
  hsn_code:                 z.string().trim().regex(/^\d{4,8}$/, 'hsn_code must be 4–8 digits'),
  product_name:             z.string().trim().min(2).max(100),
  taxable_value_inr:        z.number().positive().finite(),
  gst_rate:                 z.union([z.literal(0), z.literal(5), z.literal(12), z.literal(18), z.literal(28)]),
  total_invoice_value_inr:  z.number().positive().finite(),
  distance_km:              z.number().positive().max(4000),
  vehicle_number:           z.string().trim().max(15).optional().nullable(),
  transporter_id:           z.string().trim().toUpperCase().regex(GSTIN_RE).optional().nullable(),
  from_place:               z.string().trim().min(2).max(50),
  to_place:                 z.string().trim().min(2).max(50),
  vehicle_type:             z.enum(['R', 'O']).optional(),
})

export const UpdateVehicleBodySchema = z.object({
  vehicle_number: z.string().trim().min(7).max(15),
  /** NIC Part B reason: 1 breakdown, 2 transhipment, 3 others, 4 first time. */
  reason_code:    z.enum(['1', '2', '3', '4']),
  remarks:        z.string().trim().min(2).max(50),
  from_place:     z.string().trim().min(2).max(50),
  vehicle_type:   z.enum(['R', 'O']).optional(),
})

export const ExtendValidityBodySchema = z.object({
  remaining_distance_km: z.number().positive().max(4000),
  /** NIC extension reason: 1 natural calamity, 2 law and order, 3 transhipment, 4 accident, 99 others. */
  reason_code:           z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(99)]),
  remarks:               z.string().trim().min(2).max(50),
  from_place:            z.string().trim().min(2).max(50),
  from_pincode:          z.string().trim().regex(/^[1-9]\d{5}$/),
  from_state_code:       z.string().trim().regex(/^\d{2}$/).optional(),
  vehicle_number:        z.string().trim().max(15).optional().nullable(),
  /** 'M' = goods in movement (give the vehicle); 'T' = in transit at a place (give the address). */
  consignment_status:    z.enum(['M', 'T']).optional(),
  transit_type:          z.enum(['R', 'W', 'O']).optional(),
  address_line1:         z.string().trim().max(120).optional(),
})

export const CancelOnPortalBodySchema = z.object({
  /** NIC: 1 duplicate, 2 order cancelled, 3 data-entry mistake, 4 others. */
  reason_code: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  remarks:     z.string().trim().max(100).optional(),
})

export type PortalCredentialsBody = z.infer<typeof PortalCredentialsBodySchema>
export type GenerateEwayBillBody = z.infer<typeof GenerateEwayBillBodySchema>
export type UpdateVehicleBody = z.infer<typeof UpdateVehicleBodySchema>
export type ExtendValidityBody = z.infer<typeof ExtendValidityBodySchema>
export type CancelOnPortalBody = z.infer<typeof CancelOnPortalBodySchema>

// ── portal credentials ────────────────────────────────────────

export function portalCredentialsView(userId: string) {
  return creds.getCredentialsView(userId)
}

/** Save after a real login to the portal — a wrong password is refused here, not at the first bill. */
export async function savePortalCredentials(userId: string, body: PortalCredentialsBody, client: EwbSandboxClient = ewbSandbox) {
  if (!creds.credentialsStorageConfigured()) {
    throw new EwbError('E-way bill portal credentials cannot be stored: EWB_CREDENTIALS_KEY is not set on the server', 503, 'NOT_CONFIGURED')
  }
  await client.forgetSession(body.gstin)
  await client.ewbSession(body, true)
  await creds.saveCredentials(userId, body)
  return creds.getCredentialsView(userId)
}

export async function removePortalCredentials(userId: string, client: EwbSandboxClient = ewbSandbox) {
  const existing = await creds.getCredentials(userId).catch(() => null)
  if (existing) await client.forgetSession(existing.gstin)
  await creds.deleteCredentials(userId)
}

// ── access ────────────────────────────────────────────────────

async function loadBookingOr404(bookingId: string) {
  const booking = await repo.getBookingById(bookingId)
  if (!booking) throw new BookingError(`Booking ${bookingId} not found`, 'NOT_FOUND', 404)
  return booking
}

/** The bill is raised in the shipper's name with the shipper's login: only the shipper (or ops). */
async function assertShipper(booking: { shipper_id: string; driver_id: string | null; fleet_owner_id: string | null }, actor: AuthenticatedUser) {
  if (actor.role === 'admin') return
  const snapshot = await resolvePersonas(supabase, actor.userId, actor.role)
  if (relationsToBooking(booking, snapshot).includes('shipper')) return
  throw new BookingError('Only the shipper who posted this load can raise or change its e-way bill on the portal', 'FORBIDDEN', 403)
}

async function shipperCredentials(shipperUserId: string) {
  const c = await creds.getCredentials(shipperUserId)
  if (!c) throw new EwbError('Add your e-way bill portal API login in Settings first', 409, 'PORTAL_NOT_LINKED')
  return c
}

async function standingRecord(bookingId: string, ewbNumber: string) {
  const record = (await docs.listEwayBills(bookingId)).find((r) => r.ewb_number === ewbNumber)
  if (!record) throw new BookingError(`E-way bill ${ewbNumber} is not recorded against this booking`, 'NOT_FOUND', 404)
  return record
}

async function updateRecord(bookingId: string, ewbNumber: string, patch: Record<string, unknown>) {
  const { data, error } = await supabase.from('eway_bill_records').update(patch).eq('booking_id', bookingId).eq('ewb_number', ewbNumber).select('*').maybeSingle()
  if (error) throw new BookingError(`E-way bill record update failed: ${error.message}`, 'INTERNAL', 500)
  return data as docs.DbEwayBillRecord
}

/** With the shipper's session; a stale session (401-ish NIC auth) is retried once with a fresh login. */
async function withSession<T>(c: creds.PortalCredentials, client: EwbSandboxClient, fn: (token: string) => Promise<T>): Promise<T> {
  const token = await client.ewbSession(c)
  try {
    return await fn(token)
  } catch (err) {
    if (err instanceof EwbError && (err.code === 'UPSTREAM' || err.code === 'VALIDATION_ERROR') && /auth|token|session|401/i.test(err.message)) {
      const fresh = await client.ewbSession(c, true)
      return fn(fresh)
    }
    throw err
  }
}

// ── defaults for the form ─────────────────────────────────────

export type GenerateDefaults = {
  portal_linked: boolean
  shipper_gstin: string | null
  document_number: string | null
  document_date: string | null
  consignee_name: string | null
  consignee_gstin: string | null
  product_name: string | null
  total_invoice_value_inr: number | null
  taxable_value_inr: number | null
  vehicle_number: string | null
  transporter_id: string | null
  from_place: string | null
  to_place: string | null
  inter_state: boolean | null
  weight_kg: number | null
  /** Road km: the trip's routed distance, else the quote's. Null = type it (it used to be always blank). */
  distance_km: number | null
  /** The rate on the shipper's own tax invoice; null = choose one (it used to default to 5%). */
  gst_rate: 0 | 5 | 12 | 18 | 28 | null
}

/** The standard GST rate a tax invoice was raised at, or null when it is not one of them. Exported for tests. */
export function invoiceGstRate(inv: { taxable_value_inr: string | number; cgst_inr?: string | number | null; sgst_inr?: string | number | null; igst_inr?: string | number | null; utgst_inr?: string | number | null } | null): 0 | 5 | 12 | 18 | 28 | null {
  if (!inv) return null
  const taxable = Number(inv.taxable_value_inr)
  if (!(taxable > 0)) return null
  const tax = [inv.cgst_inr, inv.sgst_inr, inv.igst_inr, inv.utgst_inr].reduce<number>((s, v) => s + (Number(v) || 0), 0)
  const pct = (tax / taxable) * 100
  const hit = ([0, 5, 12, 18, 28] as const).find((r) => Math.abs(pct - r) < 0.15)
  return hit ?? null
}

/** Road km for the e-way bill: the routed distance, else the quote's. Exported for tests. */
export async function tripDistanceKm(bookingId: string): Promise<number | null> {
  const { data: route } = await supabase.from('trip_routes').select('distance_m').eq('booking_id', bookingId).maybeSingle()
  const m = Number((route as { distance_m?: number } | null)?.distance_m)
  if (m > 0) return Math.round(m / 1000)
  const { data: quote } = await supabase.from('price_quotes').select('distance_km').eq('consumed_by_booking_id', bookingId).limit(1).maybeSingle()
  const km = Number((quote as { distance_km?: number | string } | null)?.distance_km)
  return km > 0 ? Math.round(km) : null
}

const firstSegment = (addr: string | null | undefined) => (addr ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(-3, -2)[0] ?? (addr ?? '').split(',')[0]?.trim() ?? null

export async function generateDefaults(bookingId: string, actor: AuthenticatedUser): Promise<GenerateDefaults> {
  const booking = await loadBookingOr404(bookingId)
  await assertShipper(booking, actor)
  // Columns the LR row carries beyond the typed subset (repository.ts types only what its own
  // callers read).
  type LrExtra = { consignee_gstin?: string | null; said_to_contain?: string | null; vehicle_number?: string | null; origin_place?: string | null; destination_place?: string | null; invoice_number?: string | null; invoice_value_inr?: string | number | null; issued_at?: string }
  const [lrRow, invoice, view, shipper, distanceKm] = await Promise.all([
    docs.getLorryReceipt(bookingId),
    docs.getFreightInvoice(bookingId),
    creds.getCredentialsView(actor.userId),
    supabase.from('users').select('gstin').eq('id', booking.shipper_id).maybeSingle(),
    tripDistanceKm(bookingId).catch(() => null),
  ])
  const lr = lrRow as (typeof lrRow & LrExtra) | null
  const fleetGstin = booking.fleet_owner_id
    ? ((await supabase.from('fleet_owners').select('gstin').eq('id', booking.fleet_owner_id).maybeSingle()).data as { gstin?: string } | null)?.gstin ?? null
    : null
  const b = booking as typeof booking & { source_state_code?: string | null; dest_state_code?: string | null }
  return {
    portal_linked: view.configured,
    shipper_gstin: (shipper.data as { gstin?: string } | null)?.gstin ?? null,
    document_number: lr?.invoice_number ?? invoice?.invoice_number ?? null,
    document_date: invoice?.issued_at?.slice(0, 10) ?? lr?.issued_at?.slice(0, 10) ?? null,
    consignee_name: lr?.consignee_name ?? invoice?.billed_to_name ?? null,
    consignee_gstin: lr?.consignee_gstin ?? invoice?.billed_to_gstin ?? null,
    product_name: lr?.said_to_contain ?? booking.load_type ?? null,
    total_invoice_value_inr: lr?.invoice_value_inr != null ? Number(lr.invoice_value_inr) : invoice ? Number(invoice.consignment_value_inr) : null,
    taxable_value_inr: invoice ? Number(invoice.taxable_value_inr) : null,
    vehicle_number: lr?.vehicle_number ?? null,
    transporter_id: fleetGstin,
    from_place: lr?.origin_place ?? firstSegment(booking.source_address),
    to_place: lr?.destination_place ?? firstSegment(booking.destination_address),
    inter_state: b.source_state_code && b.dest_state_code ? b.source_state_code !== b.dest_state_code : null,
    weight_kg: booking.weight_kg != null ? Number(booking.weight_kg) : null,
    distance_km: distanceKm,
    gst_rate: invoiceGstRate(invoice as never),
  }
}

// ── generate ──────────────────────────────────────────────────

export async function generateEwayBill(bookingId: string, body: GenerateEwayBillBody, actor: AuthenticatedUser, client: EwbSandboxClient = ewbSandbox) {
  const booking = await loadBookingOr404(bookingId)
  await assertShipper(booking, actor)
  const c = await shipperCredentials(booking.shipper_id)

  const b = booking as typeof booking & { source_pincode?: string | null; source_state_code?: string | null; dest_pincode?: string | null; dest_state_code?: string | null }
  const facts: PartyFacts = {
    shipper_gstin: c.gstin,
    shipper_name: booking.shipper_name,
    source_address: booking.source_address,
    source_pincode: b.source_pincode ?? '',
    source_state_code: b.source_state_code ?? '',
    destination_address: booking.destination_address,
    dest_pincode: b.dest_pincode ?? '',
    dest_state_code: b.dest_state_code ?? '',
    weight_kg: booking.weight_kg != null ? Number(booking.weight_kg) : null,
  }
  const input: GenerateInput = { ...body, consignee_gstin: body.consignee_gstin ?? null, vehicle_number: body.vehicle_number ?? null, transporter_id: body.transporter_id ?? null }
  const payload = buildGeneratePayload(facts, input)

  const data = await withSession(c, client, async (token) =>
    nicData<{ ewayBillNo?: number | string; ewayBillDate?: string; validUpto?: string; alert?: string }>(
      await client.call('POST', `${CONSIGNOR}/bill`, payload, token),
      'Generating the e-way bill',
    ),
  )
  const ewbNumber = String(data.ewayBillNo ?? '')
  const generatedAt = nicDateTimeToIso(data.ewayBillDate) ?? new Date().toISOString()
  const validUpto = nicDateTimeToIso(data.validUpto)
  if (!/^\d{12}$/.test(ewbNumber) || !validUpto) {
    throw new EwbError('The portal generated a bill but returned no number or validity — check the portal before trying again', 502, 'UPSTREAM')
  }

  // The portal's PDF link is time-limited; it is kept as the uploaded copy the pickup gate
  // asks for and refreshed on demand by pdfUrl().
  let documentUri: string | null = null
  try { documentUri = await fetchPdfUrl(ewbNumber, c, client) } catch { documentUri = null }

  const vehicleNo = normaliseVehicleNo(body.vehicle_number)
  const record = await docs.recordEwayBill({
    bookingId,
    ewbNumber,
    generatedAt,
    validUpto,
    issuingPortal: 'NIC1',
    partBEnteredAt: vehicleNo ? generatedAt : null,
    documentNumber: body.document_number,
    consignmentValueInr: body.total_invoice_value_inr,
    documentUri,
    recordedBy: actor.userId,
  })
  return { record, alert: data.alert ?? null }
}

// ── Part B ────────────────────────────────────────────────────

export async function updateVehicle(bookingId: string, ewbNumber: string, body: UpdateVehicleBody, actor: AuthenticatedUser, client: EwbSandboxClient = ewbSandbox) {
  const booking = await loadBookingOr404(bookingId)
  await assertShipper(booking, actor)
  const record = await standingRecord(bookingId, ewbNumber)
  if (!isStandingEwayBill(record.status)) throw new BookingError(`E-way bill ${ewbNumber} is ${record.status}`, 'INVALID_TRANSITION', 409)
  const c = await shipperCredentials(booking.shipper_id)
  const b = booking as typeof booking & { source_state_code?: string | null }
  const vehicleNo = normaliseVehicleNo(body.vehicle_number)
  if (vehicleNo.length < 7) throw new EwbError('Vehicle number must be 7–15 characters (e.g. MH12AB1234)', 400, 'VALIDATION_ERROR')

  const data = await withSession(c, client, async (token) =>
    nicData<{ validUpto?: string; vehUpdDate?: string }>(
      await client.call('PUT', `${CONSIGNOR}/bill/${ewbNumber}/vehicle`, {
        ewbNo: Number(ewbNumber),
        vehicleNo,
        vehicleType: body.vehicle_type ?? 'R',
        fromPlace: body.from_place.slice(0, 50),
        fromState: Number(b.source_state_code ?? 0),
        reasonCode: body.reason_code,
        reasonRem: body.remarks.slice(0, 50),
        transMode: '1',
      }, token),
      'Updating the vehicle (Part B)',
    ),
  )
  const updated = await updateRecord(bookingId, ewbNumber, {
    part_b_entered_at: nicDateTimeToIso(data.vehUpdDate) ?? new Date().toISOString(),
    ...(nicDateTimeToIso(data.validUpto) ? { valid_upto: nicDateTimeToIso(data.validUpto) } : {}),
  })
  return updated
}

// ── extend ────────────────────────────────────────────────────

export async function extendValidity(bookingId: string, ewbNumber: string, body: ExtendValidityBody, actor: AuthenticatedUser, client: EwbSandboxClient = ewbSandbox) {
  const booking = await loadBookingOr404(bookingId)
  await assertShipper(booking, actor)
  const record = await standingRecord(bookingId, ewbNumber)
  if (!isStandingEwayBill(record.status)) throw new BookingError(`E-way bill ${ewbNumber} is ${record.status}`, 'INVALID_TRANSITION', 409)
  const c = await shipperCredentials(booking.shipper_id)
  const b = booking as typeof booking & { source_state_code?: string | null }
  const consignmentStatus = body.consignment_status ?? 'M'
  const vehicleNo = normaliseVehicleNo(body.vehicle_number)
  if (consignmentStatus === 'M' && vehicleNo.length < 7) throw new EwbError('Give the vehicle number for goods in movement', 400, 'VALIDATION_ERROR')
  if (consignmentStatus === 'T' && !body.transit_type) throw new EwbError('Give the transit type (R road, W warehouse, O others) for goods in transit', 400, 'VALIDATION_ERROR')

  const data = await withSession(c, client, async (token) =>
    nicData<{ validUpto?: string; updatedDate?: string }>(
      await client.call('POST', `${CONSIGNOR}/bill/${ewbNumber}/extend`, {
        ewbNo: Number(ewbNumber),
        ...(vehicleNo ? { vehicleNo } : {}),
        fromPlace: body.from_place.slice(0, 50),
        fromState: Number(body.from_state_code ?? b.source_state_code ?? 0),
        remainingDistance: Math.round(body.remaining_distance_km),
        transMode: '1',
        extnRsnCode: body.reason_code,
        extnRemarks: body.remarks.slice(0, 50),
        fromPincode: Number(body.from_pincode),
        consignmentStatus: consignmentStatus,
        ...(body.transit_type ? { transitType: body.transit_type } : {}),
        ...(body.address_line1 ? { addressLine1: body.address_line1.slice(0, 120) } : {}),
      }, token),
      'Extending the e-way bill',
    ),
  )
  const validUpto = nicDateTimeToIso(data.validUpto)
  if (!validUpto) throw new EwbError('The portal extended the bill but returned no new validity — sync the bill', 502, 'UPSTREAM')
  return updateRecord(bookingId, ewbNumber, { valid_upto: validUpto })
}

// ── cancel on the portal ──────────────────────────────────────

export async function cancelOnPortal(bookingId: string, ewbNumber: string, body: CancelOnPortalBody, actor: AuthenticatedUser, client: EwbSandboxClient = ewbSandbox) {
  const booking = await loadBookingOr404(bookingId)
  await assertShipper(booking, actor)
  const record = await standingRecord(bookingId, ewbNumber)
  if (!isStandingEwayBill(record.status)) throw new BookingError(`E-way bill ${ewbNumber} is already ${record.status}`, 'INVALID_TRANSITION', 409)
  const c = await shipperCredentials(booking.shipper_id)

  const data = await withSession(c, client, async (token) =>
    nicData<{ cancelDate?: string; ewayBillNo?: string | number }>(
      await client.call('POST', `${CONSIGNOR}/bill/${ewbNumber}/cancel`, {
        ewbNo: Number(ewbNumber),
        cancelRsnCode: body.reason_code,
        ...(body.remarks ? { cancelRmrk: body.remarks } : {}),
      }, token),
      'Cancelling the e-way bill',
    ),
  )
  const reasons: Record<number, string> = { 1: 'Duplicate', 2: 'Order cancelled', 3: 'Data entry mistake', 4: 'Others' }
  return docs.setEwayBillStatus({
    bookingId,
    ewbNumber,
    status: 'cancelled',
    changedAt: nicDateTimeToIso(data.cancelDate) ?? new Date().toISOString(),
    changedBy: actor.userId,
    reason: `${reasons[body.reason_code]}${body.remarks ? ` — ${body.remarks}` : ''} (cancelled on the portal)`,
  })
}

// ── sync + pdf ────────────────────────────────────────────────

export async function syncFromPortal(bookingId: string, ewbNumber: string, actor: AuthenticatedUser, client: EwbSandboxClient = ewbSandbox) {
  const booking = await loadBookingOr404(bookingId)
  await assertShipper(booking, actor)
  await standingRecord(bookingId, ewbNumber)
  const c = await shipperCredentials(booking.shipper_id)

  const data = await withSession(c, client, async (token) =>
    nicData<{ validUpto?: string; status?: string; VehiclListDetails?: Array<{ enteredDate?: string; vehicleNo?: string }> }>(
      await client.call('GET', `${TAXPAYER}/bill/${ewbNumber}`, undefined, token),
      'Reading the e-way bill',
    ),
  )
  const patch: Record<string, unknown> = {}
  const validUpto = nicDateTimeToIso(data.validUpto)
  if (validUpto) patch.valid_upto = validUpto
  const lastVehicle = data.VehiclListDetails?.filter((v) => v.vehicleNo).slice(-1)[0]
  if (lastVehicle?.enteredDate) patch.part_b_entered_at = nicDateTimeToIso(lastVehicle.enteredDate)
  if (String(data.status ?? '').toUpperCase() === 'CNL') {
    patch.status = 'cancelled'
    patch.status_changed_at = new Date().toISOString()
    patch.status_changed_by = actor.userId
    patch.status_reason = 'Cancelled on the portal (found on sync)'
  }
  return Object.keys(patch).length ? updateRecord(bookingId, ewbNumber, patch) : standingRecord(bookingId, ewbNumber)
}

async function fetchPdfUrl(ewbNumber: string, c: creds.PortalCredentials, client: EwbSandboxClient): Promise<string> {
  return withSession(c, client, async (token) => {
    const res = await client.call<{ 'e-way-bill_pdf_url'?: string; status?: string; error?: { errorCodes?: string } }>('GET', `${TAXPAYER}/bill/${ewbNumber}/pdf/generate`, undefined, token)
    const url = res.data?.['e-way-bill_pdf_url']
    if (!url) throw new EwbError('The portal returned no PDF link', 502, 'UPSTREAM')
    return url
  })
}

export async function pdfUrl(bookingId: string, ewbNumber: string, actor: AuthenticatedUser, client: EwbSandboxClient = ewbSandbox) {
  const booking = await loadBookingOr404(bookingId)
  await assertShipper(booking, actor)
  await standingRecord(bookingId, ewbNumber)
  const c = await shipperCredentials(booking.shipper_id)
  const url = await fetchPdfUrl(ewbNumber, c, client)
  await updateRecord(bookingId, ewbNumber, { document_uri: url }).catch(() => undefined)
  return { url }
}
