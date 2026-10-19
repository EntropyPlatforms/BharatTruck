// Sandbox (sandbox.co.in) HTTP client — the transport for the Sandbox KYC provider.
//
// Sandbox's auth differs from Surepass's static bearer key: you first POST /authenticate with the
// API key + secret in HEADERS to mint a 24h ACCESS TOKEN (found at response.data.access_token),
// then send that token on every call as `Authorization: <token>` — WITHOUT the "Bearer" keyword —
// alongside `x-api-key` and `x-api-version`. This client hides that: it caches the token, attaches
// the headers, and re-authenticates once on a 401 (expired token). It is transport only — which
// verifications exist and how their responses map to a VerificationOutcome live behind the provider
// seam (modules/kyc/provider.ts), so Sandbox is one aggregator among the seam's providers.
//
// Prod base is https://api.sandbox.co.in; the sandbox/test base is https://test-api.sandbox.co.in
// (override via SANDBOX_BASE_URL).

const SANDBOX_BASE_URL = (process.env.SANDBOX_BASE_URL ?? 'https://api.sandbox.co.in').replace(/\/+$/, '')
const SANDBOX_API_VERSION = process.env.SANDBOX_API_VERSION ?? '1.0'
const TIMEOUT_MS = Number(process.env.SANDBOX_TIMEOUT_MS) > 0 ? Number(process.env.SANDBOX_TIMEOUT_MS) : 10_000

/** Sandbox wraps every response in { code, data, message?, transaction_id, timestamp }. */
export interface SandboxResponse<T = unknown> {
  code?: number
  message?: string
  transaction_id?: string
  timestamp?: number
  data?: T
}

export class SandboxError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(`Sandbox [${statusCode}] ${endpoint}: ${message}`)
    this.name = 'SandboxError'
  }
}

export class SandboxClient {
  private readonly apiKey: string
  private readonly apiSecret: string
  private token: string | null = null
  private tokenExpiresAt = 0

  constructor(
    apiKey: string = process.env.SANDBOX_API_KEY ?? '',
    apiSecret: string = process.env.SANDBOX_API_SECRET ?? '',
  ) {
    this.apiKey = apiKey
    this.apiSecret = apiSecret
  }

  /** Both credentials present — the resolver checks this before selecting Sandbox. */
  get configured(): boolean {
    return this.apiKey.length > 0 && this.apiSecret.length > 0
  }

  /** POST /authenticate → a 24h access token (response.data.access_token). Cached ~23h. */
  private async authenticate(): Promise<string> {
    if (!this.configured) throw new SandboxError('/authenticate', 0, 'SANDBOX_API_KEY / SANDBOX_API_SECRET are not set')
    let res: Response
    try {
      res = await fetch(`${SANDBOX_BASE_URL}/authenticate`, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'x-api-secret': this.apiSecret,
          'x-api-version': SANDBOX_API_VERSION,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (err) {
      throw new SandboxError('/authenticate', 0, err instanceof Error ? err.message : 'request failed')
    }
    const raw = await res.text().catch(() => '')
    let json: SandboxResponse<{ access_token?: string }> | null = null
    try { json = raw ? (JSON.parse(raw) as SandboxResponse<{ access_token?: string }>) : null } catch { json = null }
    if (!res.ok) {
      throw new SandboxError('/authenticate', res.status, typeof json?.message === 'string' ? json.message.slice(0, 200) : `HTTP ${res.status}`)
    }
    // Token is nested under data; fall back to a top-level field defensively across versions.
    const token = json?.data?.access_token ?? (json as { access_token?: string } | null)?.access_token ?? null
    if (!token) throw new SandboxError('/authenticate', res.status, 'no access_token in authenticate response')
    this.token = token
    // Token is valid 24h; refresh an hour early so a call never rides an about-to-expire token.
    this.tokenExpiresAt = Date.now() + 23 * 60 * 60 * 1000
    return token
  }

  private async getToken(force = false): Promise<string> {
    if (!force && this.token && this.tokenExpiresAt > Date.now()) return this.token
    return this.authenticate()
  }

  /**
   * Authenticated POST to a Sandbox endpoint. Mints/reuses the access token, re-authenticates ONCE
   * on a 401 (expired token), retries 5xx/network with small back-off, times out at 10s, and
   * normalises every failure to a SandboxError (status + Sandbox's own message only — never the
   * payload, which carries the PII being verified).
   */
  async post<T = unknown>(endpoint: string, payload: unknown): Promise<SandboxResponse<T>> {
    return this.request<T>('POST', endpoint, payload)
  }

  /** Authenticated GET — DigiLocker session status / profile / documents are GETs. */
  async get<T = unknown>(endpoint: string): Promise<SandboxResponse<T>> {
    return this.request<T>('GET', endpoint, undefined)
  }

  private async request<T = unknown>(method: 'GET' | 'POST', endpoint: string, payload: unknown): Promise<SandboxResponse<T>> {
    if (!this.configured) throw new SandboxError(endpoint, 0, 'SANDBOX_API_KEY / SANDBOX_API_SECRET are not set')
    const url = `${SANDBOX_BASE_URL}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`
    const maxAttempts = 3
    let reauthed = false
    let lastErr: SandboxError | null = null

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let token: string
      try {
        token = await this.getToken()
      } catch (err) {
        // Auth itself failed — surface it (a bad key/secret is terminal, a network blip retried).
        lastErr = err instanceof SandboxError ? err : new SandboxError(endpoint, 0, 'authentication failed')
        if (lastErr.statusCode !== 0 && lastErr.statusCode < 500) throw lastErr
        if (attempt < maxAttempts) { await backoff(attempt); continue }
        throw lastErr
      }

      try {
        const res = await fetch(url, {
          method,
          headers: {
            authorization: token, // NOT "Bearer <token>" — Sandbox rejects the Bearer prefix.
            'x-api-key': this.apiKey,
            'x-api-version': SANDBOX_API_VERSION,
            ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
            accept: 'application/json',
          },
          body: method === 'POST' ? JSON.stringify(payload) : undefined,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })

        // A 401 means the cached token expired mid-life — re-auth once and retry immediately.
        if (res.status === 401 && !reauthed) {
          reauthed = true
          await this.getToken(true)
          continue
        }

        if (res.status >= 500) {
          lastErr = new SandboxError(endpoint, res.status, `upstream ${res.status}`)
          if (attempt < maxAttempts) { await backoff(attempt); continue }
          throw lastErr
        }

        const raw = await res.text()
        let json: SandboxResponse<T> | null = null
        try { json = raw ? (JSON.parse(raw) as SandboxResponse<T>) : null } catch { json = null }

        if (!res.ok) {
          throw new SandboxError(endpoint, res.status, typeof json?.message === 'string' ? json.message.slice(0, 200) : `HTTP ${res.status}`)
        }
        if (!json) throw new SandboxError(endpoint, res.status, 'unparseable response body')
        return json
      } catch (err) {
        if (err instanceof SandboxError) {
          if (err.statusCode !== 0 && err.statusCode < 500) throw err
          lastErr = err
        } else {
          lastErr = new SandboxError(endpoint, 0, err instanceof Error ? err.message : 'request failed')
        }
        if (attempt < maxAttempts) { await backoff(attempt); continue }
        throw lastErr
      }
    }
    throw lastErr ?? new SandboxError(endpoint, 0, 'request failed')
  }
}

function backoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 200 * 2 ** (attempt - 1)))
}

/** Singleton — import and use everywhere instead of constructing a client per request. */
export const sandbox = new SandboxClient()
