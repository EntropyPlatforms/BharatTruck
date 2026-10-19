// Aadhaar eKYC — two-step OTP via the provider seam. Stateless across the two calls: step 1 returns
// a reference_id the CLIENT sends back in step 2, so there is no server-side OTP session to store.
//
// The full Aadhaar number is NEVER stored: on success we keep only a one-way hash (for cross-account
// dedup) and the last 4 digits. The client re-supplies the number at step 2 so the hash can be
// computed without ever having persisted it.
//
// Real Aadhaar OTP eKYC needs an AUA/KUA licence — that is the provider's concern; a DigiLocker or
// offline-XML flow can be slotted in as another KycProvider without touching this file.

import { hashForLookup } from '../../../lib/encryption.js'
import { checkDuplicateAadhaar } from '../fraud.js'
import { failed, manualReview, pending, success, type Verifier } from '../verify.js'

const AADHAAR_RE = /^\d{12}$/

export const verifyAadhaar: Verifier = async (request, ctx) => {
  const otp = request.metadata.otp ? String(request.metadata.otp).trim() : ''

  // ── Step 2: submit the OTP (present ⇒ this is the verify call) ──
  if (otp) {
    const referenceId = String(request.metadata.reference_id ?? '').trim()
    if (!referenceId) return { result: failed('reference_id from the OTP step is required to submit the OTP') }

    const outcome = await ctx.provider.aadhaarSubmitOtp({ reference_id: referenceId, otp })
    if (outcome.unavailable) return { result: manualReview(outcome.reason ?? 'no KYC provider configured') }
    if (!outcome.verified) return { result: failed(outcome.reason ?? 'The OTP could not be verified') }

    const aadhaar = String(request.metadata.aadhaar_number ?? '').trim()
    if (AADHAAR_RE.test(aadhaar)) {
      const hash = hashForLookup(aadhaar)
      if (await checkDuplicateAadhaar(ctx.supabase, hash, request.user_id)) {
        return { result: failed('This Aadhaar is already linked to another account') }
      }
      return { result: success(outcome.reference_id ?? referenceId), keys: { aadhaar_hash: hash, aadhaar_last4: aadhaar.slice(-4) } }
    }
    return { result: success(outcome.reference_id ?? referenceId) }
  }

  // ── Step 1: initiate — OTP to the registered mobile ──
  const aadhaar = String(request.metadata.aadhaar_number ?? '').trim()
  if (!AADHAAR_RE.test(aadhaar)) return { result: failed('aadhaar_number must be 12 digits') }

  const outcome = await ctx.provider.aadhaarGenerateOtp({ aadhaar })
  if (outcome.unavailable) return { result: manualReview(outcome.reason ?? 'no KYC provider configured') }
  if (!outcome.verified && !outcome.reference_id) return { result: failed(outcome.reason ?? 'Could not send an Aadhaar OTP') }

  return { result: pending(outcome.reference_id ?? '', 'OTP sent to the Aadhaar-registered mobile — resubmit with { otp, reference_id, aadhaar_number } to complete') }
}
