// PAN verification — one provider call, a name-match guard, and a cross-account dedup on the PAN hash.

import { hashForLookup } from '../../../lib/encryption.js'
import { checkDuplicatePAN, fuzzyNameMatch } from '../fraud.js'
import { failed, manualReview, success, type Verifier } from '../verify.js'

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/

export const verifyPan: Verifier = async (request, ctx) => {
  const pan = String(request.metadata.pan_number ?? '').trim().toUpperCase()
  if (!PAN_RE.test(pan)) return { result: failed('pan_number must be a valid 10-character PAN') }

  const name = String(request.metadata.name ?? '').trim()
  // Accepts ISO (yyyy-mm-dd) or DD/MM/YYYY; the provider wants DD/MM/YYYY.
  const dobRaw = String(request.metadata.dob ?? request.metadata.date_of_birth ?? '').trim()
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dobRaw)
  const dob = iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : dobRaw || undefined
  const outcome = await ctx.provider.verifyPan({ pan, name: name || undefined, dob })
  if (outcome.unavailable) return { result: manualReview(outcome.reason ?? 'no KYC provider configured') }
  if (!outcome.verified) return { result: failed(outcome.reason ?? 'PAN could not be verified') }

  if (name && outcome.name && !fuzzyNameMatch(name, outcome.name)) {
    return { result: failed('The name does not match the PAN record') }
  }

  // Store only a one-way hash (dedup) — never the number.
  const hash = hashForLookup(pan)
  if (await checkDuplicatePAN(ctx.supabase, hash, request.user_id)) {
    return { result: failed('This PAN is already linked to another account') }
  }

  return { result: success(outcome.reference_id ?? ''), keys: { pan_hash: hash } }
}
