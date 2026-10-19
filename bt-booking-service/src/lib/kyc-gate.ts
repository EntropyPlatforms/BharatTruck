// -----------------------------------------------------------
// kyc-gate — PAN is mandatory (product decision, 2026-10-15): a person posts a load or bids
// on one only once their PAN has been VERIFIED (bt-auth-service /kyc/verify/pan, which checks
// the number, the name and the date of birth against the PAN record and writes the result to
// user_kyc). This is the one place that rule lives for the booking service.
//
// It reads the same user_kyc row the KYC service writes — status 'success' under
// verifications.pan — and refuses with code PAN_REQUIRED, which the app turns into a link to
// Settings → PAN. The gate is on unless PAN_GATE=off (tests and the scenario simulation run
// with it off: they exercise the booking flow, not the KYC vendor).
//
// This deliberately overrides D-31 ("KYC never gates") for PAN alone, by instruction.
// -----------------------------------------------------------

import { supabase } from './supabase.js'
import { BookingError, type BookingErrorCode } from './types.js'

export const panGateEnabled = () => (process.env.PAN_GATE ?? 'on').trim().toLowerCase() !== 'off'

export async function assertPanVerified(userId: string, action: 'post a load' | 'bid on a load'): Promise<void> {
  if (!panGateEnabled()) return
  const { data, error } = await supabase.from('user_kyc').select('verifications').eq('user_id', userId).maybeSingle()
  if (error) {
    // A database that predates migration 0038 cannot hold a verification at all; refusing
    // everyone would stop the platform, so the gate stands down and says so in the log.
    const code = (error as { code?: string }).code
    if (code === '42P01' || code === 'PGRST205') return
    throw new Error(`user_kyc read failed: ${error.message}`)
  }
  const pan = (data as { verifications?: Record<string, { status?: string }> } | null)?.verifications?.pan
  if (pan?.status === 'success') return
  throw new BookingError(
    `Verify your PAN before you ${action} — Settings → PAN. It takes a minute: enter the PAN, the name on the card and your date of birth (or scan the card).`,
    // The code list lives in @bharattruck/shared/errors; adding there means rebuilding the shared
    // dist and redeploying every consumer. The wire format is a string either way, and the app
    // keys on it by name, so the new code is asserted here and added to shared with the next
    // shared change.
    'PAN_REQUIRED' as BookingErrorCode,
    403,
  )
}
