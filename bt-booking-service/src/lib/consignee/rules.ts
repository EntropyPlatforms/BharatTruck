// ============================================================
// src/lib/consignee/rules.ts
//
// Responsibility: the pure rules that decide what a consignee's contact details
// MEAN. No Postgres, no Fastify — every function here is total and testable on
// its own, in the same shape as documents/rules.ts.
//
// There is exactly one idea in this file and it is worth stating plainly: the
// UNIQUE index `users_phone_number_key` is what stops one human becoming two
// parties (docs/ARCHITECTURE_UNIFIED_IDENTITY.md §9.2, "Matching"). An index can
// only dedup values that are SPELLED the same, so the normalisation below is not
// input hygiene — it is the thing that makes the dedup work at all. '+91 98765
// 43210', '098765 43210' and '9876543210' are one receiver, and storing them
// verbatim would file them as three, each with its own shipment history and its
// own claim.
// ============================================================

/**
 * The canonical shape `users.phone_number` is stored in: a bare 10-digit Indian
 * mobile number. This is not a choice made here — it is what bt-auth-service
 * already writes (`PhoneOtpBody` validates `^[6-9]\d{9}$` and /auth/verify-otp
 * inserts that exact string), so a consignee phone stored in any other shape
 * could never match the account the receiver later claims by OTP.
 */
export const INDIA_MOBILE_PATTERN = /^[6-9]\d{9}$/

/**
 * Reduce a typed-in mobile number to the stored form, or null if it is not an
 * Indian mobile at all.
 *
 * Accepts the shapes a human actually enters — a pasted contact with spaces or
 * hyphens, a country code with or without '+', the domestic trunk '0' — because
 * this is typed on a phone by a shipper reading a customer's number off a
 * WhatsApp thread. It rejects everything else rather than storing a
 * best-effort string: a wrong number here is a POD code sent to a stranger.
 *
 * Note '91' is only stripped from a 12-digit number and '0' only from an
 * 11-digit one. An Indian mobile is 10 digits starting 6-9, so neither prefix
 * can be ambiguous with a real subscriber number at those lengths.
 */
export function normalizeIndianMobile(raw: string): string | null {
  const digits = raw.replace(/[\s()\-.]/g, '').replace(/^\+/, '')

  const local =
    digits.length === 12 && digits.startsWith('91') ? digits.slice(2)
    : digits.length === 11 && digits.startsWith('0') ? digits.slice(1)
    : digits

  return INDIA_MOBILE_PATTERN.test(local) ? local : null
}

/**
 * A GSTIN is exactly 15 characters with a fixed shape: 2-digit state code,
 * 10-character PAN, entity code, a registration character (normally 'Z') and a
 * checksum.
 *
 * This regex is deliberately IDENTICAL to the `users_gstin_format` CHECK in
 * migration 0026. Two spellings of one rule drift, and the direction they drift
 * in is a 500 from the database on a request the service said was valid.
 *
 * The 14th character is not pinned to 'Z' — it varies for OIDAR and UN-body
 * registrations, and rejecting a real registration is worse than accepting an
 * unusual one. NULL/absent means UNREGISTERED, which renders as 'URP' on an LR
 * or e-way bill; the literal 'URP' is never stored.
 */
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{2}[0-9A-Z]$/

export function isGstin(value: string): boolean {
  return GSTIN_PATTERN.test(value)
}

/**
 * What a booking read may say about the consignee — and the exhaustive list of
 * it. This type IS the disclosure policy, which is why it lives with the rules
 * and not with the query that fills it: making the projection wider is a change
 * to this declaration, not something that can happen by adding a column to a
 * `select('*')`.
 *
 * Name, phone and city are the fields the carrier and the shipper need to
 * actually deliver a load — call the receiver, find the town. Deliberately
 * ABSENT, for a party who is very often not the viewer and has frequently never
 * consented to anything:
 *
 *   email   — a direct contact channel, and the one an account is recovered on;
 *   gstin   — the party's tax identity, and a business relationship they may not
 *             want disclosed to a haulier;
 *   address — the street-level drop, which the booking's own
 *             `destination_address` already carries for whoever legitimately has
 *             the booking.
 *
 * All three DO appear on the LR and the invoice, which is correct and is a
 * different disclosure: those documents are handed to the parties to the
 * consignment, per document, by the documents layer (migration 0024) — not
 * returned on every booking read to everyone who can see the row.
 */
export type ConsigneeParty = {
  name: string | null
  phone: string | null
  city: string | null
}
