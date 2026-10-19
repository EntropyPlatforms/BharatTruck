// Driving-licence verification — one provider call (DL number + DOB), optional name-match.
// DL number formats vary widely by state, so validation is intentionally light (non-empty); the
// provider is the real check.

import { fuzzyNameMatch } from '../fraud.js'
import { failed, manualReview, success, type Verifier } from '../verify.js'

export const verifyDl: Verifier = async (request, ctx) => {
  const dl = String(request.metadata.dl_number ?? '').trim().toUpperCase()
  const dob = request.metadata.dob ? String(request.metadata.dob).trim() : undefined
  if (dl.length < 6) return { result: failed('dl_number is required') }

  const outcome = await ctx.provider.verifyDl({ dl_number: dl, dob })
  if (outcome.unavailable) return { result: manualReview(outcome.reason ?? 'no KYC provider configured') }
  if (!outcome.verified) return { result: failed(outcome.reason ?? 'Driving licence could not be verified') }

  const name = String(request.metadata.name ?? '').trim()
  if (name && outcome.name && !fuzzyNameMatch(name, outcome.name)) {
    return { result: failed('The name does not match the driving-licence record') }
  }
  return { result: success(outcome.reference_id ?? '') }
}
