// -----------------------------------------------------------
// bahi/client — Bahi Khata's EXISTING public API (bahi-api Worker, /api/v1/*), used exactly as
// Bahi's own web app uses it. Nothing in Bahi is changed for BharatTruck:
//
//   POST /auth/login            email + password → access token (short) + refresh token (30 d)
//   POST /auth/refresh          rotates the refresh token; each use extends it another 30 days
//   GET  /auth/me, /settings    who signed in (role) and which company (name, GSTIN)
//   GET|POST /parties, /items   find or create the counterparty and the "Freight charges" item
//   POST /transactions          draft invoice (SINV = sales, PI = purchase)
//   POST /transactions/:id/submit
//   POST /documents/:id/approval/send · GET /documents/:id/approval
//                               a sales invoice needs the customer's approval before it can be
//                               submitted — Bahi emails them a link
//   POST /payments              idempotent on request_id
// -----------------------------------------------------------

const DEFAULT_URL = 'https://bahi-api.deltaos1997.workers.dev'
const TIMEOUT_MS = 12_000

export const bahiBaseUrl = () => (process.env.BAHI_API_URL ?? DEFAULT_URL).trim().replace(/\/+$/, '')

export class BahiError extends Error {
  constructor(message: string, public readonly httpStatus: number) {
    super(message)
    this.name = 'BahiError'
  }
}

async function call<T>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${bahiBaseUrl()}/api/v1${path}`, {
      method: init.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new BahiError('Bahi could not be reached right now', 503)
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new BahiError(typeof data.detail === 'string' ? data.detail : `Bahi answered ${res.status}`, res.status)
  return data as T
}

export type BahiTokens = { access_token: string; refresh_token: string }
export type BahiUser = { name: string; email: string; role: string; tenant_id: string }
export type BahiCompany = { name: string | null; gstin: string | null }
export type BahiPartyRow = { id: string; legal_name: string | null; gstin: string | null; email: string | null; role_type?: string | null }
export type BahiItemRow = { id: string; name: string; hsn_sac: string | null; is_stock_item: number; status?: string }
export type BahiApproval = { status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'REVOKED'; recipient_email?: string; expires_at?: string } | null

export const bahi = {
  login: (email: string, password: string) =>
    call<BahiTokens & { user: BahiUser }>('/auth/login', { method: 'POST', body: { email, password } }),
  refresh: (refreshToken: string) =>
    call<BahiTokens>('/auth/refresh', { method: 'POST', body: { refresh_token: refreshToken } }),
  me: (t: string) => call<BahiUser>('/auth/me', { token: t }),
  company: async (t: string): Promise<BahiCompany> => {
    const s = await call<Record<string, unknown>>('/settings', { token: t })
    return { name: (s.name as string) ?? null, gstin: (s.gstin as string) ?? null }
  },
  parties: async (t: string): Promise<BahiPartyRow[]> => {
    const r = await call<{ items?: BahiPartyRow[] } | BahiPartyRow[]>('/parties?limit=1000', { token: t })
    return Array.isArray(r) ? r : r.items ?? []
  },
  createParty: (t: string, body: { legal_name: string; gstin: string | null; email: string | null; phone: string | null; party_type: string; role_type: 'CUSTOMER' | 'SUPPLIER' }) =>
    call<{ id: string }>('/parties', { method: 'POST', body, token: t }),
  items: async (t: string): Promise<BahiItemRow[]> => {
    const r = await call<{ items?: BahiItemRow[] } | BahiItemRow[]>('/items', { token: t })
    return Array.isArray(r) ? r : r.items ?? []
  },
  createItem: (t: string, body: { name: string; hsn_sac: string; stock_uom: string; gst_rate: number; is_stock_item: false }) =>
    call<{ id: string }>('/items', { method: 'POST', body, token: t }),
  createTransaction: (t: string, body: { txn_type: 'SINV' | 'PI'; party_id: string; date: string; items: Array<{ item_id: string; qty: number; rate: number; gst_rate: number }> }) =>
    call<{ id: string; grand_total: number; status: string }>('/transactions', { method: 'POST', body, token: t }),
  transaction: (t: string, id: string) => call<Record<string, unknown>>(`/transactions/${encodeURIComponent(id)}`, { token: t }),
  submit: (t: string, id: string) => call<{ status?: string }>(`/transactions/${encodeURIComponent(id)}/submit`, { method: 'POST', token: t }),
  sendApproval: (t: string, id: string, email: string) =>
    call<{ approval: BahiApproval }>(`/documents/${encodeURIComponent(id)}/approval/send`, { method: 'POST', body: { email }, token: t }),
  approval: async (t: string, id: string): Promise<BahiApproval> =>
    (await call<{ approval: BahiApproval }>(`/documents/${encodeURIComponent(id)}/approval`, { token: t })).approval ?? null,
  pay: (t: string, body: { invoice_id: string; amount: number; payment_type: 'RECEIVE' | 'PAY'; mode: string; request_id: string; payment_date: string; reference: string | null; note: string }) =>
    call<{ id: string; status?: string }>('/payments', { method: 'POST', body, token: t }),
}
