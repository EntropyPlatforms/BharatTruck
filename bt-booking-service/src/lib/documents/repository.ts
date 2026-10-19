// ============================================================
// src/lib/documents/repository.ts
//
// Responsibility: the ONLY path between this service and the freight-document
// tables from migration 0024.
//
// THE RULE THIS FILE ENFORCES BY CONSTRUCTION: an LR or invoice number is never
// computed here. Issuing goes through the `issue_lorry_receipt` /
// `issue_freight_invoice` RPCs, and a PostgREST rpc call is ONE statement in ONE
// implicit transaction — which is the only way to satisfy §3.3's "allocated
// inside the SAME DB transaction that persists the row". supabase-js cannot open
// a transaction, so the alternative shape (read the counter, format a number,
// insert the row) would hand the same number to two bookings that confirm in the
// same instant, and would burn a number every time the insert failed. There is
// deliberately no select on document_series in this file.
//
// MISSING-RELATION TOLERANCE, same contract as fleet.ts: migrations are applied
// BY HAND while CD deploys this service on merge, so this code runs against a
// pre-0024 database for some window. READS answer "no documents" there, because
// that is the truth and it keeps every existing screen working. WRITES fail
// loudly with a 503 — silently pretending to issue a legal document is far worse
// than an error the operator can read.
// ============================================================

import { supabase } from '../supabase.js'
import { BookingError } from '../types.js'
import type { DocumentIssuerKind, EwbPortal, EwbStatus } from './rules.js'

// PostgREST reports an unknown table as 42P01 / PGRST205 and an unknown function
// as 42883 / PGRST202. Both mean the same thing here: migration 0024 has not been
// applied to this database yet.
const MISSING_RELATION_CODES = new Set(['42P01', 'PGRST205'])
const MISSING_FUNCTION_CODES = new Set(['42883', 'PGRST202'])

// 54000 program_limit_exceeded, raised by allocate_document_number when a series'
// serials no longer fit Rule 46(b)'s 16 characters. It is NOT an internal fault:
// the request was well formed and the platform's answer is "this series is full
// for this financial year, open a second one" (Rule 46(b) permits multiple).
const SERIES_EXHAUSTED_CODE = '54000'

type DbError = { code?: string; message?: string } | null

function isMissingRelation(error: DbError): boolean {
  return !!error?.code && MISSING_RELATION_CODES.has(error.code)
}

function isMissingFunction(error: DbError): boolean {
  return !!error?.code && MISSING_FUNCTION_CODES.has(error.code)
}

function isSeriesExhausted(error: DbError): boolean {
  return error?.code === SERIES_EXHAUSTED_CODE
}

// An exhausted series is reported to the caller VERBATIM, because the SQL builds
// the whole remedy into its message — which series, its budget, and that Rule
// 46(b) permits opening a second one. Wrapping it in a generic 500 is what made
// the original failure undiagnosable from the outside.
function seriesExhausted(error: DbError): BookingError {
  return new BookingError(error?.message ?? 'This document series is exhausted for the financial year', 'CONFLICT', 409)
}

// A write attempt on a database without 0024. UPSTREAM_ERROR/503 rather than 500:
// the request was well formed, the platform is not ready to answer it yet, and a
// retry after the migration lands will succeed unchanged.
function notMigrated(what: string): BookingError {
  return new BookingError(
    `${what} is unavailable: the freight-documents schema (migration 0024) is not applied to this database`,
    'UPSTREAM_ERROR',
    503,
  )
}

// -----------------------------------------------------------
// Row shapes. Deliberately narrow — the columns the apps and this service
// actually read. The DB rows carry more (the full §11.2 / §11.3 field sets) and
// are returned verbatim by the RPCs; these types describe what we promise.
// -----------------------------------------------------------

export type DbLorryReceipt = {
  id: string
  booking_id: string
  lr_number: string
  financial_year: string
  issuer_kind: DocumentIssuerKind
  issuer_id: string
  issuer_legal_name: string
  consignor_name: string
  consignee_name: string
  actual_weight_kg: string | number
  charged_weight_kg: string | number
  freight_charge_inr: string | number
  stationary_charge_inr: string | number
  handling_charge_inr: string | number
  other_charge_inr: string | number
  total_charge_inr: string | number
  freight_term: 'PAID' | 'TO_PAY' | 'TO_BE_BILLED'
  delivery_mode: 'GODOWN' | 'DOOR' | null
  invoice_number: string | null
  invoice_value_inr: string | number | null
  eway_bill_number: string | null
  issued_at: string
}

export type DbFreightInvoice = {
  id: string
  booking_id: string
  invoice_number: string
  financial_year: string
  supplier_user_id: string
  supplier_legal_name: string
  supplier_gstin: string | null
  billed_to_name: string
  billed_to_gstin: string | null
  billed_to_state_code: string | null
  shipped_to_name: string | null
  shipped_to_gstin: string | null
  shipped_to_state_code: string | null
  place_of_supply_code: string | null
  taxable_value_inr: string | number
  /** GENERATED by the DB from the Rule 138 Explanation 2 formula — GST-inclusive. */
  consignment_value_inr: string | number
  grand_total_inr: string | number
  lr_number: string | null
  eway_bill_number: string | null
  irn: string | null
  issued_at: string
}

export type DbEwayBillRecord = {
  id: string
  booking_id: string
  ewb_number: string
  generated_at: string
  /** Copied from the portal. NEVER recomputed — see rules.ewayBillExpiry. */
  valid_upto: string
  issuing_portal: EwbPortal
  /** What a PERSON did to the bill (§4.5). Expiry is separate and always derived. */
  status: EwbStatus
  status_changed_at: string | null
  /** users.id of whoever filed the cancel/reject — audit trail (review S-7). */
  status_changed_by: string | null
  status_reason: string | null
  part_b_entered_at: string | null
  document_number: string | null
  consignment_value_inr: string | number | null
  document_uri: string | null
  recorded_at: string
}

// -----------------------------------------------------------
// issueLorryReceipt / issueFreightInvoice
//
// Both RPCs are idempotent per booking: an already-issued document comes back
// unchanged rather than being renumbered (§3.3 "never renumbered after issue"),
// so a retried request, a double-tapped button and a replayed saga all converge
// on the ONE document the consignee is holding.
// -----------------------------------------------------------

export async function issueLorryReceipt(args: {
  bookingId: string
  issuerKind: Extract<DocumentIssuerKind, 'fleet_owner' | 'driver'>
  issuerId: string
  prefix: string | null
  payload: Record<string, unknown>
}): Promise<DbLorryReceipt> {
  const { data, error } = await supabase.rpc('issue_lorry_receipt', {
    p_booking_id:  args.bookingId,
    p_issuer_kind: args.issuerKind,
    p_issuer_id:   args.issuerId,
    p_prefix:      args.prefix,
    p_payload:     args.payload,
  })

  if (error) {
    if (isMissingFunction(error) || isMissingRelation(error)) throw notMigrated('Issuing a lorry receipt')
    if (isSeriesExhausted(error)) throw seriesExhausted(error)
    throw new BookingError(`Lorry receipt issue failed: ${error.message}`, 'INTERNAL', 500)
  }
  if (!data) throw new BookingError('Lorry receipt issue returned no row', 'INTERNAL', 500)
  return data as DbLorryReceipt
}

export async function issueFreightInvoice(args: {
  bookingId: string
  supplierUserId: string
  prefix: string | null
  payload: Record<string, unknown>
}): Promise<DbFreightInvoice> {
  const { data, error } = await supabase.rpc('issue_freight_invoice', {
    p_booking_id:       args.bookingId,
    p_supplier_user_id: args.supplierUserId,
    p_prefix:           args.prefix,
    p_payload:          args.payload,
  })

  if (error) {
    if (isMissingFunction(error) || isMissingRelation(error)) throw notMigrated('Issuing an invoice')
    if (isSeriesExhausted(error)) throw seriesExhausted(error)
    throw new BookingError(`Invoice issue failed: ${error.message}`, 'INTERNAL', 500)
  }
  if (!data) throw new BookingError('Invoice issue returned no row', 'INTERNAL', 500)
  return data as DbFreightInvoice
}

// -----------------------------------------------------------
// recordEwayBill — a plain insert, and that is the whole point.
//
// D-17: we do not generate e-way bills. No GSP contract, no ISO 27001, no second
// IRP integration for e-invoice-enabled shippers whose bills the EWB API refuses
// outright (§11.5). The user raises it on the portal in two minutes and we record
// the number, the validity the PORTAL gave it, and which portal gave it.
//
// No series, so no allocator: the number is theirs, not ours.
// -----------------------------------------------------------

export async function recordEwayBill(args: {
  bookingId: string
  ewbNumber: string
  generatedAt: string
  /** Straight from the portal response. Never derived here. */
  validUpto: string
  issuingPortal: EwbPortal
  partBEnteredAt?: string | null
  documentNumber?: string | null
  consignmentValueInr?: number | null
  documentUri?: string | null
  recordedBy: string
}): Promise<DbEwayBillRecord> {
  const { data, error } = await supabase
    .from('eway_bill_records')
    .insert({
      booking_id:            args.bookingId,
      ewb_number:            args.ewbNumber,
      generated_at:          args.generatedAt,
      valid_upto:            args.validUpto,
      issuing_portal:        args.issuingPortal,
      part_b_entered_at:     args.partBEnteredAt ?? null,
      document_number:       args.documentNumber ?? null,
      consignment_value_inr: args.consignmentValueInr ?? null,
      document_uri:          args.documentUri ?? null,
      recorded_by:           args.recordedBy,
    })
    .select('*')
    .single()

  if (error) {
    if (isMissingRelation(error)) throw notMigrated('Recording an e-way bill')
    // 23505 on (booking_id, ewb_number): this bill is already on file AGAINST THIS
    // BOOKING. A duplicate is a client mistake (two people recording the same
    // paper), not a server fault. Note the constraint is per-booking, not global:
    // one e-way bill covering two bookings is the D-16 consolidated case and must
    // not 409.
    if (error.code === '23505') {
      throw new BookingError(
        `E-way bill ${args.ewbNumber} is already recorded against this booking`,
        'CONFLICT',
        409,
      )
    }
    throw new BookingError(`E-way bill record failed: ${error.message}`, 'INTERNAL', 500)
  }
  return data as DbEwayBillRecord
}

/**
 * §4.5 — file what the portal did to a bill (cancelled within 24h, rejected
 * within 72h). Scoped by booking AND number: the same consolidated bill may cover
 * another booking, and cancelling it there is a separate act with its own row.
 */
export async function setEwayBillStatus(args: {
  bookingId: string
  ewbNumber: string
  status: EwbStatus
  changedAt: string
  /** users.id of the actor filing the change — audit trail (review S-7). */
  changedBy: string
  reason?: string | null
}): Promise<DbEwayBillRecord> {
  const { data, error } = await supabase
    .from('eway_bill_records')
    .update({
      status:            args.status,
      status_changed_at: args.changedAt,
      status_changed_by: args.changedBy,
      status_reason:     args.reason ?? null,
    })
    .eq('booking_id', args.bookingId)
    .eq('ewb_number', args.ewbNumber)
    .select('*')
    .maybeSingle()

  if (error) {
    if (isMissingRelation(error)) throw notMigrated('Updating an e-way bill')
    throw new BookingError(`E-way bill status update failed: ${error.message}`, 'INTERNAL', 500)
  }
  if (!data) {
    throw new BookingError(
      `E-way bill ${args.ewbNumber} is not recorded against this booking`,
      'NOT_FOUND',
      404,
    )
  }
  return data as DbEwayBillRecord
}

// -----------------------------------------------------------
// Reads. Every one of these answers "nothing" on a pre-0024 database instead of
// throwing, so a booking screen that asks for documents on a database that has
// none of the tables renders exactly as it did before this slice existed.
// -----------------------------------------------------------

export async function getLorryReceipt(bookingId: string): Promise<DbLorryReceipt | null> {
  const { data, error } = await supabase
    .from('lorry_receipts')
    .select('*')
    .eq('booking_id', bookingId)
    .maybeSingle()

  if (error) {
    if (isMissingRelation(error)) return null
    throw new Error(`Lorry receipt lookup failed: ${error.message}`)
  }
  return (data as DbLorryReceipt | null) ?? null
}

export async function getFreightInvoice(bookingId: string): Promise<DbFreightInvoice | null> {
  const { data, error } = await supabase
    .from('freight_invoices')
    .select('*')
    .eq('booking_id', bookingId)
    .maybeSingle()

  if (error) {
    if (isMissingRelation(error)) return null
    throw new Error(`Invoice lookup failed: ${error.message}`)
  }
  return (data as DbFreightInvoice | null) ?? null
}

/**
 * All e-way bills recorded against a booking, newest first. A list, not a single
 * row: a cancelled-and-regenerated bill (§4.5) and a D-16 multi-truck consignment
 * both legitimately produce several, and "which bill was live when the vehicle
 * was stopped" is the question that actually gets asked.
 */
export async function listEwayBills(bookingId: string): Promise<DbEwayBillRecord[]> {
  const { data, error } = await supabase
    .from('eway_bill_records')
    .select('*')
    .eq('booking_id', bookingId)
    .order('generated_at', { ascending: false })

  if (error) {
    if (isMissingRelation(error)) return []
    throw new Error(`E-way bill lookup failed: ${error.message}`)
  }
  return (data as DbEwayBillRecord[] | null) ?? []
}
