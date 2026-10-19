// -----------------------------------------------------------
// GSTIN / PAN rules — the whole of what a number itself can prove.
//
// A GSTIN is 15 characters: state code (2 digits), the registrant's PAN (10), an entity
// number within the state (1), the letter Z, and a CHECK DIGIT computed over the first 14
// characters (GSTN's mod-36 scheme). The old format regex accepted anything of the right
// SHAPE — "99ZZZZZ9999Z9Z9" passed (UAT BT-11). These checks add the state code, the PAN
// embedded in the GSTIN, and the check digit, so a mistyped or invented number is refused.
//
// None of this says the registration EXISTS or is active — that is the KYC provider's
// verifyGstin, when a vendor is configured. This is the free, offline half.
//
// Mirrored in bt-app/src/lib/gst.ts (client-side, same messages) and, for the check digit
// alone, in bt-fleet-service/src/routes/owners.ts.
// -----------------------------------------------------------

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** GST state codes in use: 01–38 for states and UTs, 97 for other territory, 99 for the Centre. */
const STATE_CODES = new Set([
  ...Array.from({ length: 38 }, (_, i) => String(i + 1).padStart(2, '0')),
  '97', '99',
])

export const PAN_RE = /^[A-Z]{3}[ABCFGHLJPT][A-Z][0-9]{4}[A-Z]$/
export const GSTIN_SHAPE_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

/** The check character GSTN's algorithm produces for the first 14 characters. */
export function gstinCheckDigit(first14: string): string {
  let sum = 0
  for (let i = 0; i < 14; i++) {
    const value = ALPHABET.indexOf(first14[i])
    const product = value * (i % 2 === 0 ? 1 : 2)
    sum += Math.floor(product / 36) + (product % 36)
  }
  return ALPHABET[(36 - (sum % 36)) % 36]
}

/** The PAN a GSTIN was issued against — characters 3 to 12. */
export const panOfGstin = (gstin: string) => gstin.slice(2, 12)

/** null when valid; otherwise one sentence saying what is wrong, for the person typing it. */
export function gstinProblem(raw: string): string | null {
  const g = raw.trim().toUpperCase()
  if (g.length !== 15) return 'A GSTIN is 15 characters.'
  if (!GSTIN_SHAPE_RE.test(g)) return 'That is not the GSTIN format: 2 digits, 5 letters, 4 digits, a letter, a digit or letter, Z, and a check character (e.g. 27AAPFU0939F1ZV).'
  if (!STATE_CODES.has(g.slice(0, 2))) return `"${g.slice(0, 2)}" is not a GST state code.`
  if (!PAN_RE.test(panOfGstin(g))) return 'Characters 3–12 of a GSTIN are the PAN, and these do not form a valid PAN.'
  if (gstinCheckDigit(g.slice(0, 14)) !== g[14]) return 'The last character does not match the rest of the number — one of the characters is mistyped.'
  return null
}

export const isValidGstin = (raw: string) => gstinProblem(raw) === null

export function panProblem(raw: string): string | null {
  const p = raw.trim().toUpperCase()
  if (p.length !== 10) return 'A PAN is 10 characters.'
  if (!PAN_RE.test(p)) return 'That is not the PAN format: 5 letters, 4 digits, a letter (e.g. ABCPD1234E); the 4th letter is the holder type (P person, C company, F firm…).'
  return null
}

export const isValidPan = (raw: string) => panProblem(raw) === null

/** Both given and both valid: do they belong to the same registrant? */
export function panMatchesGstin(pan: string, gstin: string): boolean {
  return panOfGstin(gstin.trim().toUpperCase()) === pan.trim().toUpperCase()
}
