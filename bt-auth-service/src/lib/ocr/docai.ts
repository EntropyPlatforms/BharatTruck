// -----------------------------------------------------------
// Document AI call core for DRIVER-DOCUMENT OCR (the pure text->fields parsing is in
// driver-docs.ts). Runs a photographed driving licence / cheque / passbook through the configured
// Document AI *Document OCR* processor and returns the plain text it read.
//
// AUTH: no key, no new dependency — on Cloud Run the service account's token comes from the
// instance metadata server; the SA needs the "Document AI User" role and the Document AI API
// enabled (the operator's one-time GCP step, see .env.example). GCP_ACCESS_TOKEN is honoured as a
// local/dev escape hatch (`gcloud auth print-access-token`).
//
// DELIBERATE DUPLICATION (to consolidate later): this mirrors bt-booking-service/src/lib/documents/
// docai.ts and bt-fleet-service/src/lib/ocr/document-ai.ts, for the reason given there — a shared
// change would rebuild and redeploy every shared consumer.
//
// Same "provider seam, activate with config" posture as KYC: with no processor configured this is
// inert, the app hides the scan buttons, and onboarding is typed by hand exactly as before.
// -----------------------------------------------------------

const METADATA_BASE = 'http://metadata.google.internal/computeMetadata/v1'
const METADATA_HEADERS = { 'Metadata-Flavor': 'Google' }

/** A failure with a message safe to show the driver and a status for the route to answer with. */
export class OcrError extends Error {
  constructor(message: string, public readonly httpStatus: number, public readonly code: string) {
    super(message)
    this.name = 'OcrError'
  }
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

// Read at call time, not at import: the route's `enabled` answer and the tests both depend on the
// environment as it is now.
const location = () => process.env.DOCAI_LOCATION ?? 'us'
const processorId = () => (process.env.DOCAI_OCR_PROCESSOR_ID ?? '').trim()

/** Configured == a Document OCR processor id is set. Project + token resolve at call time. */
export function driverOcrConfigured(): boolean {
  return processorId().length > 0
}

/** Read one photographed document and return the text on it. */
export async function readDocumentText(bytes: Buffer, mimeType: string): Promise<string> {
  if (!driverOcrConfigured()) {
    throw new OcrError('Document scanning is not switched on. Type the details in instead.', 501, 'OCR_NOT_CONFIGURED')
  }

  let token: string
  let project: string
  try {
    ;[token, project] = await Promise.all([getAccessToken(), getProjectId()])
  } catch (e) {
    throw new OcrError(
      `Could not obtain Google credentials for OCR (${(e as Error).message}). The service account needs the Document AI User role.`,
      502,
      'OCR_UPSTREAM',
    )
  }

  const url =
    `https://${location()}-documentai.googleapis.com/v1/projects/${project}` +
    `/locations/${location()}/processors/${processorId()}:process`

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawDocument: { content: bytes.toString('base64'), mimeType }, skipHumanReview: true }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (e) {
    throw new OcrError(`Document AI unreachable: ${(e as Error).message}`, 502, 'OCR_UPSTREAM')
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    if (res.status === 403) {
      throw new OcrError(
        'Document AI denied the request — enable the Document AI API and grant the service account the Document AI User role.',
        502,
        'OCR_UPSTREAM',
      )
    }
    throw new OcrError(`Document AI error ${res.status}: ${text.slice(0, 300)}`, 502, 'OCR_UPSTREAM')
  }

  const json = (await res.json()) as { document?: { text?: string } }
  return json.document?.text ?? ''
}
