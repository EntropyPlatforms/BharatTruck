// ============================================================
// src/lib/pod/storage.ts
//
// Responsibility: the seam between POD metadata and the object store that holds the
// original photo bytes. The driver's app now sends the bytes THROUGH this service (the
// same base64-in-JSON path the OCR endpoints use), so this service uploads them to a
// PRIVATE Supabase Storage bucket and records where they landed, re-hashing the bytes on
// arrival to fill sha256_received.
//
// ── STORAGE CHOICE: Supabase Storage (pilot), WORM later ────────────────────
// The compliance spec (INDIA_FREIGHT_COMPLIANCE.md §5.4 server-side) wants the original
// bytes in "WORM / object-lock, versioned, deletion disabled for the retention period."
// Supabase Storage does NOT give first-class object-lock — a service-role key can
// overwrite or delete an object — so it is not the final home for evidentiary bytes.
// For the pilot it IS the right first step: the fleet-owner dashboard has to SHOW the
// photos to verify them, which needs them retained and retrievable NOW, and Supabase
// Storage is already the app's object store (kyc_documents, message attachments). The
// object-lock/WORM hardening (a GCS bucket with a locked retention policy) is a later
// migration that only changes THIS file — the schema, the capture flow and the dashboard
// do not move.
//
// §5.4 rule 3 (never re-encode the original, IT Act s.7(b)) is honoured: the bytes are
// uploaded exactly as received (no image processing), the key is content-addressed by the
// device SHA-256, and sha256_received is the server's independent hash of the arrived
// bytes so a later verifier can assert byte-identity against sha256_original.
// ============================================================

import { createHash } from 'node:crypto'
import { supabase } from '../supabase.js'

export type EvidenceStorageInput = {
  bookingId: string
  evidenceId: string
  sha256Original: string
  contentType?: string | null
}

export type EvidenceStorageResult = {
  // 'stored' once bytes are uploaded; 'no_op' when the bucket is unset or no bytes were
  // sent (metadata-only capture); 'failed' when an upload errored. Mirrors
  // pod_evidence.storage_status so the row records the truth, not an assumption.
  status: 'stored' | 'no_op' | 'failed'
  originalBytesUri: string | null
  // The server's own SHA-256 of the arrived bytes (null when nothing was uploaded). Stored
  // as sha256_received; a verifier compares it to sha256_original for byte-identity.
  sha256Received: string | null
}

type Logger = { warn(obj: unknown, msg: string): void }

// The one env var that flips this live. Absent (the default on an unprovisioned
// environment) → inert: metadata is recorded, bytes are not retained. Set to the private
// bucket name (e.g. `pod-evidence`) → uploads. Same kill-switch shape 0025 used.
const BUCKET_ENV = 'POD_EVIDENCE_BUCKET'

function bucketName(): string | null {
  const b = process.env[BUCKET_ENV]?.trim()
  return b ? b : null
}

// Object key layout: partitioned by booking (so a legal hold can be applied per trip) and
// named by the content hash (content-addressable — the same bytes never fork into two
// objects, so a retry is a no-op). `.bin` because we never assume — nor re-encode to — a
// specific image format.
function objectKey(bookingId: string, sha256: string): string {
  return `pod/${bookingId}/${sha256}.bin`
}

export interface EvidenceStorage {
  store(input: EvidenceStorageInput, bytes: Buffer | null, log?: Logger): Promise<EvidenceStorageResult>
}

// The production/inert seam. ONE implementation: the difference between inert and live is a
// bucket name in the environment, not a second class to keep in sync (the shape D-14 used).
export class SupabaseEvidenceStorage implements EvidenceStorage {
  async store(input: EvidenceStorageInput, bytes: Buffer | null, log?: Logger): Promise<EvidenceStorageResult> {
    const bucket = bucketName()
    const key = objectKey(input.bookingId, input.sha256Original)

    if (!bucket || !bytes || bytes.length === 0) {
      // INERT (bucket unset) or metadata-only (no bytes). The evidence row still exists and
      // is real; the bytes simply have nowhere to live yet. Warn only when bytes were sent
      // but could not be stored — a metadata-only capture is a legitimate no_op, not a fault.
      if (!bucket && bytes && bytes.length > 0) {
        log?.warn(
          { booking_id: input.bookingId, evidence_id: input.evidenceId, expected_key: key },
          `POD evidence storage is inert (${BUCKET_ENV} unset) — metadata recorded, original bytes NOT retained`,
        )
      }
      return { status: 'no_op', originalBytesUri: null, sha256Received: null }
    }

    // The server's independent hash of the arrived bytes → sha256_received (§5.4 verification).
    const received = createHash('sha256').update(bytes).digest('hex')

    const { error } = await supabase.storage
      .from(bucket)
      .upload(key, bytes, { contentType: input.contentType ?? 'application/octet-stream', upsert: false })

    if (error) {
      // A content-addressed retry hits the SAME key — "already exists" is the idempotency
      // signal, not a failure: the identical bytes are already stored.
      const msg = (error as { message?: string }).message?.toLowerCase() ?? ''
      const already = msg.includes('exist') || msg.includes('duplicate') ||
        (error as { statusCode?: string }).statusCode === '409'
      if (already) {
        return { status: 'stored', originalBytesUri: `supabase://${bucket}/${key}`, sha256Received: received }
      }
      log?.warn(
        { err: error, booking_id: input.bookingId, evidence_id: input.evidenceId },
        'POD evidence upload failed — metadata recorded, original bytes NOT retained',
      )
      return { status: 'failed', originalBytesUri: null, sha256Received: received }
    }

    return { status: 'stored', originalBytesUri: `supabase://${bucket}/${key}`, sha256Received: received }
  }
}

export function defaultEvidenceStorage(): EvidenceStorage {
  return new SupabaseEvidenceStorage()
}

// signedEvidenceUrl — a short-lived, private view of a stored POD photo for the dashboard.
// Parses the `supabase://<bucket>/<key>` handle stored on the row and mints a time-limited
// signed URL. Returns null for an unstored row (inert/no_op) or an unrecognised handle, so a
// caller renders "no image retained" rather than a broken link. Never throws.
export async function signedEvidenceUrl(
  originalBytesUri: string | null,
  ttlSeconds = 300,
): Promise<string | null> {
  if (!originalBytesUri) return null
  const m = /^supabase:\/\/([^/]+)\/(.+)$/.exec(originalBytesUri)
  if (!m) return null
  const [, bucket, key] = m
  try {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(key, ttlSeconds)
    if (error || !data?.signedUrl) return null
    return data.signedUrl
  } catch {
    return null
  }
}
