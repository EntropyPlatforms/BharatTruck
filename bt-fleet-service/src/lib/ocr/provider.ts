// -----------------------------------------------------------
// The document-OCR seam. One interface, a swappable implementation, exactly like the KYC
// provider seam — so the OCR vendor is a config change, never a code rewrite. Today's real
// implementation is Google Document AI; the default is inert (501) so a deployment with no OCR
// configured behaves exactly as before (CSV-only, honest "not enabled" for scans).
//
// Every provider returns CSV text, which flows into the existing importVehiclesCsv validator —
// so OCR is an input format, not a second unvalidated write path.
// -----------------------------------------------------------

import { FleetError } from '../types.js'
import { documentAiConfigured, documentAiExtractCsv } from './document-ai.js'

export interface DocumentOcrProvider {
  readonly name: string
  readonly configured: boolean
  /** Extract the register table from a PDF/image as CSV text (header row + one line per truck). */
  extractCsv(bytes: Buffer, mimeType: string): Promise<string>
}

/** Default: OCR off. Same answer the service gave before OCR existed, via the same seam. */
class UnavailableOcrProvider implements DocumentOcrProvider {
  readonly name = 'none'
  readonly configured = false
  async extractCsv(): Promise<string> {
    throw new FleetError(
      'OCR is not enabled on this deployment. Export your register to CSV and upload that instead.',
      'NOT_IMPLEMENTED',
      501,
    )
  }
}

class DocumentAiProvider implements DocumentOcrProvider {
  readonly name = 'document_ai'
  get configured(): boolean {
    return documentAiConfigured()
  }
  extractCsv(bytes: Buffer, mimeType: string): Promise<string> {
    return documentAiExtractCsv(bytes, mimeType)
  }
}

let cached: DocumentOcrProvider | null = null

export function resolveOcrProvider(): DocumentOcrProvider {
  const choice = (process.env.OCR_PROVIDER ?? '').trim().toLowerCase()
  if (choice === 'document_ai' || choice === 'documentai') return new DocumentAiProvider()
  // Convenience: a bare DOCAI_PROCESSOR_ID (no OCR_PROVIDER) also activates Document AI, so the
  // operator only has to set one thing. Anything else — including OCR_PROVIDER unset — is inert.
  if (!choice && documentAiConfigured()) return new DocumentAiProvider()
  return new UnavailableOcrProvider()
}

export function getOcrProvider(): DocumentOcrProvider {
  if (!cached) cached = resolveOcrProvider()
  return cached
}
