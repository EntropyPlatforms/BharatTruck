// Fastify route plugin exposing the KYC HTTP endpoints — validates request schemas and delegates to
// the individual verification modules, which run through the provider seam (modules/kyc/provider.ts).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import { authenticate } from '../lib/authenticate.js'
import { getCurrentLevel, getKYCRecord, upsertVerification } from '../modules/kyc/repository.js'
import { getKycProvider } from '../modules/kyc/provider.js'
import { KYCStatus, UserRole, type KYCRequest } from '../modules/kyc/types.js'
import type { Verifier } from '../modules/kyc/verify.js'

// Verification handlers — each module is a thin mapping over the provider seam.
import { verifyPhone }     from '../modules/kyc/verifications/phone.js'
import { verifyEmail }     from '../modules/kyc/verifications/email.js'
import { verifyAadhaar }   from '../modules/kyc/verifications/aadhaar.js'
import { verifyPan }       from '../modules/kyc/verifications/pan.js'
import { verifyDl }        from '../modules/kyc/verifications/dl.js'
import { verifyRc }        from '../modules/kyc/verifications/rc.js'
import { verifyGst }       from '../modules/kyc/verifications/gst.js'
import { verifyFaceMatch } from '../modules/kyc/verifications/face-match.js'
import { verifyBank }      from '../modules/kyc/verifications/bank.js'
import { gstFilingSummary, GstPublicError, lookupGstin } from '../modules/kyc/gst-public.js'
import { GstOtpError, sendGstOtp, verifyGstOtp } from '../modules/kyc/gst-otp.js'
import { DigiLockerError, importSession, sessionStatus, startSession, type DigiLockerDocType } from '../modules/kyc/digilocker.js'
import { sandbox } from '../lib/sandbox.js'

const VERIFIERS: Record<string, Verifier> = {
  phone:      verifyPhone,
  email:      verifyEmail,
  aadhaar:    verifyAadhaar,
  pan:        verifyPan,
  dl:         verifyDl,
  rc:         verifyRc,
  gst:        verifyGst,
  face_match: verifyFaceMatch,
  bank:       verifyBank,
}

// ---------------------------------------------------------------------------
// Request / response schemas (JSON Schema — Fastify uses ajv under the hood)
// ---------------------------------------------------------------------------

const verifyBodySchema = {
  type: 'object',
  required: ['user_id', 'role', 'metadata'],
  properties: {
    user_id:  { type: 'string' },
    role:     { type: 'string', enum: Object.values(UserRole) },
    metadata: { type: 'object', additionalProperties: true },
  },
} as const

const verifyParamsSchema = {
  type: 'object',
  required: ['type'],
  properties: { type: { type: 'string', enum: Object.keys(VERIFIERS) } },
} as const

const statusParamsSchema = {
  type: 'object',
  required: ['userId'],
  properties: { userId: { type: 'string' } },
} as const

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

// HTTP status by verification outcome: a hard failure is 422 (the input was rejected), a
// manual_review (no provider wired / provider unavailable) is 202 (accepted, awaiting Ops), and a
// success or an in-flight pending (e.g. Aadhaar OTP sent) is 200. KYC never gates (D-5/D-31), so
// even a failure is data, not a blocked action.
function statusCodeFor(status: KYCStatus): number {
  if (status === KYCStatus.Failed) return 422
  if (status === KYCStatus.ManualReview) return 202
  return 200
}

async function handleVerify(
  this: FastifyInstance,
  request: FastifyRequest<{ Params: { type: string }; Body: KYCRequest }>,
  reply: FastifyReply,
): Promise<void> {
  const { type } = request.params
  const verifier = VERIFIERS[type]
  if (!verifier) {
    reply.code(400).send({ success: false, error: `Unknown verification type '${type}'`, code: 'VALIDATION_ERROR' })
    return
  }

  const body = request.body
  // A caller may only run KYC for THEMSELVES (admin excepted) — no verifying on another user's id.
  if (body.user_id !== request.user.userId && request.user.role !== 'admin') {
    reply.code(403).send({ success: false, error: 'Forbidden', code: 'FORBIDDEN' })
    return
  }

  try {
    const { result, keys } = await verifier(body, { supabase: this.supabase, provider: getKycProvider() })
    const kyc_level = await upsertVerification(this.supabase, body.user_id, body.role, type, result, keys)
    if (result.status === KYCStatus.Success) await applyVerifiedEffects(this.supabase, type, body)
    reply.code(statusCodeFor(result.status)).send({
      success: result.status !== KYCStatus.Failed,
      data: { type, result, kyc_level },
    })
  } catch (err) {
    request.log.error(err, `KYC verify (${type}) failed`)
    reply.code(500).send({ success: false, error: 'Verification failed — please try again', code: 'INTERNAL_ERROR' })
  }
}

// A verification that PASSED flips the matching domain row, so the badge / checklist / payout
// safety the rest of the app reads (driver_licenses.status, vehicles.rc_status,
// bank_accounts.verification_status, users.kyc_status) agrees with the KYC record. Best-effort:
// the verification itself is already stored; a failed flip is logged by the caller's try.
async function applyVerifiedEffects(supabase: FastifyInstance['supabase'], type: string, body: KYCRequest): Promise<void> {
  const userId = body.user_id
  const nowIso = new Date().toISOString()
  if (type === 'aadhaar' || type === 'pan') {
    await supabase.from('users').update({ kyc_status: 'verified', kyc_verified_at: nowIso }).eq('id', userId)
    return
  }
  if (type === 'dl') {
    const { data: driver } = await supabase.from('drivers').select('id').eq('user_id', userId).maybeSingle()
    const driverId = (driver as { id?: string } | null)?.id
    if (driverId) await supabase.from('driver_licenses').update({ status: 'verified', updated_at: nowIso }).eq('driver_id', driverId)
    return
  }
  if (type === 'rc') {
    const rc = String(body.metadata.rc_number ?? '').trim().toUpperCase().replace(/[\s-]/g, '')
    if (rc) await supabase.from('vehicles').update({ rc_status: 'verified', updated_at: nowIso }).ilike('rc_number', rc)
    return
  }
  if (type === 'bank') {
    const account = String(body.metadata.account_number ?? '').trim()
    const ifsc = String(body.metadata.ifsc ?? '').trim().toUpperCase()
    if (account.length >= 4 && ifsc) {
      await supabase.from('bank_accounts').update({ verification_status: 'verified', updated_at: nowIso })
        .eq('user_id', userId).eq('ifsc', ifsc).eq('account_number_last4', account.slice(-4))
    }
  }
}

function sendKnownError(reply: FastifyReply, err: unknown): boolean {
  if (err instanceof GstPublicError || err instanceof DigiLockerError || err instanceof GstOtpError) {
    reply.code(err.httpStatus).send({ success: false, error: err.message, code: err.code })
    return true
  }
  return false
}

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

async function handleStatus(
  this: FastifyInstance,
  request: FastifyRequest<{ Params: { userId: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const { userId } = request.params
  // A caller may read only their OWN KYC status (admin excepted) — enforced even before we read. F13.
  if (request.user.userId !== userId && request.user.role !== 'admin') {
    reply.code(403).send({ success: false, error: 'Forbidden', code: 'FORBIDDEN' })
    return
  }
  try {
    const kyc_level = await getCurrentLevel(this.supabase, userId)
    // Per-document status (status + when), never the number or the provider payload — so the
    // app can say "PAN verified" / "PAN needed" on its own cards.
    const record = await getKYCRecord(this.supabase, userId)
    const verifications: Record<string, { status: string; verified_at: string | null }> = {}
    for (const [type, v] of Object.entries((record?.verifications ?? {}) as Record<string, { status?: string; verified_at?: string | null }>)) {
      if (v?.status) verifications[type] = { status: v.status, verified_at: v.verified_at ?? null }
    }
    reply.send({ success: true, data: { user_id: userId, kyc_level, verifications } })
  } catch (err) {
    request.log.error(err, 'KYC status read failed')
    reply.code(500).send({ success: false, error: 'Could not read KYC status', code: 'INTERNAL_ERROR' })
  }
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export const kycRoutes = fp(async (app: FastifyInstance) => {
  app.post<{ Params: { type: string }; Body: KYCRequest }>(
    '/kyc/verify/:type',
    { preHandler: authenticate, schema: { params: verifyParamsSchema, body: verifyBodySchema } },
    handleVerify.bind(app),
  )

  app.get<{ Params: { userId: string } }>(
    '/kyc/status/:userId',
    { preHandler: authenticate, schema: { params: statusParamsSchema } },
    handleStatus.bind(app),
  )

  // GET /kyc/config — what the app may offer: which provider answers verifications, and whether
  // the public GST lookups and DigiLocker (both need the Sandbox keys) are available.
  app.get('/kyc/config', { preHandler: authenticate }, async (_req, reply) => {
    const provider = getKycProvider().name
    return reply.send({ success: true, data: { provider, gst_lookup: sandbox.configured, digilocker: sandbox.configured, gst_otp: sandbox.configured } })
  })

  // GST identity by OTP (2026-10-17): prove a GSTIN is the caller's OWN with the GST portal's
  // one-time password to the mobile/email registered against it — nothing from the taxpayer but
  // their gst.gov.in username and the OTP. A verified OTP: user_kyc.gst = success, users.gstin =
  // that GSTIN, and the registered names come back so the app can fill the company name.
  // One-time prerequisite on gst.gov.in: View Profile → Manage API Access → Enable API Request.
  const otpBody = (b: unknown) => {
    const o = (b ?? {}) as Record<string, unknown>
    return { gstin: String(o.gstin ?? '').trim().toUpperCase(), username: String(o.username ?? '').trim(), otp: String(o.otp ?? '').trim() }
  }
  const otpFailed = (req: FastifyRequest, reply: FastifyReply, err: unknown, what: string) => {
    if (sendKnownError(reply, err)) return
    req.log.error(err, what)
    return reply.code(502).send({ success: false, error: 'The GST portal could not be reached right now', code: 'UPSTREAM' })
  }

  app.post('/kyc/gst/otp', { preHandler: authenticate }, async (req, reply) => {
    const { gstin, username } = otpBody(req.body)
    if (!GSTIN_RE.test(gstin)) return reply.code(400).send({ success: false, error: 'Not a GSTIN', code: 'VALIDATION_ERROR' })
    if (username.length < 3) return reply.code(400).send({ success: false, error: 'Enter the username you sign in to gst.gov.in with', code: 'VALIDATION_ERROR' })
    try {
      await sendGstOtp({ gstin, username })
      return reply.send({ success: true, data: { sent: true } })
    } catch (err) {
      return otpFailed(req, reply, err, 'GST OTP send failed')
    }
  })

  app.post('/kyc/gst/otp/verify', { preHandler: authenticate }, async (req, reply) => {
    const { gstin, username, otp } = otpBody(req.body)
    if (!GSTIN_RE.test(gstin)) return reply.code(400).send({ success: false, error: 'Not a GSTIN', code: 'VALIDATION_ERROR' })
    if (!/^\d{4,8}$/.test(otp)) return reply.code(400).send({ success: false, error: 'Enter the OTP digits', code: 'VALIDATION_ERROR' })
    let session: { expires_at: string | null }
    try {
      session = await verifyGstOtp({ gstin, username, otp })
    } catch (err) {
      return otpFailed(req, reply, err, 'GST OTP verify failed')
    }
    const userId = req.user.userId
    const roleHint = String(req.user.role ?? '').toLowerCase()
    const role = roleHint.includes('driver') ? UserRole.Driver : roleHint.includes('fleet') ? UserRole.FleetOperator : UserRole.Customer
    try {
      const kyc_level = await upsertVerification(app.supabase, userId, role, 'gst', {
        status: KYCStatus.Success,
        kyc_level: await getCurrentLevel(app.supabase, userId),
        provider_ref: `gst-portal-otp:${gstin}`,
        raw_response: { method: 'gst_portal_otp', session_expires_at: session.expires_at },
        verified_at: new Date(),
      })
      // The GSTIN is now proven to be this account's: it becomes the account GSTIN (what Post a
      // Load, invoices and e-way bills read). The format CHECK is the same shape test as GSTIN_RE.
      const { error } = await app.supabase.from('users').update({ gstin }).eq('id', userId)
      if (error) req.log.error(error, 'users.gstin update after GST OTP failed')
      let legal_name: string | null = null
      let trade_name: string | null = null
      try {
        const p = await lookupGstin(gstin)
        legal_name = p.legal_name
        trade_name = p.trade_name
      } catch (e) {
        req.log.warn(e, 'GST profile after OTP unavailable')
      }
      return reply.send({ success: true, data: { verified: true, gstin, legal_name, trade_name, kyc_level, gstin_saved: !error } })
    } catch (err) {
      req.log.error(err, 'GST OTP record failed')
      return reply.code(500).send({ success: false, error: 'The OTP was accepted but the verification could not be saved — try again', code: 'INTERNAL_ERROR' })
    }
  })

  // GET /kyc/gst/:gstin/profile — the public GST record: real? active? whose?
  app.get<{ Params: { gstin: string } }>('/kyc/gst/:gstin/profile', { preHandler: authenticate }, async (req, reply) => {
    const gstin = req.params.gstin.trim().toUpperCase()
    if (!GSTIN_RE.test(gstin)) return reply.code(400).send({ success: false, error: 'Not a GSTIN', code: 'VALIDATION_ERROR' })
    try {
      return reply.send({ success: true, data: await lookupGstin(gstin) })
    } catch (err) {
      if (sendKnownError(reply, err)) return
      req.log.error(err, 'GSTIN lookup failed')
      return reply.code(502).send({ success: false, error: 'GST portal lookup failed', code: 'UPSTREAM' })
    }
  })

  // GET /kyc/gst/:gstin/returns?financial_year=FY 2026-27 — does this business file?
  app.get<{ Params: { gstin: string }; Querystring: { financial_year?: string } }>('/kyc/gst/:gstin/returns', { preHandler: authenticate }, async (req, reply) => {
    const gstin = req.params.gstin.trim().toUpperCase()
    if (!GSTIN_RE.test(gstin)) return reply.code(400).send({ success: false, error: 'Not a GSTIN', code: 'VALIDATION_ERROR' })
    const fy = req.query.financial_year?.trim()
    if (fy && !/^FY \d{4}-\d{2}$/.test(fy)) return reply.code(400).send({ success: false, error: 'financial_year looks like "FY 2026-27"', code: 'VALIDATION_ERROR' })
    try {
      return reply.send({ success: true, data: await gstFilingSummary(gstin, fy || undefined) })
    } catch (err) {
      if (sendKnownError(reply, err)) return
      req.log.error(err, 'GST returns lookup failed')
      return reply.code(502).send({ success: false, error: 'GST portal lookup failed', code: 'UPSTREAM' })
    }
  })

  // DigiLocker: the driver's licence from Sarathi, with their consent.
  const digi = () => ({ redis: app.redis, supabase: app.supabase })

  app.post<{ Body: { doc_types?: string[]; redirect_url?: string } }>('/kyc/digilocker/session', { preHandler: authenticate }, async (req, reply) => {
    const wanted = Array.isArray(req.body?.doc_types) ? req.body.doc_types : ['driving_license']
    const doc_types = wanted.filter((d): d is DigiLockerDocType => d === 'driving_license' || d === 'aadhaar' || d === 'pan')
    const redirect_url = String(req.body?.redirect_url ?? '')
    if (doc_types.length === 0) return reply.code(400).send({ success: false, error: 'doc_types must include driving_license, aadhaar or pan', code: 'VALIDATION_ERROR' })
    if (!/^https:\/\//.test(redirect_url)) return reply.code(400).send({ success: false, error: 'redirect_url must be an https URL', code: 'VALIDATION_ERROR' })
    try {
      const { data: user } = await app.supabase.from('users').select('phone_number').eq('id', req.user.userId).maybeSingle()
      const mobile = String((user as { phone_number?: string } | null)?.phone_number ?? '').replace(/\D/g, '').slice(-10)
      const session = await startSession(req.user.userId, { doc_types, redirect_url, mobile }, digi())
      return reply.send({ success: true, data: session })
    } catch (err) {
      if (sendKnownError(reply, err)) return
      req.log.error(err, 'DigiLocker session start failed')
      return reply.code(502).send({ success: false, error: 'DigiLocker could not be started', code: 'UPSTREAM' })
    }
  })

  app.get<{ Params: { id: string } }>('/kyc/digilocker/session/:id', { preHandler: authenticate }, async (req, reply) => {
    try {
      return reply.send({ success: true, data: await sessionStatus(req.params.id, req.user.userId, digi()) })
    } catch (err) {
      if (sendKnownError(reply, err)) return
      req.log.error(err, 'DigiLocker status failed')
      return reply.code(502).send({ success: false, error: 'DigiLocker status could not be read', code: 'UPSTREAM' })
    }
  })

  app.post<{ Params: { id: string } }>('/kyc/digilocker/session/:id/import', { preHandler: authenticate }, async (req, reply) => {
    try {
      return reply.send({ success: true, data: await importSession(req.params.id, req.user.userId, digi()) })
    } catch (err) {
      if (sendKnownError(reply, err)) return
      req.log.error(err, 'DigiLocker import failed')
      return reply.code(502).send({ success: false, error: 'The DigiLocker documents could not be read', code: 'UPSTREAM' })
    }
  })
})
