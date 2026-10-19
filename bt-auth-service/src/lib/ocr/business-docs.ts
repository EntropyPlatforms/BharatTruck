// -----------------------------------------------------------
// business-docs — the fields on a GST registration certificate (Form GST REG-06) and a PAN
// card, read off OCR text. Pure, like driver-docs.ts, and under the same rule: a field that
// cannot be read with confidence is null, never a guess, and the person confirms the form.
//
// A GSTIN found on the certificate is returned ONLY if it passes the full GSTIN check
// (state code, embedded PAN, check digit — lib/gst.ts): OCR confuses 0/O, 1/I, 5/S, 8/B, and
// a GSTIN with one such slip is worse than no GSTIN, because the form would look filled.
// The same for the PAN on a PAN card.
// -----------------------------------------------------------

import { GSTIN_SHAPE_RE, PAN_RE, isValidGstin, isValidPan, panOfGstin } from '../gst.js'

export type GstCertificateFields = {
  gstin: string | null
  /** The PAN embedded in the GSTIN — present whenever the GSTIN is. */
  pan: string | null
  legal_name: string | null
  trade_name: string | null
  /** 'Proprietorship', 'Private Limited Company', 'Partnership', … as printed. */
  constitution: string | null
  address: string | null
  /** ISO yyyy-mm-dd — "Date of Liability" / "Date of Validity From". */
  registered_from: string | null
}

export type PanCardFields = {
  pan: string | null
  name: string | null
  /** ISO yyyy-mm-dd — a person's date of birth or a company's date of incorporation. */
  date_of_birth: string | null
  /** From the 4th letter of the PAN. */
  holder_type: 'person' | 'company' | 'firm' | 'huf' | 'trust' | 'other' | null
}

const lines = (text: string) => text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean)

// OCR's usual slips on a fixed-shape code, by position class: letters that are really digits
// and digits that are really letters.
const TO_DIGIT: Record<string, string> = { O: '0', D: '0', Q: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6' }
const TO_LETTER: Record<string, string> = { '0': 'O', '1': 'I', '5': 'S', '8': 'B', '6': 'G', '2': 'Z' }

function isoDate(d: number, m: number, y: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1950 || y > 2100) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCDate() !== d || dt.getUTCMonth() !== m - 1) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function firstDate(s: string): string | null {
  const m = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/.exec(s)
  return m ? isoDate(Number(m[1]), Number(m[2]), Number(m[3])) : null
}

/** "RAMESH KUMAR PATIL." -> "Ramesh Kumar Patil"; null unless it reads as a name. */
function cleanName(raw: string): string | null {
  const s = raw.replace(/[^A-Za-z .'&()-]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[.' ]+|[.' ]+$/g, '')
  if (s.length < 3 || s.length > 80 || !/[A-Za-z]{2,}/.test(s)) return null
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\b(Llp|Pvt|Ltd|Opc)\b/g, (w) => w.toUpperCase())
}

/** The value after a label on the same line, or the next line when the label stands alone. */
function valueAfter(ls: string[], label: RegExp): string | null {
  for (let i = 0; i < ls.length; i++) {
    const m = label.exec(ls[i])
    if (!m) continue
    const rest = ls[i].slice(m.index + m[0].length).replace(/^[\s:.\-–]+/, '').trim()
    if (rest) return rest
    const next = ls[i + 1]
    if (next && !/:\s*$/.test(next)) return next
  }
  return null
}

/**
 * A 10-character PAN-shaped token with OCR slips corrected per position (letters where
 * letters belong, digits where digits belong). Returns the corrected PAN or null.
 */
export function normalisePan(token: string): string | null {
  const t = token.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (t.length !== 10) return null
  const out = t.split('').map((c, i) => {
    const wantLetter = i < 5 || i === 9
    if (wantLetter) return /[A-Z]/.test(c) ? c : TO_LETTER[c] ?? c
    return /[0-9]/.test(c) ? c : TO_DIGIT[c] ?? c
  }).join('')
  return PAN_RE.test(out) ? out : null
}

/** Same for a 15-character GSTIN-shaped token: positions decide what each character must be. */
export function normaliseGstin(token: string): string | null {
  const t = token.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (t.length !== 15) return null
  const pan = normalisePan(t.slice(2, 12))
  if (!pan) return null
  const state = t.slice(0, 2).split('').map((c) => (/[0-9]/.test(c) ? c : TO_DIGIT[c] ?? c)).join('')
  // Entity number (13th) and check (15th) may be a digit or a letter; the 14th is always Z.
  const out = `${state}${pan}${t[12]}Z${t[14]}`
  return GSTIN_SHAPE_RE.test(out) && isValidGstin(out) ? out : null
}

export function parseGstCertificate(text: string): GstCertificateFields {
  const upper = text.toUpperCase()
  const ls = lines(text)

  // The GSTIN: beside its label first, else any 15-character token that validates.
  let gstin: string | null = null
  const labelled = /(?:REGISTRATION\s*(?:NUMBER|NO)|GSTIN(?:\/UIN)?|GST\s*(?:NUMBER|NO))\s*[:.\-–]?\s*([0-9A-Z]{2}\s?[0-9A-Z]{10}\s?[0-9A-Z]{3})/.exec(upper)
  if (labelled) gstin = normaliseGstin(labelled[1])
  if (!gstin) {
    for (const m of upper.matchAll(/\b[0-9A-Z]{15}\b/g)) {
      const g = normaliseGstin(m[0])
      if (g) { gstin = g; break }
    }
  }

  const legal_name = cleanName(valueAfter(ls, /legal\s*name(?:\s*of\s*business)?/i) ?? '')
  const tradeRaw = valueAfter(ls, /trade\s*name(?:,?\s*if\s*any)?/i)
  const trade_name = tradeRaw && !/^(n\/?a|nil|-+)$/i.test(tradeRaw) ? cleanName(tradeRaw) : null
  const constitution = cleanName(valueAfter(ls, /constitution\s*of\s*business/i) ?? '')

  // Address runs over several lines until the next labelled field.
  let address: string | null = null
  for (let i = 0; i < ls.length; i++) {
    if (!/address\s*of\s*principal\s*place\s*of\s*business/i.test(ls[i])) continue
    const parts: string[] = []
    const same = ls[i].replace(/.*address\s*of\s*principal\s*place\s*of\s*business\s*[:.\-–]?\s*/i, '').trim()
    if (same) parts.push(same)
    for (let j = i + 1; j < ls.length && parts.join(' ').length < 240; j++) {
      if (/^(date|period|type|constitution|legal|trade|particulars|signature|name|designation|\d+\.)\b/i.test(ls[j])) break
      parts.push(ls[j])
    }
    const joined = parts.join(', ').replace(/\s*,\s*,+/g, ',').trim()
    if (joined.length >= 8) address = joined
    break
  }

  const registered_from =
    firstDate(valueAfter(ls, /date\s*of\s*liability/i) ?? '') ??
    firstDate(valueAfter(ls, /(?:period\s*of\s*)?validity\s*from|valid\s*from/i) ?? '')

  return {
    gstin,
    pan: gstin ? panOfGstin(gstin) : null,
    legal_name,
    trade_name,
    constitution,
    address,
    registered_from,
  }
}

const HOLDER: Record<string, PanCardFields['holder_type']> = {
  P: 'person', C: 'company', F: 'firm', H: 'huf', T: 'trust', A: 'other', B: 'other', G: 'other', J: 'other', L: 'other',
}

export function parsePanCard(text: string): PanCardFields {
  const upper = text.toUpperCase()
  const ls = lines(text)

  let pan: string | null = null
  const labelled = /PERMANENT\s*ACCOUNT\s*NUMBER(?:\s*CARD)?\s*[:.\-–]?\s*([A-Z0-9]{10})\b/.exec(upper)
  if (labelled) pan = normalisePan(labelled[1])
  if (!pan) {
    for (const m of upper.matchAll(/\b[A-Z0-9]{10}\b/g)) {
      const p = normalisePan(m[0])
      if (p && isValidPan(p)) { pan = p; break }
    }
  }

  // The card prints the holder's name under a "Name" label and the father's under
  // "Father's Name"; the relative's line must never be taken as the holder.
  let name: string | null = null
  for (let i = 0; i < ls.length && !name; i++) {
    if (!/\bname\b/i.test(ls[i]) || /father|mother|husband/i.test(ls[i])) continue
    const same = ls[i].replace(/.*\bname\b\s*[:.\-–\/]?\s*/i, '').replace(/^(?:नाम|\/)\s*/, '').trim()
    if (same && !/^(?:नाम)?$/.test(same)) { name = cleanName(same); if (name) break }
    const next = ls[i + 1]
    if (next && !/name|father|birth|\d/i.test(next)) name = cleanName(next)
  }

  const date_of_birth =
    firstDate(valueAfter(ls, /date\s*of\s*(?:birth|incorporation)|\bDOB\b/i) ?? '') ??
    firstDate(text)

  return { pan, name, date_of_birth, holder_type: pan ? HOLDER[pan[3]] ?? 'other' : null }
}
