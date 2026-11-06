/**
 * The drivers CSV a fleet owner uploads to invite many drivers at once.
 *
 * Pure (no React, no fetch): read the file, map its columns, check every row, and shape the rows
 * for POST /fleet/drivers/invite/bulk. The service re-checks everything — this exists so the
 * owner sees and fixes bad rows BEFORE anything is sent, instead of reading 40 refusals after.
 *
 * Columns mirror the single "Invite driver" dialog: a mobile OR an email to find the driver's
 * existing account by, plus a name. The name is the owner's own label for the row (shown in the
 * preview and the results) — the driver's name on BharatTruck always comes from their account.
 */
import type { BulkInviteRow } from '@/lib/api'

export const TEMPLATE_COLUMNS = ['name', 'mobile', 'email'] as const

/** Header only — no sample rows, so a template uploaded unedited can never invite a real number. */
export function templateCsv(): string {
  return `${TEMPLATE_COLUMNS.join(',')}\r\n`
}

/** Header spellings accepted for each column (lower-cased, spaces/underscores/dashes ignored). */
const ALIASES: Record<(typeof TEMPLATE_COLUMNS)[number], string[]> = {
  name: ['name', 'drivername', 'fullname'],
  mobile: ['mobile', 'mobilenumber', 'mobileno', 'phone', 'phonenumber', 'phoneno', 'drivermobile', 'driverphone'],
  email: ['email', 'emailaddress', 'emailid', 'mail', 'driveremail'],
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** One editable row of the preview. `line` is the row's line in the file, for "row 7" messages. */
export type DraftRow = { key: number; line: number; name: string; mobile: string; email: string }

export type RowProblems = { name?: string; mobile?: string; email?: string }

/** RFC-4180: quoted fields, embedded commas/newlines, doubled quotes, CRLF, a leading BOM. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++ }
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row) }
  return rows
}

/**
 * File text -> preview rows. Fully blank lines are skipped (spreadsheets export trailing ones).
 * Returns an error string instead of rows when the file cannot be read as a drivers list at all.
 */
export function readDriverCsv(text: string): { rows: DraftRow[] } | { error: string } {
  const table = parseCsv(text)
  if (table.length === 0) return { error: 'The file is empty.' }

  const norm = (h: string) => h.trim().toLowerCase().replace(/[\s_\-.]/g, '')
  const header = table[0].map(norm)
  const col = (k: keyof typeof ALIASES) => header.findIndex(h => ALIASES[k].includes(h))
  const iName = col('name'), iMobile = col('mobile'), iEmail = col('email')
  if (iName < 0 || (iMobile < 0 && iEmail < 0)) {
    return { error: 'The first line must name the columns: name, mobile and (optionally) email. Download the template to start from.' }
  }

  const rows: DraftRow[] = []
  table.slice(1).forEach((cells, i) => {
    if (cells.every(c => c.trim() === '')) return
    const at = (j: number) => (j >= 0 ? (cells[j] ?? '').trim() : '')
    rows.push({ key: i, line: i + 2, name: at(iName), mobile: at(iMobile), email: at(iEmail) })
  })
  if (rows.length === 0) return { error: 'The file has the column names but no drivers under them.' }
  return { rows }
}

/**
 * Indian mobile -> bare 10 digits, or null. The same rule as toCanonicalPhone in
 * bt-fleet-service: +91 / 91 / a leading 0 and any spaces or dashes are all the same number.
 */
export function canonicalMobile(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  const local =
    digits.length === 12 && digits.startsWith('91') ? digits.slice(2)
    : digits.length === 11 && digits.startsWith('0') ? digits.slice(1)
    : digits
  return /^[6-9]\d{9}$/.test(local) ? local : null
}

/** Every row's problems, keyed by DraftRow.key. A row missing from the map is ready to send. */
export function validateRows(rows: DraftRow[]): Map<number, RowProblems> {
  const out = new Map<number, RowProblems>()
  const add = (key: number, p: RowProblems) => out.set(key, { ...out.get(key), ...p })
  const seenMobile = new Map<string, number>()
  const seenEmail = new Map<string, number>()

  for (const r of rows) {
    if (!r.name.trim()) add(r.key, { name: 'Name is missing' })

    const mobile = r.mobile.trim()
    const email = r.email.trim()
    if (!mobile && !email) {
      add(r.key, { mobile: 'Add a mobile number (or an email)' })
      continue
    }
    if (mobile) {
      const c = canonicalMobile(mobile)
      if (!c) add(r.key, { mobile: 'Not a valid 10-digit Indian mobile' })
      else if (seenMobile.has(c)) add(r.key, { mobile: `Same mobile as row ${seenMobile.get(c)}` })
      else seenMobile.set(c, r.line)
    }
    if (email) {
      const e = email.toLowerCase()
      if (!EMAIL_RE.test(email)) add(r.key, { email: 'Not a valid email' })
      else if (seenEmail.has(e)) add(r.key, { email: `Same email as row ${seenEmail.get(e)}` })
      else seenEmail.set(e, r.line)
    }
  }
  return out
}

/**
 * A checked row -> the request row. The mobile is used when there is one (sent as +91…, exactly
 * as the single invite sends it); the email only when the mobile is blank.
 */
export function toInviteRow(r: DraftRow): BulkInviteRow {
  const c = canonicalMobile(r.mobile)
  return c ? { name: r.name.trim(), driver_phone: `+91${c}` } : { name: r.name.trim(), driver_email: r.email.trim() }
}
