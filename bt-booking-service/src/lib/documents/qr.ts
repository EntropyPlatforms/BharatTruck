// -----------------------------------------------------------
// NIC document QR parsing — turn the QR printed on an e-way bill or a GST e-invoice into
// structured fields that PREFILL the freight-documents form (a human always confirms before
// anything is saved).
//
// WHY QR, not OCR (the founder's call, INDIA_FREIGHT_COMPLIANCE.md §6): the e-way bill and the
// GST e-invoice already carry a NIC-signed QR. Reading it is exact and tamper-evident, so the
// driver stops re-typing a 12-digit e-way bill number at the gate. OCR is only for the
// handwritten/paper bills small shippers hand over — a separate, vendor-backed path.
//
// PURE + input-only: these functions take the raw scanned string and return fields. They never
// touch the POD photo (that is byte-preserved WORM storage, §5.4) — a document QR is the
// shipper's own artifact, a different thing entirely.
//
// Two formats:
//   • GST e-invoice QR — a JWS (header.payload.signature). The base64url payload is JSON whose
//     `data` claim is a JSON string of the invoice fields (SellerGstin, BuyerGstin, DocNo, DocDt,
//     TotInvVal, ItemCnt, MainHsnCode, Irn, IrnDt). Well-specified and stable.
//   • E-way bill QR — the NIC print format is less consistently documented, so this is parsed
//     DEFENSIVELY: try JSON, else pull the 12-digit EWB number + a date + a GSTIN out of the
//     string. It reliably yields the 12-digit number (the headline win); confirm the exact
//     layout against a real e-way bill during pilot testing before trusting the date field.
// -----------------------------------------------------------

export type EwayQrFields = {
  ewb_number?: string
  generated_at?: string
  generated_by_gstin?: string
}

export type EInvoiceQrFields = {
  irn?: string
  seller_gstin?: string
  buyer_gstin?: string
  doc_no?: string
  doc_date?: string
  total_value?: number
  item_count?: number
  main_hsn?: string
  irn_date?: string
}

export type ParsedQr =
  | { kind: 'einvoice_qr'; fields: EInvoiceQrFields }
  | { kind: 'eway_qr'; fields: EwayQrFields }
  | { kind: 'unknown'; fields: Record<string, never> }

const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]\b/
const EWB12_RE = /\b\d{12}\b/
const IRN64_RE = /\b[0-9a-f]{64}\b/i

// Case-insensitive key lookup, so 'SellerGstin' / 'sellergstin' / 'SELLERGSTIN' all resolve.
function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  const lower = new Map(Object.keys(obj).map(k => [k.toLowerCase(), k]))
  for (const k of keys) {
    const actual = lower.get(k.toLowerCase())
    if (actual !== undefined) return obj[actual]
  }
  return undefined
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (typeof v === 'number') return String(v)
  return undefined
}

function asNumber(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/,/g, '')) : NaN
  return Number.isFinite(n) ? n : undefined
}

function base64urlToString(seg: string): string | null {
  try {
    return Buffer.from(seg, 'base64url').toString('utf8')
  } catch {
    return null
  }
}

// A JWS is three base64url segments. We only read the payload (middle) — signature verification
// against NIC's public key is a later, optional hardening step; the fields still only prefill.
function decodeJwsPayload(raw: string): Record<string, unknown> | null {
  const parts = raw.split('.')
  if (parts.length !== 3) return null
  const json = base64urlToString(parts[1])
  if (!json) return null
  try {
    const outer = JSON.parse(json) as Record<string, unknown>
    // The IRP payload nests the invoice fields as a JSON STRING under `data`.
    const data = pick(outer, 'data')
    if (typeof data === 'string') {
      try { return JSON.parse(data) as Record<string, unknown> } catch { return outer }
    }
    return outer
  } catch {
    return null
  }
}

function parseEInvoice(obj: Record<string, unknown>): EInvoiceQrFields {
  return {
    irn: asString(pick(obj, 'Irn', 'irn')),
    seller_gstin: asString(pick(obj, 'SellerGstin', 'sellerGstin')),
    buyer_gstin: asString(pick(obj, 'BuyerGstin', 'buyerGstin')),
    doc_no: asString(pick(obj, 'DocNo', 'docNo')),
    doc_date: asString(pick(obj, 'DocDt', 'docDt', 'DocDate')),
    total_value: asNumber(pick(obj, 'TotInvVal', 'totInvVal', 'TotalValue')),
    item_count: asNumber(pick(obj, 'ItemCnt', 'itemCnt', 'ItemCount')),
    main_hsn: asString(pick(obj, 'MainHsnCode', 'mainHsnCode', 'HsnCode')),
    irn_date: asString(pick(obj, 'IrnDt', 'irnDt')),
  }
}

// Defensive e-way parse: JSON first (some printers encode JSON), else regex the raw string.
function parseEway(raw: string): EwayQrFields {
  let obj: Record<string, unknown> | null = null
  try { obj = JSON.parse(raw) as Record<string, unknown> } catch { obj = null }

  if (obj) {
    const ewb = asString(pick(obj, 'EwbNo', 'ewbNo', 'ewbNumber', 'ewb_no'))
    return {
      ewb_number: ewb && /^\d{12}$/.test(ewb) ? ewb : raw.match(EWB12_RE)?.[0],
      generated_at: asString(pick(obj, 'EwbDt', 'ewbDate', 'generatedDate', 'GenDate')),
      generated_by_gstin: asString(pick(obj, 'GenGstin', 'genGstin', 'fromGstin')) ?? raw.match(GSTIN_RE)?.[0],
    }
  }

  return {
    ewb_number: raw.match(EWB12_RE)?.[0],
    generated_by_gstin: raw.match(GSTIN_RE)?.[0],
  }
}

// parseDocumentQr — detect the kind and extract fields. Never throws: an unrecognised payload
// returns kind:'unknown' so the caller can tell the user to enter the fields by hand.
export function parseDocumentQr(raw: string): ParsedQr {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return { kind: 'unknown', fields: {} }

  // A JWS whose payload carries an IRN is unambiguously a GST e-invoice QR.
  const jws = decodeJwsPayload(trimmed)
  if (jws) {
    const fields = parseEInvoice(jws)
    if (fields.irn || fields.doc_no || fields.seller_gstin) return { kind: 'einvoice_qr', fields }
  }

  // Otherwise, if we can find a 12-digit number it is an e-way bill QR (or close enough to
  // prefill the number, which is the point).
  const eway = parseEway(trimmed)
  if (eway.ewb_number) return { kind: 'eway_qr', fields: eway }

  // A bare 64-hex IRN with no JWS wrapper — rare, but still an e-invoice identifier.
  const irn = trimmed.match(IRN64_RE)?.[0]
  if (irn) return { kind: 'einvoice_qr', fields: { irn } }

  return { kind: 'unknown', fields: {} }
}
