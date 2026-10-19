// Shared plumbing for the individual verification modules: the context they receive (the Supabase
// client + the resolved KYC provider), the result-and-keys they return, and the small builders that
// turn a provider VerificationOutcome into a KYCResult. Keeping these here makes each verifier a thin,
// readable mapping and keeps persistence in ONE place (the route).

import type { SupabaseClient } from '@supabase/supabase-js'
import type { KycProvider, VerificationOutcome } from './provider.js'
import type { VerificationKeys } from './repository.js'
import { KYCLevel, KYCStatus, type KYCRequest, type KYCResult } from './types.js'

export type VerifierContext = { supabase: SupabaseClient; provider: KycProvider }

/** A verifier returns the result to store/return, plus any dedup keys it produced (aadhaar/pan). */
export type VerifierOutput = { result: KYCResult; keys?: VerificationKeys }

export type Verifier = (request: KYCRequest, ctx: VerifierContext) => Promise<VerifierOutput>

// kyc_level on a per-verification KYCResult is not the user's overall level — that is derived from
// the whole record (repository.deriveLevel). It is left L0 here and ignored on read.
export function failed(error: string): KYCResult {
  return { status: KYCStatus.Failed, kyc_level: KYCLevel.L0, provider_ref: '', raw_response: null, verified_at: null, error }
}

export function manualReview(reason: string): KYCResult {
  return { status: KYCStatus.ManualReview, kyc_level: KYCLevel.L0, provider_ref: '', raw_response: null, verified_at: null, error: reason }
}

export function pending(providerRef: string, reason?: string): KYCResult {
  return { status: KYCStatus.Pending, kyc_level: KYCLevel.L0, provider_ref: providerRef, raw_response: null, verified_at: null, error: reason }
}

export function success(providerRef: string): KYCResult {
  // raw_response deliberately null: the provider response carries name/dob/address/masked-number PII,
  // and only the status + reference key are persisted.
  return { status: KYCStatus.Success, kyc_level: KYCLevel.L0, provider_ref: providerRef, raw_response: null, verified_at: new Date() }
}

/** Map a single-step outcome to a result, with an optional name-match guard already applied upstream. */
export function fromOutcome(outcome: VerificationOutcome, failReason = 'verification failed'): KYCResult {
  if (outcome.unavailable) return manualReview(outcome.reason ?? 'no KYC provider configured — recorded for manual review')
  if (!outcome.verified) return failed(outcome.reason ?? failReason)
  return success(outcome.reference_id ?? '')
}
