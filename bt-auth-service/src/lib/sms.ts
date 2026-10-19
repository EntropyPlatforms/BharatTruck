// -----------------------------------------------------------
// The one seam every phone OTP leaves this service through.
//
// In India sending an OTP is a registration problem before it is a code problem.
// TRAI's DLT regime requires a registered principal entity, a registered sender
// header, and a PRE-APPROVED template before an operator will carry a commercial
// SMS; registration runs weeks and has not been started (docs/BLOCKERS.md B-2).
// So today every phone OTP is printed to the server log and read out from there.
//
// This file exists so that the day DLT clears, turning SMS on is setting env vars
// on the Cloud Run service — not editing a route that also owns the per-phone rate
// limit, the Redis TTL and the user upsert. That is decision D-14 in
// docs/ARCHITECTURE_UNIFIED_IDENTITY.md: one seam, every send site through it.
//
// Two rules the shape deliberately encodes:
//
//   1. Live SMS is OPT-IN and ALL-OR-NOTHING. `SMS_PROVIDER` must name a provider
//      AND every credential that provider needs must be present, or we fall back
//      to the console. Half-configured must not throw: a deploy that forgot
//      MSG91_TEMPLATE_ID would otherwise take phone login down entirely. It must
//      not attempt the send either — an unregistered template is rejected by the
//      operator, and a run of rejections is what gets a sender header suspended,
//      which is weeks of DLT work to undo.
//
//   2. The "not wired" warning is emitted ONCE, when the provider is resolved at
//      boot. Per-send it would be one identical line per OTP, burying the code an
//      operator is trying to read out of that same log.
//
// Nothing here reads or writes Redis, and nothing here decides whether a send is
// allowed — that stays in the route, so the throttle cannot be bypassed by adding
// a second call site later.
// -----------------------------------------------------------

/** Thrown when a provider was asked to deliver and the operator refused. */
export class SmsSendError extends Error {
  constructor(public readonly provider: string, message: string) {
    super(`sms[${provider}]: ${message}`)
    this.name = 'SmsSendError'
  }
}

export interface SmsProvider {
  /** Stable id, for the boot line and for tests. */
  readonly name: 'console' | 'msg91' | 'twilio'
  /**
   * Deliver a one-time code to a BARE 10-digit Indian mobile number (no +91, no
   * spaces — the route's zod schema has already enforced /^[6-9]\d{9}$/).
   *
   * Throws SmsSendError when delivery was refused. The caller must not answer
   * "OTP sent" for a code that never left the building — the user would sit on a
   * verify screen waiting for an SMS that is never coming. The console provider
   * never throws, which is what keeps today's behaviour byte-identical.
   */
  sendOtp(phone: string, otp: string): Promise<void>
}

// ── console ───────────────────────────────────────────────────────────────────

/**
 * The default, and the only provider that runs today. Prints the code exactly as
 * this service printed it before the seam existed — the pilot runbook and the QA
 * scripts grep for these two lines, so the wording is load-bearing, not cosmetic.
 */
export class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console' as const

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async sendOtp(phone: string, otp: string): Promise<void> {
    if (this.env.OTP_DEV_MODE === 'true' || this.env.NODE_ENV === 'development') {
      console.log(`[DEV] Phone OTP for +91${phone}: ${otp}`)
    } else {
      console.log(`[WARN] No SMS provider configured — OTP for ${phone}: ${otp}`)
    }
  }
}

// ── MSG91 ─────────────────────────────────────────────────────────────────────

/**
 * Every var that must be present before a single byte goes to MSG91. All three
 * come out of DLT registration, not out of the MSG91 dashboard alone:
 * the sender id is the registered header, the template id is the approved
 * template. Missing any one of them means the send would be rejected downstream,
 * so the resolver refuses to build this provider at all.
 */
export const MSG91_REQUIRED_ENV = ['MSG91_AUTH_KEY', 'MSG91_SENDER_ID', 'MSG91_TEMPLATE_ID'] as const

export type Msg91Config = {
  authKey:    string
  senderId:   string
  templateId: string
  /**
   * Name of the variable the approved DLT template exposes for the code. The
   * template text is fixed at approval time (e.g. "Your BharatTruck code is
   * ##OTP##"), so this has to match whatever was registered — it is not ours to
   * choose after the fact. Defaults to the conventional `otp`.
   */
  templateVar: string
  /** Some operators want the DLT template entity id echoed on the send. */
  dltTeId:   string | null
  baseUrl:   string
  timeoutMs: number
}

/** Only the two fields that decide success; MSG91 returns more and may add more. */
type Msg91Reply = { type?: string; message?: unknown }

export class Msg91SmsProvider implements SmsProvider {
  readonly name = 'msg91' as const

  constructor(private readonly cfg: Msg91Config) {}

  async sendOtp(phone: string, otp: string): Promise<void> {
    let res: Response
    try {
      res = await fetch(`${this.cfg.baseUrl}/api/v5/flow`, {
        method: 'POST',
        headers: {
          authkey:        this.cfg.authKey,
          'content-type': 'application/json',
          accept:         'application/json',
        },
        body: JSON.stringify({
          template_id: this.cfg.templateId,
          sender:      this.cfg.senderId,
          short_url:   '0',
          ...(this.cfg.dltTeId ? { DLT_TE_ID: this.cfg.dltTeId } : {}),
          // We mint the code ourselves with crypto.randomInt and store it in Redis
          // before we get here, so we use the flow endpoint (which sends a value we
          // supply) rather than MSG91's OTP endpoint (which generates and holds its
          // own code). Two sources of truth for a bearer credential is a bug.
          recipients: [{ mobiles: `91${phone}`, [this.cfg.templateVar]: otp }],
        }),
        // A hung provider must not hold the request open: the user is watching a
        // spinner, and the code is already in Redis with its own TTL running.
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      })
    } catch (err) {
      // Network failure or timeout. The message is ours, not the provider's, so
      // nothing from the request body can reach the log by accident.
      throw new SmsSendError(this.name, err instanceof Error ? err.message : 'request failed')
    }

    // MSG91 answers 200 with `{"type":"error"}` for a rejected send — a template
    // that is not approved, a header that is not registered, a spent balance — so
    // res.ok on its own would report a delivery that never happened.
    const raw = await res.text()
    let parsed: Msg91Reply | null = null
    try { parsed = JSON.parse(raw) as Msg91Reply } catch { parsed = null }

    if (!res.ok) {
      // Status only. The error body can echo the request payload back, and that
      // payload carries the live OTP — logging it would put a working credential
      // in the log with none of the Redis TTL protections around it.
      throw new SmsSendError(this.name, `HTTP ${res.status}`)
    }
    if (parsed?.type === 'error') {
      const detail = typeof parsed.message === 'string' ? parsed.message.slice(0, 200) : 'rejected'
      throw new SmsSendError(this.name, detail)
    }
  }
}

// ── Twilio ────────────────────────────────────────────────────────────────────

/**
 * The account credentials, and nothing else — the sender is checked separately
 * because Twilio accepts two mutually exclusive forms of it (see TwilioConfig).
 */
export const TWILIO_REQUIRED_ENV = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'] as const

/**
 * Twilio wants E.164, the route hands us a bare 10-digit number (its zod schema is
 * /^[6-9]\d{9}$/), so the two are reconciled here rather than in the route — the
 * route's shape is what every other provider and the Redis OTP key are built on,
 * and widening it for one provider would ripple through all of them.
 *
 * This is the ONE line that changes if BharatTruck ever carries a non-India phone
 * number. It is India-only today by product decision, not by accident.
 */
const INDIA_E164_PREFIX = '+91'

export type TwilioConfig = {
  accountSid: string
  authToken:  string
  /**
   * Exactly one of these is used, and the messaging service wins when both are
   * set: a Messaging Service carries the sender pool, the geo-permissions and the
   * regulatory/compliance bundle, so sending through it is strictly more correct
   * than pinning one raw From number. Twilio rejects a request carrying both.
   */
  messagingServiceSid: string | null
  from:                string | null
  baseUrl:   string
  timeoutMs: number
}

/** Twilio's documented error envelope; it returns more fields and may add more. */
type TwilioReply = { code?: unknown; message?: unknown }

/**
 * DLT applies to the DESTINATION, not to the vendor: an Indian operator will drop a
 * transactional SMS whose entity/header/template are not registered on the DLT
 * portal no matter whose API put it on the wire (docs/BLOCKERS.md B-2). So correct
 * Twilio credentials are necessary and not sufficient — an unregistered sender can
 * authenticate cleanly and still be refused downstream. That refusal surfaces as a
 * Twilio error code/message on the throw below, which is the whole point: an
 * operator reading the log can tell "wrong credentials" from "not registered yet".
 * Until registration completes, leaving SMS_PROVIDER unset keeps every phone flow
 * alive on the console provider, and nothing in this file changes when it does.
 */
export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio' as const

  constructor(private readonly cfg: TwilioConfig) {}

  async sendOtp(phone: string, otp: string): Promise<void> {
    // Twilio's REST API is form-encoded, NOT JSON — a JSON body is accepted by the
    // socket and then rejected as a missing-parameter error, which reads like a
    // credential problem and is not one.
    const form = new URLSearchParams({
      To:   `${INDIA_E164_PREFIX}${phone}`,
      Body: `${otp} is your BharatTruck verification code. Do not share it with anyone.`,
    })
    if (this.cfg.messagingServiceSid) form.set('MessagingServiceSid', this.cfg.messagingServiceSid)
    else if (this.cfg.from) form.set('From', this.cfg.from)

    let res: Response
    try {
      res = await fetch(`${this.cfg.baseUrl}/2010-04-01/Accounts/${encodeURIComponent(this.cfg.accountSid)}/Messages.json`, {
        method: 'POST',
        headers: {
          authorization:  `Basic ${Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept:         'application/json',
        },
        body: form.toString(),
        // Same reason as MSG91: the user is on a spinner and the code is already in
        // Redis with its own TTL running, so a hung provider must not hold the
        // request open until the platform's own timeout kills it.
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      })
    } catch (err) {
      throw new SmsSendError(this.name, err instanceof Error ? err.message : 'request failed')
    }

    // Unlike MSG91, Twilio does not hide a rejection behind a 200 — a refused send
    // is a non-2xx with `{code, message}`. So the body is only read on failure, and
    // res.ok is trusted on success.
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      let parsed: TwilioReply | null = null
      try { parsed = JSON.parse(raw) as TwilioReply } catch { parsed = null }
      // The numeric code is what an operator acts on — 21608 is an unverified
      // trial number, 21211 a malformed To, 20003 bad credentials — so it is
      // surfaced verbatim. Only the two known fields are read: the raw body can
      // echo the request back, and that request carries the live OTP.
      const code = typeof parsed?.code === 'number' || typeof parsed?.code === 'string' ? String(parsed.code) : null
      const detail = typeof parsed?.message === 'string' ? parsed.message.slice(0, 200) : null
      throw new SmsSendError(
        this.name,
        `HTTP ${res.status}${code ? ` code ${code}` : ''}${detail ? `: ${detail}` : ''}`,
      )
    }
  }
}

// ── resolution ────────────────────────────────────────────────────────────────

export type SmsProviderResolution = {
  provider: SmsProvider
  /**
   * Non-null whenever phone OTPs are landing in a log instead of on a handset,
   * with the reason. Callers log this ONCE; it is the difference between an
   * operator knowing SMS is off and a user reporting "I never got the code".
   */
  unwiredReason: string | null
}

/**
 * Pure: takes an env bag, returns a provider. No logging, no memoisation, no
 * process.env reads beyond the bag it was handed — which is what lets a test pin
 * several configurations inside one process.
 */
export function resolveSmsProvider(env: NodeJS.ProcessEnv = process.env): SmsProviderResolution {
  const selected = (env.SMS_PROVIDER ?? '').trim().toLowerCase()

  if (!selected) {
    return {
      provider: new ConsoleSmsProvider(env),
      unwiredReason: 'SMS_PROVIDER is unset',
    }
  }

  if (selected === 'console') {
    return {
      provider: new ConsoleSmsProvider(env),
      unwiredReason: 'SMS_PROVIDER=console',
    }
  }

  if (selected === 'msg91') {
    const missing = MSG91_REQUIRED_ENV.filter(k => !(env[k] ?? '').trim())
    if (missing.length > 0) {
      // Fall back rather than throw: a missing credential is an ops mistake, and
      // taking phone login down is a worse outcome than logging the code.
      return {
        provider: new ConsoleSmsProvider(env),
        unwiredReason: `SMS_PROVIDER=msg91 but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} unset`,
      }
    }
    return {
      provider: new Msg91SmsProvider({
        authKey:     env.MSG91_AUTH_KEY!.trim(),
        senderId:    env.MSG91_SENDER_ID!.trim(),
        templateId:  env.MSG91_TEMPLATE_ID!.trim(),
        templateVar: (env.MSG91_TEMPLATE_VAR ?? '').trim() || 'otp',
        dltTeId:     (env.MSG91_DLT_TE_ID ?? '').trim() || null,
        baseUrl:     ((env.MSG91_BASE_URL ?? '').trim() || 'https://control.msg91.com').replace(/\/+$/, ''),
        timeoutMs:   Number(env.SMS_TIMEOUT_MS) > 0 ? Number(env.SMS_TIMEOUT_MS) : 8000,
      }),
      unwiredReason: null,
    }
  }

  if (selected === 'twilio') {
    const missing: string[] = TWILIO_REQUIRED_ENV.filter(k => !(env[k] ?? '').trim())
    const messagingServiceSid = (env.TWILIO_MESSAGING_SERVICE_SID ?? '').trim() || null
    const from = (env.TWILIO_FROM ?? '').trim() || null
    // A send with neither a Messaging Service nor a From number is rejected by
    // Twilio every time, so it counts as missing config exactly like a missing
    // credential — fall back rather than burn a request per login attempt.
    if (!messagingServiceSid && !from) missing.push('TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM')
    if (missing.length > 0) {
      return {
        provider: new ConsoleSmsProvider(env),
        unwiredReason: `SMS_PROVIDER=twilio but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} unset`,
      }
    }
    return {
      provider: new TwilioSmsProvider({
        accountSid: env.TWILIO_ACCOUNT_SID!.trim(),
        authToken:  env.TWILIO_AUTH_TOKEN!.trim(),
        // Preferred over `from`, and the provider sends only one of the two —
        // Twilio rejects a request that carries both.
        messagingServiceSid,
        from,
        baseUrl:    ((env.TWILIO_BASE_URL ?? '').trim() || 'https://api.twilio.com').replace(/\/+$/, ''),
        timeoutMs:  Number(env.SMS_TIMEOUT_MS) > 0 ? Number(env.SMS_TIMEOUT_MS) : 8000,
      }),
      unwiredReason: null,
    }
  }

  return {
    provider: new ConsoleSmsProvider(env),
    // Sliced: this is an unvalidated env value being written to a log.
    unwiredReason: `SMS_PROVIDER='${selected.slice(0, 32)}' is not a known provider`,
  }
}

let cached: SmsProvider | null = null

/**
 * Process-wide provider. Resolved and announced on first call — index.ts makes
 * that call during bootstrap so the banner appears at startup rather than in the
 * middle of the first user's login.
 *
 * console.* rather than app.log deliberately: this runs outside any request and
 * before the Fastify logger is necessarily available, and the console provider's
 * own output already goes here — an operator reading OTPs out of the log needs
 * the "SMS is not wired" line in the same stream, not in a different one.
 */
export function getSmsProvider(): SmsProvider {
  if (!cached) {
    const { provider, unwiredReason } = resolveSmsProvider()
    if (unwiredReason) {
      console.warn(
        `[sms] ${unwiredReason} — phone OTPs are printed to this log and NOT sent by SMS. ` +
        `Wiring needs TRAI DLT registration first (docs/BLOCKERS.md B-2).`,
      )
    } else {
      console.log(`[sms] provider=${provider.name} — phone OTPs are delivered by SMS`)
    }
    cached = provider
  }
  return cached
}
