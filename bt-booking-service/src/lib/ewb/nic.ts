// -----------------------------------------------------------
// nic — the PURE half of e-way bill generation: what NIC's API wants, built from what the
// booking, the documents and the shipper's form supply; and NIC's answers, read back.
//
// Field names and limits follow NIC's e-way bill API as exposed by Sandbox (consignor
// endpoints, 2026-10): docNo ≤16, trade names ≤100, addresses ≤120, places ≤50, state codes
// as integers, vehicle numbers 7–15 characters with no spaces, qtyUnit exactly 3 letters,
// dates DD/MM/YYYY, timestamps "DD/MM/YYYY HH:MM:SS AM". No network here, so every rule is
// unit-tested without an NIC account.
// -----------------------------------------------------------

export class EwbError extends Error {
  constructor(message: string, public readonly httpStatus: number, public readonly code: string) {
    super(message)
    this.name = 'EwbError'
  }
}

export type GstRate = 0 | 5 | 12 | 18 | 28

export type GenerateInput = {
  /** The SHIPPER's goods invoice (Rule 46(b) number, the date it was issued). */
  document_number: string
  document_date: string            // ISO yyyy-mm-dd
  consignee_name: string
  consignee_gstin?: string | null   // null / 'URP' = unregistered recipient
  hsn_code: string
  product_name: string
  taxable_value_inr: number
  gst_rate: GstRate
  total_invoice_value_inr: number
  distance_km: number
  vehicle_number?: string | null
  /** The transporter's GSTIN / transporter id. When set, Part B must come from the transporter. */
  transporter_id?: string | null
  from_place: string
  to_place: string
  /** 'M'oving/own vehicle default; NIC's vehicleType R(egular) or O(ver-dimensional cargo). */
  vehicle_type?: 'R' | 'O'
}

export type PartyFacts = {
  shipper_gstin: string
  shipper_name: string
  source_address: string
  source_pincode: string
  source_state_code: string
  destination_address: string
  dest_pincode: string
  dest_state_code: string
  weight_kg: number | null
}

const clip = (s: string | null | undefined, n: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

export function toNicDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) throw new EwbError('document_date must be yyyy-mm-dd', 400, 'VALIDATION_ERROR')
  return `${m[3]}/${m[2]}/${m[1]}`
}

/** "01/05/2024 07:00:00 PM" (NIC prints IST) -> ISO with the +05:30 offset. */
export function nicDateTimeToIso(raw: string | null | undefined): string | null {
  if (!raw) return null
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(raw.trim())
  if (!m) return null
  let h = Number(m[4])
  const ap = m[7]?.toUpperCase()
  if (ap === 'PM' && h < 12) h += 12
  if (ap === 'AM' && h === 12) h = 0
  // NIC prints "11:59:00 PM" as 23:59; it also prints "23:59:00 PM" on some endpoints.
  if (h > 23) h -= 12
  const pad = (n: number | string) => String(n).padStart(2, '0')
  return `${m[3]}-${pad(m[2])}-${pad(m[1])}T${pad(h)}:${m[5]}:${m[6] ?? '00'}+05:30`
}

export const normaliseVehicleNo = (v: string | null | undefined) => (v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

/** Inter-state → IGST; intra-state → CGST + SGST, each half the rate. Paise-exact, owner-rounded. */
export function splitGst(taxable: number, rate: GstRate, interState: boolean): { cgst: number; sgst: number; igst: number } {
  const taxPaise = Math.round(taxable * rate)  // taxable * rate / 100 * 100
  if (interState) return { cgst: 0, sgst: 0, igst: taxPaise / 100 }
  const half = Math.floor(taxPaise / 2)
  return { cgst: half / 100, sgst: (taxPaise - half) / 100, igst: 0 }
}

/**
 * The consignor's Generate E-Way Bill body. Throws EwbError (400) on anything NIC would
 * reject anyway, with the reason in the shipper's words.
 */
export function buildGeneratePayload(facts: PartyFacts, input: GenerateInput): Record<string, unknown> {
  const fromState = Number(facts.source_state_code)
  const toState = Number(facts.dest_state_code)
  if (!Number.isInteger(fromState) || !Number.isInteger(toState) || fromState < 1 || toState < 1) {
    throw new EwbError('The booking has no GST state code for pickup or drop — re-pick the addresses on the load', 400, 'VALIDATION_ERROR')
  }
  const fromPin = Number(facts.source_pincode)
  const toPin = Number(facts.dest_pincode)
  if (!(fromPin >= 100000 && fromPin <= 999999) || !(toPin >= 100000 && toPin <= 999999)) {
    throw new EwbError('The booking has no PIN code for pickup or drop — re-pick the addresses on the load', 400, 'VALIDATION_ERROR')
  }
  if (!/^[A-Za-z0-9/-]{1,16}$/.test(input.document_number)) {
    throw new EwbError('Invoice number must be 1–16 letters, digits, / or - (Rule 46(b))', 400, 'VALIDATION_ERROR')
  }
  if (!/^\d{4,8}$/.test(input.hsn_code)) throw new EwbError('HSN code must be 4–8 digits', 400, 'VALIDATION_ERROR')
  if (!(input.taxable_value_inr > 0)) throw new EwbError('Taxable value must be above zero', 400, 'VALIDATION_ERROR')
  if (!(input.total_invoice_value_inr >= input.taxable_value_inr)) throw new EwbError('Total invoice value cannot be below the taxable value', 400, 'VALIDATION_ERROR')
  if (!(input.distance_km > 0 && input.distance_km <= 4000)) throw new EwbError('Distance must be 1–4000 km', 400, 'VALIDATION_ERROR')
  const vehicleNo = normaliseVehicleNo(input.vehicle_number)
  if (vehicleNo && (vehicleNo.length < 7 || vehicleNo.length > 15)) throw new EwbError('Vehicle number must be 7–15 characters (e.g. MH12AB1234)', 400, 'VALIDATION_ERROR')
  if (!vehicleNo && !input.transporter_id) {
    throw new EwbError('Give the vehicle number (Part B) or the transporter id — a bill with neither cannot move goods', 400, 'VALIDATION_ERROR')
  }
  const toGstin = (input.consignee_gstin ?? '').trim().toUpperCase() || 'URP'
  if (toGstin !== 'URP' && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(toGstin)) {
    throw new EwbError('Consignee GSTIN is not in the GSTIN format (leave blank for an unregistered receiver)', 400, 'VALIDATION_ERROR')
  }

  const interState = fromState !== toState
  const tax = splitGst(input.taxable_value_inr, input.gst_rate, interState)
  const otherValue = Math.max(0, Math.round((input.total_invoice_value_inr - input.taxable_value_inr - tax.cgst - tax.sgst - tax.igst) * 100) / 100)

  return {
    supplyType: 'O',
    subSupplyType: '1',
    docType: 'INV',
    docNo: input.document_number,
    docDate: toNicDate(input.document_date),
    fromGstin: facts.shipper_gstin,
    fromTrdName: clip(facts.shipper_name, 100),
    fromAddr1: clip(facts.source_address, 120),
    fromPlace: clip(input.from_place, 50),
    fromPincode: fromPin,
    fromStateCode: fromState,
    actFromStateCode: fromState,
    toGstin,
    toTrdName: clip(input.consignee_name, 100),
    toAddr1: clip(facts.destination_address, 120),
    toPlace: clip(input.to_place, 50),
    toPincode: toPin,
    toStateCode: toState,
    actToStateCode: toState,
    transactionType: 1,
    totalValue: input.taxable_value_inr,
    cgstValue: tax.cgst,
    sgstValue: tax.sgst,
    igstValue: tax.igst,
    cessValue: 0,
    cessNonAdvolValue: 0,
    otherValue,
    totInvValue: input.total_invoice_value_inr,
    transMode: '1',
    transDistance: String(Math.round(input.distance_km)),
    ...(input.transporter_id ? { transporterId: input.transporter_id.toUpperCase() } : {}),
    ...(vehicleNo ? { vehicleNo, vehicleType: input.vehicle_type ?? 'R' } : {}),
    itemList: [
      {
        productName: clip(input.product_name, 100),
        productDesc: clip(input.product_name, 100),
        hsnCode: Number(input.hsn_code),
        quantity: facts.weight_kg && facts.weight_kg > 0 ? Math.round(facts.weight_kg * 100) / 100 : 1,
        qtyUnit: facts.weight_kg && facts.weight_kg > 0 ? 'KGS' : 'NOS',
        taxableAmount: input.taxable_value_inr,
        cgstRate: interState ? 0 : input.gst_rate / 2,
        sgstRate: interState ? 0 : input.gst_rate / 2,
        igstRate: interState ? input.gst_rate : 0,
        cessRate: 0,
        cessNonadvol: 0,
      },
    ],
  }
}

// NIC error codes the shipper can act on. Anything else is shown as "NIC error <code>".
export const NIC_ERRORS: Record<string, string> = {
  '108': 'The e-way bill portal rejected the API username or password — check them in Settings',
  '202': 'The portal is not responding — try again in a minute',
  '204': 'Invalid GSTIN on the bill',
  '217': 'Invalid HSN code',
  '301': 'Invalid e-way bill number',
  '312': 'This bill cannot be cancelled — it is already cancelled, or you are not its generator',
  '325': 'The e-way bill is no longer valid',
  '343': 'Vehicle number is not in the registered format',
  '357': 'The portal has no data for this e-way bill',
  '361': 'Invalid vehicle type',
  '382': 'Validity can only be extended within 8 hours before or after it expires',
  '418': 'No e-way bills found for that date',
  '444': 'This bill was generated on the other NIC portal and cannot be changed from here',
  '604': 'A bill for this invoice already exists on the portal',
  '705': 'Invalid transit type',
  '726': 'Vehicle type cannot be regular for this transport mode',
}

/** NIC answers HTTP 200 with status "0" on a business rejection; turn that into an EwbError. */
export function nicData<T>(res: { data?: { status?: string | number; data?: T; error?: { errorCodes?: string | number }; info?: string } }, what: string): T {
  const status = String(res.data?.status ?? '')
  if (status === '1' && res.data?.data !== undefined) return res.data.data as T
  const codes = String(res.data?.error?.errorCodes ?? '').split(',').map((c) => c.trim()).filter(Boolean)
  const known = codes.map((c) => NIC_ERRORS[c]).find(Boolean)
  const detail = known ?? (codes.length ? `NIC error ${codes.join(', ')}` : 'the portal returned no result')
  throw new EwbError(`${what} failed — ${detail}`, 422, 'NIC_REJECTED')
}
