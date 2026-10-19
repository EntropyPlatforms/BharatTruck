/**
 * Consignee claim (D-35): the lightweight join for a receiving party.
 *
 * An UNCLAIMED consignee is a `public.users` row created by booking-service when a load is posted —
 * `claimed_at IS NULL`, no credential (migration 0026 / D-22). It is a RECORD, not a weak account: it
 * cannot be logged into, only CLAIMED. This file is the claim path, and it is DELIBERATELY SEPARATE
 * from the KYC/onboarding surface — a consignee carries no persona, no completeness ring and no KYC
 * burden (D-35). All they do is set a password on a record that already has their inbound shipment
 * history attached (bookings.consignee_user_id), turning it into a full account.
 *
 * Two endpoints, two audiences, so two plugins in one file sharing the token/email helpers:
 *   • POST /auth/consignee/claim/complete   — public; the standalone claim form calls it with the
 *                                             emailed token + a chosen password.
 *   • POST /internal/consignee/claim-invite — internal-secret gated; booking-service calls it when it
 *                                             creates a NEW consignee, to email the claim link.
 *
 * The token MIRRORS the password-reset pattern in auth.ts: a signed JWT plus a Redis key that is
 * checked-and-deleted on use, so a link is single-use and a second use of a burned token fails cleanly.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import nodemailer from 'nodemailer'
import { consume } from '../lib/rate-limit.js'
import type { JwtPayload } from '../lib/authenticate.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const ACCESS_TTL_S  = 15 * 60         // mirror auth.ts — a claimed consignee is logged straight in
const REFRESH_TTL_S = 7 * 24 * 3600
// A consignee may not open their email for days, and the link is their ONLY way in until they claim —
// so it lives far longer than a 30-minute password reset. Single-use + the burn-on-claim below is what
// bounds it, not a short clock.
const CLAIM_TTL_S   = 14 * 24 * 3600  // 14 days
// One invite email per consignee per day, so a booking-service retry loop cannot turn this into a
// mail bomb aimed at a receiver who has not claimed yet.
const INVITE_LIMIT_PER_DAY = 3

// ── Token helpers (mirror the pwreset pattern in auth.ts) ──────────────────────

function claimRedisKey(userId: string): string {
  return `consignee_claim:${userId}`
}

function signClaimToken(userId: string): string {
  return jwt.sign({ userId, type: 'consignee_claim' }, process.env.JWT_SECRET!, { expiresIn: CLAIM_TTL_S })
}

/**
 * Where the claim link lands: a standalone form origin, NOT the app's authenticated surface (D-35).
 * Defaults to the DEPLOYED origin (like DEFAULT_APP_RESET_URL in routes/auth.ts) so a fresh deploy
 * that forgot to set CONSIGNEE_CLAIM_URL still emails a WORKING link, rather than a localhost one
 * that silently dead-ends on the external recipient's device; CONSIGNEE_CLAIM_URL overrides it
 * (review F12).
 */
function claimLinkFor(token: string): string {
  const base = process.env.CONSIGNEE_CLAIM_URL ?? 'https://bt-app-itcdoenefa-el.a.run.app/consignee/claim'
  return `${base}?token=${encodeURIComponent(token)}`
}

// Lazy transport. This MIRRORS getMailer() in routes/auth.ts (which itself mirrors
// smtpTransportOptions() in @bharattruck/shared/notifications, the canonical copy). Kept local rather
// than reaching into auth.ts's module-private mailer so the consignee flow is self-contained and
// auth.ts is left untouched; a second pooled transport on a rarely-hit invite path costs nothing.
let mailerInstance: nodemailer.Transporter | null = null
function getMailer(): nodemailer.Transporter {
  if (!mailerInstance) {
    const port = Number(process.env.SMTP_PORT ?? 587)
    mailerInstance = nodemailer.createTransport({
      host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  }
  return mailerInstance
}

async function sendClaimEmail(email: string, link: string) {
  if (process.env.EMAIL_DEV_MODE === 'true' || !process.env.SMTP_USER) {
    console.log(`[DEV] Consignee claim link for ${email}: ${link}`)
    return
  }
  const mailer = getMailer()
  await mailer.sendMail({
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
    to: email,
    subject: 'BharatTruck — Confirm your incoming shipment',
    text:
      `A shipment is on its way to you through BharatTruck.\n\n` +
      `Confirm your details and track it here: ${link}\n\n` +
      `No app to install. This link is personal to you — do not share it.`,
    html:
      `<p>A shipment is on its way to you through BharatTruck.</p>` +
      `<p><a href="${link}">Confirm your details and track it</a>. No app to install.</p>` +
      `<p>This link is personal to you — do not share it.</p>`,
  })
}

function issueTokens(userId: string, role: string): { access_token: string; refresh_token: string } {
  const payload: JwtPayload = { userId, role }
  // `type:'access'` marks this as a general session (see issueTokens in routes/auth.ts): the
  // claim token itself is single-purpose and must not double as a session once consumed.
  const access_token  = jwt.sign({ ...payload, type: 'access' }, process.env.JWT_SECRET!, { expiresIn: ACCESS_TTL_S })
  const refresh_token = jwt.sign(payload, process.env.JWT_REFRESH_SECRET!, { expiresIn: REFRESH_TTL_S })
  return { access_token, refresh_token }
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const ClaimCompleteBody = z.object({
  token:    z.string().min(1),
  password: z.string().min(8, 'Password must be at least 8 characters'),
})

const ClaimInviteBody = z.object({
  consignee_user_id: z.string().uuid(),
})

// ── Public plugin: claim completion. Registered under the /auth prefix. ─────────

export async function consigneeClaimRoutes(app: FastifyInstance) {

  // ── POST /consignee/claim/complete  →  /auth/consignee/claim/complete ──────────
  app.post('/consignee/claim/complete', async (req, reply) => {
    const body = ClaimCompleteBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ success: false, error: body.error.errors[0].message })
    const { token, password } = body.data

    let decoded: { userId: string; type?: string }
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string; type?: string }
    } catch {
      return reply.status(400).send({ success: false, error: 'Claim link is invalid or has expired', code: 'INVALID_CLAIM_TOKEN' })
    }
    if (decoded.type !== 'consignee_claim' || !decoded.userId) {
      return reply.status(400).send({ success: false, error: 'Claim link is invalid', code: 'INVALID_CLAIM_TOKEN' })
    }

    // Single-use: the token must still match the one in Redis. A second use of a burned token, or a
    // link superseded by a fresh invite, fails here rather than being replayable.
    const stored = await app.redis.get(claimRedisKey(decoded.userId))
    if (!stored || stored !== token) {
      return reply.status(400).send({ success: false, error: 'Claim link is invalid or already used', code: 'INVALID_CLAIM_TOKEN' })
    }

    const { data: user, error: readErr } = await app.supabase
      .from('users').select('*').eq('id', decoded.userId).maybeSingle()
    if (readErr) return reply.status(500).send({ success: false, error: 'Could not complete claim' })
    if (!user) return reply.status(404).send({ success: false, error: 'This record no longer exists' })

    // Refuse to claim anything that is already a real account. An unclaimed record has claimed_at NULL
    // AND no credential (D-22 anti-goal §9.2); a row that fails either half is somebody's live account,
    // and setting a password on it here would be an account takeover. Burn the (now-useless) token so a
    // leaked link to a since-claimed row cannot be retried against it.
    const alreadyClaimed = user.claimed_at != null || user.password_hash != null || user.google_sub != null
    if (alreadyClaimed) {
      await app.redis.del(claimRedisKey(decoded.userId))
      return reply.status(409).send({ success: false, error: 'This account has already been claimed. Please sign in instead.', code: 'ALREADY_CLAIMED' })
    }

    const password_hash = await bcrypt.hash(password, 12)
    const { data: claimed, error } = await app.supabase
      .from('users')
      // email_verified: the link went to their email, so completing the claim proves possession of it.
      .update({ password_hash, claimed_at: new Date().toISOString(), email_verified: true })
      .eq('id', decoded.userId)
      .select('*')
      .single()
    if (error || !claimed) return reply.status(500).send({ success: false, error: 'Could not complete claim' })

    // Burn the token: the record is now an account and this link must never work again.
    await app.redis.del(claimRedisKey(decoded.userId))

    // Log them straight in — the whole point of claiming is immediate access to their inbound history.
    const { access_token, refresh_token } = issueTokens(claimed.id, claimed.role)
    await app.redis.set(`refresh:${claimed.id}`, refresh_token, 'EX', REFRESH_TTL_S)

    return reply.send({
      success: true,
      data: {
        access_token,
        refresh_token,
        user: {
          id:             claimed.id,
          phone:          claimed.phone_number ?? null,
          email:          claimed.email ?? null,
          full_name:      claimed.full_name ?? null,
          role:           claimed.role,
          email_verified: claimed.email_verified ?? false,
          created_at:     claimed.created_at,
        },
      },
    })
  })
}

// ── Internal plugin: emit the claim invite. Registered under the /internal prefix. ──

export async function consigneeInternalRoutes(app: FastifyInstance) {

  // Service-to-service secret gate, mirroring bt-booking-service/src/plugins/internal-auth.ts. These
  // routes are called by trusted siblings (booking-service), never by end-user clients, and the
  // gateway does not expose /internal/* publicly.
  app.addHook('onRequest', async (req, reply) => {
    const secret = process.env.INTERNAL_SERVICE_SECRET
    if (!secret) {
      req.log.error('INTERNAL_SERVICE_SECRET is not configured; refusing internal request')
      return reply.status(503).send({ success: false, error: 'Internal auth not configured', code: 'MISCONFIGURED' })
    }
    const provided = req.headers['x-internal-secret']
    if (typeof provided !== 'string' || provided !== secret) {
      return reply.status(401).send({ success: false, error: 'Invalid internal secret', code: 'UNAUTHORIZED' })
    }
  })

  // ── POST /consignee/claim-invite  →  /internal/consignee/claim-invite ──────────
  // booking-service calls this when it creates a NEW consignee. Emails the claim link. Does NOT require
  // the consignee to have KYC or a persona — this is a lightweight join (D-35).
  app.post('/consignee/claim-invite', async (req, reply) => {
    const body = ClaimInviteBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ success: false, error: body.error.errors[0].message })
    const { consignee_user_id } = body.data

    const { data: user, error: readErr } = await app.supabase
      .from('users').select('id, email, claimed_at, password_hash, google_sub').eq('id', consignee_user_id).maybeSingle()
    if (readErr) return reply.status(500).send({ success: false, error: 'Could not read consignee record' })
    if (!user) return reply.status(404).send({ success: false, error: 'Consignee record not found', code: 'NOT_FOUND' })

    // Only an UNCLAIMED record can be invited to claim. An already-claimed / credentialed account has
    // nothing to claim — answer 200 idempotently so a duplicate emit from booking-service is a no-op,
    // not an error that would make its outbox retry forever.
    if (user.claimed_at != null || user.password_hash != null || user.google_sub != null) {
      return reply.send({ success: true, data: { emailed: false, reason: 'already_claimed' } })
    }

    // A consignee with no email on record cannot be invited by email. This is expected in this market
    // (most receivers are phone-only, D-22) — the POD OTP remains their access path until phone-based
    // invites land (D-26). Report it plainly rather than failing.
    if (!user.email) {
      return reply.send({ success: true, data: { emailed: false, reason: 'no_email' } })
    }

    // Throttle so a retry storm cannot bomb the receiver. Silently a no-op past the cap — the caller
    // does not need to distinguish "sent" from "recently sent".
    const day = new Date().toISOString().slice(0, 10)
    const gate = await consume(app.redis, `consignee_invite:${consignee_user_id}:${day}`, INVITE_LIMIT_PER_DAY, 25 * 3600)
    if (!gate.allowed) {
      return reply.send({ success: true, data: { emailed: false, reason: 'throttled' } })
    }

    // Sign + store the single-use token, then email. Stored BEFORE the send so a slow SMTP that still
    // delivers cannot leave a live link with nothing to verify it against.
    const token = signClaimToken(consignee_user_id)
    await app.redis.set(claimRedisKey(consignee_user_id), token, 'EX', CLAIM_TTL_S)
    try {
      await sendClaimEmail(user.email, claimLinkFor(token))
    } catch (err) {
      req.log.error({ err, consignee_user_id }, 'consignee claim invite failed to send')
      return reply.status(502).send({ success: false, error: 'Could not send the claim invite', code: 'SEND_FAILED' })
    }

    return reply.status(202).send({ success: true, data: { emailed: true } })
  })
}
