// Vehicle RC (registration certificate) verification — one provider call (Surepass → Vahan).

import { failed, fromOutcome, manualReview, type Verifier } from '../verify.js'

export const verifyRc: Verifier = async (request, ctx) => {
  const rc = String(request.metadata.rc_number ?? '').trim().toUpperCase().replace(/[\s-]/g, '')
  if (rc.length < 6) return { result: failed('rc_number is required') }

  const outcome = await ctx.provider.verifyRc({ rc_number: rc })
  if (outcome.unavailable) return { result: manualReview(outcome.reason ?? 'no KYC provider configured') }
  return { result: fromOutcome(outcome, 'Vehicle RC could not be verified') }
}
