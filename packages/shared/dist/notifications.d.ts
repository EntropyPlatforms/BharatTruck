export type EmailMessage = {
    to: string;
    subject: string;
    html: string;
    text: string;
    /**
     * Extra headers. Used for List-Unsubscribe on opt-out-able categories — Gmail and
     * Outlook surface a native unsubscribe button when it is present, and its absence
     * on bulk-ish mail measurably raises the odds of being marked spam (which costs
     * deliverability for the OTPs that actually matter).
     */
    headers?: Record<string, string>;
};
export interface EmailSender {
    send(msg: EmailMessage): Promise<void>;
}
/**
 * Minimal structural type for the nodemailer transport we use. Declared here rather
 * than importing nodemailer's types so this package does not take a hard dependency
 * on nodemailer — the consuming service supplies the transport (see `createSmtpSender`).
 */
export interface MailTransport {
    sendMail(options: {
        from: string;
        to: string;
        subject: string;
        text: string;
        html: string;
        headers?: Record<string, string>;
    }): Promise<unknown>;
}
/** Production sender: hands the message to an injected SMTP transport. */
export declare class SmtpEmailSender implements EmailSender {
    private readonly from;
    private readonly transport;
    constructor(from: string, transport: MailTransport);
    send(msg: EmailMessage): Promise<void>;
}
/** Dev/test sender: logs instead of reaching the network. */
export declare class ConsoleEmailSender implements EmailSender {
    send(msg: EmailMessage): Promise<void>;
}
/**
 * Is a real SMTP transport configured?
 *
 * The single signal both halves of the system branch on, kept identical to the guard
 * bt-auth-service has always used so dev and prod behaviour cannot drift between
 * services. `EMAIL_DEV_MODE=true` forces console logging even when credentials exist.
 */
export declare function smtpConfigured(): boolean;
/**
 * Resolve the From address.
 *
 * Precedence: `SMTP_FROM` → `SMTP_USER`. There is deliberately NO hardcoded
 * `@bharattruck.in` fallback: the live transport is currently Gmail SMTP, which
 * refuses to send as an unverified From, so such a default would fail at delivery
 * time instead of surfacing as a missing-config error here.
 */
export declare function resolveFromAddress(): string;
/**
 * Build the active sender for a service.
 *
 * `transportFactory` is called ONLY when SMTP is actually configured, which is what
 * lets this package stay free of a nodemailer dependency: each service passes
 * `() => nodemailer.createTransport(smtpTransportOptions())`. The transport is built
 * once per sender, not once per email — the previous bt-auth-service code opened a
 * fresh connection on every single send.
 */
export declare function createEmailSender(transportFactory: () => MailTransport): EmailSender;
/**
 * The `SMTP_*` env contract, in one place, as nodemailer's connection options.
 *
 * Defaults to Gmail because that is what the platform is provisioned with today.
 * Gmail SMTP caps at roughly 500 recipients/day and will not send as an unverified
 * From — fine for the pilot, not fine for auction-scale fan-out. Swapping to SES /
 * Postmark / Resend is an env change only (host, port, user, pass); no code here or
 * in any template needs to move.
 */
export declare function smtpTransportOptions(): {
    host: string;
    port: number;
    secure: boolean;
    auth: {
        user: string | undefined;
        pass: string | undefined;
    };
};
/**
 * Every async notification the platform can emit.
 *
 * Adding one here is intentionally NOT a migration: notification_outbox.event_type is
 * free text, and the dispatcher parks an unknown event instead of crashing. That means
 * a producer can deploy ahead of the renderer without breaking the drain loop — the
 * rows simply wait for the template to ship.
 */
export type NotificationEvent = 'quote_received' | 'quote_countered' | 'quote_awarded' | 'quote_lost' | 'quote_withdrawn' | 'booking_accepted' | 'trip_started' | 'trip_completed' | 'booking_cancelled' | 'ops_override' | 'receiver_email_missing' | 'payment_settled' | 'payout_recorded' | 'fleet_invite' | 'fleet_invite_answered' | 'password_changed' | 'alert_raised';
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
export type NotificationCategory = 'transactional' | 'marketplace' | 'trip_updates' | 'digest';
export declare const EVENT_CATEGORY: Record<NotificationEvent, NotificationCategory>;
/** The preferences column each optional category is gated on (transactional has none). */
export declare const CATEGORY_PREFERENCE_COLUMN: Record<Exclude<NotificationCategory, 'transactional'>, 'email_marketplace' | 'email_trip_updates' | 'email_digests'>;
export type NotificationInput = {
    event: NotificationEvent;
    /** Delivery address. A receiver/consignee has no account, so this is the only required identifier. */
    to: string;
    /** Set when the recipient has an account, so the dispatcher can honour their preferences. */
    userId?: string | null;
    /**
     * Everything the template needs, snapshotted at emit time. A "you won at Rs.X" email
     * must say what was true when it was sent, even if the booking changes later.
     */
    payload: Record<string, unknown>;
    /**
     * Natural key of this event, for idempotency, e.g. `quote_awarded:<quoteId>`.
     * MUST include the recipient role when one event mails several people
     * (`trip_completed:<bookingId>:shipper` vs `...:driver`), or the second insert is
     * silently swallowed as a duplicate and that person is never told.
     */
    dedupeKey: string;
    /** Delay the first attempt (seconds). Used for nudges/digests; default is immediate. */
    delaySeconds?: number;
};
type Logger = {
    warn(obj: unknown, msg: string): void;
};
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
export declare function enqueueNotification(input: NotificationInput, log?: Logger): Promise<void>;
/**
 * Fire-and-forget wrapper for call sites that must not await.
 *
 * The enqueue is a single local INSERT, so awaiting it is usually correct and keeps the
 * ordering obvious. This exists for the handful of hot paths that already return before
 * their side effects settle (mirroring `emitTripCompleted` in bt-booking-service).
 */
export declare function enqueueNotificationAsync(input: NotificationInput, log?: Logger): void;
export {};
