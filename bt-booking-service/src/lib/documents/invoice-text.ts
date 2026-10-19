// -----------------------------------------------------------
// invoice-text — read freight paperwork off the PLAIN TEXT an OCR pass returns, by the labels
// Indian documents actually print. The Invoice Parser's typed entities (invoice-ocr.ts) know
// "supplier" and "receiver"; they do not know that a transporter's consignment note prints the
// CONSIGNOR's and CONSIGNEE's GSTINs beside those words, nor "EwayNo", "Invoice Value Rs",
// "TOPAY", "A.Weight", "SAC 996511". This layer does, and it also works with a plain Document
// OCR processor when no Invoice Parser is configured.
//
// What it recognises:
//   consignment_note — a transporter's LR / freight bill (VRL, TCI, Gati, …): the shipper's
//                      invoice number and value, the e-way bill number, consignor/consignee
//                      GSTINs, LR number, weight, freight charges, PAID / TO PAY.
//   tax_invoice      — a GST invoice (HSN/SAC lines, CGST/SGST or IGST, grand total).
//   receipt          — a bill / cash receipt with a bill number and a total, no GST lines.
//
// Pure (text in, fields out) so it is unit-tested on transcribed documents. Every field is a
// PREFILL for a human to confirm; a GSTIN is kept only when it passes the full GSTIN check.
// -----------------------------------------------------------

export type InvoiceTextFields = {
  doc_type: 'consignment_note' | 'tax_invoice' | 'receipt' | 'unknown'
  /** The SHIPPER's invoice number (on an LR, the "Invoice No" of the goods; on an invoice, its own number). */
  doc_no?: string
  /** ISO yyyy-mm-dd */
  doc_date?: string
  /** The invoice value / grand total in rupees. */
  total_value?: number
  taxable_value?: number
  total_tax?: number
  cgst?: number
  sgst?: number
  igst?: number
  seller_gstin?: string
  buyer_gstin?: string
  supplier_name?: string
  buyer_name?: string
  /** 12-digit NIC e-way bill number. */
  eway_bill_no?: string
  /** The transporter's consignment-note / LR number. */
  lr_no?: string
  transporter_gstin?: string
  transporter_name?: string
  from_place?: string
  to_place?: string
  /** Chargeable weight in kg (the higher of actual and charged when both print). */
  weight_kg?: number
  /** Freight charges total on a consignment note, in rupees. */
  freight_inr?: number
  freight_term?: 'PAID' | 'TO_PAY' | 'TO_BE_BILLED'
  /** 6-digit SAC / HSN; 9965xx and 9967xx are transport services. */
  sac_code?: string
  item_count?: number
}

// ── GSTIN check (mirrors bt-auth-service/src/lib/gst.ts; kept local — no shared rebuild) ──
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const PAN_SHAPE = /^[A-Z]{3}[ABCFGHLJPT][A-Z][0-9]{4}[A-Z]$/
const TO_DIGIT: Record<string, string> = { O: '0', D: '0', Q: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6' }
const TO_LETTER: Record<string, string> = { '0': 'O', '1': 'I', '5': 'S', '8': 'B', '6': 'G', '2': 'Z' }

export function isValidGstin(g: string): boolean {
  if (!GSTIN_SHAPE.test(g) || !PAN_SHAPE.test(g.slice(2, 12))) return false
  const state = Number(g.slice(0, 2))
  if (!((state >= 1 && state <= 38) || state === 97 || state === 99)) return false
  let sum = 0
  for (let i = 0; i < 14; i++) {
    const p = ALPHABET.indexOf(g[i]) * (i % 2 === 0 ? 1 : 2)
    sum += Math.floor(p / 36) + (p % 36)
  }
  return ALPHABET[(36 - (sum % 36)) % 36] === g[14]
}

/** A 15-character token with OCR's letter/digit slips corrected by position; null unless it validates. */
export function normaliseGstin(token: string): string | null {
  const t = token.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (t.length !== 15) return null
  const fix = (c: string, letter: boolean) => (letter ? (/[A-Z]/.test(c) ? c : TO_LETTER[c] ?? c) : (/[0-9]/.test(c) ? c : TO_DIGIT[c] ?? c))
  const out = t.split('').map((c, i) => {
    if (i < 2) return fix(c, false)
    if (i < 7) return fix(c, true)
    if (i < 11) return fix(c, false)
    if (i === 11) return fix(c, true)
    if (i === 13) return 'Z'
    return c
  }).join('')
  return isValidGstin(out) ? out : null
}

// ── helpers ───────────────────────────────────────────────────
const lines = (text: string) => text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean)

const GSTIN_TOKEN = /\b[0-9A-Z]{15}\b/g

function isoDate(d: number, m: number, y: number): string | null {
  if (y < 100) y += 2000
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCDate() !== d || dt.getUTCMonth() !== m - 1) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function dateIn(s: string): string | undefined {
  const m = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/.exec(s)
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3])) ?? undefined
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s)
  if (iso) return isoDate(Number(iso[3]), Number(iso[2]), Number(iso[1])) ?? undefined
  return undefined
}

/** "Rs. 1,27,552.00" / "₹4,130" / "1275 52" -> 127552 ; undefined when there is no number. */
function money(s: string | undefined): number | undefined {
  if (!s) return undefined
  const m = /(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i.exec(s)
  if (!m) return undefined
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** The text after a label on its line, or the next line when the label stands alone. */
function after(ls: string[], label: RegExp, opts: { nextLine?: boolean } = { nextLine: true }): string | undefined {
  for (let i = 0; i < ls.length; i++) {
    const m = label.exec(ls[i])
    if (!m) continue
    const rest = ls[i].slice(m.index + m[0].length).replace(/^[\s:.\-–]+/, '').trim()
    if (rest) return rest
    if (opts.nextLine !== false && ls[i + 1]) return ls[i + 1]
  }
  return undefined
}

/**
 * The first rupee amount found beside a label, trying EVERY line that carries the label: a
 * table header ("… SGST CGST AMOUNT") matches the label but holds no number, and the value is
 * on the "SGST PAYABLE 3.58" line further down.
 */
function moneyAfter(ls: string[], label: RegExp): number | undefined {
  for (const l of ls) {
    const m = label.exec(l)
    if (!m) continue
    const n = money(l.slice(m.index + m[0].length))
    if (n !== undefined) return n
  }
  return undefined
}

/** A name: letters, &, ., -, parentheses; title-cased unless it is an acronym. */
function cleanName(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const s = raw.replace(/\b(?:GSTIN|GST\s*NO|PAN|PHONE|MOB(?:ILE)?)\b.*$/i, '').replace(/[^A-Za-z0-9 .&()'-]/g, ' ').replace(/\s+/g, ' ').trim()
  if (s.length < 3 || s.length > 80 || !/[A-Za-z]{2,}/.test(s)) return undefined
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\b(Llp|Pvt|Ltd|Opc|Co)\b\.?/g, (w) => w.toUpperCase())
}

/** The first GSTIN that validates in a stretch of text (slips corrected). */
function gstinIn(s: string | undefined): string | undefined {
  if (!s) return undefined
  for (const m of s.toUpperCase().matchAll(GSTIN_TOKEN)) {
    const g = normaliseGstin(m[0])
    if (g) return g
  }
  // OCR sometimes splits the GSTIN with a space: "24AABCV3609C 1ZT"
  for (const m of s.toUpperCase().matchAll(/\b([0-9A-Z]{2,14})\s([0-9A-Z]{1,13})\b/g)) {
    if ((m[1] + m[2]).length === 15) { const g = normaliseGstin(m[1] + m[2]); if (g) return g }
  }
  return undefined
}

/** Lines i..i+n joined — a party block ("Consignor / name / GSTIN:…") spans a few lines. */
const block = (ls: string[], i: number, n = 4) => ls.slice(i, i + n + 1).join(' | ')

// ── the parser ───────────────────────────────────────────────
export function parseInvoiceText(text: string): InvoiceTextFields {
  const ls = lines(text)
  const upper = text.toUpperCase()
  const out: InvoiceTextFields = { doc_type: 'unknown' }

  const isLr = /\b(?:CONSIGNOR|CONSIGNEE|LORRY\s*RECEIPT|CONSIGNMENT\s*NOTE|GOODS\s*CONSIGNMENT|L\.?R\.?\s*NO|EWAY\s*NO|E-?WAY\s*BILL\s*NO|TRANSPORTER\s*ID|BOOKED\s*AT\s*OWNER)/i.test(upper)
  const isTaxInvoice = /\bTAX\s*INVOICE\b|\bGST\s*INVOICE\b|\bHSN\b|\bCGST\b|\bSGST\b|\bIGST\b/i.test(upper)
  out.doc_type = isLr ? 'consignment_note' : isTaxInvoice ? 'tax_invoice' : /\b(?:BILL|RECEIPT|INVOICE)\b/i.test(upper) ? 'receipt' : 'unknown'

  // ── parties ──
  if (isLr) {
    // The label line itself ("Consignor", "Consignee :", "Consignor Name"), not the copy
    // marker ("CONSIGNEE'S COPY") that sits in the letterhead of every transporter's LR.
    const ci = ls.findIndex((l) => /^consignor(?:\s*name)?\s*[:\-–]?\s*$/i.test(l) || /^consignor(?:\s*name)?\s*[:\-–]\s*\S/i.test(l))
    const ce = ls.findIndex((l) => /^consignee(?:\s*name)?\s*[:\-–]?\s*$/i.test(l) || /^consignee(?:\s*name)?\s*[:\-–]\s*\S/i.test(l))
    if (ci >= 0) {
      out.supplier_name = cleanName(after([ls[ci], ls[ci + 1] ?? ''], /consignor/i)?.replace(/^(?:name)?\s*[:\-]?\s*/i, ''))
      out.seller_gstin = gstinIn(block(ls, ci))
    }
    if (ce >= 0) {
      out.buyer_name = cleanName(after([ls[ce], ls[ce + 1] ?? ''], /consignee/i)?.replace(/^(?:name)?\s*[:\-]?\s*/i, ''))
      out.buyer_gstin = gstinIn(block(ls, ce))
    }
    // The transporter's own GSTIN sits in the letterhead ("Transporter ID" / "GSTIN" at the top).
    out.transporter_gstin = gstinIn(after(ls, /transporter\s*id/i, { nextLine: false }))
    if (!out.transporter_gstin) {
      const head = ls.slice(0, Math.max(ci, ce, 6)).join(' | ')
      const g = gstinIn(head)
      if (g && g !== out.seller_gstin && g !== out.buyer_gstin) out.transporter_gstin = g
    }
    const letterhead = ls.find((l) => /\b(?:LOGISTICS|TRANSPORT|ROADWAYS|CARRIERS|FREIGHT|CARGO|ROADLINES)\b/i.test(l) && /\b(?:LTD|LIMITED|PVT|LLP|CO)\b/i.test(l))
    out.transporter_name = cleanName(letterhead)
  } else if (out.doc_type !== 'unknown') {
    // A tax invoice: the seller's GSTIN is the first on the page (letterhead); the buyer's the next distinct one.
    const seen: string[] = []
    for (const m of upper.matchAll(GSTIN_TOKEN)) { const g = normaliseGstin(m[0]); if (g && !seen.includes(g)) seen.push(g) }
    // "Bill To : X", "Customer Name X", or a bare "TO" line with the name beneath it.
    const billedTo =
      after(ls, /\b(?:bill(?:ed)?\s*to|buyer|customer|party)\s*(?:name)?\b/i) ??
      (() => { const i = ls.findIndex((l) => /^to\s*[:\-–]?\s*$/i.test(l)); return i >= 0 ? ls[i + 1] : undefined })()
    const billedToGstin = gstinIn(after(ls, /\b(?:bill(?:ed)?\s*to|buyer|customer)\b.*?(?:GSTIN|GST\s*NO)/i, { nextLine: false }))
    out.seller_gstin = seen.find((g) => g !== billedToGstin) ?? seen[0]
    out.buyer_gstin = billedToGstin ?? seen.find((g) => g !== out.seller_gstin)
    out.buyer_name = cleanName(billedTo?.replace(/^(?:name)?\s*[:\-]?\s*/i, ''))
    out.supplier_name = cleanName(ls[0])
  }

  // ── the shipper's invoice / bill number and date ──
  out.doc_no =
    after(ls, /\binvoice\s*(?:no|number|#)\b/i, { nextLine: false })?.split(/\s{2,}|\s(?=[A-Za-z]+\s*[:.])/)[0]?.replace(/[^A-Za-z0-9\/-]+$/, '').trim() ||
    after(ls, /\b(?:bill|receipt)\s*(?:no|number|#)\b/i, { nextLine: false })?.split(/\s{2,}/)[0]?.trim() ||
    undefined
  if (out.doc_no && (out.doc_no.length > 30 || !/\d/.test(out.doc_no))) out.doc_no = undefined

  out.doc_date =
    dateIn(after(ls, /\b(?:invoice\s*date|bill\s*date|booking\s*date|date\s*\/\s*time|\bdate\b)/i, { nextLine: false }) ?? '') ??
    undefined

  // ── money ──
  if (isLr) {
    out.total_value = moneyAfter(ls, /invoice\s*value(?:\s*rs\.?)?/i)
    out.freight_inr = moneyAfter(ls, /^\s*total\b/i) ?? moneyAfter(ls, /\bgrand\s*total\b/i)
    if (/\bTO\s*-?\s*PAY\b|\bTOPAY\b/i.test(upper)) out.freight_term = 'TO_PAY'
    else if (/\bTO\s*BE\s*BILLED\b|\bTBB\b|\bCREDIT\b/i.test(upper)) out.freight_term = 'TO_BE_BILLED'
    else if (/\bPAID\b/i.test(upper)) out.freight_term = 'PAID'
  } else {
    out.total_value = moneyAfter(ls, /\b(?:grand\s*total|total\s*(?:paid\s*)?amount|net\s*amount|amount\s*payable|total\s*payable)\b/i) ??
      moneyAfter(ls, /^\s*total\b/i)
    out.taxable_value = moneyAfter(ls, /\b(?:taxable\s*(?:value|amount)|sub\s*total)\b/i)
    // "SGST PAYABLE 3.58" — the labelled total line, not a line item's "2.50" rate column.
    out.cgst = moneyAfter(ls, /\bCGST\s*(?:payable|amount|amt|total)\b/i) ?? moneyAfter(ls, /^\s*CGST\b/i)
    out.sgst = moneyAfter(ls, /\bSGST\s*(?:payable|amount|amt|total)\b/i) ?? moneyAfter(ls, /^\s*SGST\b/i)
    out.igst = moneyAfter(ls, /\bIGST\s*(?:payable|amount|amt|total)\b/i) ?? moneyAfter(ls, /^\s*IGST\b/i)
    const tax = moneyAfter(ls, /\btotal\s*(?:gst|tax)\s*(?:amount)?\s*[:.\-–]/i)
    out.total_tax = tax ?? ((out.cgst ?? 0) + (out.sgst ?? 0) + (out.igst ?? 0) || undefined)
    if (out.taxable_value === undefined && out.total_value !== undefined && out.total_tax !== undefined && out.total_tax < out.total_value) {
      out.taxable_value = Math.round((out.total_value - out.total_tax) * 100) / 100
    }
  }

  // ── e-way bill, LR number, SAC, weight, places ──
  const ewb = /\b(?:E-?\s*WAY\s*(?:BILL)?\s*(?:NO|NUMBER)?|EWB\s*(?:NO)?)\s*[:.\-–]?\s*(\d{4}\s?\d{4}\s?\d{4})\b/i.exec(text)
  if (ewb) out.eway_bill_no = ewb[1].replace(/\s/g, '')

  const lr = /\b(?:L\.?R\.?|G\.?C\.?|C\.?N\.?|CONSIGNMENT|DOCKET|LORRY\s*RECEIPT)\s*(?:NO|NUMBER|#)?\s*[:.\-–]?\s*([A-Z0-9][A-Z0-9\/-]{4,19})\b/i.exec(text)
  if (lr) out.lr_no = lr[1]
  if (!out.lr_no && isLr) {
    // Many LRs print the number large and bare (and under a barcode) rather than labelled.
    const bare = [...text.matchAll(/\b(\d{9,12})\b/g)].map((m) => m[1]).filter((n) => n !== out.eway_bill_no)
    const counts = new Map<string, number>()
    for (const n of bare) counts.set(n, (counts.get(n) ?? 0) + 1)
    const repeated = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
    if (repeated && repeated[1] >= 2) out.lr_no = repeated[0]
  }

  const sac = /\b(?:SAC|HSN)\s*(?:CODE|NO)?\s*[:.\-–]?\s*(\d{4,8})\b/i.exec(text)
  if (sac) out.sac_code = sac[1]
  if (!out.sac_code) {
    // Transport-of-goods SACs (9965xx / 9967xx) are unmistakable wherever they sit.
    const transportSac = /\b(99(?:65|66|67)\d{2})\b/.exec(text)
    if (transportSac) out.sac_code = transportSac[1]
  }
  if (!out.sac_code && /\bHSN\b/i.test(text)) {
    // An item table: the HSN is the first 8-digit code in a row after the header line.
    const header = ls.findIndex((l) => /\bHSN\b/i.test(l))
    for (const l of ls.slice(header + 1)) {
      const m = /\b(\d{8})\b/.exec(l)
      if (m) { out.sac_code = m[1]; break }
    }
  }

  const weights = [...text.matchAll(/\b(?:A\.?\s*WEIGHT|C\.?\s*WEIGHT|ACTUAL\s*WT|CHARGED\s*WT|CHG\.?\s*WT|WEIGHT|WT)\s*(?:\(KG\))?\s*[:.\-–]?\s*([0-9]+(?:\.[0-9]+)?)\s*(KG|KGS|MT|TON|TONNES?)?/gi)]
    .map((m) => { const n = Number(m[1]); return /^(mt|ton)/i.test(m[2] ?? '') ? n * 1000 : n })
    .filter((n) => Number.isFinite(n) && n > 0 && n < 100000)
  if (weights.length) out.weight_kg = Math.max(...weights)

  const from = after(ls, /^\s*from\s*[:.\-–]/i, { nextLine: false }) ?? after(ls, /\bfrom\s*:/i, { nextLine: false })
  const to = after(ls, /^\s*to\s*[:.\-–]/i, { nextLine: false }) ?? after(ls, /\bto\s*:\s*(?![0-9])/i, { nextLine: false })
  out.from_place = cleanName(from?.split(/\s{2,}|\bTO\b/i)[0])
  out.to_place = cleanName(to?.split(/\s{2,}|\bPHONE\b|\bKA-|\bMH-/i)[0])

  const articles = /\b(?:ARTICLES?|NO\.?\s*OF\s*(?:PKGS?|PACKAGES|ARTICLES)|QTY|PKGS?)\s*[:.\-–]?\s*(\d{1,4})\b/i.exec(text)
  if (articles) out.item_count = Number(articles[1])

  return out
}

/** How many prefill fields were read (doc_type does not count). */
export function countInvoiceFields(f: InvoiceTextFields): number {
  return Object.entries(f).filter(([k, v]) => k !== 'doc_type' && v !== undefined && v !== null && v !== '').length
}
