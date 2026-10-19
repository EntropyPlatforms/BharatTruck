// -----------------------------------------------------------
// invoice-ocr — turn a Document AI Invoice-Parser response into the SAME field shape the QR
// scanner produces, so a photographed/handwritten invoice prefills the freight-documents form
// exactly as a scanned e-invoice QR would. A human still confirms by saving the real invoice
// (§6 / INDIA_FREIGHT_COMPLIANCE.md): OCR is a prefill, never the source of truth, and the parsed
// fields are recorded in document_extractions for audit — never written onto a document row here.
//
// parseInvoiceEntities is PURE (Document AI JSON in, fields out) so it is unit-tested against a
// captured response, with no processor or credentials.
// -----------------------------------------------------------

import {
  processInvoiceDocument,
  invoiceOcrConfigured,
  type DocAiInvoiceDocument,
  type DocAiEntity,
} from './docai.js'
import { parseInvoiceText, type InvoiceTextFields } from './invoice-text.js'

export { invoiceOcrConfigured }

// A superset of the e-invoice QR fields (qr.ts EInvoiceQrFields), so the frontend prefill is
// shared: the same seller/buyer/doc/value fields, plus the amounts OCR can also read off paper.
//
// Beyond the QR fields, the TEXT reader (invoice-text.ts) adds what a transporter's consignment
// note / LR and a GST invoice print: the e-way bill number, LR number, consignor/consignee
// GSTINs, freight charges and terms, CGST/SGST/IGST, SAC/HSN, weight. doc_type says which kind
// of paper this was.
export type InvoiceOcrFields = Partial<Omit<InvoiceTextFields, 'doc_type'>> & {
  doc_type?: InvoiceTextFields['doc_type']
}

// A real GSTIN shape — an OCR mis-read that is not one is dropped rather than prefilled, so a
// garbage tax id never lands in the form (it would print on a statutory document).
const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]\b/

function entText(e: DocAiEntity | undefined): string | undefined {
  if (!e) return undefined
  const v = e.normalizedValue?.text ?? e.mentionText
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
  return s || undefined
}

/** Money as a number: prefer the structured moneyValue (units + nanos), else parse the text. */
function entMoney(e: DocAiEntity | undefined): number | undefined {
  if (!e) return undefined
  const m = e.normalizedValue?.moneyValue
  if (m && (m.units !== undefined || m.nanos !== undefined)) {
    const units = m.units ? Number(m.units) : 0
    const nanos = m.nanos ? m.nanos / 1e9 : 0
    const n = units + nanos
    if (Number.isFinite(n)) return n
  }
  const raw = entText(e)
  if (!raw) return undefined
  const n = Number(raw.replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) && raw.match(/\d/) ? n : undefined
}

function normalizeGstin(s: string | undefined): string | undefined {
  if (!s) return undefined
  const up = s.toUpperCase().replace(/\s+/g, '')
  const m = up.match(GSTIN_RE)
  return m ? m[0] : undefined
}

/**
 * parseInvoiceEntities — Document AI Invoice-Parser entities -> InvoiceOcrFields.
 *
 * Reads the standard Invoice-Parser entity types (supplier_tax_id, receiver_tax_id, invoice_id,
 * invoice_date, total_amount, net_amount, total_tax_amount, line_item). Anything missing simply
 * stays undefined — a partial prefill is better than none, and the human fills the rest.
 */
export function parseInvoiceEntities(doc: DocAiInvoiceDocument): InvoiceOcrFields {
  const byType = new Map<string, DocAiEntity[]>()
  for (const e of doc.entities ?? []) {
    if (!e.type) continue
    const list = byType.get(e.type)
    if (list) list.push(e)
    else byType.set(e.type, [e])
  }
  const first = (t: string) => byType.get(t)?.[0]

  const lineItemCount = byType.get('line_item')?.length ?? 0

  return {
    seller_gstin: normalizeGstin(entText(first('supplier_tax_id'))),
    buyer_gstin: normalizeGstin(entText(first('receiver_tax_id'))),
    supplier_name: entText(first('supplier_name')),
    buyer_name: entText(first('receiver_name')),
    doc_no: entText(first('invoice_id')),
    doc_date: entText(first('invoice_date')),
    total_value: entMoney(first('total_amount')),
    taxable_value: entMoney(first('net_amount')),
    total_tax: entMoney(first('total_tax_amount')),
    item_count: lineItemCount > 0 ? lineItemCount : undefined,
  }
}

/**
 * mergeInvoiceFields — the Invoice Parser's typed entities and the text reader's fields, as one
 * prefill. Pure, so the precedence is testable:
 *   • a CONSIGNMENT NOTE: the text reader wins outright. The Invoice Parser reads a transporter's
 *     LR as an invoice FROM the transporter, so its "supplier" is the carrier and its "total" is
 *     the freight — exactly the wrong parties and the wrong number for the goods invoice.
 *   • anything else: entities win where they exist (a trained parser beats a regex on a
 *     well-printed invoice); the text reader fills every field the parser left blank.
 */
export function mergeInvoiceFields(entities: InvoiceOcrFields, text: InvoiceTextFields): InvoiceOcrFields {
  if (text.doc_type === 'consignment_note') return { ...entities, ...dropUndefined(text) }
  return { ...dropUndefined(text), ...dropUndefined(entities), doc_type: text.doc_type }
}

function dropUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

/** OCR one invoice image/PDF -> prefill fields. `kind:'ocr'` matches the document_extractions CHECK. */
export async function ocrInvoice(bytes: Buffer, mimeType: string): Promise<{ kind: 'ocr'; fields: InvoiceOcrFields }> {
  const doc = await processInvoiceDocument(bytes, mimeType)
  const entities = doc.entities?.length ? parseInvoiceEntities(doc) : {}
  const text = parseInvoiceText(doc.text ?? '')
  return { kind: 'ocr', fields: mergeInvoiceFields(entities, text) }
}
