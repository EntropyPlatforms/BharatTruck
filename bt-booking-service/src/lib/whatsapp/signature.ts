import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Meta signs every webhook POST with HMAC-SHA256 of the RAW body, keyed by the app secret,
 * in `X-Hub-Signature-256: sha256=<hex>`. Anything that fails this check did not come from
 * Meta and is dropped before it is parsed or acted on.
 */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header || !header.startsWith('sha256=')) return false
  const given = Buffer.from(header.slice('sha256='.length), 'hex')
  const expected = createHmac('sha256', appSecret).update(rawBody).digest()
  // Length first: timingSafeEqual throws on unequal lengths, and a short header is simply wrong.
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** Constant-time string comparison for the one-off webhook verify token. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}
