// GSTIN verification — one provider call, with an optional name-match against the legal/trade name.

import { fuzzyNameMatch } from '../fraud.js'
import { failed, manualReview, success, type Verifier } from '../verify.js'

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/

export const verifyGst: Verifier = async (request, ctx) => {
  const gstin = String(request.metadata.gstin ?? '').trim().toUpperCase()
  if (!GSTIN_RE.test(gstin)) return { result: failed('gstin must be a valid 15-character GSTIN') }

  const outcome = await ctx.provider.verifyGstin({ gstin })
  if (outcome.unavailable) return { result: manualReview(outcome.reason ?? 'no KYC provider configured') }
  if (!outcome.verified) return { result: failed(outcome.reason ?? 'GSTIN could not be verified') }

  const name = String(request.metadata.name ?? request.metadata.legal_name ?? '').trim()
  if (name && outcome.name && !fuzzyNameMatch(name, outcome.name)) {
    return { result: failed('The name does not match the GSTIN record') }
  }
  return { result: success(outcome.reference_id ?? '') }
}
