// -----------------------------------------------------------
// driver-docs — turn the TEXT an OCR pass read off a driver's document into the fields the
// onboarding forms ask for. Pure: no network, no database, so every rule is unit-tested.
//
//   driving licence      -> dl_number, name, date_of_birth, expiry_date, vehicle_classes
//   cheque / passbook    -> account_number, ifsc, bank_name, account_holder_name
//
// EVERY FIELD IS A SUGGESTION. A field that cannot be read with confidence is null — never a
// guess — and the driver confirms the whole form before anything is saved. Nothing here writes;
// the existing POST /onboarding/license and /bank-account routes still validate what is submitted.
//
// Indian licences come in several layouts (the smart card, the older booklet, state variants) and
// OCR returns their labels and values in an order that does not follow the card. So the rules key
// on the SHAPE of a value (a DL number, an IFSC) first and on labels second.
// -----------------------------------------------------------

export type LicenceFields = {
  dl_number: string | null
  name: string | null
  /** ISO yyyy-mm-dd */
  date_of_birth: string | null
  /** ISO yyyy-mm-dd — the transport validity when the card prints both. */
  expiry_date: string | null
  vehicle_classes: string[]
}

export type BankFields = {
  account_number: string | null
  ifsc: string | null
  bank_name: string | null
  account_holder_name: string | null
}

// ── shared helpers ────────────────────────────────────────────

const lines = (text: string) => text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean)

function isoDate(d: number, m: number, y: number): string | null {
  if (y < 100) y += y >= 50 ? 1900 : 2000
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1930 || y > 2100) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCDate() !== d || dt.getUTCMonth() !== m - 1) return null // 31-02 and friends
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

// Indian documents print dates day-first: 05-03-2031, 05/03/2031, 05.03.2031.
const DATE_RE = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/g

/** A date-shaped token is on the line, readable or not — so the value is HERE, not on the next line. */
const hasDateShape = (line: string) => new RegExp(DATE_RE.source).test(line)

function datesIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(DATE_RE)) {
    const iso = isoDate(Number(m[1]), Number(m[2]), Number(m[3]))
    if (iso) out.push(iso)
  }
  return out
}

/** "RAMESH  KUMAR." -> "Ramesh Kumar"; null if it does not look like a person's name. */
function cleanName(raw: string): string | null {
  const s = raw.replace(/[^A-Za-z .']/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[.' ]+|[.' ]+$/g, '')
  if (s.length < 3 || s.length > 60) return null
  if (!/[A-Za-z]{2,}/.test(s)) return null
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

// ── driving licence ───────────────────────────────────────────

// SS RR YYYY NNNNNNN — state, RTO, year of issue, serial; printed with or without separators
// ("MH12 20110012345", "MH-1220110012345", "DL-04 2011 0149646").
const DL_RE = /\b([A-Z]{2})[\s-]?(\d{2})[\s-]?((?:19|20)\d{2})[\s-]?(\d{7})\b/

// What the licence form offers (bt-app driver-profile VEHICLE_CLASSES), and the printed codes
// that mean each one.
const CLASS_ALIASES: Array<[string, RegExp]> = [
  ['LMV',   /\bLMV(?:[-\s]?(?:NT|TR|GV|CAB))?\b/],
  ['MCWG',  /\bMCWG\b/],
  ['HMV',   /\bHMV\b/],
  ['HGMV',  /\bHGMV\b|\bHGV\b/],
  ['HPMV',  /\bHPMV\b|\bHPV\b/],
  ['TRANS', /\bTRANS(?:PORT)?\b/],
  ['MGV',   /\bMGV\b/],
  ['HTV',   /\bHTV\b/],
]

const RELATIVE_LABEL = /father|husband|guardian|\bson\b|daughter|\bwife\b|s\s*\/\s*[dw]|[sdw]\s*\/\s*o\b/i

export function parseDrivingLicence(text: string): LicenceFields {
  const upper = text.toUpperCase()
  const ls = lines(text)

  const dl = DL_RE.exec(upper)
  const dl_number = dl ? `${dl[1]}${dl[2]}${dl[3]}${dl[4]}` : null

  // Name: the value beside (or on the line after) a "Name" label that is not a relative's.
  let name: string | null = null
  for (let i = 0; i < ls.length && !name; i++) {
    const m = /^(.*?)\bname\b\s*[:\-]?\s*(.*)$/i.exec(ls[i])
    if (!m || RELATIVE_LABEL.test(m[1]) || RELATIVE_LABEL.test(ls[i].slice(0, m[1].length + 4))) continue
    const sameLine = cleanName(m[2])
    if (sameLine) { name = sameLine; break }
    const next = ls[i + 1]
    if (next && !/\bname\b|:/i.test(next) && !/\d/.test(next)) name = cleanName(next)
  }

  // Date of birth: the date on (or right after) its label.
  let date_of_birth: string | null = null
  for (let i = 0; i < ls.length && !date_of_birth; i++) {
    if (!/\bD\.?\s?O\.?\s?B\b|date of birth|birth/i.test(ls[i])) continue
    date_of_birth = datesIn(ls[i])[0] ?? (hasDateShape(ls[i]) ? null : datesIn(ls[i + 1] ?? '')[0] ?? null)
    if (hasDateShape(ls[i])) break
  }

  // Validity. A card can print a non-transport (NT) and a transport (TR) validity; a truck driver
  // needs the transport one, so it wins when it is labelled. Otherwise the latest date beside a
  // validity label; otherwise — only when the card shows at least an issue date as well — the
  // latest date on the card, which on a licence is always its expiry.
  let expiry_date: string | null = null
  const validity: string[] = []
  for (let i = 0; i < ls.length; i++) {
    if (!/valid|expir|upto|up to|\bTR\b|\bNT\b/i.test(ls[i])) continue
    const here = datesIn(ls[i])
    const found = here.length || hasDateShape(ls[i]) ? here : datesIn(ls[i + 1] ?? '')
    if (!found.length) continue
    const last = found[found.length - 1]
    if (/\bTR\b|transport/i.test(ls[i]) && !/non[-\s]?transport/i.test(ls[i])) expiry_date = last
    validity.push(last)
  }
  if (!expiry_date && validity.length) expiry_date = validity.sort()[validity.length - 1]
  if (!expiry_date) {
    const all = datesIn(text).filter((d) => d !== date_of_birth).sort()
    if (all.length >= 2) expiry_date = all[all.length - 1]
  }
  // An "expiry" on or before the date of birth is a misread, not a fact.
  if (expiry_date && date_of_birth && expiry_date <= date_of_birth) expiry_date = null

  const vehicle_classes = CLASS_ALIASES.filter(([, re]) => re.test(upper)).map(([c]) => c)

  return { dl_number, name, date_of_birth, expiry_date, vehicle_classes }
}

// ── cheque / passbook ─────────────────────────────────────────

// The first four letters of an IFSC are the bank. Enough of them to name the bank for most
// drivers; an unknown prefix just leaves bank_name for the driver to type.
const BANKS: Record<string, string> = {
  SBIN: 'State Bank of India', HDFC: 'HDFC Bank', ICIC: 'ICICI Bank', UTIB: 'Axis Bank',
  PUNB: 'Punjab National Bank', BARB: 'Bank of Baroda', CNRB: 'Canara Bank', UBIN: 'Union Bank of India',
  KKBK: 'Kotak Mahindra Bank', IDIB: 'Indian Bank', BKID: 'Bank of India', IOBA: 'Indian Overseas Bank',
  YESB: 'Yes Bank', INDB: 'IndusInd Bank', IDFB: 'IDFC First Bank', CBIN: 'Central Bank of India',
  MAHB: 'Bank of Maharashtra', UCBA: 'UCO Bank', FDRL: 'Federal Bank', PSIB: 'Punjab & Sind Bank',
  IBKL: 'IDBI Bank', KARB: 'Karnataka Bank', KVBL: 'Karur Vysya Bank', SIBL: 'South Indian Bank',
  RATN: 'RBL Bank', BDBL: 'Bandhan Bank', AUBL: 'AU Small Finance Bank', IPOS: 'India Post Payments Bank',
  PYTM: 'Paytm Payments Bank', AIRP: 'Airtel Payments Bank', TMBL: 'Tamilnad Mercantile Bank',
  CIUB: 'City Union Bank', DCBL: 'DCB Bank', JAKA: 'Jammu & Kashmir Bank', ESFB: 'Equitas Small Finance Bank',
  USFB: 'Ujjivan Small Finance Bank',
}

// Position 5 of an IFSC is always the digit zero; OCR often reads it as the letter O.
const IFSC_RE = /\b([A-Z]{4})[0O]([A-Z0-9]{6})\b/

export function parseBankDocument(text: string): BankFields {
  const upper = text.toUpperCase()
  const ls = lines(text)

  // Prefer the code beside its label; a bare match elsewhere could be any 11-character word.
  let ifsc: string | null = null
  const labelled = /IFS\s?C?(?:\s*CODE)?\s*[:\-.]?\s*([A-Z]{4})[0O]([A-Z0-9]{6})\b/.exec(upper)
  const bare = labelled ?? IFSC_RE.exec(upper)
  if (bare && (labelled || BANKS[bare[1]])) ifsc = `${bare[1]}0${bare[2]}`

  // Account number. Beside its label when there is one. Otherwise a single unambiguous digit run
  // of 11-18 digits: the 9-digit MICR code and the 6-digit cheque number at the foot of a cheque
  // are both shorter than that, and two candidates means we do not know which is the account.
  let account_number: string | null = null
  const acct = /(?:A\s*\/\s*C|ACCOUNT|ACC(?:OUN)?T)\.?\s*(?:NO|NUMBER|NUM)?\.?\s*[:\-.]?\s*((?:\d[\s-]?){8,18})(?!\d)/.exec(upper)
  if (acct) {
    const digits = acct[1].replace(/\D/g, '')
    if (digits.length >= 9 && digits.length <= 18) account_number = digits
  }
  if (!account_number) {
    const runs = [...new Set((upper.match(/(?<!\d)\d{11,18}(?!\d)/g) ?? []))]
    if (runs.length === 1) account_number = runs[0]
  }

  // Holder name: only from a label (passbooks print one; a cheque's printed name has no label and
  // is left for the driver).
  let account_holder_name: string | null = null
  for (let i = 0; i < ls.length && !account_holder_name; i++) {
    const m = /^(?:customer|account holder|a\/c holder|holder)?'?s?\s*name\s*[:\-]\s*(.*)$/i.exec(ls[i])
    if (!m) continue
    account_holder_name = cleanName(m[1].replace(/^(mr|mrs|ms|shri|smt)\.?\s+/i, '')) ??
      (ls[i + 1] && !/\d|:/.test(ls[i + 1]) ? cleanName(ls[i + 1]) : null)
  }

  return { account_number, ifsc, bank_name: ifsc ? BANKS[ifsc.slice(0, 4)] ?? null : null, account_holder_name }
}

/** How many fields were actually read — the route reports it so the app can say "nothing found". */
export function countFound(fields: Record<string, unknown>): number {
  return Object.values(fields).filter((v) => (Array.isArray(v) ? v.length > 0 : v !== null)).length
}
