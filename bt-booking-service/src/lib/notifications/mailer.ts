// ============================================================
// src/lib/notifications/mailer.ts
//
// The one place this service constructs an SMTP transport.
//
// @bharattruck/shared/notifications owns the EmailSender contract and the SMTP_*
// env contract but deliberately does not depend on nodemailer — each service
// supplies the transport, which is what keeps the shared package installable by
// anything (including the frontends' type-only imports) without dragging a mail
// client along. This file is that supply.
// ============================================================

import nodemailer from 'nodemailer'
import {
  createEmailSender,
  smtpConfigured,
  smtpTransportOptions,
  type EmailSender,
} from '@bharattruck/shared/notifications'

let cached: EmailSender | null = null

/**
 * The process-wide sender.
 *
 * Memoised because the transport holds a connection pool — building one per send
 * (which is what bt-auth-service did before this change) means a fresh TCP + TLS
 * handshake for every email. Falls back to the console sender when SMTP is not
 * configured, so local dev and tests never reach the network.
 */
export function mailer(): EmailSender {
  if (!cached) {
    cached = createEmailSender(() => nodemailer.createTransport(smtpTransportOptions()))
  }
  return cached
}

/** Test seam: swap the sender (pass null to restore the real one). */
export function __setMailerForTests(sender: EmailSender | null): void {
  cached = sender
}

export { smtpConfigured }
