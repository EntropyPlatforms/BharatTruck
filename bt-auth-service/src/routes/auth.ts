import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { gstinProblem } from '../lib/gst.js'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { OAuth2Client } from 'google-auth-library'
import nodemailer from 'nodemailer'
import { randomInt } from 'node:crypto'
import { resolvePersonas, type PersonaSnapshot, type UserRole } from '@bharattruck/shared'
import type { JwtPayload } from '../lib/authenticate.js'
import { authenticate } from '../lib/authenticate.js'
import { consume, isLockedOut, recordFailure, clearFailures, envInt } from '../lib/rate-limit.js'
import { getSmsProvider } from '../lib/sms.js'
import { callbackOriginAllowlist, isAllowedCallbackUrl } from '../lib/callback-url.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const ACCESS_TTL_S  = 15 * 60         // 15 minutes
const REFRESH_TTL_S = 7 * 24 * 3600   // 7 days
const OTP_TTL_S     = 600             // 10 minutes
const PWRESET_TTL_S = 30 * 60         // 30 minutes — password-reset link validity

// ── Throttles ─────────────────────────────────────────────────────────────────
// Env-overridable so ops can retune during the pilot without a redeploy.
//
// Keyed on the EMAIL, never on the client IP. `req.ip` here is the bt-gateway
// container — Fastify is not configured with trustProxy — so an IP-keyed limit
// would collapse every user onto one counter and lock the whole pilot out at
// once. The forwarded headers are no better: X-Forwarded-For is appended to by
// nginx, so its left-most entry is attacker-controlled and an attacker would
// simply rotate it. The identity is the thing worth protecting and the thing
// that cannot be spoofed.

/** Wrong passwords tolerated per account before password login is refused. */
const LOGIN_FAIL_LIMIT    = envInt('LOGIN_FAIL_LIMIT', 10)
const LOGIN_FAIL_WINDOW_S = envInt('LOGIN_FAIL_WINDOW_S', 15 * 60)

/** Wrong codes tolerated per address before the live OTP is burned. */
const OTP_VERIFY_LIMIT = envInt('OTP_VERIFY_LIMIT', 5)

/** Messages sent to one address per hour, across every email-producing route. */
const EMAIL_SEND_LIMIT    = envInt('EMAIL_SEND_LIMIT', 5)
const EMAIL_SEND_WINDOW_S = envInt('EMAIL_SEND_WINDOW_S', 3600)

/**
 * Total messages this service may send in a day. The per-address throttle alone
 * does not stop the drain the founder flagged: registration accepts any address,
 * so an attacker spreads one send across ten thousand different addresses and
 * never trips a per-address counter — they just exhaust the SMTP quota, and then
 * no real user can receive a verification code either. This is the ceiling that
 * actually binds, regardless of how the attacker distributes the load.
 */
const SMTP_DAILY_BUDGET = envInt('SMTP_DAILY_BUDGET', 500)
// Service-wide daily ceiling on outbound OTP SMS — the SMS twin of SMTP_DAILY_BUDGET. The per-phone
// otp_rate counter is bypassed by spreading sends across many distinct valid numbers, so a global
// budget is the ceiling that actually binds against a provider-balance drain (review F10).
const SMS_DAILY_BUDGET = envInt('SMS_DAILY_BUDGET', 500)

// ── Helpers ───────────────────────────────────────────────────────────────────

function issueTokens(userId: string, role: string): { access_token: string; refresh_token: string } {
  const payload: JwtPayload = { userId, role }
  // `type:'access'` marks this as a general session token; authenticate()/verifyJwt reject any
  // OTHER typed token (pwreset, consignee_claim) so a single-purpose link can't become a session.
  const access_token  = jwt.sign({ ...payload, type: 'access' }, process.env.JWT_SECRET!, { expiresIn: ACCESS_TTL_S })
  const refresh_token = jwt.sign(payload, process.env.JWT_REFRESH_SECRET!, { expiresIn: REFRESH_TTL_S })
  return { access_token, refresh_token }
}

// crypto.randomInt, not Math.random: this six-digit string is a bearer
// credential — it verifies an email and mints a session — and Math.random is a
// seeded PRNG whose stream is recoverable from observed outputs. Same range,
// same format, no predictability.
function randomOtp(): string {
  return String(randomInt(100000, 1000000))
}

// -----------------------------------------------------------
// guardEmailSend — one gate in front of every outbound message.
//
// Returns false when this address has had its fill for the hour, or when the
// service has spent its daily send budget. Callers decide how to answer: routes
// that already refuse to confirm whether an address exists absorb it silently,
// the rest return 429.
//
// The budget is charged only once the per-address check passes, so a single
// attacker hammering one address cannot also eat the global allowance.
// -----------------------------------------------------------

type SendVerdict = { allowed: boolean; retryAfterS: number }

async function guardEmailSend(app: FastifyInstance, email: string): Promise<SendVerdict> {
  const perAddress = await consume(app.redis, `email_send:${email}`, EMAIL_SEND_LIMIT, EMAIL_SEND_WINDOW_S)
  if (!perAddress.allowed) {
    app.log.warn({ email, count: perAddress.count }, 'email send throttled for address')
    return { allowed: false, retryAfterS: perAddress.retryAfterS }
  }

  // Date-stamped key + 25h TTL: rolls over on its own at UTC midnight and
  // cannot leave a stale counter behind if the service is down at the boundary.
  const day = new Date().toISOString().slice(0, 10)
  const budget = await consume(app.redis, `smtp_budget:${day}`, SMTP_DAILY_BUDGET, 25 * 3600)
  if (!budget.allowed) {
    // Loud: past this point no real user can receive a verification code
    // either, so it needs to reach whoever is watching the logs.
    app.log.error({ email, spent: budget.count, budget: SMTP_DAILY_BUDGET }, 'daily SMTP budget exhausted — outbound email suspended')
    return { allowed: false, retryAfterS: budget.retryAfterS }
  }
  return { allowed: true, retryAfterS: 0 }
}

// Built once for the process, not once per email. Every send here used to call
// createTransport() again, which throws away the connection pool and pays a fresh
// TCP + TLS handshake per message — on a login-OTP path where the user is watching a
// spinner. Lazy so a service with no SMTP configured never constructs one at all.
//
// Port 465 is implicit TLS; 587 is STARTTLS, which nodemailer upgrades to when
// secure=false. Deriving `secure` from the port means a provider swap to a 465-only
// host cannot silently attempt a plaintext handshake.
//
// NOTE: this mirrors smtpTransportOptions() in @bharattruck/shared/notifications,
// which is the canonical copy. This service is not yet on the shared package —
// migrating it is a separate, CTO-sequenced change (see packages/shared/README.md).
let mailerInstance: nodemailer.Transporter | null = null

function getMailer(): nodemailer.Transporter {
  if (!mailerInstance) {
    const port = Number(process.env.SMTP_PORT ?? 587)
    mailerInstance = nodemailer.createTransport({
      host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    })
  }
  return mailerInstance
}

// -----------------------------------------------------------
// notifyPasswordChanged — queue the "your password was changed" security notice.
//
// Posted to bt-booking-service's outbox rather than sent inline: unlike the OTP and
// reset-link emails above, nobody is waiting on this one, and it must not be able to
// fail or delay the password update that has already been committed. Same plain-fetch,
// skip-silently-when-unconfigured shape as the existing cross-service emit helpers
// (bt-booking-service/src/lib/payment-emit.ts, bt-payment-service/src/lib/fleet-emit.ts).
// -----------------------------------------------------------

function notifyPasswordChanged(userId: string, log?: { warn(o: unknown, m: string): void }): void {
  const base = process.env.BOOKING_SERVICE_URL
  const secret = process.env.INTERNAL_SERVICE_SECRET
  if (!base || !secret) return

  void fetch(`${base}/internal/notifications`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': secret },
    body: JSON.stringify({
      event: 'password_changed',
      user_id: userId,
      changed_at: new Date().toISOString(),
    }),
  }).catch((err) => {
    log?.warn({ err, user_id: userId }, 'password-changed notification emit failed (password was still updated)')
  })
}

async function sendOtpEmail(email: string, otp: string) {
  if (process.env.EMAIL_DEV_MODE === 'true' || !process.env.SMTP_USER) {
    // Production with no SMTP: refuse rather than print a working verification code into the logs and report
    // it as sent. The caller already turns a throw into a visible failure.
    if (process.env.NODE_ENV === 'production' && process.env.EMAIL_DEV_MODE !== 'true') {
      throw new Error('SMTP is not configured (SMTP_USER unset) — verification code not sent')
    }
    console.log(`[DEV] Email OTP for ${email}: ${otp}`)
    return
  }
  const mailer = getMailer()
  await mailer.sendMail({
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
    to: email,
    subject: 'BharatTruck — Verify your email',
    text: `Your BharatTruck verification code is: ${otp}\n\nExpires in 10 minutes.`,
    html: `<p>Your BharatTruck verification code is: <strong>${otp}</strong></p><p>Expires in 10 minutes.</p>`,
  })
}

// trySendOtpEmail — the OTP send with its failure made visible. Mirrors the phone-OTP
// path (/send-otp) and forgot-password, which already catch a provider error and log
// it; the email-OTP sends were the only ones left to throw, and a throw here surfaced
// as a bare 500 with no log line naming SMTP as the cause. Returns false on failure;
// the caller decides whether that is safe to reveal (register/login: yes; resend: no).
async function trySendOtpEmail(app: FastifyInstance, email: string, otp: string): Promise<boolean> {
  try {
    await sendOtpEmail(email, otp)
    return true
  } catch (err) {
    app.log.error({ err, email }, 'verification email send failed — no code was delivered')
    return false
  }
}

function replyEmailSendFailed(reply: FastifyReply) {
  return reply.status(502).send({
    success: false,
    error: 'Could not send the verification email right now. Try again shortly.',
    code: 'EMAIL_SEND_FAILED',
  })
}

async function sendPasswordResetEmail(email: string, link: string) {
  if (process.env.EMAIL_DEV_MODE === 'true' || !process.env.SMTP_USER) {
    // Production with no SMTP: refuse rather than print a working password-reset link into the logs and report
    // it as sent. The caller already turns a throw into a visible failure.
    if (process.env.NODE_ENV === 'production' && process.env.EMAIL_DEV_MODE !== 'true') {
      throw new Error('SMTP is not configured (SMTP_USER unset) — password-reset link not sent')
    }
    console.log(`[DEV] Password reset link for ${email}: ${link}`)
    return
  }
  const mailer = getMailer()
  await mailer.sendMail({
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
    to: email,
    subject: 'BharatTruck — Reset your password',
    text: `We received a request to reset your BharatTruck password.\n\nReset it here: ${link}\n\nThis link expires in 30 minutes. If you did not request this, ignore this email — your password is unchanged.`,
    html: `<p>We received a request to reset your BharatTruck password.</p>` +
      `<p><a href="${link}">Reset your password</a> (expires in 30 minutes).</p>` +
      `<p>If you did not request this, ignore this email — your password is unchanged.</p>`,
  })
}

// ── Password-reset front-end link ─────────────────────────────────────────────
//
// The unified app serves every persona from ONE origin, so a reset link has ONE
// destination — there is no longer a per-role app to route the mail to.

const RESET_PATH = '/auth/reset'

/**
 * The deployed unified-app origin the reset page lives on. It is the DEFAULT reset
 * destination and the seed of the callback allowlist, so it must be a real deployed
 * origin — never localhost, which is what made a live reset link point at a dev port.
 *
 * The link is otherwise DYNAMIC: the front-end sends its own origin as `callback_url`
 * (it knows what domain it is served from), so a reset link automatically follows the
 * domain the app actually runs on. To move to a custom domain, set PASSWORD_RESET_URL to
 * it — that both changes this default AND allowlists the origin, so the app served from
 * the new domain wires up on its own with no second list to edit. Kept in code (like the
 * Dockerfile's NEXT_PUBLIC_API_URL default) so a fresh deploy is never broken by a missing
 * env; APP_RESET_URL overrides it without a per-role var.
 */
const DEFAULT_APP_RESET_URL = process.env.APP_RESET_URL ?? `https://bt-app-itcdoenefa-el.a.run.app${RESET_PATH}`

/**
 * Where a password-reset link should land.
 *
 * PASSWORD_RESET_URL is the single production destination: one app, one reset page,
 * so every reset link goes to the same origin regardless of the account's role. When it
 * is unset an explicit *_RESET_PASSWORD_URL for the account's role still wins; otherwise
 * the deployed-app default above is used (a real origin, so the link works out of the box).
 */
function resetLinkBase(role: string | undefined): string {
  if (process.env.PASSWORD_RESET_URL) return process.env.PASSWORD_RESET_URL

  const explicit = role === 'driver'      ? process.env.DRIVER_RESET_PASSWORD_URL
                 : role === 'fleet_owner' ? process.env.FLEET_RESET_PASSWORD_URL
                 :                          process.env.SHIPPER_RESET_PASSWORD_URL
  return explicit ?? DEFAULT_APP_RESET_URL
}

/** Every role whose reset destination is configurable in the pre-config fallback. Feeds a set. */
const LINK_ROLES = ['shipper', 'driver', 'fleet_owner'] as const

/**
 * Origins a caller-supplied `callback_url` may point at.
 *
 * Built from the reset destinations this service would pick on its own, so the
 * allowlist tracks the deployment automatically: point the reset URL at a new
 * front-end and that front-end may immediately name itself, with no second list to
 * remember. With PASSWORD_RESET_URL set every role resolves to the same origin, so
 * the allowlist collapses to that one origin. ALLOWED_CALLBACK_ORIGINS covers origins
 * that have no reset var of their own yet.
 *
 * Recomputed per request rather than frozen at import: the env vars are read lazily
 * everywhere else in this file too, and a handful of URL parses are nothing next to
 * the DB round-trip and the SMTP send that follow.
 */
function allowedCallbackOrigins(): ReadonlySet<string> {
  return callbackOriginAllowlist(LINK_ROLES.map((role) => resetLinkBase(role)))
}

// fleet_owners.company_name is NOT NULL, so fall through the identity fields we actually
// have. The owner renames the fleet properly via PATCH /fleet/owners/me — this only has to
// be a truthful, non-empty placeholder so the row can exist from the moment the role is set.
function fleetCompanyName(supplied: string | undefined, user: Record<string, unknown>): string {
  const candidates = [
    supplied,
    user.full_name as string | null | undefined,
    (user.email as string | null | undefined)?.split('@')[0],
  ]
  for (const c of candidates) {
    const trimmed = c?.trim()
    if (trimmed) return trimmed
  }
  return 'Fleet owner'
}

/**
 * Create the profile row the user's role implies.
 *
 * Every downstream service joins on it (drivers.id for bookings/quotes/GPS, fleet_owners.id
 * for the whole tenant-isolation rule), so it has to exist the instant the role is decided —
 * not lazily on first use. Both tables have a UNIQUE user_id, which makes this idempotent;
 * `ignoreDuplicates` on the fleet side stops a re-login from clobbering a company name the
 * owner has since edited.
 */
async function ensureRoleProfile(
  app: FastifyInstance,
  user: Record<string, unknown>,
  companyName?: string,
): Promise<void> {
  const userId = user.id as string

  if (user.role === 'driver') {
    await app.supabase.from('drivers').upsert({ user_id: userId }, { onConflict: 'user_id' })
    return
  }

  if (user.role === 'fleet_owner') {
    const { error } = await app.supabase.from('fleet_owners').upsert(
      { user_id: userId, company_name: fleetCompanyName(companyName, user) },
      { onConflict: 'user_id', ignoreDuplicates: true },
    )
    // Never fail sign-in on this: the token is valid regardless, and POST /fleet/owners
    // repairs a missing profile. Silently swallowing it, though, would strand the owner.
    if (error) app.log.error({ err: error, userId }, 'Failed to create fleet_owners profile')
  }
}

// ── Persona resolution for /auth/me ───────────────────────────────────────────
//
// This is the gate every capability-driven client waits on: what a human may DO is COMPUTED from
// the assets they own and the fleets they are tied to (@bharattruck/shared/personas), never read
// off a stored role. /auth/me is where that computation is published.
//
// WHY `personas: null` AND A SEPARATE FLAG, RATHER THAN AN EMPTY LIST OR A 500:
//
//   • Not a 500. resolvePersonas() runs six lookups against four tables. A client that cannot
//     read its own profile is dead — no name, no email, no session — which is strictly worse than
//     one that renders with capabilities it has to re-fetch. The profile read already succeeded by
//     the time we get here; throwing it away because a secondary read failed helps nobody.
//
//   • Not `capabilities: []`. An empty list is a VALID answer shape that no real user ever has
//     (everyone gets 'ship'), and a client cannot tell it apart from a computed one. It would
//     read as "this human may do nothing" and strip their entire UI — a silent, total lockout
//     dressed up as a successful response. Absence must be unmistakably absence.
//
//   • So: `personas` is null and `personas_error` names the reason. A client sees "no answer
//     yet", not "the answer is nothing", and can hold its previous snapshot or retry.
//
// This is also the missing-relation tolerance the repo requires (see
// bt-booking-service/src/lib/documents/repository.ts): migrations are applied BY HAND while CD
// deploys on merge, so `vehicles`/`fleet_drivers` columns from 0022 may not exist yet on the
// database this code runs against. The lookup throws, /auth/me still answers, every existing
// screen keeps working, and capabilities light up the moment the schema catches up.

type PersonaResolution =
  | { personas: PersonaSnapshot; personas_error: null }
  | { personas: null; personas_error: 'PERSONA_RESOLUTION_FAILED' }

async function resolveViewerPersonas(
  app: FastifyInstance,
  user: Record<string, unknown>,
): Promise<PersonaResolution> {
  // 0022 made `primary_persona` a generated mirror of `role`, so on a migrated database these are
  // equal and either would do. Prefer the honest name — it is the column that survives when the
  // last service stops authorizing on `role` — and fall back for the pre-0022 window.
  const primaryPersona = (user.primary_persona ?? user.role) as UserRole

  try {
    const personas = await resolvePersonas(app.supabase, user.id as string, primaryPersona)
    return { personas, personas_error: null }
  } catch (err) {
    app.log.error({ err, user_id: user.id }, 'persona resolution failed — /auth/me answered without capabilities')
    return { personas: null, personas_error: 'PERSONA_RESOLUTION_FAILED' }
  }
}

// Returns the public user shape both apps expect
function userProfile(row: Record<string, unknown>) {
  return {
    id:             row.id,
    phone:          row.phone_number ?? null,
    email:          row.email ?? null,
    full_name:      row.full_name ?? null,
    avatar_url:     row.avatar_url ?? null,
    role:           row.role,
    // FB-04: clients need GSTIN to know whether post-load is allowed.
    gstin:          row.gstin ?? null,
    primary_persona: row.primary_persona ?? row.role ?? null,
    email_verified: row.email_verified ?? false,
    google_sub:     row.google_sub ?? null,
    created_at:     row.created_at,
  }
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const PhoneOtpBody       = z.object({ phone: z.string().regex(/^[6-9]\d{9}$/, 'Invalid Indian phone number') })
const VerifyOtpBody      = z.object({ phone: z.string(), otp: z.string().length(6) })
const EmailRegisterBody  = z.object({
  email:     z.string().email(),
  password:  z.string().min(8),
  full_name: z.string().min(2).max(100),
  role:      z.enum(['shipper', 'driver', 'fleet_owner']).default('shipper'),
})
const EmailVerifyBody    = z.object({ email: z.string().email(), otp: z.string().length(6) })
const EmailLoginBody     = z.object({ email: z.string().email(), password: z.string() })
const ResendOtpBody      = z.object({ email: z.string().email() })
const GoogleSignInBody   = z.object({ id_token: z.string(), role: z.enum(['shipper', 'driver', 'fleet_owner']).default('shipper') })
const RefreshBody        = z.object({ refresh_token: z.string() })
// `.url()` on callback_url is shape-checking only — it accepts every host on the internet
// and non-http schemes besides. The check that matters is the origin allowlist applied in
// the handler; see lib/callback-url.ts for why this parameter is dangerous unvalidated.
const ForgotPasswordBody = z.object({ email: z.string().email(), callback_url: z.string().url().optional() })
const ResetPasswordBody  = z.object({ token: z.string().min(1), password: z.string().min(8, 'Password must be at least 8 characters') })
const RegisterProfileBody = z.object({
  full_name:    z.string().min(2).max(100),
  role:         z.enum(['shipper', 'driver', 'fleet_owner']),
  email:        z.string().email().optional(),
  // role='fleet_owner' only; falls back to full_name when the caller has no separate
  // trading name yet.
  company_name: z.string().min(2).max(200).optional(),
  truck_type:   z.string().optional(),
  truck_number: z.string().optional(),
  license_number: z.string().optional(),
})

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function authRoutes(app: FastifyInstance) {

  // ── POST /auth/send-otp ──────────────────────────────────────────────────────

  app.post('/send-otp', async (req, reply) => {
    const body = PhoneOtpBody.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.errors[0].message })
    }
    const { phone } = body.data

    const rateKey = `otp_rate:${phone}`
    const attempts = await app.redis.incr(rateKey)
    if (attempts === 1) await app.redis.expire(rateKey, 3600)
    if (attempts > 5) {
      return reply.status(429).send({ success: false, error: 'Too many OTP requests. Try again in 1 hour.' })
    }

    // Global daily SMS ceiling (F10): the per-phone counter above is bypassed by spreading sends
    // across many distinct numbers, draining the provider balance so no real user gets a code.
    // Charged AFTER the per-phone check so one abuser's retries don't eat the shared budget first.
    const smsDay = new Date().toISOString().slice(0, 10)
    const smsBudget = await consume(app.redis, `sms_budget:${smsDay}`, SMS_DAILY_BUDGET, 25 * 3600)
    if (!smsBudget.allowed) {
      app.log.error({ spent: smsBudget.count, budget: SMS_DAILY_BUDGET }, 'daily SMS budget exhausted — outbound OTP suspended')
      return reply.status(429).send({ success: false, error: 'Too many OTP requests right now. Please try again later.' })
    }

    const otp = randomOtp()
    await app.redis.set(`phone_otp:${phone}`, otp, 'EX', OTP_TTL_S)

    // One seam for every phone OTP (D-14). Console until TRAI DLT registration
    // clears, real SMS the moment the env vars exist — see lib/sms.ts. Stored in
    // Redis BEFORE the send so a provider that accepts the message but answers
    // slowly cannot leave a delivered code with nothing to verify it against.
    try {
      await getSmsProvider().sendOtp(phone, otp)
    } catch (err) {
      // The rate-limit attempt above is deliberately NOT refunded: a provider
      // outage is exactly when a retry loop would hammer both the provider and
      // this service. The code stays in Redis and its TTL keeps running, so a
      // send that actually did go out despite the error still verifies.
      app.log.error({ err, phone }, 'phone OTP send failed — no code was delivered')
      return reply.status(502).send({ success: false, error: 'Could not send the code right now. Try again shortly.' })
    }

    return reply.send({ success: true, data: { message: 'OTP sent', expires_in: OTP_TTL_S } })
  })

  // ── POST /auth/verify-otp ────────────────────────────────────────────────────

  app.post('/verify-otp', async (req, reply) => {
    const body = VerifyOtpBody.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.errors[0].message })
    }
    const { phone, otp } = body.data

    // A six-digit code with no guess cap is a 10^6 space an attacker can walk
    // in minutes, and it mints a full session. Cap the guesses, then burn the
    // code: the attacker has to request a new one, which /send-otp already
    // limits to 5/hour, so the reachable search space collapses to ~25 guesses
    // an hour instead of unbounded.
    const guessKey = `otp_guess:${phone}`
    const gate = await isLockedOut(app.redis, guessKey, OTP_VERIFY_LIMIT)
    if (!gate.allowed) {
      return reply.status(429).send({ success: false, error: 'Too many incorrect codes. Request a new OTP.', retry_after_s: gate.retryAfterS })
    }

    const stored = await app.redis.get(`phone_otp:${phone}`)
    if (!stored || stored !== otp) {
      const used = await recordFailure(app.redis, guessKey, OTP_TTL_S)
      if (used >= OTP_VERIFY_LIMIT) await app.redis.del(`phone_otp:${phone}`)
      return reply.status(401).send({ success: false, error: 'Invalid or expired OTP' })
    }
    await app.redis.del(`phone_otp:${phone}`)
    await clearFailures(app.redis, guessKey)

    // Upsert user by phone
    let { data: user } = await app.supabase
      .from('users')
      .select('*')
      .eq('phone_number', phone)
      .maybeSingle()

    const is_new_user = !user
    if (!user) {
      const { data: newUser, error } = await app.supabase
        .from('users')
        .insert({ phone_number: phone, role: 'shipper' })
        .select('*')
        .single()
      if (error || !newUser) {
        return reply.status(500).send({ success: false, error: 'Failed to create user' })
      }
      user = newUser
    }

    const { access_token, refresh_token } = issueTokens(user.id, user.role)
    await app.redis.set(`refresh:${user.id}`, refresh_token, 'EX', REFRESH_TTL_S)

    return reply.send({
      success: true,
      data: {
        access_token,
        refresh_token,
        is_new_user,
        user: userProfile(user),
      },
    })
  })

  // ── POST /auth/email/register ────────────────────────────────────────────────

  app.post('/email/register', async (req, reply) => {
    const body = EmailRegisterBody.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.errors[0].message })
    }
    const { email, password, full_name, role } = body.data

    const { data: existing } = await app.supabase
      .from('users')
      .select('id, email_verified')
      .eq('email', email)
      .maybeSingle()

    if (existing) {
      if (!existing.email_verified) {
        // Resend OTP so the user can complete verification. Throttled like any
        // other send — replaying this branch is the cheapest way to make the
        // service mail an address it has already mailed.
        const gate = await guardEmailSend(app, email)
        if (!gate.allowed) {
          return reply.status(429).send({ success: false, error: 'Too many verification emails requested. Try again later.', retry_after_s: gate.retryAfterS })
        }
        const otp = randomOtp()
        await app.redis.set(`email_otp:${email}`, otp, 'EX', OTP_TTL_S)
        if (!(await trySendOtpEmail(app, email, otp))) return replyEmailSendFailed(reply)
        return reply.status(409).send({
          success: false,
          error: 'Email already registered but not verified. A new OTP has been sent.',
          code: 'EMAIL_NOT_VERIFIED',
        })
      }
      return reply.status(409).send({ success: false, error: 'Email already registered', code: 'EMAIL_EXISTS' })
    }

    // Checked BEFORE the row is written: a registration that cannot send its
    // verification code would otherwise leave an unverifiable account behind
    // and still burn a users row per request.
    const sendGate = await guardEmailSend(app, email)
    if (!sendGate.allowed) {
      return reply.status(429).send({ success: false, error: 'Too many verification emails requested. Try again later.', retry_after_s: sendGate.retryAfterS })
    }

    const password_hash = await bcrypt.hash(password, 12)
    const { data: user, error } = await app.supabase
      .from('users')
      .insert({ email, password_hash, full_name, role, email_verified: false })
      .select('*')
      .single()
    if (error || !user) {
      return reply.status(500).send({ success: false, error: 'Failed to create account' })
    }

    const otp = randomOtp()
    await app.redis.set(`email_otp:${email}`, otp, 'EX', OTP_TTL_S)
    // The row is already written. A failed send must not read as a generic 500: the
    // account exists but is unverified, and the next register/login answers
    // EMAIL_NOT_VERIFIED, which the app turns into the code screen + Resend.
    if (!(await trySendOtpEmail(app, email, otp))) return replyEmailSendFailed(reply)

    return reply.status(201).send({
      success: true,
      data: {
        message:        'Account created. Check your email for the verification code.',
        email_verified: false,
        user_id:        user.id,
        expires_in:     OTP_TTL_S,
      },
    })
  })

  // ── POST /auth/email/verify ──────────────────────────────────────────────────

  app.post('/email/verify', async (req, reply) => {
    const body = EmailVerifyBody.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.errors[0].message })
    }
    const { email, otp } = body.data

    // Same guess cap as the phone OTP — this code also mints a session.
    const guessKey = `email_otp_guess:${email}`
    const gate = await isLockedOut(app.redis, guessKey, OTP_VERIFY_LIMIT)
    if (!gate.allowed) {
      return reply.status(429).send({ success: false, error: 'Too many incorrect codes. Request a new one.', retry_after_s: gate.retryAfterS })
    }

    const stored = await app.redis.get(`email_otp:${email}`)
    if (!stored || stored !== otp) {
      const used = await recordFailure(app.redis, guessKey, OTP_TTL_S)
      if (used >= OTP_VERIFY_LIMIT) await app.redis.del(`email_otp:${email}`)
      return reply.status(401).send({ success: false, error: 'Invalid or expired verification code' })
    }
    await app.redis.del(`email_otp:${email}`)
    await clearFailures(app.redis, guessKey)

    const { data: user, error } = await app.supabase
      .from('users')
      .update({ email_verified: true })
      .eq('email', email)
      .select('*')
      .single()
    if (error || !user) {
      return reply.status(404).send({ success: false, error: 'User not found' })
    }

    await ensureRoleProfile(app, user)

    const { access_token, refresh_token } = issueTokens(user.id, user.role)
    await app.redis.set(`refresh:${user.id}`, refresh_token, 'EX', REFRESH_TTL_S)

    return reply.send({
      success: true,
      data: {
        access_token,
        refresh_token,
        is_new_user: true,
        user: userProfile(user),
      },
    })
  })

  // ── POST /auth/email/login ───────────────────────────────────────────────────

  app.post('/email/login', async (req, reply) => {
    const body = EmailLoginBody.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.errors[0].message })
    }
    const { email, password } = body.data

    // Brute-force / credential-stuffing gate. Checked before the DB read and
    // before bcrypt.compare — a 12-round hash is deliberately expensive, so an
    // unthrottled login endpoint is also a CPU amplification target.
    //
    // Only wrong passwords count and a success clears the tally, so a user who
    // knows their password is never affected by someone else's attempts.
    //
    // Accepted trade-off: an attacker who knows an address can lock its owner
    // out of PASSWORD login for the window. That is the standard cost of a
    // lockout, and it is bounded here — forgot-password and the other sign-in
    // methods (phone OTP, Google) still work, so the account is never actually
    // unreachable.
    const failKey = `login_fail:${email}`
    const gate = await isLockedOut(app.redis, failKey, LOGIN_FAIL_LIMIT)
    if (!gate.allowed) {
      return reply.status(429).send({
        success: false,
        error: 'Too many failed sign-in attempts. Try again later, or reset your password.',
        code: 'TOO_MANY_ATTEMPTS',
        retry_after_s: gate.retryAfterS,
      })
    }

    const { data: user } = await app.supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .maybeSingle()

    // Unknown address and wrong password are charged identically: branching
    // only on the real-account path would turn the counter into an account
    // enumeration oracle, undoing the identical 401 above it.
    if (!user || !user.password_hash) {
      await recordFailure(app.redis, failKey, LOGIN_FAIL_WINDOW_S)
      return reply.status(401).send({ success: false, error: 'Invalid email or password' })
    }

    const match = await bcrypt.compare(password, user.password_hash)
    if (!match) {
      await recordFailure(app.redis, failKey, LOGIN_FAIL_WINDOW_S)
      return reply.status(401).send({ success: false, error: 'Invalid email or password' })
    }

    // The password was right, so this actor is the account owner.
    await clearFailures(app.redis, failKey)

    if (!user.email_verified) {
      // Issue a fresh OTP so they can verify. Correct credentials still do not
      // buy unmetered sends — this is otherwise a mail loop anyone holding one
      // valid password can run indefinitely.
      const sendGate = await guardEmailSend(app, email)
      if (!sendGate.allowed) {
        return reply.status(429).send({ success: false, error: 'Too many verification emails requested. Try again later.', retry_after_s: sendGate.retryAfterS })
      }
      const otp = randomOtp()
      await app.redis.set(`email_otp:${email}`, otp, 'EX', OTP_TTL_S)
      if (!(await trySendOtpEmail(app, email, otp))) return replyEmailSendFailed(reply)
      return reply.status(403).send({
        success: false,
        error: 'Email not verified. A verification code has been sent to your email.',
        code: 'EMAIL_NOT_VERIFIED',
      })
    }

    const { access_token, refresh_token } = issueTokens(user.id, user.role)
    await app.redis.set(`refresh:${user.id}`, refresh_token, 'EX', REFRESH_TTL_S)

    return reply.send({
      success: true,
      data: {
        access_token,
        refresh_token,
        is_new_user: false,
        user: userProfile(user),
      },
    })
  })

  // ── POST /auth/email/resend-otp ──────────────────────────────────────────────

  app.post('/email/resend-otp', async (req, reply) => {
    const body = ResendOtpBody.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.errors[0].message })
    }
    const { email } = body.data

    const { data: user } = await app.supabase
      .from('users')
      .select('id, email_verified')
      .eq('email', email)
      .maybeSingle()

    if (!user) {
      // Respond with success regardless to avoid email enumeration
      return reply.send({ success: true, data: { message: 'If that email is registered, a code was sent.', expires_in: OTP_TTL_S } })
    }

    if (user.email_verified) {
      // Already verified: nothing to resend. Return the SAME generic success as the unknown-address
      // branch above so a 400-vs-200 split cannot be used to probe which addresses are verified
      // BharatTruck accounts (review F9).
      return reply.send({ success: true, data: { message: 'If that email is registered, a code was sent.', expires_in: OTP_TTL_S } })
    }

    // Absorbed silently, matching the unknown-address branch above: a 429 that
    // only ever appears for real, unverified accounts would re-open the
    // enumeration hole that branch exists to close.
    const gate = await guardEmailSend(app, email)
    if (!gate.allowed) {
      return reply.send({ success: true, data: { message: 'If that email is registered, a code was sent.', expires_in: OTP_TTL_S } })
    }

    const otp = randomOtp()
    await app.redis.set(`email_otp:${email}`, otp, 'EX', OTP_TTL_S)
    // Logged, not surfaced: a 502 that only ever appears for real, unverified accounts
    // would re-open the enumeration hole the generic responses above exist to close.
    await trySendOtpEmail(app, email, otp)

    return reply.send({ success: true, data: { message: 'Verification code sent', expires_in: OTP_TTL_S } })
  })

  // ── POST /auth/forgot-password ───────────────────────────────────────────────
  // Emails a single-use reset LINK (never a password). Enumeration-safe: the same
  // generic success is returned whether or not the email exists. Rate-limited per
  // email (5/hour) to stop the endpoint being used as an email bomb / probe.
  app.post('/forgot-password', async (req, reply) => {
    const body = ForgotPasswordBody.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.errors[0].message })
    }
    const { email, callback_url } = body.data
    const generic = { success: true, data: { message: 'If an account exists for that email, a reset link has been sent.' } }

    // Refused before the throttle and before the user lookup, so this 400 says something
    // about the request and nothing about the account. A 400 decided purely by the
    // callback_url is identical for every address and touches no account state, so it
    // cannot become an existence oracle. Everything past this line stays enumeration-safe.
    if (callback_url && !isAllowedCallbackUrl(callback_url, allowedCallbackOrigins())) {
      return reply.status(400).send({ success: false, error: 'callback_url is not an allowed origin' })
    }

    // Was an inline per-email counter; folded into the shared gate so this
    // route also draws down the global daily send budget rather than being the
    // one mail-producing path that can drain the quota around it.
    // Still silently absorbed — do not reveal the cap.
    const gate = await guardEmailSend(app, email)
    if (!gate.allowed) return reply.send(generic)

    const { data: user } = await app.supabase
      .from('users')
      .select('id, role, password_hash')
      .eq('email', email)
      .maybeSingle()

    // Only email a real link to an account that can actually log in with a password.
    // Passwordless-only accounts (phone OTP / Google) have no password to reset.
    if (user && user.password_hash) {
      const resetToken = jwt.sign(
        { userId: user.id, type: 'pwreset' },
        process.env.JWT_SECRET!,
        { expiresIn: PWRESET_TTL_S },
      )
      // Single-use: reset-password checks this key matches AND deletes it, so a token
      // cannot be replayed and a second request invalidates the first.
      await app.redis.set(`pwreset:${user.id}`, resetToken, 'EX', PWRESET_TTL_S)
      // Allowlisted above — an unchecked callback_url here mails a live reset token
      // straight to whatever origin the requester named.
      const base = callback_url ?? resetLinkBase(user.role)
      const link = `${base}?token=${encodeURIComponent(resetToken)}`
      try {
        await sendPasswordResetEmail(email, link)
      } catch (err) {
        req.log?.error({ err }, 'password reset email failed to send')
        // Still return generic success — do not leak send failures to the caller.
      }
    }

    return reply.send(generic)
  })

  // ── POST /auth/reset-password ────────────────────────────────────────────────
  // Consumes a reset token, sets a new bcrypt password, and revokes existing
  // refresh tokens so any session opened with the old password is killed.
  app.post('/reset-password', async (req, reply) => {
    const body = ResetPasswordBody.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.errors[0].message })
    }
    const { token, password } = body.data

    let decoded: { userId: string; type?: string }
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string; type?: string }
    } catch {
      return reply.status(400).send({ success: false, error: 'Reset link is invalid or has expired', code: 'INVALID_RESET_TOKEN' })
    }
    if (decoded.type !== 'pwreset' || !decoded.userId) {
      return reply.status(400).send({ success: false, error: 'Reset link is invalid', code: 'INVALID_RESET_TOKEN' })
    }

    // Single-use check: the token must match the one still in Redis.
    const stored = await app.redis.get(`pwreset:${decoded.userId}`)
    if (!stored || stored !== token) {
      return reply.status(400).send({ success: false, error: 'Reset link is invalid or already used', code: 'INVALID_RESET_TOKEN' })
    }

    const password_hash = await bcrypt.hash(password, 12)
    const { error } = await app.supabase
      .from('users')
      .update({ password_hash })
      .eq('id', decoded.userId)
    if (error) {
      return reply.status(500).send({ success: false, error: 'Could not update password' })
    }

    // Burn the reset token + revoke sessions opened under the old password.
    await app.redis.del(`pwreset:${decoded.userId}`)
    await app.redis.del(`refresh:${decoded.userId}`)

    // Security notice. This is the email that tells a user their account was taken
    // over: a reset they did not request is invisible to them without it, because the
    // reset link itself goes to whoever asked for it.
    notifyPasswordChanged(decoded.userId, req.log)

    return reply.send({ success: true, data: { message: 'Password updated. Please sign in with your new password.' } })
  })

  // ── POST /auth/google ────────────────────────────────────────────────────────

  app.post('/google', async (req, reply) => {
    const body = GoogleSignInBody.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.errors[0].message })
    }
    const { id_token, role } = body.data

    if (!process.env.GOOGLE_CLIENT_ID) {
      return reply.status(501).send({ success: false, error: 'Google sign-in not configured' })
    }

    let googlePayload: { sub: string; email?: string; name?: string; picture?: string }
    try {
      const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID)
      const ticket = await client.verifyIdToken({ idToken: id_token, audience: process.env.GOOGLE_CLIENT_ID })
      const p = ticket.getPayload()
      if (!p) throw new Error('Empty payload')
      // Use the email ONLY when Google says it is verified. Account-linking below matches an
      // existing local account by email, so an unverified email (possible in some Workspace /
      // federated setups) must NOT be treated as proof of ownership — otherwise it could link the
      // Google identity to, and issue a session for, a victim's pre-existing account (review F11).
      googlePayload = { sub: p.sub, email: p.email_verified ? p.email : undefined, name: p.name, picture: p.picture }
    } catch {
      return reply.status(401).send({ success: false, error: 'Invalid Google token' })
    }

    // Look up by google_sub first, then by email
    let { data: user } = await app.supabase
      .from('users')
      .select('*')
      .eq('google_sub', googlePayload.sub)
      .maybeSingle()

    let is_new_user = false

    if (!user && googlePayload.email) {
      const { data: emailUser } = await app.supabase
        .from('users')
        .select('*')
        .eq('email', googlePayload.email)
        .maybeSingle()

      if (emailUser) {
        // Link Google to existing account
        const { data: linked } = await app.supabase
          .from('users')
          .update({
            google_sub:     googlePayload.sub,
            avatar_url:     googlePayload.picture ?? emailUser.avatar_url,
            full_name:      emailUser.full_name ?? googlePayload.name,
            email_verified: true,
          })
          .eq('id', emailUser.id)
          .select('*')
          .single()
        user = linked ?? emailUser
      }
    }

    if (!user) {
      is_new_user = true
      const { data: newUser, error } = await app.supabase
        .from('users')
        .insert({
          email:          googlePayload.email ?? null,
          full_name:      googlePayload.name ?? null,
          avatar_url:     googlePayload.picture ?? null,
          google_sub:     googlePayload.sub,
          role:           role ?? 'shipper',
          email_verified: true,
        })
        .select('*')
        .single()
      if (error || !newUser) {
        return reply.status(500).send({ success: false, error: 'Failed to create account' })
      }
      user = newUser

      await ensureRoleProfile(app, user)
    }

    const { access_token, refresh_token } = issueTokens(user.id, user.role)
    await app.redis.set(`refresh:${user.id}`, refresh_token, 'EX', REFRESH_TTL_S)

    return reply.send({
      success: true,
      data: {
        access_token,
        refresh_token,
        is_new_user,
        user: userProfile(user),
      },
    })
  })

  // ── POST /auth/refresh ───────────────────────────────────────────────────────

  app.post('/refresh', async (req, reply) => {
    const body = RefreshBody.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.errors[0].message })
    }
    const { refresh_token } = body.data

    let payload: JwtPayload
    try {
      payload = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET!) as JwtPayload
    } catch {
      return reply.status(401).send({ success: false, error: 'Invalid or expired refresh token' })
    }

    const stored = await app.redis.get(`refresh:${payload.userId}`)
    if (!stored || stored !== refresh_token) {
      return reply.status(401).send({ success: false, error: 'Refresh token revoked or not found' })
    }

    const access_token = jwt.sign(
      { userId: payload.userId, role: payload.role, type: 'access' } satisfies JwtPayload,
      process.env.JWT_SECRET!,
      { expiresIn: ACCESS_TTL_S },
    )

    return reply.send({ success: true, data: { access_token } })
  })

  // ── GET /auth/me ─────────────────────────────────────────────────────────────

  app.get('/me', { preHandler: authenticate }, async (req, reply) => {
    const { data: user } = await app.supabase
      .from('users')
      .select('*')
      .eq('id', req.user.userId)
      .maybeSingle()

    if (!user) {
      return reply.status(404).send({ success: false, error: 'User not found' })
    }

    // STRICTLY ADDITIVE: `user` keeps every field it had, unchanged and in place. The four
    // deployed apps all read `data.user` and ignore what they do not know about, so shipping
    // capabilities here cannot break a client that has not been updated yet.
    return reply.send({
      success: true,
      data: { user: userProfile(user), ...(await resolveViewerPersonas(app, user)) },
    })
  })

  // PATCH /auth/me/gstin — FB-04 settings path for the post-load GST hard rule.
  // Format matches users_gstin_format CHECK (and fleet settings). Null clears it.
  // Shape, state code, embedded PAN and check digit (lib/gst.ts) — a GSTIN with one mistyped
  // character is refused here rather than carried onto every invoice and e-way bill.
  app.patch('/me/gstin', { preHandler: authenticate }, async (req, reply) => {
    const body = z.object({
      gstin: z.union([
        z.string().trim().toUpperCase().superRefine((g, ctx) => {
          const problem = gstinProblem(g)
          if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid GSTIN — ${problem}` })
        }),
        z.null(),
      ]),
    }).safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.errors[0].message })
    }
    const { data: user, error } = await app.supabase
      .from('users')
      .update({ gstin: body.data.gstin })
      .eq('id', req.user.userId)
      .select('*')
      .single()
    if (error || !user) {
      return reply.status(500).send({ success: false, error: 'Failed to update GSTIN' })
    }
    return reply.send({ success: true, data: { user: userProfile(user) } })
  })

  // ── POST /auth/register ──────────────────────────────────────────────────────
  // Called after first phone-OTP login to set profile + role

  app.post('/register', { preHandler: authenticate }, async (req, reply) => {
    const body = RegisterProfileBody.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.errors[0].message })
    }
    const { full_name, role, email, company_name } = body.data

    const { data: user, error } = await app.supabase
      .from('users')
      .update({ full_name, role, ...(email ? { email } : {}) })
      .eq('id', req.user.userId)
      .select('*')
      .single()
    if (error || !user) {
      return reply.status(500).send({ success: false, error: 'Failed to update profile' })
    }

    await ensureRoleProfile(app, user, company_name)

    return reply.send({ success: true, data: { user: userProfile(user) } })
  })

  // ── POST /auth/logout ────────────────────────────────────────────────────────

  app.post('/logout', { preHandler: authenticate }, async (req, reply) => {
    await app.redis.del(`refresh:${req.user.userId}`)
    return reply.send({ success: true, data: { message: 'Logged out' } })
  })
}
