// -----------------------------------------------------------
// sandbox — the transport for NIC's e-way bill API through Sandbox (api.sandbox.co.in).
//
// Two tokens, deliberately kept apart:
//   • the SANDBOX access token — ours, from the API key + secret (24 h). Authenticates us to
//     Sandbox. Used for the e-way-bill "authenticate" call.
//   • the E-WAY BILL session token — the TAXPAYER's, minted from their portal API username +
//     password + GSTIN. NIC issues it for about six hours; it goes in `authorization` on every
//     bill call. Cached per GSTIN in Redis so a shipper's dozen bills a day cost one login.
//
// This mirrors bt-auth-service/src/lib/sandbox.ts rather than importing it (no shared-package
// rebuild for this feature), trimmed to what the bill calls need.
// -----------------------------------------------------------

import { EwbError } from './nic.js'

// Redis is loaded on first use, not at import. lib/redis.js opens its connection the moment it is
// imported, and this module is reached from routes/documents.ts — so importing it here made every
// test that registers the document routes hold an open socket and never exit (CI hung for 6 h).
async function redisClient() {
  return (await import('../redis.js')).redis
}

const BASE = (process.env.SANDBOX_BASE_URL ?? 'https://api.sandbox.co.in').replace(/\/+$/, '')
const API_VERSION = process.env.SANDBOX_API_VERSION ?? '1.0'
const TIMEOUT_MS = Number(process.env.SANDBOX_TIMEOUT_MS) > 0 ? Number(process.env.SANDBOX_TIMEOUT_MS) : 15_000

export type SandboxEnvelope<T = unknown> = { code?: number; message?: string; transaction_id?: string; data?: T }

export class EwbSandboxClient {
  private token: string | null = null
  private tokenExpiresAt = 0

  constructor(
    private readonly apiKey = (process.env.SANDBOX_API_KEY ?? '').trim(),
    private readonly apiSecret = (process.env.SANDBOX_API_SECRET ?? '').trim(),
  ) {}

  get configured(): boolean {
    return this.apiKey.length > 0 && this.apiSecret.length > 0
  }

  private async sandboxToken(force = false): Promise<string> {
    if (!force && this.token && this.tokenExpiresAt > Date.now()) return this.token
    let res: Response
    try {
      res = await fetch(`${BASE}/authenticate`, {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey, 'x-api-secret': this.apiSecret, 'x-api-version': API_VERSION, accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw new EwbError('Could not reach the e-way bill gateway', 502, 'UPSTREAM')
    }
    const json = (await res.json().catch(() => ({}))) as SandboxEnvelope<{ access_token?: string }> & { access_token?: string }
    const token = json.data?.access_token ?? json.access_token
    if (!res.ok || !token) throw new EwbError('The e-way bill gateway refused our API key', 502, 'UPSTREAM')
    this.token = token
    this.tokenExpiresAt = Date.now() + 23 * 60 * 60 * 1000
    return token
  }

  /** One call to Sandbox. `authorization` is the Sandbox token unless an e-way bill session token is given. */
  async call<T = unknown>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, ewbToken?: string): Promise<SandboxEnvelope<T>> {
    if (!this.configured) throw new EwbError('E-way bill generation is not switched on (SANDBOX_API_KEY / SANDBOX_API_SECRET)', 503, 'NOT_CONFIGURED')
    const auth = ewbToken ?? await this.sandboxToken()
    let res: Response
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          authorization: auth,
          'x-api-key': this.apiKey,
          'x-api-version': API_VERSION,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw new EwbError('Could not reach the e-way bill gateway', 502, 'UPSTREAM')
    }
    const json = (await res.json().catch(() => ({}))) as SandboxEnvelope<T>
    if (res.status === 401 && !ewbToken) {
      await this.sandboxToken(true)
      return this.call<T>(method, path, body, ewbToken)
    }
    if (!res.ok) {
      const why = typeof json.message === 'string' ? json.message.slice(0, 160) : `HTTP ${res.status}`
      throw new EwbError(`E-way bill gateway: ${why}`, res.status === 422 ? 422 : 502, res.status === 422 ? 'VALIDATION_ERROR' : 'UPSTREAM')
    }
    return json
  }

  /**
   * The taxpayer's e-way bill session. Cached in Redis per GSTIN; NIC's own expiry when the
   * response carries one, else 5 hours (NIC tokens last ~6). `force` after an auth failure.
   */
  async ewbSession(creds: { gstin: string; username: string; password: string }, force = false): Promise<string> {
    const key = `ewb:session:${creds.gstin}`
    const redis = await redisClient()
    if (!force) {
      const cached = await redis.get(key).catch(() => null)
      if (cached) return cached
    }
    const res = await this.call<{ Status?: number | string; status?: string | number; access_token?: string; expiry?: number; error?: { errorCodes?: string } }>(
      'POST',
      '/gst/compliance/e-way-bill/tax-payer/authenticate',
      { username: creds.username, password: creds.password, gstin: creds.gstin },
    )
    const d = res.data ?? {}
    const token = d.access_token
    if (!token) {
      const code = String(d.error?.errorCodes ?? '')
      throw new EwbError(
        code === '108' ? 'The e-way bill portal rejected the API username or password' : 'The e-way bill portal did not open a session',
        422,
        'NIC_AUTH_FAILED',
      )
    }
    let ttl = 5 * 60 * 60
    if (typeof d.expiry === 'number') {
      const ms = d.expiry > 1e12 ? d.expiry : d.expiry * 1000
      const secs = Math.floor((ms - Date.now()) / 1000) - 300
      if (secs > 60 && secs < 24 * 3600) ttl = secs
    }
    await redis.set(key, token, 'EX', ttl).catch(() => undefined)
    return token
  }

  async forgetSession(gstin: string): Promise<void> {
    const redis = await redisClient()
    await redis.del(`ewb:session:${gstin}`).catch(() => undefined)
  }
}

export const ewbSandbox = new EwbSandboxClient()
