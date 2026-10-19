// -----------------------------------------------------------
// gst-public — the GST portal's PUBLIC records through Sandbox: no taxpayer login, just the
// GSTIN. Two questions a freight platform keeps asking about a counterparty:
//
//   lookupGstin        is this registration real and active, and whose is it?
//   gstFilingSummary   does this business file its returns? (a trust signal for To-Be-Billed
//                      credit — a dealer who is months behind on GSTR-3B is a collection risk)
//
// The calls are Sandbox's `/gst/compliance/public/...` endpoints (documented 2026-10:
// gstin/verify, gstrs/track). The summaries are pure functions over the responses, so the
// decisions are unit-tested; the transport is the shared SandboxClient.
// -----------------------------------------------------------

import { sandbox, SandboxClient, SandboxError, type SandboxResponse } from '../../lib/sandbox.js'

export type GstinProfile = {
  gstin: string
  valid: boolean
  legal_name: string | null
  /** The firm's name as traded (a proprietorship's legal name is the proprietor's own name). */
  trade_name: string | null
  /** "Active", "Cancelled", "Suspended", … as the portal reports it. */
  status: string | null
  active: boolean
  pan: string | null
  state_code: string | null
  state_name: string | null
  business_nature: string | null
  /** ISO yyyy-mm-dd */
  registered_since: string | null
  /** When nothing could be read: Sandbox's own message, so an operator can see why. */
  reason: string | null
  /** The field names Sandbox actually sent (never values) — for matching a response shape we have not seen. */
  source_keys: string[]
}

function isoFromPortalDate(raw: string | undefined): string | null {
  if (!raw) return null
  const m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/.exec(raw.trim())
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim())
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null
}

/** Pure: the portal's verify payload -> a profile the app can show. */
// Sandbox has two spellings of the taxpayer record: the verify endpoint's camelCase (legalName,
// stateCode, regStartDate, validGstin) and the GSTN search shape (lgnm, tradeNam, sts, stcd,
// rgdt, pradr) that the search endpoint and older responses carry. The record also sits either
// directly under `data` or one level down under `data.data`. The live account answered with a
// shape the first version of this did not read, so every spelling and both depths are accepted.
type AnyRecord = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const pick = (d: AnyRecord, ...keys: string[]) => { for (const k of keys) { const v = str(d[k]); if (v) return v } return null }

export function toGstinProfile(gstin: string, res: SandboxResponse<AnyRecord>): GstinProfile {
  const outer = (res.data ?? {}) as AnyRecord
  const inner = outer.data && typeof outer.data === 'object' && !Array.isArray(outer.data) ? (outer.data as AnyRecord) : null
  // The record is whichever level actually carries a taxpayer field.
  const looksLikeRecord = (o: AnyRecord | null) => !!o && ['legalName', 'lgnm', 'gstin', 'status', 'sts', 'validGstin', 'pan', 'tradeNam'].some((k) => k in o)
  const d: AnyRecord = looksLikeRecord(inner) ? inner! : looksLikeRecord(outer) ? outer : (inner ?? outer)

  const status = pick(d, 'status', 'sts')
  const legal_name = pick(d, 'legalName', 'lgnm', 'legal_name')
  const trade_name = pick(d, 'tradeName', 'tradeNam', 'trade_name')
  const errorMessage = pick((outer.error as AnyRecord) ?? {}, 'message') ?? pick(outer, 'message') ?? pick(res as unknown as AnyRecord, 'message')
  const valid = d.validGstin === true || outer.status_cd === '1' || (!!legal_name && d.validGstin !== false)
  const stateCode = d.stateCode ?? d.stcd ?? ((d.pradr as AnyRecord | undefined)?.addr as AnyRecord | undefined)?.stcd
  const nature = d.bussNature ?? d.nba
  return {
    gstin,
    valid,
    legal_name,
    trade_name,
    status,
    active: valid && /^active$/i.test(status ?? ''),
    pan: pick(d, 'pan')?.toUpperCase() ?? (valid ? gstin.slice(2, 12) : null),
    state_code: stateCode != null && String(stateCode).trim() ? String(stateCode).trim().padStart(2, '0') : null,
    state_name: pick(d, 'stateName'),
    business_nature: Array.isArray(nature) ? nature.filter((x) => typeof x === 'string').join(', ') || null : str(nature),
    registered_since: isoFromPortalDate(pick(d, 'regStartDate', 'rgdt') ?? undefined),
    reason: valid ? null : errorMessage ?? (outer.status_cd === '0' ? 'The GST portal has no record for this GSTIN' : null),
    source_keys: [...new Set([...Object.keys(outer), ...(inner ? Object.keys(inner).map((k) => 'data.' + k) : [])])].filter((k) => k !== 'data').slice(0, 40),
  }
}

export type GstReturnRow = { rtntype?: string; ret_prd?: string; dof?: string; status?: string; valid?: string; arn?: string; mof?: string }

export type GstFilingSummary = {
  gstin: string
  financial_year: string
  /** GSTR-3B is the monthly tax payment return — the one that shows a business is paying. */
  gstr3b_filed: number
  gstr1_filed: number
  /** The latest period filed, as the portal prints it ("082026" = Aug 2026). */
  last_period: string | null
  last_filed_on: string | null
  /** Months of the financial year that have passed and have no GSTR-3B yet (quarterly filers show 0..2 pending between quarters). */
  months_elapsed: number
  gstr3b_missing: number
  /** 'regular' = GSTR-3B for every elapsed month; 'behind' = one or more missing; 'none' = nothing filed. */
  verdict: 'regular' | 'behind' | 'none'
}

/** "FY 2026-27" for a date (Indian FY starts 1 April). */
export function financialYearOf(d = new Date()): string {
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1
  return `FY ${y}-${String(y + 1).slice(2)}`
}

/** Pure: the portal's return list -> a filing verdict for the chosen year. */
export function toFilingSummary(gstin: string, financialYear: string, rows: GstReturnRow[], today = new Date()): GstFilingSummary {
  const filed = rows.filter((r) => /^filed$/i.test(r.status ?? '') && (r.valid ?? 'Y').toUpperCase() !== 'N')
  const gstr3b = filed.filter((r) => /^GSTR3B$/i.test(r.rtntype ?? ''))
  const gstr1 = filed.filter((r) => /^GSTR1$/i.test(r.rtntype ?? ''))

  // Months of this FY that have fully elapsed (a return for month M is due around the 20th
  // of M+1, so a month counts as "due" only once the next month has started).
  const fyStart = Number(/FY (\d{4})/.exec(financialYear)?.[1] ?? today.getUTCFullYear())
  const monthsSinceApril = (today.getUTCFullYear() - fyStart) * 12 + (today.getUTCMonth() - 3)
  const months_elapsed = Math.max(0, Math.min(12, monthsSinceApril))

  const periods = new Set(gstr3b.map((r) => r.ret_prd ?? ''))
  const latest = [...filed].sort((a, b) => (toSortable(b.ret_prd) - toSortable(a.ret_prd)))[0]
  const gstr3b_missing = Math.max(0, months_elapsed - periods.size)

  return {
    gstin,
    financial_year: financialYear,
    gstr3b_filed: gstr3b.length,
    gstr1_filed: gstr1.length,
    last_period: latest?.ret_prd ?? null,
    last_filed_on: latest?.dof ? isoFromPortalDate(latest.dof) : null,
    months_elapsed,
    gstr3b_missing,
    verdict: filed.length === 0 ? 'none' : gstr3b_missing === 0 ? 'regular' : 'behind',
  }
}

/** "082026" -> 202608 so periods sort chronologically. */
function toSortable(prd: string | undefined): number {
  if (!prd || !/^\d{6}$/.test(prd)) return 0
  return Number(prd.slice(2)) * 100 + Number(prd.slice(0, 2))
}

export class GstPublicError extends Error {
  constructor(message: string, public readonly httpStatus: number, public readonly code: string) {
    super(message)
    this.name = 'GstPublicError'
  }
}

function requireClient(client: SandboxClient) {
  if (!client.configured) {
    throw new GstPublicError('GST portal lookups are not switched on (SANDBOX_API_KEY / SANDBOX_API_SECRET)', 503, 'NOT_CONFIGURED')
  }
}

export async function lookupGstin(gstin: string, client: SandboxClient = sandbox): Promise<GstinProfile> {
  requireClient(client)
  try {
    const res = await client.post<AnyRecord>('/gst/compliance/public/gstin/verify', { gstin })
    const profile = toGstinProfile(gstin, res)
    // The verify endpoint answered but named nothing: fall back to the GSTN search endpoint,
    // which returns the full taxpayer record (lgnm, sts, rgdt, pradr) for a registered number.
    if (!profile.valid && !profile.reason) {
      try {
        const alt = await client.post<AnyRecord>('/gst/compliance/public/gstin/search', { gstin })
        const p2 = toGstinProfile(gstin, alt)
        if (p2.valid) return p2
        return { ...profile, reason: p2.reason ?? profile.reason, source_keys: [...profile.source_keys, ...p2.source_keys.map((k) => 'search:' + k)] }
      } catch { /* the first answer stands */ }
    }
    return profile
  } catch (err) {
    if (err instanceof SandboxError && err.statusCode === 422) {
      return { gstin, valid: false, legal_name: null, trade_name: null, status: null, active: false, pan: null, state_code: null, state_name: null, business_nature: null, registered_since: null, reason: err.message, source_keys: [] }
    }
    throw new GstPublicError('The GST portal could not be reached right now', 502, 'UPSTREAM')
  }
}

export async function gstFilingSummary(gstin: string, financialYear = financialYearOf(), client: SandboxClient = sandbox): Promise<GstFilingSummary> {
  requireClient(client)
  try {
    const res = await client.post<{ status_cd?: string; data?: { EFiledlist?: GstReturnRow[] }; error?: { error_code?: string } }>(
      `/gst/compliance/public/gstrs/track?financial_year=${encodeURIComponent(financialYear)}`,
      { gstin },
    )
    // RET13510 = no record for the year: that IS the answer (nothing filed), not a failure.
    const rows = res.data?.data?.EFiledlist ?? []
    return toFilingSummary(gstin, financialYear, rows)
  } catch (err) {
    if (err instanceof SandboxError && err.statusCode === 422) {
      throw new GstPublicError('That is not a valid GSTIN', 422, 'VALIDATION_ERROR')
    }
    throw new GstPublicError('The GST portal could not be reached right now', 502, 'UPSTREAM')
  }
}
