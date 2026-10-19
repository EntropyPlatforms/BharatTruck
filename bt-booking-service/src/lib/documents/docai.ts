// -----------------------------------------------------------
// Document AI call core for invoice OCR (the pure entity->fields parsing is in invoice-ocr.ts).
// Runs a photographed/scanned invoice through the configured Document AI *Invoice Parser* and
// returns the raw `document` (with typed entities) to parse.
//
// AUTH: no key, no new dependency — on Cloud Run the service account's token comes from the
// instance metadata server; the SA needs the "Document AI User" role and the Document AI API
// enabled (the operator's one-time GCP step, see .env.example). GCP_ACCESS_TOKEN is honoured as a
// local/dev escape hatch (`gcloud auth print-access-token`).
//
// DELIBERATE DUPLICATION (to consolidate later): this mirrors bt-fleet-service/src/lib/ocr/
// document-ai.ts. It is kept local rather than moved to @bharattruck/shared/ocr so this feature
// ships touching only bt-booking-service — a shared change would rebuild and redeploy every shared
// consumer (auth/booking/payment/tracking). Fold both into shared when the fleet dedup lands.
//
// Same "provider seam, activate with config" posture as KYC/geocoding: with no invoice processor
// configured this is inert (a clean 501), so the QR-scan path and everything else are unaffected.
// -----------------------------------------------------------

import { BookingError } from '../types.js'

const METADATA_BASE = 'http://metadata.google.internal/computeMetadata/v1'
const METADATA_HEADERS = { 'Metadata-Flavor': 'Google' }

// Minimal shape of a Document AI Invoice-Parser `Document`. Entities are typed key/values
// (supplier_tax_id, invoice_id, total_amount, line_item, …); money arrives as a moneyValue or as
// text, and line items nest under `properties`.
export interface DocAiMoney {
  units?: string
  nanos?: number
  currencyCode?: string
}
export interface DocAiEntity {
  type?: string
  mentionText?: string
  normalizedValue?: { text?: string; moneyValue?: DocAiMoney }
  properties?: DocAiEntity[]
}
export interface DocAiInvoiceDocument {
  text?: string
  entities?: DocAiEntity[]
}

async function metadata(path: string, timeoutMs = 1500): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${METADATA_BASE}/${path}`, { headers: METADATA_HEADERS, signal: ctrl.signal })
    if (!res.ok) throw new Error(`metadata ${path} -> ${res.status}`)
    return (await res.text()).trim()
  } finally {
    clearTimeout(timer)
  }
}

let tokenCache: { token: string; expiresAt: number } | null = null
async function getAccessToken(): Promise<string> {
  const override = process.env.GCP_ACCESS_TOKEN
  if (override) return override
  const now = Date.now()
  if (tokenCache && tokenCache.expiresAt > now + 60_000) return tokenCache.token
  const raw = await metadata('instance/service-accounts/default/token')
  const json = JSON.parse(raw) as { access_token?: string; expires_in?: number }
  if (!json.access_token) throw new Error('metadata token response had no access_token')
  tokenCache = { token: json.access_token, expiresAt: now + (json.expires_in ?? 3600) * 1000 }
  return json.access_token
}

let projectCache: string | null = null
async function getProjectId(): Promise<string> {
  const fromEnv = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT
  if (fromEnv) return fromEnv
  if (projectCache) return projectCache
  projectCache = await metadata('project/project-id')
  return projectCache
}

export const DOCAI_LOCATION = process.env.DOCAI_LOCATION ?? 'us'
export const DOCAI_INVOICE_PROCESSOR_ID = (process.env.DOCAI_INVOICE_PROCESSOR_ID ?? '').trim()
// A plain "Document OCR" processor (the one bt-auth-service's document scans use) is enough on
// its own: it returns the page text, and invoice-text.ts reads the fields off that. The Invoice
// Parser adds typed entities on top when it is configured; both may be set.
export const DOCAI_OCR_PROCESSOR_ID = (process.env.DOCAI_OCR_PROCESSOR_ID ?? '').trim()

/** Configured == an Invoice Parser OR a Document OCR processor id is set. Project + token resolve at call time. */
export function invoiceOcrConfigured(): boolean {
  return DOCAI_INVOICE_PROCESSOR_ID.length > 0 || DOCAI_OCR_PROCESSOR_ID.length > 0
}

/** Whether the response will carry Invoice-Parser entities (else text only). */
export function invoiceParserConfigured(): boolean {
  return DOCAI_INVOICE_PROCESSOR_ID.length > 0
}

/** Run one invoice document through Document AI and return its `document` (entities to parse). */
export async function processInvoiceDocument(bytes: Buffer, mimeType: string): Promise<DocAiInvoiceDocument> {
  if (!invoiceOcrConfigured()) {
    throw new BookingError(
      'Invoice OCR is not enabled on this deployment (set DOCAI_INVOICE_PROCESSOR_ID or DOCAI_OCR_PROCESSOR_ID). Enter the invoice fields by hand.',
      'UPSTREAM_ERROR',
      501,
    )
  }

  let token: string
  let project: string
  try {
    ;[token, project] = await Promise.all([getAccessToken(), getProjectId()])
  } catch (e) {
    throw new BookingError(
      `Could not obtain Google credentials for OCR (${(e as Error).message}). The service account needs the Document AI User role.`,
      'UPSTREAM_ERROR',
      502,
    )
  }

  const processor = DOCAI_INVOICE_PROCESSOR_ID || DOCAI_OCR_PROCESSOR_ID
  const url =
    `https://${DOCAI_LOCATION}-documentai.googleapis.com/v1/projects/${project}` +
    `/locations/${DOCAI_LOCATION}/processors/${processor}:process`

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawDocument: { content: bytes.toString('base64'), mimeType }, skipHumanReview: true }),
    })
  } catch (e) {
    throw new BookingError(`Document AI unreachable: ${(e as Error).message}`, 'UPSTREAM_ERROR', 502)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    if (res.status === 403) {
      throw new BookingError(
        'Document AI denied the request — enable the Document AI API and grant the service account the Document AI User role.',
        'UPSTREAM_ERROR',
        502,
      )
    }
    throw new BookingError(`Document AI error ${res.status}: ${text.slice(0, 300)}`, 'UPSTREAM_ERROR', 502)
  }

  const json = (await res.json()) as { document?: DocAiInvoiceDocument }
  if (!json.document) throw new BookingError('Document AI returned no document to read.', 'UPSTREAM_ERROR', 502)
  return json.document
}
