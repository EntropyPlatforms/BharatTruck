// All Supabase reads/writes for the user_kyc table (migration 0038) — merge results, derive level.
//
// Read-modify-write rather than a raw jsonb `||` merge: supabase-js cannot express the SQL operator,
// and KYC verifications are user-driven and low-concurrency, so reading the row, merging in JS, and
// writing it back is correct and far simpler. What is stored per document is a LEAN, PII-free result
// (status + provider_ref + verified_at) — never the raw provider response, and never a full ID
// number. The dedup hashes and the last-4 live in their own columns.

import type { SupabaseClient } from '@supabase/supabase-js'
import { KYCLevel, KYCStatus, type KYCRecord, type KYCResult } from './types.js'

const TABLE = 'user_kyc'
const RECORD_COLUMNS = 'id, user_id, role, kyc_level, verifications, created_at, updated_at'

/** What we persist per document — deliberately PII-free (no raw response, no full number). */
export type StoredVerification = {
  status: KYCStatus
  provider_ref: string
  verified_at: string | null
  error?: string
}

/** Optional dedup keys / masks a verification contributes to the top-level columns. */
export type VerificationKeys = {
  aadhaar_hash?: string
  aadhaar_last4?: string
  pan_hash?: string
}

type StoredVerifications = Record<string, StoredVerification>

export async function getKYCRecord(supabase: SupabaseClient, userId: string): Promise<KYCRecord | null> {
  const { data, error } = await supabase.from(TABLE).select(RECORD_COLUMNS).eq('user_id', userId).maybeSingle()
  if (error) throw new Error(`user_kyc select failed: ${error.message}`)
  return (data as unknown as KYCRecord | null) ?? null
}

// deriveLevel — PURE. The BharatTruck level ladder (types.ts): L1 = phone+email, L2 = +aadhaar+pan,
// L3 = +(dl|rc|gst)+face_match+bank. A gap at any rung stops the climb, so a user with L3 documents
// but no email is still L0 — the ladder is cumulative on purpose.
export function deriveLevel(verifications: Record<string, { status?: string } | undefined>): KYCLevel {
  const ok = (t: string) => verifications[t]?.status === KYCStatus.Success
  if (!(ok('phone') && ok('email'))) return KYCLevel.L0
  if (!(ok('aadhaar') && ok('pan'))) return KYCLevel.L1
  if (!((ok('dl') || ok('rc') || ok('gst')) && ok('face_match') && ok('bank'))) return KYCLevel.L2
  return KYCLevel.L3
}

/**
 * Merge one verification into the user's record and return the recomputed level. Persists a lean,
 * PII-free result plus any dedup keys the verification produced.
 */
export async function upsertVerification(
  supabase: SupabaseClient,
  userId: string,
  role: string,
  type: string,
  result: KYCResult,
  keys: VerificationKeys = {},
): Promise<KYCLevel> {
  const existing = await getKYCRecord(supabase, userId)
  const verifications: StoredVerifications = { ...((existing?.verifications as unknown as StoredVerifications) ?? {}) }
  verifications[type] = {
    status: result.status,
    provider_ref: result.provider_ref,
    verified_at: result.verified_at ? new Date(result.verified_at).toISOString() : null,
    ...(result.error ? { error: result.error } : {}),
  }

  const kyc_level = deriveLevel(verifications)
  const nowIso = new Date().toISOString()

  const { error } = await supabase.from(TABLE).upsert({
    user_id: userId,
    role,
    kyc_level,
    verifications,
    // Only set a key column when this verification produced it (never blank an existing one).
    ...(keys.aadhaar_hash !== undefined ? { aadhaar_hash: keys.aadhaar_hash } : {}),
    ...(keys.aadhaar_last4 !== undefined ? { aadhaar_last4: keys.aadhaar_last4 } : {}),
    ...(keys.pan_hash !== undefined ? { pan_hash: keys.pan_hash } : {}),
    updated_at: nowIso,
  }, { onConflict: 'user_id' })
  if (error) throw new Error(`user_kyc upsert failed: ${error.message}`)
  return kyc_level
}

export async function getCurrentLevel(supabase: SupabaseClient, userId: string): Promise<KYCLevel> {
  const record = await getKYCRecord(supabase, userId)
  if (!record) return KYCLevel.L0
  // Trust the stored level (upsert keeps it current), but fall back to deriving from the JSONB.
  return (record.kyc_level as KYCLevel) ?? deriveLevel(record.verifications as unknown as Record<string, { status?: string }>)
}
