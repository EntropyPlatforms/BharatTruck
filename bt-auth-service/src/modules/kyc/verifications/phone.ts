// Phone verification for KYC — reflects the account's phone number, which the signup OTP flow
// already verified (there is no separate phone_verified column). No number on file ⇒ nothing to
// verify. KYC does not run its own phone OTP; that lives in the auth signup flow (the SMS seam).

import { failed, success, type Verifier } from '../verify.js'

export const verifyPhone: Verifier = async (request, ctx) => {
  const { data, error } = await ctx.supabase
    .from('users').select('phone_number').eq('id', request.user_id).maybeSingle()
  if (error) throw new Error(`users select failed: ${error.message}`)
  const phone = (data as { phone_number?: string | null } | null)?.phone_number
  return { result: phone ? success('phone_on_file') : failed('No verified phone number on this account') }
}
