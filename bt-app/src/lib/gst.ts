/**
 * GSTIN / PAN rules, client side — the same checks bt-auth-service/src/lib/gst.ts makes, with
 * the same messages, so the form explains a bad number before the round trip.
 *
 * A GSTIN is: state code (2 digits), the registrant's PAN (10), an entity number, the letter
 * Z, and a check character computed over the first 14 (GSTN's mod-36 scheme). Shape alone
 * let "99ZZZZZ9999Z9Z9" through; these refuse it.
 */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const STATE_CODES = new Set([...Array.from({ length: 38 }, (_, i) => String(i + 1).padStart(2, '0')), '97', '99'])

export const PAN_RE = /^[A-Z]{3}[ABCFGHLJPT][A-Z][0-9]{4}[A-Z]$/
export const GSTIN_SHAPE_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

export function gstinCheckDigit(first14: string): string {
  let sum = 0
  for (let i = 0; i < 14; i++) {
    const value = ALPHABET.indexOf(first14[i])
    const product = value * (i % 2 === 0 ? 1 : 2)
    sum += Math.floor(product / 36) + (product % 36)
  }
  return ALPHABET[(36 - (sum % 36)) % 36]
}

export const panOfGstin = (gstin: string) => gstin.slice(2, 12)

/** null when valid; otherwise what is wrong with it, in one sentence. */
export function gstinProblem(raw: string): string | null {
  const g = raw.trim().toUpperCase()
  if (g.length !== 15) return 'A GSTIN is 15 characters.'
  if (!GSTIN_SHAPE_RE.test(g)) return 'That is not the GSTIN format: 2 digits, 5 letters, 4 digits, a letter, a digit or letter, Z, and a check character (e.g. 27AAPFU0939F1ZV).'
  if (!STATE_CODES.has(g.slice(0, 2))) return `"${g.slice(0, 2)}" is not a GST state code.`
  if (!PAN_RE.test(panOfGstin(g))) return 'Characters 3–12 of a GSTIN are the PAN, and these do not form a valid PAN.'
  if (gstinCheckDigit(g.slice(0, 14)) !== g[14]) return 'The last character does not match the rest of the number — one of the characters is mistyped.'
  return null
}

export function panProblem(raw: string): string | null {
  const p = raw.trim().toUpperCase()
  if (p.length !== 10) return 'A PAN is 10 characters.'
  if (!PAN_RE.test(p)) return 'That is not the PAN format: 5 letters, 4 digits, a letter (e.g. ABCPD1234E).'
  return null
}

export const panMatchesGstin = (pan: string, gstin: string) =>
  panOfGstin(gstin.trim().toUpperCase()) === pan.trim().toUpperCase()
