// Email verification for KYC — reflects the account's own email_verified flag (set by the signup
// OTP flow). KYC does not re-send its own email; it reads the state the auth flow already established.

import { failed, success, type Verifier } from '../verify.js'

export const verifyEmail: Verifier = async (request, ctx) => {
  const { data, error } = await ctx.supabase
    .from('users').select('email_verified').eq('id', request.user_id).maybeSingle()
  if (error) throw new Error(`users select failed: ${error.message}`)
  const verified = (data as { email_verified?: boolean } | null)?.email_verified === true
  return { result: verified ? success('email_verified') : failed('Email is not verified — confirm it from your profile first') }
}
