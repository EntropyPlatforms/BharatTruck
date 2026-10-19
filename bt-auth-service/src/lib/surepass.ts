// Surepass HTTP client wrapper — centralises auth headers, base URL, and error normalisation for all Surepass API calls.
//
// This is the transport only. Which verifications exist and how their responses map to a KYCResult
// lives behind the provider seam (modules/kyc/provider.ts) — Surepass is one provider among the
// aggregators the seam can front (Signzy / IDfy / Perfios / …), so swapping vendor is a config change.

const SUREPASS_BASE_URL = (process.env.SUREPASS_BASE_URL ?? 'https://kyc-api.surepass.io/api/v1').replace(/\/+$/, '')
const TIMEOUT_MS = Number(process.env.SUREPASS_TIMEOUT_MS) > 0 ? Number(process.env.SUREPASS_TIMEOUT_MS) : 10_000

export interface SurepassResponse<T = unknown> {
  success:    boolean
  message:    string
  status_code: number
  data:       T
}

export class SurepassError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(`Surepass [${statusCode}] ${endpoint}: ${message}`)
    this.name = 'SurepassError'
  }
}

export class SurepassClient {
  private readonly apiKey: string

  constructor(apiKey: string = process.env.SUREPASS_API_KEY ?? '') {
    this.apiKey = apiKey
  }

  /** Whether a real key is configured — the provider resolver checks this before selecting Surepass. */
  get configured(): boolean {
    return this.apiKey.length > 0
  }

  /**
   * Authenticated POST to a Surepass endpoint. 3 attempts with exponential back-off on 5xx /
   * network errors, a 10 s timeout via AbortController, and every failure normalised to a
   * SurepassError so callers never see a raw fetch/HTTP shape. Surepass's own error bodies can
   * echo the request back, so only the status and Surepass's `message` are surfaced — never the
   * payload (it carries the PII being verified).
   */
  async post<T = unknown>(endpoint: string, payload: unknown): Promise<SurepassResponse<T>> {
    if (!this.apiKey) {
      throw new SurepassError(endpoint, 0, 'SUREPASS_API_KEY is not set')
    }
    const url = `${SUREPASS_BASE_URL}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`
    const maxAttempts = 3
    let lastErr: SurepassError | null = null

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })

        // Retry 5xx (transient); 4xx is a caller/data problem and is surfaced immediately.
        if (res.status >= 500) {
          lastErr = new SurepassError(endpoint, res.status, `upstream ${res.status}`)
          if (attempt < maxAttempts) { await backoff(attempt); continue }
          throw lastErr
        }

        const raw = await res.text()
        let json: SurepassResponse<T> | null = null
        try { json = raw ? (JSON.parse(raw) as SurepassResponse<T>) : null } catch { json = null }

        if (!res.ok) {
          // Status + Surepass's own message only — never the parsed body (it can mirror the PII payload).
          throw new SurepassError(endpoint, res.status, typeof json?.message === 'string' ? json.message.slice(0, 200) : `HTTP ${res.status}`)
        }
        if (!json) {
          throw new SurepassError(endpoint, res.status, 'unparseable response body')
        }
        return json
      } catch (err) {
        if (err instanceof SurepassError) {
          // A 4xx-derived SurepassError is terminal; a 5xx one already retried above.
          if (err.statusCode !== 0 && err.statusCode < 500) throw err
          lastErr = err
        } else {
          // Timeout / network / abort — transient, so retry.
          lastErr = new SurepassError(endpoint, 0, err instanceof Error ? err.message : 'request failed')
        }
        if (attempt < maxAttempts) { await backoff(attempt); continue }
        throw lastErr
      }
    }
    // Unreachable: the loop either returns or throws. Satisfies the type checker.
    throw lastErr ?? new SurepassError(endpoint, 0, 'request failed')
  }
}

function backoff(attempt: number): Promise<void> {
  // 200ms, 400ms — small, since a KYC verify is a foreground request the user is waiting on.
  return new Promise(resolve => setTimeout(resolve, 200 * 2 ** (attempt - 1)))
}

// Singleton — import and use this everywhere instead of constructing a new client per request.
export const surepass = new SurepassClient()
