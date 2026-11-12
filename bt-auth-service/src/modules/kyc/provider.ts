// -----------------------------------------------------------
// The one seam every identity-document verification leaves this service through.
//
// Modelled on lib/sms.ts (decision D-14's shape): a provider INTERFACE, a default that always
// works, real providers behind an all-or-nothing env switch, and a memoised accessor that
// announces the wiring state once at boot. Rewriting the KYC calls this way is what makes
// swapping aggregators (Surepass / Signzy / IDfy / Perfios / HyperVerge / Digio / Cashfree) a
// config change (KYC_PROVIDER=…) rather than a code change — exactly the property the founder
// asked for. Pick ONE aggregator; it covers PAN, DL, RC and GSTIN. (Bank penny-drop and Aadhaar
// have their own notes below.)
//
// Two rules the shape encodes:
//   1. Verification is OPT-IN and ALL-OR-NOTHING. KYC_PROVIDER must name a provider AND its
//      credential must be present, or we fall back to the console provider. A half-configured
//      deploy must not throw — KYC does not gate use at MVP (D-5/D-31), so the worst outcome of
//      "no provider" is that a verification lands as manual_review for Ops, never a blocked user.
//   2. The console provider NEVER returns `verified: true` in production. Without a real
//      aggregator there is nothing to verify against, so it returns `unavailable`, which the
//      callers map to manual_review. A dev auto-pass exists ONLY under KYC_DEV_MODE in
//      development, so the flow is testable without a vendor.
//
// Aadhaar caveat (founder's "decide this now"): real Aadhaar OTP eKYC needs an AUA/KUA licence.
// This interface is licence-agnostic — a provider may implement Aadhaar via its own AUA/KUA, or a
// DigiLocker / offline-XML flow can be slotted in as another provider. The seam does not force the
// choice; it just gives Aadhaar one place to live.
// -----------------------------------------------------------

import { SurepassClient, surepass, type SurepassResponse } from '../../lib/surepass.js'
import { SandboxClient, SandboxError, sandbox, type SandboxResponse } from '../../lib/sandbox.js'

/** The normalised result of one verification, whatever the vendor. Carries NO full ID numbers. */
export type VerificationOutcome = {
  /** The provider confirmed the identifier. */
  verified: boolean
  /** Name on record, for the fuzzy-match guard. */
  name: string | null
  /** The provider's reference / transaction id — the "reference key" we store instead of the number. */
  reference_id: string | null
  /** Safe, non-identifying fields only (last-4, dob, masked value) — never a full number. */
  details: Record<string, unknown>
  /** The full provider response, for audit. Callers must redact before persisting. */
  raw: unknown
  /** No provider is wired: the caller records manual_review rather than a pass or a fail. */
  unavailable: boolean
  reason: string | null
}

/** Sandbox's PAN check matches the NAME and DATE OF BIRTH against the PAN record, not just the number. */
export type PanInput = { pan: string; name?: string; dob?: string }
export type GstinInput = { gstin: string }
export type DlInput = { dl_number: string; dob?: string }
export type RcInput = { rc_number: string }
export type BankInput = { account_number: string; ifsc: string }
export type FaceMatchInput = { image1: string; image2: string }
export type AadhaarOtpInput = { aadhaar: string }
export type AadhaarSubmitInput = { reference_id: string; otp: string }

export interface KycProvider {
  readonly name: 'console' | 'surepass' | 'sandbox'
  verifyPan(input: PanInput): Promise<VerificationOutcome>
  verifyGstin(input: GstinInput): Promise<VerificationOutcome>
  verifyDl(input: DlInput): Promise<VerificationOutcome>
  verifyRc(input: RcInput): Promise<VerificationOutcome>
  /** Bank account penny-drop. Prefer Razorpay/Cashfree in production — they already do this and
   *  one is likely already in the payments plan — but the seam accepts whichever provider serves it. */
  verifyBank(input: BankInput): Promise<VerificationOutcome>
  verifyFaceMatch(input: FaceMatchInput): Promise<VerificationOutcome>
  /** Aadhaar step 1: OTP to the registered mobile. reference_id (client_id) is cached by the caller. */
  aadhaarGenerateOtp(input: AadhaarOtpInput): Promise<VerificationOutcome>
  /** Aadhaar step 2: submit the OTP against the cached reference_id. */
  aadhaarSubmitOtp(input: AadhaarSubmitInput): Promise<VerificationOutcome>
}

function base(partial: Partial<VerificationOutcome>): VerificationOutcome {
  return {
    verified: false, name: null, reference_id: null, details: {}, raw: null, unavailable: false, reason: null,
    ...partial,
  }
}

// ── console (default) ─────────────────────────────────────────────────────────

/**
 * The default, and the only provider that runs until an aggregator is wired. In production every
 * method returns `unavailable`, so the verification is recorded as manual_review for Ops (D-5).
 * Under KYC_DEV_MODE in development it auto-passes, so the end-to-end flow is testable.
 */
export class ConsoleKycProvider implements KycProvider {
  readonly name = 'console' as const
  private readonly dev: boolean

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.dev = env.KYC_DEV_MODE === 'true' && env.NODE_ENV === 'development'
  }

  private answer(ref: string): VerificationOutcome {
    if (this.dev) {
      return base({ verified: true, reference_id: `dev-${ref}`, raw: { mock: true, dev: true }, reason: 'dev auto-pass' })
    }
    return base({ unavailable: true, raw: { mock: true }, reason: 'no KYC provider configured — recorded for manual review' })
  }

  async verifyPan() { return this.answer('pan') }
  async verifyGstin() { return this.answer('gstin') }
  async verifyDl() { return this.answer('dl') }
  async verifyRc() { return this.answer('rc') }
  async verifyBank() { return this.answer('bank') }
  async verifyFaceMatch() { return this.answer('face') }
  async aadhaarGenerateOtp() {
    // In dev the "OTP" is skipped; the submit step's dev-pass completes it.
    return this.dev ? base({ verified: true, reference_id: 'dev-aadhaar', raw: { mock: true, dev: true } }) : this.answer('aadhaar')
  }
  async aadhaarSubmitOtp() { return this.answer('aadhaar') }
}

// ── Surepass ──────────────────────────────────────────────────────────────────

function pickName(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null
  for (const k of ['full_name', 'name_on_pan', 'name', 'owner_name', 'legal_name', 'trade_name', 'business_name']) {
    const v = data[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

function isVerified(res: SurepassResponse<Record<string, unknown>>): boolean {
  if (!res.success) return false
  const d = res.data ?? {}
  // Some checks answer with an explicit boolean; default to "success ⇒ verified" otherwise.
  for (const k of ['account_exists', 'valid', 'is_valid', 'verified']) {
    if (typeof d[k] === 'boolean') return d[k] as boolean
  }
  return true
}

const str = (d: Record<string, unknown>, keys: string[]): string | null => {
  for (const k of keys) {
    const v = d[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number') return String(v)
  }
  return null
}

/** Parse YYYY-MM-DD, DD-MM-YYYY or DD/MM/YYYY into a UTC date; null when unreadable. */
export function parseRecordDate(v: string | null): Date | null {
  if (!v) return null
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  m = v.match(/^(\d{2})[-/](\d{2})[-/](\d{4})/)
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]))
  return null
}

const lapsed = (v: string | null, today: Date): boolean | null => {
  const t = parseRecordDate(v)
  return t ? t.getTime() < today.getTime() : null
}

const BAD_RC_STATUS = /(inactive|suspend|cancel|blacklist|revok|surrender|scrap|not\s*found)/i

/** Pure: a Surepass RC (Vahan) response → outcome. Exported for the unit test. */
export function surepassRcOutcome(res: SurepassResponse<Record<string, unknown>>, today = new Date()): VerificationOutcome {
  const d = res.data ?? {}
  const rcStatus = str(d, ['rc_status', 'status'])
  const blacklisted = d.blacklist_status != null && /^(y|yes|true|blacklisted)$/i.test(String(d.blacklist_status).trim())
  const fitUpto = str(d, ['fit_up_to', 'fit_upto', 'fitness_upto', 'fitness_up_to'])
  const insUpto = str(d, ['insurance_upto', 'insurance_up_to'])
  const bad = blacklisted || (rcStatus != null && BAD_RC_STATUS.test(rcStatus))
  return base({
    verified: res.success && !bad,
    name: str(d, ['owner_name']),
    reference_id: typeof d.client_id === 'string' ? d.client_id : null,
    // Vehicle facts only: no owner name, address, chassis or engine number.
    details: {
      rc_status: rcStatus,
      maker_model: str(d, ['maker_model', 'maker_description']),
      vehicle_category: str(d, ['vehicle_category_description', 'vehicle_category', 'vehicle_class']),
      fuel_type: str(d, ['fuel_type']),
      norms: str(d, ['norms_type', 'norms']),
      registration_date: str(d, ['registration_date']),
      registered_at: str(d, ['registered_at']),
      fitness_upto: fitUpto,
      fitness_lapsed: lapsed(fitUpto, today),
      insurance_upto: insUpto,
      insurance_lapsed: lapsed(insUpto, today),
      permit_valid_upto: str(d, ['permit_valid_upto']),
      financed: typeof d.financed === 'boolean' ? d.financed : null,
    },
    raw: res,
    reason: !res.success ? (res.message || 'RC not found on Vahan')
      : blacklisted ? 'The RC is blacklisted on Vahan'
      : bad ? `The RC is ${rcStatus} on Vahan` : null,
  })
}

/** Pure: a Surepass driving-licence (Sarathi) response → outcome. Exported for the unit test. */
export function surepassDlOutcome(res: SurepassResponse<Record<string, unknown>>, today = new Date()): VerificationOutcome {
  const d = res.data ?? {}
  const doe = str(d, ['doe', 'date_of_expiry', 'expiry_date'])
  const transportDoe = str(d, ['transport_doe'])
  const expired = lapsed(doe, today) === true
  const transportLapsed = lapsed(transportDoe, today)
  const classes = Array.isArray(d.vehicle_classes) ? (d.vehicle_classes as unknown[]).filter((x): x is string => typeof x === 'string') : []
  return base({
    verified: res.success && !expired,
    name: str(d, ['name', 'full_name']),
    reference_id: typeof d.client_id === 'string' ? d.client_id : null,
    details: {
      expiry: doe,
      transport_expiry: transportDoe,
      transport_valid: transportLapsed === null ? null : !transportLapsed,
      vehicle_classes: classes,
      state: str(d, ['state']),
    },
    raw: res,
    reason: !res.success ? (res.message || 'Licence not found on Sarathi') : expired ? `The licence expired on ${doe}` : null,
  })
}

/**
 * Surepass-backed provider. Each method is one authenticated POST to the documented endpoint,
 * mapped into a VerificationOutcome. The raw response is returned for audit; callers redact the
 * PII (full numbers) before persisting — we store only a hash, the last 4, and the reference id.
 */
export class SurepassKycProvider implements KycProvider {
  readonly name = 'surepass' as const
  constructor(private readonly client: SurepassClient = surepass) {}

  private async call(endpoint: string, payload: unknown): Promise<VerificationOutcome> {
    const res = await this.client.post<Record<string, unknown>>(endpoint, payload)
    return base({
      verified: isVerified(res),
      name: pickName(res.data),
      reference_id: (typeof res.data?.client_id === 'string' ? res.data.client_id : null),
      raw: res,
      reason: res.success ? null : (res.message || 'verification failed'),
    })
  }

  verifyPan(input: PanInput) { return this.call('/pan/pan', { id_number: input.pan }) }
  verifyGstin(input: GstinInput) { return this.call('/corporate/gstin', { id_number: input.gstin }) }
  // Driving licence: Surepass reads the transport department's Sarathi record, which needs the
  // date of birth. A licence past its expiry is not a pass.
  async verifyDl(input: DlInput) {
    if (!input.dob) return base({ unavailable: true, reason: 'Licence verification needs the date of birth on the licence' })
    const res = await this.client.post<Record<string, unknown>>('/driving-license/driving-license', { id_number: input.dl_number, dob: input.dob })
    return surepassDlOutcome(res)
  }
  // Vehicle RC: Surepass reads the Vahan record. An RC that Vahan marks inactive, suspended,
  // cancelled or blacklisted is not a pass. The endpoint is overridable (SUREPASS_RC_ENDPOINT)
  // because Surepass sells RC in several tiers and an account may have only one of them.
  async verifyRc(input: RcInput) {
    const endpoint = (process.env.SUREPASS_RC_ENDPOINT ?? '').trim() || '/rc/rc-full'
    const res = await this.client.post<Record<string, unknown>>(endpoint, { id_number: input.rc_number })
    return surepassRcOutcome(res)
  }
  verifyBank(input: BankInput) { return this.call('/bank-verification/bank-verification', { id_number: input.account_number, ifsc: input.ifsc }) }
  verifyFaceMatch(input: FaceMatchInput) { return this.call('/face/face-match', { image_1: input.image1, image_2: input.image2 }) }
  aadhaarGenerateOtp(input: AadhaarOtpInput) { return this.call('/aadhaar-v2/generate-otp', { id_number: input.aadhaar }) }
  aadhaarSubmitOtp(input: AadhaarSubmitInput) { return this.call('/aadhaar-v2/submit-otp', { client_id: input.reference_id, otp: input.otp }) }
}

// ── Sandbox (sandbox.co.in) ─────────────────────────────────────────────────────

// Sandbox nests result fields under `data` and signals validity a few different ways depending on
// the check (a `status` string, or an explicit boolean like account_exists). Read it defensively —
// same posture as the Surepass mapping above — so a check whose shape we did not anticipate never
// silently reads as "unverified".
function sandboxName(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null
  for (const k of ['name_as_per_pan', 'name_as_per_bank', 'name_at_bank', 'full_name', 'name', 'legal_name', 'trade_name', 'registered_name', 'owner_name']) {
    const v = data[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

function sandboxVerified(res: SandboxResponse<Record<string, unknown>>): boolean {
  if (res.code !== undefined && res.code !== 200) return false
  const d = res.data ?? {}
  for (const k of ['account_exists', 'valid', 'is_valid', 'verified', 'name_match']) {
    if (typeof d[k] === 'boolean') return d[k] as boolean
  }
  const status = typeof d.status === 'string' ? d.status.toLowerCase() : ''
  if (status) return ['valid', 'active', 'exists', 'success', 'verified', 'id_found'].some((s) => status.includes(s))
  // A 200 with data but no explicit flag: the identifier resolved. The caller still runs the
  // fuzzy name-match guard on top, so this is not the whole decision.
  return res.code === 200 || Object.keys(d).length > 0
}

// Sandbox requires an affirmative consent + a stated purpose on every KYC call.
const SANDBOX_CONSENT = 'Y'
const SANDBOX_REASON = 'Driver / fleet-owner onboarding KYC for the BharatTruck freight platform'

/**
 * Sandbox-backed provider. Each method is one authenticated POST (the client handles the
 * authenticate→token flow) to the documented /kyc/* endpoint, mapped into a VerificationOutcome.
 * Endpoint paths + `@entity` request tags follow Sandbox's KYC API; the response mapping is
 * deliberately defensive so a field-name difference degrades to a sensible outcome rather than a
 * false negative. Callers redact PII (full numbers) before persisting — only a hash, last-4 and the
 * reference id are stored.
 */
export class SandboxKycProvider implements KycProvider {
  readonly name = 'sandbox' as const
  constructor(private readonly client: SandboxClient = sandbox) {}

  private async call(endpoint: string, payload: Record<string, unknown>): Promise<VerificationOutcome> {
    const res = await this.client.post<Record<string, unknown>>(endpoint, payload)
    const refRaw = res.data?.reference_id
    return base({
      verified: sandboxVerified(res),
      name: sandboxName(res.data),
      reference_id: typeof refRaw === 'string' || typeof refRaw === 'number' ? String(refRaw) : (res.transaction_id ?? null),
      raw: res,
      reason: res.code === undefined || res.code === 200 ? null : (res.message || 'verification failed'),
    })
  }

  // Documented request (2026-10): name_as_per_pan and date_of_birth (DD/MM/YYYY) are REQUIRED and
  // the answer says whether each matched — so a PAN check here is "this PAN belongs to this
  // person", not just "this PAN exists". Without a name/DOB the call cannot be made.
  async verifyPan(input: PanInput) {
    if (!input.name || !input.dob) {
      return base({ unavailable: true, reason: 'PAN verification needs the name as printed on the card and the date of birth (DD/MM/YYYY)' })
    }
    const res = await this.client.post<Record<string, unknown>>('/kyc/pan/verify', {
      '@entity': 'in.co.sandbox.kyc.pan_verification.request',
      pan: input.pan,
      name_as_per_pan: input.name,
      date_of_birth: input.dob,
      consent: SANDBOX_CONSENT,
      reason: SANDBOX_REASON,
    })
    const d = res.data ?? {}
    const valid = typeof d.status === 'string' && /valid/i.test(d.status) && !/invalid/i.test(d.status)
    const nameOk = d.name_as_per_pan_match !== false
    const dobOk = d.date_of_birth_match !== false
    return base({
      verified: valid && nameOk && dobOk,
      name: null,
      reference_id: res.transaction_id ?? null,
      details: { category: d.category ?? null, aadhaar_seeding_status: d.aadhaar_seeding_status ?? null, name_match: nameOk, dob_match: dobOk },
      raw: res,
      reason: !valid ? 'PAN is not valid' : !nameOk ? 'The name does not match the PAN record' : !dobOk ? 'The date of birth does not match the PAN record' : null,
    })
  }
  // The public GST portal record (no taxpayer login): legal name, status, PAN, registration date.
  async verifyGstin(input: GstinInput) {
    const res = await this.client.post<{ status_cd?: string; data?: Record<string, unknown> }>('/gst/compliance/public/gstin/verify', { gstin: input.gstin })
    const d = res.data?.data ?? {}
    const valid = d.validGstin === true || res.data?.status_cd === '1'
    const status = typeof d.status === 'string' ? d.status : ''
    return base({
      verified: valid && /^active$/i.test(status.trim()),
      name: typeof d.legalName === 'string' ? d.legalName.trim() : null,
      reference_id: res.transaction_id ?? null,
      details: { status, pan: d.pan ?? null, registered_since: d.regStartDate ?? null, state_code: d.stateCode ?? null },
      raw: res,
      reason: !valid ? 'GSTIN is not on the GST portal' : !/^active$/i.test(status.trim()) ? `GST registration is ${status || 'not active'}` : null,
    })
  }
  // Sandbox's KYC catalogue (2026-10) lists no direct licence or RC lookup. The licence comes
  // through DigiLocker (modules/kyc/digilocker.ts); a vehicle RC has no Sandbox route at all.
  // The legacy paths are still tried in case the account has them; a 404 means "not offered".
  async verifyDl(input: DlInput) {
    try {
      return await this.call('/kyc/driving-license', { '@entity': 'in.co.sandbox.kyc.driving_license.request', driving_license_number: input.dl_number, date_of_birth: input.dob, consent: SANDBOX_CONSENT, reason: SANDBOX_REASON })
    } catch (err) {
      if (err instanceof SandboxError && err.statusCode === 404) return base({ unavailable: true, reason: 'Sandbox offers no direct licence lookup — verify the licence through DigiLocker' })
      throw err
    }
  }
  async verifyRc(input: RcInput) {
    try {
      return await this.call('/kyc/rc', { '@entity': 'in.co.sandbox.kyc.rc.request', rc_number: input.rc_number, consent: SANDBOX_CONSENT, reason: SANDBOX_REASON })
    } catch (err) {
      if (err instanceof SandboxError && err.statusCode === 404) return base({ unavailable: true, reason: 'Sandbox offers no vehicle RC lookup — recorded for ops review' })
      throw err
    }
  }
  verifyBank(input: BankInput) {
    return this.call('/kyc/bank-account/verify', { '@entity': 'in.co.sandbox.kyc.bank_account.request', account_number: input.account_number, ifsc: input.ifsc, consent: SANDBOX_CONSENT, reason: SANDBOX_REASON })
  }
  verifyFaceMatch(input: FaceMatchInput) {
    return this.call('/kyc/face-match', { '@entity': 'in.co.sandbox.kyc.face_match.request', image_1: input.image1, image_2: input.image2, consent: SANDBOX_CONSENT, reason: SANDBOX_REASON })
  }
  aadhaarGenerateOtp(input: AadhaarOtpInput) {
    return this.call('/kyc/aadhaar/okyc/otp', { '@entity': 'in.co.sandbox.kyc.aadhaar.okyc.otp.request', aadhaar_number: input.aadhaar, consent: SANDBOX_CONSENT, reason: SANDBOX_REASON })
  }
  aadhaarSubmitOtp(input: AadhaarSubmitInput) {
    // Sandbox's reference_id is numeric; send a number when the cached id is all digits.
    const ref = /^\d+$/.test(input.reference_id) ? Number(input.reference_id) : input.reference_id
    return this.call('/kyc/aadhaar/okyc/otp/verify', { '@entity': 'in.co.sandbox.kyc.aadhaar.okyc.request', reference_id: ref, otp: input.otp })
  }
}

// ── per-check routing ─────────────────────────────────────────────────────────

/**
 * Sends the licence and/or RC checks to a different vendor from the rest (2026-11-12). Sandbox
 * has no Vahan (RC) lookup, so RC can go to Surepass while PAN, GST, bank and Aadhaar stay on
 * Sandbox. Every other check is delegated to the base provider unchanged.
 */
export class RoutedKycProvider implements KycProvider {
  constructor(private readonly baseProvider: KycProvider, private readonly overrides: { dl?: KycProvider; rc?: KycProvider }) {}
  get name() { return this.baseProvider.name }
  /** Which vendor answers each overridable check. */
  get routing(): { dl: KycProvider['name']; rc: KycProvider['name'] } {
    return { dl: (this.overrides.dl ?? this.baseProvider).name, rc: (this.overrides.rc ?? this.baseProvider).name }
  }
  verifyPan(i: PanInput) { return this.baseProvider.verifyPan(i) }
  verifyGstin(i: GstinInput) { return this.baseProvider.verifyGstin(i) }
  verifyDl(i: DlInput) { return (this.overrides.dl ?? this.baseProvider).verifyDl(i) }
  verifyRc(i: RcInput) { return (this.overrides.rc ?? this.baseProvider).verifyRc(i) }
  verifyBank(i: BankInput) { return this.baseProvider.verifyBank(i) }
  verifyFaceMatch(i: FaceMatchInput) { return this.baseProvider.verifyFaceMatch(i) }
  aadhaarGenerateOtp(i: AadhaarOtpInput) { return this.baseProvider.aadhaarGenerateOtp(i) }
  aadhaarSubmitOtp(i: AadhaarSubmitInput) { return this.baseProvider.aadhaarSubmitOtp(i) }
}

/** Which vendor answers the licence and RC checks, for a routed or a plain provider. */
export function checkRouting(p: KycProvider): { dl: KycProvider['name']; rc: KycProvider['name'] } {
  return p instanceof RoutedKycProvider ? p.routing : { dl: p.name, rc: p.name }
}

// ── resolution ────────────────────────────────────────────────────────────────

export type KycProviderResolution = {
  provider: KycProvider
  /** Non-null whenever verifications are NOT hitting a real aggregator, with the reason. */
  unwiredReason: string | null
  /** A KYC_DL_PROVIDER / KYC_RC_PROVIDER override that was ignored (missing credentials), with why. */
  overrideWarnings?: string[]
}

/**
 * Pure: env bag in, provider out. No logging, no memoisation — so a test can pin configurations.
 * KYC_PROVIDER picks the vendor for every check; KYC_DL_PROVIDER and KYC_RC_PROVIDER optionally
 * send the licence (Sarathi) and RC (Vahan) checks to another vendor. An override whose
 * credentials are missing is ignored with a reason, never half-applied.
 */
export function resolveKycProvider(env: NodeJS.ProcessEnv = process.env): KycProviderResolution {
  const main = resolveBase(env)
  const warnings: string[] = []
  const overrides: { dl?: KycProvider; rc?: KycProvider } = {}
  for (const [check, varName] of [['dl', 'KYC_DL_PROVIDER'], ['rc', 'KYC_RC_PROVIDER']] as const) {
    const sel = (env[varName] ?? '').trim().toLowerCase()
    if (!sel) continue
    const r = resolveBase({ ...env, KYC_PROVIDER: sel })
    if (r.unwiredReason) { warnings.push(r.unwiredReason.replace(/KYC_PROVIDER/g, varName)); continue }
    if (r.provider.name !== main.provider.name) overrides[check] = r.provider
  }
  const provider = overrides.dl || overrides.rc ? new RoutedKycProvider(main.provider, overrides) : main.provider
  return { provider, unwiredReason: main.unwiredReason, overrideWarnings: warnings }
}

function resolveBase(env: NodeJS.ProcessEnv): KycProviderResolution {
  const selected = (env.KYC_PROVIDER ?? '').trim().toLowerCase()

  if (!selected || selected === 'console') {
    return { provider: new ConsoleKycProvider(env), unwiredReason: selected ? 'KYC_PROVIDER=console' : 'KYC_PROVIDER is unset' }
  }
  if (selected === 'surepass') {
    const key = (env.SUREPASS_API_KEY ?? '').trim()
    if (!key) {
      return { provider: new ConsoleKycProvider(env), unwiredReason: 'KYC_PROVIDER=surepass but SUREPASS_API_KEY is unset' }
    }
    return { provider: new SurepassKycProvider(new SurepassClient(key)), unwiredReason: null }
  }
  if (selected === 'sandbox') {
    const key = (env.SANDBOX_API_KEY ?? '').trim()
    const secret = (env.SANDBOX_API_SECRET ?? '').trim()
    if (!key || !secret) {
      return { provider: new ConsoleKycProvider(env), unwiredReason: 'KYC_PROVIDER=sandbox but SANDBOX_API_KEY / SANDBOX_API_SECRET is unset' }
    }
    return { provider: new SandboxKycProvider(new SandboxClient(key, secret)), unwiredReason: null }
  }
  return { provider: new ConsoleKycProvider(env), unwiredReason: `KYC_PROVIDER='${selected.slice(0, 32)}' is not a known provider` }
}

let cached: KycProvider | null = null

/** Process-wide provider, resolved and announced once. index.ts calls this at bootstrap. */
export function getKycProvider(): KycProvider {
  if (!cached) {
    const { provider, unwiredReason, overrideWarnings } = resolveKycProvider()
    for (const w of overrideWarnings ?? []) console.warn(`[kyc] ${w} — that override is ignored`)
    if (unwiredReason) {
      console.warn(`[kyc] ${unwiredReason} — verifications are recorded as manual_review, not automatically verified. Set KYC_PROVIDER + the vendor key to enable.`)
    } else {
      const r = checkRouting(provider)
      console.log(`[kyc] provider=${provider.name} licence=${r.dl} rc=${r.rc} — identity documents are verified against the vendor`)
    }
    cached = provider
  }
  return cached
}

/** Test seam: pin a provider (or null to reset to env resolution). */
export function __setKycProviderForTests(provider: KycProvider | null): void {
  cached = provider
}
