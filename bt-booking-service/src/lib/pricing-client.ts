import { BookingError } from './types.js'

// -----------------------------------------------------------
// PricingClient — booking-service's window into bt-pricing-service.
// pricing OWNS the price_quotes lock, so booking never reads that table
// directly (own-your-data). It reads the locked quote over the internal,
// shared-secret-gated endpoint, then atomically consumes it once a booking
// locks the quote in. Mirrors the internal-client pattern of
// bt-payment-service/src/lib/booking-client.ts.
//
// All non-2xx responses surface as a BookingError (a 4xx/5xx envelope), so a
// pricing failure NEVER leaks a raw 500 from the booking-create path.
// -----------------------------------------------------------

export type LockedQuote = {
  id: string
  shipper_id: string
  quoted_price: number
  currency: string
  expires_at: string
  // consumed_at is the source of truth for "already consumed" (immutable; survives
  // a booking hard-delete). consumed_by_booking_id has ON DELETE SET NULL and must
  // NOT be used as the replay guard.
  consumed_at: string | null
  consumed_by_booking_id: string | null
  // Priced route + cargo — booking-create BINDS the booking to these so a lock
  // priced for a short/light trip cannot be spent on a long/heavy one.
  source_lat: number
  source_lng: number
  dest_lat: number
  dest_lng: number
  distance_km: number
  vehicle_type: string
  vehicle_class: string
  load_type: string
  weight_kg: number
  breakdown_json: unknown
}

export interface PricingClient {
  getQuote(quoteId: string): Promise<LockedQuote>
  consumeQuote(quoteId: string, bookingId: string): Promise<LockedQuote>
}

async function readBody(res: Response): Promise<any> {
  return res.json().catch(() => ({}))
}

// Map pricing's error code onto a BookingError. Known domain codes pass through
// with their canonical status; anything else is an upstream fault (502) with a
// redacted message so pricing's internals never leak to the shipper.
function upstreamError(body: any, fallback: string): BookingError {
  switch (body?.code) {
    case 'NOT_FOUND':
      return new BookingError(body?.error ?? 'Quote not found', 'NOT_FOUND', 404)
    case 'INVALID_TRANSITION':
      return new BookingError(body?.error ?? 'Quote already used or expired', 'INVALID_TRANSITION', 409)
    case 'VALIDATION_ERROR':
      return new BookingError(body?.error ?? 'Invalid quote request', 'VALIDATION_ERROR', 400)
    default:
      return new BookingError(fallback, 'UPSTREAM_ERROR', 502)
  }
}

export class HttpPricingClient implements PricingClient {
  constructor(private readonly baseUrl: string, private readonly internalSecret: string) {}

  async getQuote(quoteId: string): Promise<LockedQuote> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/internal/quote/${quoteId}`, {
        headers: { 'x-internal-secret': this.internalSecret },
      })
    } catch {
      throw new BookingError('Pricing service unavailable', 'UPSTREAM_ERROR', 502)
    }
    const body = await readBody(res)
    if (!res.ok) {
      throw upstreamError(body, 'Failed to read locked quote')
    }
    return body.data as LockedQuote
  }

  async consumeQuote(quoteId: string, bookingId: string): Promise<LockedQuote> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/internal/quote/${quoteId}/consume`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-secret': this.internalSecret },
        body: JSON.stringify({ booking_id: bookingId }),
      })
    } catch {
      throw new BookingError('Pricing service unavailable', 'UPSTREAM_ERROR', 502)
    }
    const body = await readBody(res)
    if (!res.ok) {
      throw upstreamError(body, 'Failed to consume locked quote')
    }
    return body.data as LockedQuote
  }
}

export function defaultPricingClient(): PricingClient {
  const baseUrl = process.env.PRICING_SERVICE_URL
  const secret = process.env.INTERNAL_SERVICE_SECRET
  if (!baseUrl) throw new Error('PRICING_SERVICE_URL must be set')
  if (!secret) throw new Error('INTERNAL_SERVICE_SECRET must be set')
  return new HttpPricingClient(baseUrl, secret)
}
