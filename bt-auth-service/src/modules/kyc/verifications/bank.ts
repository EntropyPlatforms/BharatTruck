// Bank-account verification via penny-drop, with an account-holder name-match.
//
// In production, prefer routing this to Razorpay or Cashfree — they already run penny-drop and one
// is likely already in the payments plan, so it need not be a separate KYC vendor. The seam accepts
// whichever KycProvider is configured; nothing here assumes Surepass.

import { fuzzyNameMatch } from '../fraud.js'
import { failed, manualReview, success, type Verifier } from '../verify.js'

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/
const ACCOUNT_RE = /^\d{9,18}$/

export const verifyBank: Verifier = async (request, ctx) => {
  const account = String(request.metadata.account_number ?? '').trim()
  const ifsc = String(request.metadata.ifsc ?? '').trim().toUpperCase()
  if (!ACCOUNT_RE.test(account)) return { result: failed('account_number must be 9–18 digits') }
  if (!IFSC_RE.test(ifsc)) return { result: failed('ifsc must be a valid 11-character IFSC') }

  const outcome = await ctx.provider.verifyBank({ account_number: account, ifsc })
  if (outcome.unavailable) return { result: manualReview(outcome.reason ?? 'no KYC provider configured') }
  if (!outcome.verified) return { result: failed(outcome.reason ?? 'Bank account could not be verified (penny-drop failed)') }

  const name = String(request.metadata.name ?? '').trim()
  if (name && outcome.name && !fuzzyNameMatch(name, outcome.name)) {
    return { result: failed('The account-holder name does not match') }
  }
  return { result: success(outcome.reference_id ?? '') }
}
