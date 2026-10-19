// Internal client → bt-tracking-service `POST /internal/route/point`.
//
// Pricing needs the REAL road distance for a quote but must NEVER hold the Google Maps key (the
// frozen maps CONTRACT keeps it in bt-tracking-service only). So it asks tracking over the internal
// (x-internal-secret) channel; tracking caches by lane, so a repeat quote is one cache hit. A
// failure, timeout, or missing secret returns null — the caller then falls back to a self-contained
// haversine estimate, so a quote never hard-fails on tracking being down (pricing-engine P1).

export type RouteCoords = { source_lat: number; source_lng: number; dest_lat: number; dest_lng: number }

export interface RouteDistanceClient {
  /** Road distance in km, or null if tracking is unavailable (caller falls back to haversine). */
  routeDistanceKm(coords: RouteCoords): Promise<number | null>
}

const DEFAULT_TIMEOUT_MS = 2500

export class HttpRouteDistanceClient implements RouteDistanceClient {
  constructor(
    private readonly baseUrl: string,
    private readonly internalSecret: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async routeDistanceKm(coords: RouteCoords): Promise<number | null> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}/internal/route/point`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-secret': this.internalSecret },
        body: JSON.stringify(coords),
        signal: ctrl.signal,
      })
      if (!res.ok) return null
      const json = (await res.json()) as { success?: boolean; data?: { distance_km?: number } }
      const km = json?.data?.distance_km
      return typeof km === 'number' && km > 0 ? km : null
    } catch {
      // Timeout / network / abort / bad JSON — all resolve to "no routed distance", fall back.
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

let injected: RouteDistanceClient | null = null
/** Test seam: inject a fake route client (or null to reset). */
export function __setRouteDistanceClientForTests(client: RouteDistanceClient | null): void {
  injected = client
}

/**
 * The client for the current process, or null when routing is not configured (no
 * INTERNAL_SERVICE_SECRET) — the caller then uses the haversine estimate.
 */
export function defaultRouteDistanceClient(): RouteDistanceClient | null {
  if (injected) return injected
  const secret = process.env.INTERNAL_SERVICE_SECRET
  if (!secret) return null
  const baseUrl = process.env.TRACKING_INTERNAL_URL ?? 'http://bt-tracking-service:3006'
  return new HttpRouteDistanceClient(baseUrl, secret)
}
