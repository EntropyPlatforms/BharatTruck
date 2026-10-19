// -----------------------------------------------------------
// EmailSender — thin swappable interface. Prod uses SmtpEmailSender; local dev
// uses ConsoleEmailSender; tests inject a mock. Nothing else in the POD flow
// knows which transport is active.
//
// SMTP (nodemailer) is the platform-wide transactional channel — bt-auth-service
// already sends every login OTP / verification / magic link through it, and this
// service reuses the SAME `SMTP_*` env contract so there is one mail config to
// operate rather than two. An earlier revision of this file used Resend and
// described it as a settled decision; it was not — `docs/BIBLE.md` Appendix A
// T-CTO-1 ("pick the email provider") is still open, and no Resend key was ever
// provisioned, so POD mail silently degraded to console logging in production.
// -----------------------------------------------------------

import nodemailer, { type Transporter } from 'nodemailer'

export type EmailMessage = {
  to: string
  subject: string
  html: string
  text: string
}

export interface EmailSender {
  send(msg: EmailMessage): Promise<void>
}

/** Production sender: SMTP via nodemailer (same transport as bt-auth-service). */
export class SmtpEmailSender implements EmailSender {
  private readonly transport: Transporter

  constructor(private readonly from: string, transport?: Transporter) {
    // Built once per instance — the sender is constructed at route registration,
    // so we do not open a fresh connection per email. `transport` is injectable
    // so tests can assert on send() without reaching the network.
    this.transport =
      transport ??
      nodemailer.createTransport({
        host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      })
  }

  async send(msg: EmailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    })
  }
}

/** Local-dev sender: logs the message instead of hitting a provider. */
export class ConsoleEmailSender implements EmailSender {
  async send(msg: EmailMessage): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(`[DEV EMAIL] to=${msg.to} subject="${msg.subject}"\n${msg.text}`)
  }
}

/** Pick the sender from env: SMTP when credentials are present, else dev console.
 *  Mirrors bt-auth-service's guard (`EMAIL_DEV_MODE` / `SMTP_USER`) so both
 *  services fall silent in dev and go live in prod on exactly the same signal.
 *
 *  From-address precedence: `POD_EMAIL_FROM` (POD-specific override, for once a
 *  verified sending domain exists) → `SMTP_FROM` → `SMTP_USER`. It deliberately
 *  does NOT fall back to a hardcoded `@bharattruck.in` address: the live transport
 *  is Gmail SMTP, which refuses to send as an unverified From, so that default
 *  would fail at delivery time instead of surfacing here. */
export function defaultEmailSender(): EmailSender {
  if (process.env.EMAIL_DEV_MODE === 'true' || !process.env.SMTP_USER) {
    return new ConsoleEmailSender()
  }
  const from = process.env.POD_EMAIL_FROM ?? process.env.SMTP_FROM ?? process.env.SMTP_USER
  return new SmtpEmailSender(from)
}

/** Build the delivery-confirmation email body for a POD OTP.
 *  The receiver confirms delivery THEMSELVES on the public receiver page
 *  (`RECEIVER_APP_BASE_URL/pod/:bookingId`) — not by handing the code to the
 *  driver. When RECEIVER_APP_BASE_URL is set we include a direct link to that
 *  page plus the code; if it is unset we gracefully fall back to code-only
 *  copy (no crash) so the flow still works in environments without the base URL. */
export function buildOtpEmail(
  to: string,
  otp: string,
  ttlMinutes: number,
  bookingId: string,
): EmailMessage {
  const subject = 'Your BharatTruck delivery confirmation code'
  const base = process.env.RECEIVER_APP_BASE_URL?.replace(/\/+$/, '')
  const link = base ? `${base}/pod/${bookingId}` : null

  const text = link
    ? `Open this link and enter your delivery code to confirm you received the shipment:\n` +
      `${link}\n\n` +
      `Your delivery code is ${otp}.\n` +
      `It expires in ${ttlMinutes} minutes. If you did not expect this, ignore this email.`
    : `Your BharatTruck delivery confirmation code is ${otp}.\n` +
      `Enter this code to confirm you received the shipment.\n` +
      `It expires in ${ttlMinutes} minutes. If you did not expect this, ignore this email.`

  const html = link
    ? `<p>Open this link and enter your delivery code to confirm you received the shipment:</p>` +
      `<p><a href="${link}">${link}</a></p>` +
      `<p>Your delivery code is <strong style="font-size:20px">${otp}</strong>. ` +
      `It expires in ${ttlMinutes} minutes.</p>` +
      `<p>If you did not expect this, please ignore this email.</p>`
    : `<p>Your BharatTruck delivery confirmation code is <strong style="font-size:20px">${otp}</strong>.</p>` +
      `<p>Enter this code to confirm you received the shipment. ` +
      `It expires in ${ttlMinutes} minutes.</p>` +
      `<p>If you did not expect this, please ignore this email.</p>`

  return { to, subject, html, text }
}
