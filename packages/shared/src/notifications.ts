/**
 * Shared notification primitives: the SMTP transport, the event catalogue, and the
 * outbox enqueue helper.
 *
 * This module owns the two halves of the platform's email story:
 *
 *   1. SYNCHRONOUS sends (`EmailSender`) — a code a human is actively waiting for:
 *      login OTP, magic link, password reset, POD receiver OTP. These must not go
 *      through a polled queue; the poll interval would be added to every login.
 *      bt-auth-service and bt-cargo-ledger send inline through this interface.
 *
 *   2. ASYNCHRONOUS events (`enqueueNotification`) — everything else: auctions,
 *      trip lifecycle, payments, fleet invites. These become a row in
 *      notification_outbox (migration 021) and are drained by bt-booking-service's
 *      dispatcher, with retries and a delivery audit trail. A producer NEVER blocks
 *      on SMTP and never fails a business operation because a mail server was slow.
 *
 * Both halves share one transport and one `SMTP_*` env contract so there is a single
 * mail config to operate. Before this module the transport was copy-pasted into
 * bt-auth-service (three inline functions, rebuilding the connection per send) and
 * bt-cargo-ledger — exactly the duplication the README of this package exists to stop.
 */
import { getServiceRoleClient } from './db.js'

// ---------------------------------------------------------------
// Transport
// ---------------------------------------------------------------

export type EmailMessage = {
  to: string
  subject: string
  html: string
  text: string
  /**
   * Extra headers. Used for List-Unsubscribe on opt-out-able categories — Gmail and
   * Outlook surface a native unsubscribe button when it is present, and its absence
   * on bulk-ish mail measurably raises the odds of being marked spam (which costs
   * deliverability for the OTPs that actually matter).
   */
  headers?: Record<string, string>
}

export interface EmailSender {
  send(msg: EmailMessage): Promise<void>
}

/**
 * Minimal structural type for the nodemailer transport we use. Declared here rather
 * than importing nodemailer's types so this package does not take a hard dependency
 * on nodemailer — the consuming service supplies the transport (see `createSmtpSender`).
 */
export interface MailTransport {
  sendMail(options: {
    from: string
    to: string
    subject: string
    text: string
    html: string
    headers?: Record<string, string>
  }): Promise<unknown>
}

/** Production sender: hands the message to an injected SMTP transport. */
export class SmtpEmailSender implements EmailSender {
  constructor(
    private readonly from: string,
    private readonly transport: MailTransport,
  ) {}

  async send(msg: EmailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      headers: msg.headers,
    })
  }
}

/** Dev/test sender: logs instead of reaching the network. */
export class ConsoleEmailSender implements EmailSender {
  async send(msg: EmailMessage): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(`[DEV EMAIL] to=${msg.to} subject="${msg.subject}"\n${msg.text}`)
  }
}

/**
 * Is a real SMTP transport configured?
 *
 * The single signal both halves of the system branch on, kept identical to the guard
 * bt-auth-service has always used so dev and prod behaviour cannot drift between
 * services. `EMAIL_DEV_MODE=true` forces console logging even when credentials exist.
 */
export function smtpConfigured(): boolean {
  return process.env.EMAIL_DEV_MODE !== 'true' && !!process.env.SMTP_USER
}

/**
 * Resolve the From address.
 *
 * Precedence: `SMTP_FROM` → `SMTP_USER`. There is deliberately NO hardcoded
 * `@bharattruck.in` fallback: the live transport is currently Gmail SMTP, which
 * refuses to send as an unverified From, so such a default would fail at delivery
 * time instead of surfacing as a missing-config error here.
 */
export function resolveFromAddress(): string {
  const from = process.env.SMTP_FROM ?? process.env.SMTP_USER
  if (!from) throw new Error('SMTP_FROM or SMTP_USER must be set to send email')
  return from
}

/**
 * Build the active sender for a service.
 *
 * `transportFactory` is called ONLY when SMTP is actually configured, which is what
 * lets this package stay free of a nodemailer dependency: each service passes
 * `() => nodemailer.createTransport(smtpTransportOptions())`. The transport is built
 * once per sender, not once per email — the previous bt-auth-service code opened a
 * fresh connection on every single send.
 */
export function createEmailSender(transportFactory: () => MailTransport): EmailSender {
  if (!smtpConfigured()) return new ConsoleEmailSender()
  return new SmtpEmailSender(resolveFromAddress(), transportFactory())
}

/**
 * The `SMTP_*` env contract, in one place, as nodemailer's connection options.
 *
 * Defaults to Gmail because that is what the platform is provisioned with today.
 * Gmail SMTP caps at roughly 500 recipients/day and will not send as an unverified
 * From — fine for the pilot, not fine for auction-scale fan-out. Swapping to SES /
 * Postmark / Resend is an env change only (host, port, user, pass); no code here or
 * in any template needs to move.
 */
export function smtpTransportOptions(): {
  host: string
  port: number
  secure: boolean
  auth: { user: string | undefined; pass: string | undefined }
} {
  const port = Number(process.env.SMTP_PORT ?? 587)
  return {
    host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
    port,
    // 465 is implicit TLS; 587 is STARTTLS, which nodemailer upgrades to when
    // secure=false. Deriving this from the port stops a provider swap to a 465-only
    // host from silently attempting a plaintext handshake.
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  }
}

// ---------------------------------------------------------------
// Event catalogue
// ---------------------------------------------------------------

/**
 * Every async notification the platform can emit.
 *
 * Adding one here is intentionally NOT a migration: notification_outbox.event_type is
 * free text, and the dispatcher parks an unknown event instead of crashing. That means
 * a producer can deploy ahead of the renderer without breaking the drain loop — the
 * rows simply wait for the template to ship.
 */
export type NotificationEvent =
  // ── Marketplace / auction ──────────────────────────────────────
  | 'quote_received'        // a bid landed          → shipper
  | 'quote_countered'       // price counter-offer   → the other party
  | 'quote_awarded'         // you won the load      → winning driver / fleet owner
  | 'quote_lost'            // awarded elsewhere     → losing bidders
  | 'quote_withdrawn'       // bidder pulled out     → shipper
  // ── Trip lifecycle ────────────────────────────────────────────
  | 'booking_accepted'      // a driver took the load → shipper
  | 'trip_started'          // driver rolling         → shipper
  | 'trip_completed'        // POD verified           → shipper / driver / fleet owner
  | 'booking_cancelled'     // cancelled by either side → the other party
  | 'ops_override'          // ops force-completed or reassigned → both parties
  | 'receiver_email_missing' // driver blocked at the drop, no consignee address → shipper
  // ── Payments ──────────────────────────────────────────────────
  | 'payment_settled'       // settlement recorded    → shipper (receipt)
  | 'payout_recorded'       // payout booked          → driver / fleet owner
  // ── Fleet ─────────────────────────────────────────────────────
  | 'fleet_invite'          // owner invited a driver → driver
  | 'fleet_invite_answered' // driver accepted/declined → owner
  // ── Account ───────────────────────────────────────────────────
  | 'password_changed'      // security notice        → user
  // ── Alerts ────────────────────────────────────────────────────
  | 'alert_raised'          // a scheduled check found a critical problem → its audience

/**
 * Delivery categories.
 *
 * 'transactional' is the important one: it is the category that CANNOT be opted out of,
 * and it is assigned on a strict test — would a reasonable user consider it a broken
 * product if this never arrived? Money moved, a contract was formed, or their account
 * security changed. Everything else is optional, because a fleet owner drowning in
 * marketplace chatter who cannot mute it will mark the whole domain as spam, and that
 * costs deliverability on the mail that must arrive.
 */
export type NotificationCategory = 'transactional' | 'marketplace' | 'trip_updates' | 'digest'

export const EVENT_CATEGORY: Record<NotificationEvent, NotificationCategory> = {
  quote_received:        'marketplace',
  quote_countered:       'marketplace',
  quote_awarded:         'transactional', // a contract was formed — never mutable
  quote_lost:            'marketplace',
  quote_withdrawn:       'marketplace',
  booking_accepted:      'trip_updates',
  trip_started:          'trip_updates',
  trip_completed:        'transactional', // proof of delivery — never mutable
  booking_cancelled:     'transactional', // a commitment was broken — never mutable
  ops_override:          'transactional',
  // Transactional: a truck is sitting at the drop and only this person can release
  // it. Muting it would strand the trip and the driver's payment.
  receiver_email_missing: 'transactional',
  payment_settled:       'transactional',
  payout_recorded:       'transactional',
  fleet_invite:          'transactional', // requires the recipient to act
  fleet_invite_answered: 'trip_updates',
  password_changed:      'transactional', // security notice — never mutable
  // Optional: an alert is a nudge about a state the person can already see in the app
  // (Home feed), so it rides the trip-updates preference rather than forcing delivery.
  alert_raised:          'trip_updates',
}

/** The preferences column each optional category is gated on (transactional has none). */
export const CATEGORY_PREFERENCE_COLUMN: Record<
  Exclude<NotificationCategory, 'transactional'>,
  'email_marketplace' | 'email_trip_updates' | 'email_digests'
> = {
  marketplace:  'email_marketplace',
  trip_updates: 'email_trip_updates',
  digest:       'email_digests',
}

// ---------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------

export type NotificationInput = {
  event: NotificationEvent
  /** Delivery address. A receiver/consignee has no account, so this is the only required identifier. */
  to: string
  /** Set when the recipient has an account, so the dispatcher can honour their preferences. */
  userId?: string | null
  /**
   * Everything the template needs, snapshotted at emit time. A "you won at Rs.X" email
   * must say what was true when it was sent, even if the booking changes later.
   */
  payload: Record<string, unknown>
  /**
   * Natural key of this event, for idempotency, e.g. `quote_awarded:<quoteId>`.
   * MUST include the recipient role when one event mails several people
   * (`trip_completed:<bookingId>:shipper` vs `...:driver`), or the second insert is
   * silently swallowed as a duplicate and that person is never told.
   */
  dedupeKey: string
  /** Delay the first attempt (seconds). Used for nudges/digests; default is immediate. */
  delaySeconds?: number
}

type Logger = { warn(obj: unknown, msg: string): void }

/**
 * Queue an async notification.
 *
 * Never throws. A notification failing to enqueue must not fail the business operation
 * that triggered it — awarding an auction is the real work, telling someone about it is
 * a consequence. Failures are logged, and the caller carries on. This is the same
 * best-effort contract as the ops-override audit write and the GPS breadcrumb.
 *
 * Duplicate `dedupeKey` is a SUCCESS, not an error: it means this exact event is already
 * queued or already delivered (a retried request, a saga replay, a double-clicked
 * button). Postgres reports it as unique-violation 23505, which we swallow deliberately.
 */
export async function enqueueNotification(input: NotificationInput, log?: Logger): Promise<void> {
  try {
    // Guard here rather than at the call sites: a booking with no receiver_email, or a
    // driver row whose user has no address, is a normal data condition and every
    // producer would otherwise need the same check.
    if (!input.to) return

    const nextAttempt = input.delaySeconds
      ? new Date(Date.now() + input.delaySeconds * 1000).toISOString()
      : new Date().toISOString()

    const { error } = await getServiceRoleClient()
      .from('notification_outbox')
      .insert({
        event_type:        input.event,
        recipient_email:   input.to,
        recipient_user_id: input.userId ?? null,
        payload:           input.payload,
        dedupe_key:        input.dedupeKey,
        next_attempt_at:   nextAttempt,
      })

    // 23505 = unique_violation on dedupe_key. Already queued; nothing to do.
    if (error && error.code !== '23505') {
      log?.warn(
        { err: error, event: input.event, dedupe_key: input.dedupeKey },
        'notification enqueue failed (business operation unaffected)',
      )
    }
  } catch (err) {
    log?.warn(
      { err, event: input.event, dedupe_key: input.dedupeKey },
      'notification enqueue threw (business operation unaffected)',
    )
  }
}

/**
 * Fire-and-forget wrapper for call sites that must not await.
 *
 * The enqueue is a single local INSERT, so awaiting it is usually correct and keeps the
 * ordering obvious. This exists for the handful of hot paths that already return before
 * their side effects settle (mirroring `emitTripCompleted` in bt-booking-service).
 */
export function enqueueNotificationAsync(input: NotificationInput, log?: Logger): void {
  void enqueueNotification(input, log)
}
