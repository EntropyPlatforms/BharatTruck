// -----------------------------------------------------------
// document-ai — the network + auth half of Document AI OCR (the pure parsing is in
// docai-table.ts). Runs one uploaded document through the configured processor and returns the
// extracted table as CSV.
//
// AUTH: no new dependency and no key. On Cloud Run the service account's access token comes from
// the instance metadata server; the SA needs the "Document AI User" role and the Document AI API
// enabled (both are the operator's one-time GCP step, documented in .env.example / README).
// A GCP_ACCESS_TOKEN env is honoured as a local/dev escape hatch (`gcloud auth print-access-token`).
//
// This is the same "provider seam, activate with config" shape as the KYC and geocoding work:
// with no processor configured it is inert (501), so the CSV path is unaffected.
// -----------------------------------------------------------

import { FleetError } from '../types.js'
import { extractTableCsv, type DocAiDocument } from './docai-table.js'

const METADATA_BASE = 'http://metadata.google.internal/computeMetadata/v1'
const METADATA_HEADERS = { 'Metadata-Flavor': 'Google' }

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

// The metadata token is valid ~1h; cache it until a minute before expiry.
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
export const DOCAI_PROCESSOR_ID = (process.env.DOCAI_PROCESSOR_ID ?? '').trim()

/** Configured == a processor id is set. Project + token resolve at call time via metadata. */
export function documentAiConfigured(): boolean {
  return DOCAI_PROCESSOR_ID.length > 0
}

/**
 * Run one document through the configured Document AI processor and return the extracted table
 * as CSV (fed downstream into the existing importVehiclesCsv validator). All failures come back
 * as FleetError with an operator-actionable message.
 */
export async function documentAiExtractCsv(bytes: Buffer, mimeType: string): Promise<string> {
  if (!documentAiConfigured()) {
    throw new FleetError(
      'Document AI is not configured on this deployment (set DOCAI_PROCESSOR_ID). Upload a CSV instead.',
      'NOT_IMPLEMENTED',
      501,
    )
  }

  let token: string
  let project: string
  try {
    ;[token, project] = await Promise.all([getAccessToken(), getProjectId()])
  } catch (e) {
    throw new FleetError(
      `Could not obtain Google credentials for OCR (${(e as Error).message}). The service account needs the Document AI User role.`,
      'MISCONFIGURED',
      500,
    )
  }

  const url =
    `https://${DOCAI_LOCATION}-documentai.googleapis.com/v1/projects/${project}` +
    `/locations/${DOCAI_LOCATION}/processors/${DOCAI_PROCESSOR_ID}:process`

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // rawDocument sends the bytes inline; fine for the single-file, <=20 MB sync path.
        rawDocument: { content: bytes.toString('base64'), mimeType },
        skipHumanReview: true,
      }),
    })
  } catch (e) {
    throw new FleetError(`Document AI unreachable: ${(e as Error).message}`, 'INTERNAL_ERROR', 502)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    if (res.status === 403) {
      throw new FleetError(
        'Document AI denied the request — enable the Document AI API and grant the service account the Document AI User role.',
        'MISCONFIGURED',
        500,
      )
    }
    throw new FleetError(`Document AI error ${res.status}: ${text.slice(0, 300)}`, 'INTERNAL_ERROR', 502)
  }

  const json = (await res.json()) as { document?: DocAiDocument }
  if (!json.document) throw new FleetError('Document AI returned no document to read.', 'INTERNAL_ERROR', 502)
  return extractTableCsv(json.document)
}
