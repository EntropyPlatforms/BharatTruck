// -----------------------------------------------------------
// bahi/client — the three calls BharatTruck makes to Bahi's integrations module
// (EntropyPlatforms/Bahi-Khata worker/src/modules/integrations). Every call carries the
// account's own integration token; nothing here is shared across accounts.
// -----------------------------------------------------------

import { BookingError, type BookingErrorCode } from '../types.js'
import type { BahiFreightBody } from './posting.js'

const DEFAULT_URL = 'https://bahi-api.deltaos1997.workers.dev'
const TIMEOUT_MS = 10_000

export const bahiBaseUrl = () => (process.env.BAHI_API_URL ?? DEFAULT_URL).trim().replace(/\/+$/, '')

export type BahiPing = { company_name: string | null; gstin: string | null; integration: string }
export type BahiPostResult = {
  txn_id: string
  number: string | null
  txn_type: 'SINV' | 'PI'
  status: string
  grand_total: number
  deduped: boolean
  note?: string
}

export class BahiError extends Error {
  constructor(message: string, public readonly httpStatus: number) {
    super(message)
    this.name = 'BahiError'
  }
  toBookingError(): BookingError {
    const code = (this.httpStatus === 401 ? 'BAHI_TOKEN_REJECTED' : this.httpStatus === 400 ? 'VALIDATION_ERROR' : 'UPSTREAM') as BookingErrorCode
    return new BookingError(this.message, code, this.httpStatus === 401 || this.httpStatus === 400 ? 400 : 502)
  }
}

async function call<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${bahiBaseUrl()}${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new BahiError('Bahi could not be reached right now', 503)
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const detail = typeof data.detail === 'string' ? data.detail : `Bahi answered ${res.status}`
    throw new BahiError(res.status === 401 ? 'Bahi did not accept this token — it may have been revoked. Create a new one in Bahi.' : detail, res.status)
  }
  return data as T
}

export const pingBahi = (token: string) => call<BahiPing>(token, '/api/v1/integrations/connect/ping')

export const postFreightToBahi = (token: string, body: BahiFreightBody) =>
  call<BahiPostResult>(token, '/api/v1/integrations/connect/freight', { method: 'POST', body })
