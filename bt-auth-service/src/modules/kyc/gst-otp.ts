// -----------------------------------------------------------
// gst-otp — prove a GSTIN is YOURS with the GST portal's own OTP, instead of API keys.
//
// The GST portal lets a taxpayer authorise an application by one-time password to the
// mobile / email registered against the GSTIN (after a one-time "Manage API Access → Enable"
// on gst.gov.in). Sandbox exposes that as the taxpayer-authentication pair:
//   POST /gst/compliance/tax-payer/otp                 { username, gstin }   → OTP sent
//   POST /gst/compliance/tax-payer/otp/verify?otp=…    { username, gstin }   → taxpayer session
// A session coming back means the person holding the registered mobile authorised us — the
// GSTIN is theirs. We record exactly that (user_kyc 'gst' = success, users.gstin = the GSTIN)
// and throw the session away: nothing here files returns or reads ledgers.
//
// Pure mapping functions are exported for tests; the transport is the shared SandboxClient.
// -----------------------------------------------------------

import { sandbox, SandboxClient, SandboxError, type SandboxResponse } from '../../lib/sandbox.js'

export class GstOtpError extends Error {
  constructor(message: string, public readonly httpStatus: number, public readonly code: string) {
    super(message)
    this.name = 'GstOtpError'
  }
}

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

function requireClient(client: SandboxClient) {
  if (!client.configured) throw new GstOtpError('GST portal OTP is not switched on (SANDBOX_API_KEY / SANDBOX_API_SECRET)', 503, 'NOT_CONFIGURED')
}

/** What the GST portal says when an OTP request is refused, in the taxpayer's words. */
export function otpFailureReason(res: SandboxResponse<Record<string, unknown>> | null, fallback: string): string {
  const d = (res?.data ?? {}) as Record<string, unknown>
  const err = (d.error as Record<string, unknown> | undefined) ?? {}
  const msg = [err.message, d.message, res?.message].find((m) => typeof m === 'string' && m.trim()) as string | undefined
  if (!msg) return fallback
  if (/not enabled|api access|AUTH4033|AUTH4034/i.test(msg)) {
    return 'API access is not enabled for this GSTIN on the GST portal. On gst.gov.in: View Profile → Manage API Access → Enable API Request: Yes (30 days), then try again.'
  }
  if (/invalid.*otp|otp.*invalid|AUTH4035|expired/i.test(msg)) return 'That OTP is wrong or has expired — request a new one.'
  if (/username|user name|AUTH4031/i.test(msg)) return 'The GST portal does not recognise that username for this GSTIN.'
  return msg.slice(0, 200)
}

export async function sendGstOtp(args: { gstin: string; username: string }, client: SandboxClient = sandbox): Promise<void> {
  requireClient(client)
  if (!GSTIN_RE.test(args.gstin)) throw new GstOtpError('Not a GSTIN', 400, 'VALIDATION_ERROR')
  let res: SandboxResponse<Record<string, unknown>>
  try {
    res = await client.post<Record<string, unknown>>('/gst/compliance/tax-payer/otp', { username: args.username, gstin: args.gstin })
  } catch (err) {
    throw new GstOtpError(err instanceof SandboxError && err.statusCode === 422 ? otpFailureReason(null, err.message) : 'The GST portal could not be reached right now', 502, 'UPSTREAM')
  }
  const d = (res.data ?? {}) as Record<string, unknown>
  const ok = String(d.status_cd ?? d.status ?? '1') !== '0'
  if (!ok) throw new GstOtpError(otpFailureReason(res, 'The GST portal did not send an OTP'), 422, 'GST_OTP_REFUSED')
}

export type GstOtpVerified = { verified: true; expires_at: string | null }

export async function verifyGstOtp(args: { gstin: string; username: string; otp: string }, client: SandboxClient = sandbox): Promise<GstOtpVerified> {
  requireClient(client)
  if (!/^\d{4,8}$/.test(args.otp)) throw new GstOtpError('Enter the OTP digits', 400, 'VALIDATION_ERROR')
  let res: SandboxResponse<Record<string, unknown>>
  try {
    res = await client.post<Record<string, unknown>>(`/gst/compliance/tax-payer/otp/verify?otp=${encodeURIComponent(args.otp)}`, { username: args.username, gstin: args.gstin })
  } catch (err) {
    throw new GstOtpError(err instanceof SandboxError && err.statusCode === 422 ? otpFailureReason(null, err.message) : 'The GST portal could not be reached right now', 502, 'UPSTREAM')
  }
  return readVerify(res)
}

/** Pure: a verify response → verified, or the portal's reason. A session token = the holder of the registered mobile said yes. */
export function readVerify(res: SandboxResponse<Record<string, unknown>>): GstOtpVerified {
  const d = (res.data ?? {}) as Record<string, unknown>
  const token = [d.access_token, d.taxpayer_access_token, d.token, (d.data as Record<string, unknown> | undefined)?.access_token].find((t) => typeof t === 'string' && t.length > 10)
  const refused = String(d.status_cd ?? d.status ?? '') === '0'
  if (!token || refused) throw new GstOtpError(otpFailureReason(res, 'The GST portal did not accept that OTP'), 422, 'GST_OTP_REFUSED')
  const exp = d.session_expiry ?? d.token_expiry ?? d.expiry
  const expires_at = typeof exp === 'number' ? new Date(exp > 1e12 ? exp : exp * 1000).toISOString() : typeof exp === 'string' ? exp : null
  return { verified: true, expires_at }
}
