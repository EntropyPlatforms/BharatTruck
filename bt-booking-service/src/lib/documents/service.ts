// ============================================================
// src/lib/documents/service.ts
//
// Responsibility: who may issue which document on a booking, what the platform
// fills in itself, and what it will accept from a client.
//
// 🔴 THE CONTROL THIS FILE EXISTS FOR (red line 1, §1.3): the ISSUER of an LR is
// derived from the BOOKING and the AUTHENTICATED ACTOR — never from the request
// body. A caller cannot name the party a document is issued by, and in particular
// cannot make BharatTruck the named issuer, because there is no code path that
// reads an issuer identity off the wire. The platform is never a party; it holds
// the pen for the carrier, and the carrier's own series numbers the document.
//
// The second control is §11.4: the invoice number, the invoice value and the
// e-way bill number printed on an LR are READ FROM OUR OWN ROWS, not accepted
// from the caller. On paper a booking clerk retypes them and they drift — one
// specimen pair is out by ₹63,776 on a hand-keyed invoice value, and consignment
// value drives the e-way bill threshold, so that is not a clerical matter.
// Generating both documents is what removes the entire class of error, and
// removing it means refusing to take the number from a human.
// ============================================================

import { z } from 'zod'
import { relationsToBooking, resolvePersonas } from '@bharattruck/shared/personas'
import { BookingError, type AuthenticatedUser, type BookingStatus } from '../types.js'
import * as repo from '../repository.js'
import { getFleetOwnerByUserId } from '../fleet.js'
import { supabase } from '../supabase.js'
import { TERMINAL_BOOKING_STATUSES } from '../state.js'
import * as docs from './repository.js'
import { parseDocumentQr } from './qr.js'
import { ocrInvoice } from './invoice-ocr.js'
import {
  chargedWeightKg,
  consignmentValueInr,
  ewayBillExpiry,
  ewayBillRequirement,
  isGstDocumentNumber,
  isStandingEwayBill,
  lrChargeTotalInr,
  MAX_SERIES_PREFIX_LENGTH,
  roundInr,
  SERIES_PREFIX_PATTERN,
  stateCodeOfGstin,
  type DocumentIssuerKind,
  type EwayBillExpiry,
  type EwayBillRequirement,
  type EwbStatus,
} from './rules.js'

// -----------------------------------------------------------
// WHEN a document may be issued — 🔴 the gate, not a formality.
//
// Every issuance BURNS A SERIAL out of a gapless, per-owner, per-financial-year
// series (§3.3). Migration 0024 has no void and no cancel: once a number is on a
// row it is spent, and Rule 46(b) wants the series consecutive. So minting a
// consignment note or a tax invoice against a trip that never ran does not just
// produce a junk row — it puts a permanent hole in a legally sequenced series,
// and a tax invoice in particular is a statutory document with GST consequences
// attached to a supply that did not happen.
//
// The precedent is setReceiverEmail (lib/service.ts): a status allowlist and a
// 409 INVALID_TRANSITION, terminal bookings frozen. Same shape here.
//
// 🔴 THE TWO DOCUMENTS DO NOT UNLOCK AT THE SAME MOMENT, and treating them as one
// gate is how this gets written wrong:
//
//   LORRY RECEIPT — 'accepted' and 'in_transit' ONLY. It is a RECEIPT FOR GOODS
//   HANDED OVER: issuing one transfers the lien and makes the carrier responsible
//   for the goods until safe delivery (CBIC Flyer 38, §3.1). It cannot open before
//   a carrier exists to take that custody — which is why 'pending'/'negotiating'
//   are out, and why the carrier-assigned check below is the identity half of the
//   same rule. It closes when the carriage does: once POD has proved delivery, the
//   custody the LR evidences has already ended, so a serial minted then is a
//   backdated document. Nullable vehicle_number in 0024 is deliberate — an LR
//   raised at 'accepted', before the truck is finally allotted, is normal.
//
//   TAX INVOICE — from 'pending' through 'completed'. It is the SHIPPER's document
//   for the goods they sold, not a freight bill, and it is raised against the
//   GOODS rather than against the carriage: EWB-01 Part A field A.4 takes ITS
//   number (§2), so the shipper needs it BEFORE a carrier has been found at all.
//   It stays open through 'completed' because a TO_BE_BILLED consignment (§5.8) is
//   invoiced after delivery.
//
// Both stop dead at the terminal states, which is the defect this closes: 'paid'
// (the money is settled — a tax invoice raised now is a demand for payment already
// made) and 'cancelled' (no goods moved, so there is nothing to receipt and no
// supply to invoice). TERMINAL_BOOKING_STATUSES is derived from VALID_TRANSITIONS
// so this cannot drift away from the lifecycle.
// -----------------------------------------------------------

const LR_ISSUABLE_STATUSES: BookingStatus[] = ['accepted', 'in_transit']

const INVOICE_ISSUABLE_STATUSES: BookingStatus[] = [
  'pending', 'negotiating', 'accepted', 'in_transit', 'completed',
]

function assertIssuable(
  document: string,
  status: BookingStatus,
  allowed: BookingStatus[],
): void {
  if (allowed.includes(status)) return

  const because = TERMINAL_BOOKING_STATUSES.includes(status)
    ? `booking is '${status}' and will not move again`
    : `booking is '${status}'`

  throw new BookingError(
    `${document} cannot be issued on this booking — ${because}. ` +
    `Issuing burns a number out of a gapless statutory series that cannot be voided.`,
    'INVALID_TRANSITION',
    409,
  )
}

// -----------------------------------------------------------
// Request schemas. Money and weights are validated here so an invalid document
// is rejected with a sentence the user can act on, before a serial is allocated
// against it — a rejected allocation rolls back cleanly, but not allocating at
// all is cheaper and leaves nothing to explain.
// -----------------------------------------------------------

const money = z.number().nonnegative().finite()
const stateCode = z.string().regex(/^\d{2}$/, 'state code must be the two-digit GST state code')

// The length cap is a SERIAL BUDGET, not a style rule — every character of prefix
// costs a digit of serial inside Rule 46(b)'s 16, and running out mid-year locks
// the owner's series until 1 April. See rules.ts.
const seriesPrefix = z.string().regex(
  SERIES_PREFIX_PATTERN,
  `series prefix: max ${MAX_SERIES_PREFIX_LENGTH} chars, [A-Za-z0-9-] only — ` +
  'a longer prefix would leave too few serials for a financial year',
)

// Format guards for party tax identifiers (review S-7). Optional stays optional —
// whether a party's GSTIN belongs on the paper is a business choice — but a value
// that IS supplied must be a real GSTIN/PAN shape: these strings feed the e-way
// requirement decision (stateCodeOfGstin reads the first two digits) and print on
// statutory documents, where a malformed identifier is worse than a blank one.
// Same patterns the profile-level guards use (bt-auth identity, bt-fleet owners).
const GSTIN_FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{2}[0-9A-Z]$/
const PAN_FORMAT   = /^[A-Z]{5}[0-9]{4}[A-Z]$/
const optionalGstin = z.string().trim().toUpperCase().regex(GSTIN_FORMAT, 'Invalid GSTIN').optional()
const optionalPan   = z.string().trim().toUpperCase().regex(PAN_FORMAT, 'Invalid PAN').optional()

export const IssueLorryReceiptBodySchema = z.object({
  // Per-owner series prefix, frozen on the first document of the financial year.
  series_prefix:         seriesPrefix.optional(),

  consignor_name:        z.string().min(1),
  consignor_gstin:       optionalGstin,
  consignor_pan:         optionalPan,
  consignor_address:     z.string().optional(),
  consignee_name:        z.string().min(1),
  consignee_gstin:       optionalGstin,
  consignee_address:     z.string().optional(),

  origin_place:          z.string().min(1),
  destination_place:     z.string().min(1),
  // Rule 46(o) — the delivery address where it differs from the place of supply.
  // This, not the billing address, is what the POD geofence targets (§5.4).
  delivery_address:      z.string().optional(),

  vehicle_number:        z.string().optional(),
  articles_count:        z.number().int().positive().optional(),

  // §11.2. The caller states what was weighed and what the cargo cubes out at;
  // the CHARGED weight is computed, never accepted — see below.
  actual_weight_kg:      z.number().positive().finite(),
  volumetric_weight_kg:  z.number().positive().finite().optional(),

  rate_inr:              money.optional(),
  rate_type:             z.string().optional(),
  // Printed under "(said to contain)" — the carrier never opens the packaging,
  // so the description is the consignor's assertion and is labelled as one.
  said_to_contain:       z.string().min(1),

  freight_charge_inr:    money,
  stationary_charge_inr: money.optional(),
  handling_charge_inr:   money.optional(),
  other_charge_inr:      money.optional(),

  freight_term:          z.enum(['PAID', 'TO_PAY', 'TO_BE_BILLED']),
  delivery_mode:         z.enum(['GODOWN', 'DOOR']).optional(),
  loading_by:            z.enum(['consignor', 'consignee']).optional(),
  unloading_by:          z.enum(['consignor', 'consignee']).optional(),

  place_of_supply_state: z.string().optional(),
  place_of_supply_code:  stateCode.optional(),
  reverse_charge:        z.boolean().optional(),
  carriage_risk:         z.enum(['owners_risk', 'carriers_risk']).optional(),

  // Issuer facts the platform does not hold for a solo owner-driver. Accepted
  // ONLY as attributes of the issuer the booking already determines — they can
  // never change WHO the issuer is.
  issuer_transporter_id: z.string().optional(),
  issuer_pan:            optionalPan,
  issuer_address:        z.string().optional(),
})

export type IssueLorryReceiptBody = z.infer<typeof IssueLorryReceiptBodySchema>

export const IssueInvoiceBodySchema = z.object({
  series_prefix:         seriesPrefix.optional(),

  supplier_legal_name:   z.string().min(1).optional(),
  supplier_gstin:        optionalGstin,
  supplier_address:      z.string().optional(),

  billed_to_name:        z.string().min(1),
  billed_to_gstin:       optionalGstin,
  billed_to_address:     z.string().optional(),
  billed_to_state:       z.string().optional(),
  billed_to_state_code:  stateCode.optional(),
  shipped_to_name:       z.string().optional(),
  shipped_to_gstin:      optionalGstin,
  shipped_to_address:    z.string().optional(),
  shipped_to_state:      z.string().optional(),
  shipped_to_state_code: stateCode.optional(),

  place_of_supply_state: z.string().optional(),
  place_of_supply_code:  stateCode.optional(),
  reverse_charge:        z.boolean().optional(),

  taxable_value_inr:     money,
  cgst_inr:              money.optional(),
  sgst_inr:              money.optional(),
  utgst_inr:             money.optional(),
  igst_inr:              money.optional(),
  cess_inr:              money.optional(),
  // Subtracted from consignment value ONLY on an invoice covering exempt and
  // taxable goods together (Rule 138 Explanation 2).
  exempt_value_inr:      money.optional(),
  tcs_inr:               money.optional(),
  round_off_inr:         z.number().finite().optional(),

  // E-invoice fields (D-18). Recorded, never generated — an IRN can only come
  // from the IRP, and its presence changes which e-way bill path is legal (§11.5).
  irn:                   z.string().regex(/^[0-9a-fA-F]{64}$/, 'IRN must be a 64-character hex hash').optional(),
  ack_no:                z.string().optional(),
  ack_date:              z.string().datetime().optional(),
})

export type IssueInvoiceBody = z.infer<typeof IssueInvoiceBodySchema>

export const RecordEwayBillBodySchema = z.object({
  ewb_number:      z.string().regex(/^\d{12}$/, 'e-way bill number is 12 digits'),
  generated_at:    z.string().datetime(),
  // 🔴 REQUIRED, and never computed. §4.4: a day of validity expires at midnight
  // of the day FOLLOWING generation, so a bill raised at 23:55 has ~24h and one
  // raised at 00:05 has ~48h from the identical allowance. Deriving it locally
  // would tell a driver they are covered while the bill is dead. Copy the
  // portal's figure or record nothing.
  valid_upto:      z.string().datetime(),
  issuing_portal:  z.enum(['NIC1', 'NIC2']),
  // §4.5 / Rule 138(5A): once Part B is entered the consignment cannot be
  // reassigned to another transporter. Capturing the moment is what will let the
  // booking flow refuse a carrier swap instead of desyncing from the EWB system.
  part_b_entered_at: z.string().datetime().optional(),
  // The one Rule 46(b) check, from rules.ts — a second copy of that regex here is
  // a second place for it to be wrong.
  document_number: z.string().refine(isGstDocumentNumber, 'document number must satisfy Rule 46(b)').optional(),
  document_uri:    z.string().url().optional(),
  // Fallback only — the invoice's own GST-inclusive value wins when we have one.
  consignment_value_inr: money.optional(),
})

export type RecordEwayBillBody = z.infer<typeof RecordEwayBillBodySchema>

// -----------------------------------------------------------
// Party resolution.
//
// The carrier on a booking is a fleet when fleet_owner_id is set and the solo
// driver otherwise — the same discriminator the rest of this service uses. Both
// issue LRs under their OWN GSTIN/TRANSIN and their own series; a solo
// owner-driver is not "the platform's driver", they are a carrier with one truck.
// -----------------------------------------------------------

type LrIssuer = {
  kind: Extract<DocumentIssuerKind, 'fleet_owner' | 'driver'>
  id: string
  legalName: string
  transporterId: string | null
  pan: string | null
  address: string | null
}

async function resolveLrIssuer(
  booking: { id: string; driver_id: string | null; fleet_owner_id: string | null },
  actor: AuthenticatedUser,
): Promise<LrIssuer> {
  if (booking.fleet_owner_id) {
    const owner = await getFleetOwnerByUserId(actor.userId)
    if (!owner || owner.id !== booking.fleet_owner_id) {
      throw new BookingError('Only the carrier on this booking can issue its consignment note', 'FORBIDDEN', 403)
    }
    // Identity read from the fleet's own row, not the request. company_name is
    // the name that gets printed as the issuer.
    const { data } = await supabase
      .from('fleet_owners')
      .select('company_name, gstin, pan, billing_address')
      .eq('id', owner.id)
      .maybeSingle()

    return {
      kind: 'fleet_owner',
      id: owner.id,
      legalName: data?.company_name ?? 'Carrier',
      transporterId: data?.gstin ?? null,
      pan: data?.pan ?? null,
      address: data?.billing_address ?? null,
    }
  }

  const driverRow = await repo.getDriverByUserId(actor.userId)
  if (!driverRow || !booking.driver_id || driverRow.id !== booking.driver_id) {
    throw new BookingError('Only the carrier on this booking can issue its consignment note', 'FORBIDDEN', 403)
  }
  const { data } = await supabase
    .from('users')
    .select('full_name')
    .eq('id', actor.userId)
    .maybeSingle()

  return {
    kind: 'driver',
    id: driverRow.id,
    legalName: data?.full_name ?? 'Owner-driver',
    transporterId: null,
    pan: null,
    address: null,
  }
}

async function loadBookingOr404(bookingId: string) {
  const booking = await repo.getBookingById(bookingId)
  if (!booking) throw new BookingError(`Booking ${bookingId} not found`, 'NOT_FOUND', 404)
  return booking
}

/**
 * The e-way bill that currently STANDS for a booking — newest first, skipping any
 * the portal has cancelled or rejected (§4.5).
 *
 * This is what the status column on eway_bill_records is for. A bill cancelled
 * inside its 24-hour window and the bill raised to replace it are otherwise the
 * same row shape, and printing the dead one on an LR or an invoice reproduces
 * exactly the transcription error §11.4 says generating both documents removes.
 * Expiry is deliberately NOT considered here: an expired bill is still the bill
 * that was raised, and its expiry is reported separately and always recomputed.
 */
function standingEwayBill(records: docs.DbEwayBillRecord[]): docs.DbEwayBillRecord | null {
  return records.find(r => isStandingEwayBill(r.status)) ?? null
}

/**
 * Read access to a booking's documents: the shipper, the assigned driver, the
 * fleet that won it, and ops. Decided by RELATION-to-object, not the JWT role
 * string (D-27) — a distributor who both posts and carries their own load reads
 * the documents on either side of it, instead of being forced down one costume.
 *
 * The consignee is deliberately NOT here, because their access is the emailed
 * document itself (§5.6: the receiver path assumes zero app installation) — so
 * the 'consignee' relation and observers (empty set) are refused.
 */
async function assertCanReadDocuments(
  booking: { shipper_id: string; driver_id: string | null; fleet_owner_id: string | null },
  actor: AuthenticatedUser,
): Promise<void> {
  // Ops carve-out (no 'admin' capability; the admin JWT is the explicit override).
  if (actor.role === 'admin') return

  const snapshot = await resolvePersonas(supabase, actor.userId, actor.role)
  const relations = relationsToBooking(booking, snapshot)
  // shipper (posted it), carrier (the winning fleet or a solo owner-driver) or
  // driver (the assigned employee on a fleet booking) may read.
  if (relations.includes('shipper') || relations.includes('carrier') || relations.includes('driver')) return

  throw new BookingError('You cannot view documents for this booking', 'FORBIDDEN', 403)
}

// -----------------------------------------------------------
// issueLorryReceipt
// -----------------------------------------------------------

export async function issueLorryReceipt(
  bookingId: string,
  body: IssueLorryReceiptBody,
  actor: AuthenticatedUser,
) {
  const booking = await loadBookingOr404(bookingId)

  // WHEN. See LR_ISSUABLE_STATUSES: a consignment note is a receipt for goods
  // handed over for carriage, so it opens when a carrier takes custody and closes
  // when the carriage does. A 'cancelled' or 'paid' booking previously issued a
  // 201 here and burnt a serial for a trip that never ran or is long over.
  assertIssuable('A consignment note', booking.status, LR_ISSUABLE_STATUSES)

  // WHO. The identity half of the same rule: a consignment note transfers the lien
  // on the goods and makes the carrier responsible for them until safe delivery
  // (CBIC Flyer 38). Issuing one before a carrier has been awarded the load would
  // assert that transfer with nobody on the other end of it. Kept as a separate
  // check because a booking can be 'accepted' with the award still unbound —
  // a fleet may bid with no free truck (see assertFleetAssignmentReady).
  if (!booking.driver_id && !booking.fleet_owner_id) {
    throw new BookingError(
      'A consignment note can only be issued once a carrier is assigned to the booking',
      'INVALID_TRANSITION',
      409,
    )
  }

  const issuer = await resolveLrIssuer(booking, actor)

  // §11.4 — the linkage fields come from OUR rows. Never from the request.
  // invoice_value is the GST-INCLUSIVE consignment value, because that is the
  // figure the e-way bill threshold is measured against (§4.1).
  const invoice = await docs.getFreightInvoice(bookingId)
  const ewbs = await docs.listEwayBills(bookingId)

  const chargedKg = chargedWeightKg(body.actual_weight_kg, body.volumetric_weight_kg)

  const payload = {
    issuer_legal_name:     issuer.legalName,
    issuer_transporter_id: issuer.transporterId ?? body.issuer_transporter_id ?? null,
    issuer_pan:            issuer.pan ?? body.issuer_pan ?? null,
    issuer_address:        issuer.address ?? body.issuer_address ?? null,

    consignor_name:    body.consignor_name,
    consignor_gstin:   body.consignor_gstin ?? null,
    consignor_pan:     body.consignor_pan ?? null,
    consignor_address: body.consignor_address ?? null,
    consignee_name:    body.consignee_name,
    consignee_gstin:   body.consignee_gstin ?? null,
    consignee_address: body.consignee_address ?? null,

    origin_place:      body.origin_place,
    destination_place: body.destination_place,
    delivery_address:  body.delivery_address ?? null,

    vehicle_number: body.vehicle_number ?? null,
    articles_count: body.articles_count ?? null,

    actual_weight_kg:  body.actual_weight_kg,
    charged_weight_kg: chargedKg,
    rate_inr:          body.rate_inr ?? null,
    rate_type:         body.rate_type ?? null,
    said_to_contain:   body.said_to_contain,

    freight_charge_inr:    roundInr(body.freight_charge_inr),
    stationary_charge_inr: roundInr(body.stationary_charge_inr ?? 0),
    handling_charge_inr:   roundInr(body.handling_charge_inr ?? 0),
    other_charge_inr:      roundInr(body.other_charge_inr ?? 0),

    freight_term:  body.freight_term,
    delivery_mode: body.delivery_mode ?? null,
    loading_by:    body.loading_by ?? null,
    unloading_by:  body.unloading_by ?? null,

    place_of_supply_state: body.place_of_supply_state ?? null,
    place_of_supply_code:  body.place_of_supply_code ?? null,
    reverse_charge:        body.reverse_charge ?? true,
    carriage_risk:         body.carriage_risk ?? 'owners_risk',

    invoice_number:    invoice?.invoice_number ?? null,
    invoice_value_inr: invoice ? Number(invoice.consignment_value_inr) : null,
    eway_bill_number:  standingEwayBill(ewbs)?.ewb_number ?? null,
  }

  const lr = await docs.issueLorryReceipt({
    bookingId,
    issuerKind: issuer.kind,
    issuerId:   issuer.id,
    prefix:     body.series_prefix ?? null,
    payload,
  })

  return {
    ...lr,
    // Convenience for the caller: the same total the DB generated, so a client
    // never has to add the charge lines up itself and get a different answer.
    charges_total_inr: lrChargeTotalInr({
      freightInr:    payload.freight_charge_inr,
      stationaryInr: payload.stationary_charge_inr,
      handlingInr:   payload.handling_charge_inr,
      otherInr:      payload.other_charge_inr,
    }),
  }
}

// -----------------------------------------------------------
// issueFreightInvoice — the SHIPPER's document, on the SHIPPER's series.
// -----------------------------------------------------------

export async function issueFreightInvoice(
  bookingId: string,
  body: IssueInvoiceBody,
  actor: AuthenticatedUser,
) {
  const booking = await loadBookingOr404(bookingId)

  // The invoice is the SHIPPER's document. Authorized on the 'shipper' relation
  // to THIS booking (booking.shipper_id === them), never the role string (D-27):
  // a distributor holding a fleet_owner-role token who posted the load issues it,
  // while a carrier — even on this same booking — cannot. The old `role !==
  // 'shipper' || shipper_id !== userId` collapses into this one relation check.
  const snapshot = await resolvePersonas(supabase, actor.userId, actor.role)
  if (!relationsToBooking(booking, snapshot).includes('shipper')) {
    throw new BookingError('Only the shipper on this booking can issue its invoice', 'FORBIDDEN', 403)
  }

  // WHEN. See INVOICE_ISSUABLE_STATUSES — wider than the LR's window at the front
  // (the invoice number feeds EWB-01 Part A before a carrier exists) and one state
  // longer at the back (TO_BE_BILLED is invoiced after delivery), but stopping
  // dead at the terminal states. There was previously NO status check here at all,
  // so a tax invoice — a statutory document with GST consequences — could be
  // minted against a cancelled booking, against a supply that never happened.
  assertIssuable('A tax invoice', booking.status, INVOICE_ISSUABLE_STATUSES)

  // §4.1, computed here so the caller cannot supply a total that disagrees with
  // its own parts. The DB recomputes the same formula as a generated column —
  // this copy exists to put the number in the response and, more importantly, in
  // the e-way bill decision below.
  const consignmentValue = consignmentValueInr({
    taxableValueInr: body.taxable_value_inr,
    cgstInr:  body.cgst_inr,
    sgstInr:  body.sgst_inr,
    utgstInr: body.utgst_inr,
    igstInr:  body.igst_inr,
    cessInr:  body.cess_inr,
    exemptValueInr: body.exempt_value_inr,
  })

  // TCS (s.206C(1H)) and the round-off move the money owed but are NOT part of
  // consignment value — they sit outside the Rule 138 formula, which is why they
  // are added here and not inside consignmentValueInr.
  const grandTotal = roundInr(consignmentValue + (body.tcs_inr ?? 0) + (body.round_off_inr ?? 0))

  // Prefill supplier GSTIN from the shipper profile (FB-09) when the caller omits it.
  // Falls back to fleet_owners.gstin — the FB-04 post-gate accepts EITHER users.gstin OR
  // fleet_owners.gstin, so a fleet-owner shipper who has only the latter must still get a
  // supplier GSTIN here, or the pickup e-way gate can't derive fromStateCode and fails closed.
  const { data: supplier } = await supabase
    .from('users')
    .select('full_name, gstin')
    .eq('id', actor.userId)
    .maybeSingle()
  let supplierGstin = (supplier?.gstin as string | null) ?? null
  if (!supplierGstin) {
    const { data: fleet } = await supabase
      .from('fleet_owners')
      .select('gstin')
      .eq('user_id', actor.userId)
      .maybeSingle()
    supplierGstin = (fleet?.gstin as string | null) ?? null
  }

  const lr = await docs.getLorryReceipt(bookingId)
  const ewbs = await docs.listEwayBills(bookingId)

  const invoice = await docs.issueFreightInvoice({
    bookingId,
    supplierUserId: actor.userId,
    prefix: body.series_prefix ?? null,
    payload: {
      supplier_legal_name: body.supplier_legal_name ?? supplier?.full_name ?? 'Supplier',
      supplier_gstin:      body.supplier_gstin ?? supplierGstin,
      supplier_address:    body.supplier_address ?? null,

      billed_to_name:        body.billed_to_name,
      billed_to_gstin:       body.billed_to_gstin ?? null,
      billed_to_address:     body.billed_to_address ?? null,
      billed_to_state:       body.billed_to_state ?? null,
      billed_to_state_code:  body.billed_to_state_code ?? null,
      shipped_to_name:       body.shipped_to_name ?? null,
      shipped_to_gstin:      body.shipped_to_gstin ?? null,
      shipped_to_address:    body.shipped_to_address ?? null,
      shipped_to_state:      body.shipped_to_state ?? null,
      shipped_to_state_code: body.shipped_to_state_code ?? null,

      place_of_supply_state: body.place_of_supply_state ?? null,
      place_of_supply_code:  body.place_of_supply_code ?? null,
      reverse_charge:        body.reverse_charge ?? false,

      taxable_value_inr: roundInr(body.taxable_value_inr),
      cgst_inr:          roundInr(body.cgst_inr ?? 0),
      sgst_inr:          roundInr(body.sgst_inr ?? 0),
      utgst_inr:         roundInr(body.utgst_inr ?? 0),
      igst_inr:          roundInr(body.igst_inr ?? 0),
      cess_inr:          roundInr(body.cess_inr ?? 0),
      exempt_value_inr:  roundInr(body.exempt_value_inr ?? 0),
      tcs_inr:           roundInr(body.tcs_inr ?? 0),
      round_off_inr:     roundInr(body.round_off_inr ?? 0),
      grand_total_inr:   grandTotal,

      lr_number:        lr?.lr_number ?? null,
      eway_bill_number: standingEwayBill(ewbs)?.ewb_number ?? null,

      irn:      body.irn ?? null,
      ack_no:   body.ack_no ?? null,
      ack_date: body.ack_date ?? null,
    },
  })

  return { ...invoice, eway_bill: invoiceEwayBillRequirement(body, Number(invoice.consignment_value_inr)) }
}

/**
 * §9.2's first validation gate, on the request path rather than in a helper
 * nobody calls: "threshold check on GST-INCLUSIVE consignment value".
 *
 * Answered off the invoice we just wrote, because its consignment_value_inr is
 * the DB-generated Rule 138 Explanation 2 figure — the same number an officer
 * would compute. Thresholding on taxable_value_inr instead is the §4.1 bug:
 * ₹48,000 + 5% = ₹50,400 needs a bill and ₹48,000 says it does not, and the
 * difference is a s.129 detention.
 *
 * The two ends of the movement are read from what the invoice already carries —
 * explicit state codes first, then the first two digits of the GSTINs, which ARE
 * the state code. Shipped-to beats billed-to because the goods go to the
 * shipped-to address (§11.3 / §5.4); head-office billing with a warehouse
 * delivery 400km away is ordinary. Where neither end can be established,
 * ewayBillRequirement declines to answer rather than guessing 'not required'.
 */
function invoiceEwayBillRequirement(
  body: IssueInvoiceBody,
  consignmentValueInr: number,
): EwayBillRequirement {
  return ewayBillRequirement({
    consignmentValueInr,
    fromStateCode: stateCodeOfGstin(body.supplier_gstin),
    toStateCode:
      body.shipped_to_state_code ??
      stateCodeOfGstin(body.shipped_to_gstin) ??
      body.billed_to_state_code ??
      stateCodeOfGstin(body.billed_to_gstin) ??
      body.place_of_supply_code ??
      null,
  })
}

// -----------------------------------------------------------
// recordEwayBill — D-17. We record theirs; we generate nothing.
// -----------------------------------------------------------

export async function recordEwayBill(
  bookingId: string,
  body: RecordEwayBillBody,
  actor: AuthenticatedUser,
) {
  const booking = await loadBookingOr404(bookingId)
  // Either party may hold the paper: the shipper usually raises Part A, the
  // carrier enters Part B. Whoever has it in their hand should be able to file it.
  await assertCanReadDocuments(booking, actor)

  if (new Date(body.valid_upto).getTime() <= new Date(body.generated_at).getTime()) {
    throw new BookingError('valid_upto must be after generated_at', 'VALIDATION_ERROR', 400)
  }

  const invoice = await docs.getFreightInvoice(bookingId)
  // Pickup hard-gate (FB-03) always needs the tax invoice. E-way is required when
  // ewayBillRequirement says so — see assertPickupDocumentsReady.
  if (!invoice) {
    throw new BookingError(
      'Record the tax invoice for this booking before filing its e-way bill — ' +
      'Part A needs the invoice number, and pickup will not start without both when an e-way is required',
      'INVALID_TRANSITION',
      409,
    )
  }

  // D-17 is record + upload. A number alone is not enough for the pickup gate.
  if (!body.document_uri) {
    throw new BookingError(
      'Upload the portal e-way bill file (document_uri) when recording — ' +
      'D-17 is record + upload, and pickup requires the uploaded copy',
      'VALIDATION_ERROR',
      400,
    )
  }

  const record = await docs.recordEwayBill({
    bookingId,
    ewbNumber:     body.ewb_number,
    generatedAt:   body.generated_at,
    validUpto:     body.valid_upto,
    issuingPortal: body.issuing_portal,
    partBEnteredAt: body.part_b_entered_at ?? null,
    documentNumber: body.document_number ?? invoice.invoice_number ?? null,
    consignmentValueInr: Number(invoice.consignment_value_inr),
    documentUri: body.document_uri,
    recordedBy:  actor.userId,
  })

  return withExpiry(record)
}

// -----------------------------------------------------------
// scanDocument — parse a NIC document QR (e-way bill / GST e-invoice) into fields that PREFILL
// the freight-documents form. The client decodes the QR from the camera and posts the raw
// string; this parses it, records the extraction for audit (best-effort — the prefill is the
// point, the saved LR/invoice/e-way row is the source of truth), and returns the fields. A
// human still confirms by saving. Never touches the POD photo — a document QR is the shipper's
// own artifact (INDIA_FREIGHT_COMPLIANCE.md §6).
// -----------------------------------------------------------

export const ScanDocumentBodySchema = z.object({
  // The decoded QR string. Capped generously — a signed e-invoice JWS is a few KB.
  raw: z.string().min(1, 'raw QR content is required').max(8192),
})
export type ScanDocumentBody = z.infer<typeof ScanDocumentBodySchema>

export async function scanDocument(
  bookingId: string,
  body: ScanDocumentBody,
  actor: AuthenticatedUser,
) {
  const booking = await loadBookingOr404(bookingId)
  await assertCanReadDocuments(booking, actor)

  const parsed = parseDocumentQr(body.raw)

  // Record the extraction for audit. Best-effort: a scan that could not be logged (e.g. a
  // pre-0037 database) must still prefill the form — the extraction table is an audit of what
  // was scanned, not the legal record, so its absence never blocks the driver at the gate.
  let extractionId: string | null = null
  try {
    const { data, error } = await supabase
      .from('document_extractions')
      .insert({
        booking_id: bookingId,
        kind: parsed.kind,
        source: 'qr',
        raw_payload: body.raw,
        parsed_json: parsed.fields,
        created_by: actor.userId,
      })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    extractionId = (data as { id: string }).id
  } catch {
    // Swallowed deliberately (see above); the parsed fields are still returned below.
    extractionId = null
  }

  return { extraction_id: extractionId, kind: parsed.kind, fields: parsed.fields }
}

// -----------------------------------------------------------
// ocrDocument — OCR a photographed / handwritten INVOICE (one with no scannable QR) into the same
// prefill fields scanDocument returns, via Document AI's Invoice Parser. Same posture as the QR
// scan: it records the extraction for audit (best-effort, source='ocr'), returns fields to prefill
// the form, and a HUMAN confirms by saving the actual invoice. It runs on the uploaded derivative
// image, never the byte-preserved POD photo (§5.4). Inert (a clean 501) until an invoice processor
// is configured, so nothing changes on a deployment without OCR.
// -----------------------------------------------------------

export const OcrDocumentBodySchema = z.object({
  // Base64 of the invoice image/PDF, and its exact mime type for Document AI.
  content: z.string().min(1, 'content (base64 image or PDF) is required'),
  mime_type: z.string().trim().max(100).optional(),
})
export type OcrDocumentBody = z.infer<typeof OcrDocumentBodySchema>

export async function ocrDocument(
  bookingId: string,
  body: OcrDocumentBody,
  actor: AuthenticatedUser,
) {
  const booking = await loadBookingOr404(bookingId)
  await assertCanReadDocuments(booking, actor)

  const bytes = Buffer.from(body.content, 'base64')
  const { kind, fields } = await ocrInvoice(bytes, body.mime_type ?? 'application/pdf')

  // Audit the extraction (kind='ocr', source='ocr' — the 0037 CHECK set). Best-effort, exactly
  // like the QR path: the prefill is the point and the saved invoice row is the source of truth.
  // The image itself is NOT stored (raw_payload is for QR strings) — OCR ran on this transient
  // derivative, never on a POD original.
  let extractionId: string | null = null
  try {
    const { data, error } = await supabase
      .from('document_extractions')
      .insert({
        booking_id: bookingId,
        kind: 'ocr',
        source: 'ocr',
        raw_payload: null,
        parsed_json: fields,
        created_by: actor.userId,
      })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    extractionId = (data as { id: string }).id
  } catch {
    extractionId = null
  }

  return { extraction_id: extractionId, kind, fields }
}

// FB-03 hard gate on accepted → in_transit: tax invoice always; e-way only when
// ewayBillRequirement.required !== false. Fail closed when the helper declines
// (required === null — unknown ends / intra-state): safer than letting a truck
// move without a bill that may be legally required (D-17 still record+upload only).
export async function assertPickupDocumentsReady(bookingId: string): Promise<void> {
  const invoice = await docs.getFreightInvoice(bookingId)
  if (!invoice) {
    throw new BookingError(
      'Cannot start trip — missing required freight documents before pickup: tax invoice. ' +
      'The shipper must issue the invoice first.',
      'INVALID_TRANSITION',
      409,
    )
  }

  const ewbNeed = ewayBillRequirement({
    consignmentValueInr: Number(invoice.consignment_value_inr),
    fromStateCode: stateCodeOfGstin(invoice.supplier_gstin),
    toStateCode:
      invoice.shipped_to_state_code ??
      stateCodeOfGstin(invoice.shipped_to_gstin) ??
      invoice.billed_to_state_code ??
      stateCodeOfGstin(invoice.billed_to_gstin) ??
      invoice.place_of_supply_code ??
      null,
  })

  // required === false → inter-state under threshold; skip e-way. Otherwise require it.
  if (ewbNeed.required === false) return

  const standing = standingEwayBill(await docs.listEwayBills(bookingId))
  const missing: string[] = []
  if (!standing) missing.push('e-way bill record')
  else if (!standing.document_uri) missing.push('e-way bill upload (document_uri)')
  // standingEwayBill deliberately ignores expiry (it answers "which bill stands"), so the
  // pickup gate must check it here — a truck may not start on an EXPIRED e-way bill (s.129).
  else if (ewayBillExpiry(standing.valid_upto).state === 'expired') {
    missing.push('a valid (unexpired) e-way bill — the recorded one has expired')
  }

  if (missing.length === 0) return

  const why =
    ewbNeed.required === null
      ? `E-way requirement could not be determined (${ewbNeed.reason}) — failing closed.`
      : ewbNeed.reason

  throw new BookingError(
    `Cannot start trip — missing required freight documents before pickup: ${missing.join(' and ')}. ` +
    `${why} The shipper must record+upload the e-way bill first.`,
    'INVALID_TRANSITION',
    409,
  )
}

// -----------------------------------------------------------
// setEwayBillStatus — §4.5, and the reason eway_bill_records.status exists.
//
// A bill may be cancelled within 24 hours of generation and rejected (or deemed
// accepted) within 72. Several rows per booking is the design — cancel-and-
// regenerate and a D-16 multi-truck movement both produce them — but until this
// path existed there was no way to say WHICH of them still stands, so "which
// e-way bill was live when the vehicle was stopped" had no answer and the number
// printed on an LR could be a dead one.
//
// 🔴 WE DO NOT ENFORCE THE 24-HOUR WINDOW. The portal decides whether a
// cancellation is accepted; §4.5 records the window's start (generation vs Part B
// entry) as unreconciled between the rule and NIC error 728; and refusing to
// RECORD a cancellation the portal has already performed would leave our copy
// insisting a bill is live when the EWB system says it is not. That is the
// failure mode this whole record-don't-generate posture (D-17) exists to avoid.
// -----------------------------------------------------------

export const SetEwayBillStatusBodySchema = z.object({
  status: z.enum(['cancelled', 'rejected']),
  changed_at: z.string().datetime().optional(),
  reason: z.string().min(1).max(500).optional(),
})

export type SetEwayBillStatusBody = z.infer<typeof SetEwayBillStatusBodySchema>

export async function setEwayBillStatus(
  bookingId: string,
  ewbNumber: string,
  body: SetEwayBillStatusBody,
  actor: AuthenticatedUser,
) {
  const booking = await loadBookingOr404(bookingId)
  // Same audience as recording one: whoever holds the paper. The portal already
  // authorised the act; we are filing what it did.
  await assertCanReadDocuments(booking, actor)

  const record = await docs.setEwayBillStatus({
    bookingId,
    ewbNumber,
    status: body.status as EwbStatus,
    changedAt: body.changed_at ?? new Date().toISOString(),
    // The acting user, straight from the session — a cancel/reject on a statutory
    // record must be traceable to WHO filed it, same as recorded_by on the record
    // itself (review S-7: "every document action traceable to a user").
    changedBy: actor.userId,
    reason: body.reason ?? null,
  })

  return withExpiry(record)
}

// -----------------------------------------------------------
// getBookingDocuments — the read side.
// -----------------------------------------------------------

export type BookingDocuments = {
  booking_id: string
  lorry_receipt: docs.DbLorryReceipt | null
  invoice: docs.DbFreightInvoice | null
  eway_bills: Array<docs.DbEwayBillRecord & { expiry: EwayBillExpiry }>
  /**
   * The bill that currently stands, if any — the answer to "which e-way bill was
   * live", which the list alone cannot give once one has been cancelled.
   */
  standing_eway_bill_number: string | null
}

export async function getBookingDocuments(
  bookingId: string,
  actor: AuthenticatedUser,
): Promise<BookingDocuments> {
  const booking = await loadBookingOr404(bookingId)
  await assertCanReadDocuments(booking, actor)

  const [lr, invoice, ewbs] = await Promise.all([
    docs.getLorryReceipt(bookingId),
    docs.getFreightInvoice(bookingId),
    docs.listEwayBills(bookingId),
  ])

  return {
    booking_id: bookingId,
    lorry_receipt: lr,
    invoice,
    eway_bills: ewbs.map(withExpiry),
    standing_eway_bill_number: standingEwayBill(ewbs)?.ewb_number ?? null,
  }
}

/**
 * Attaches the expiry verdict computed from the STORED valid_upto (§9.3's 4-day
 * alert window). The verdict is derived; the deadline never is.
 */
function withExpiry(record: docs.DbEwayBillRecord): docs.DbEwayBillRecord & { expiry: EwayBillExpiry } {
  return { ...record, expiry: ewayBillExpiry(record.valid_upto) }
}
