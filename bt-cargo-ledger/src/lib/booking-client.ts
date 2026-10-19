import { PodError } from './errors.js'

// -----------------------------------------------------------
// BookingClient — cargo-ledger's window into bt-booking-service.
// booking-service OWNS bookings + the trip state machine, so this
// service never mutates booking state directly: it asks for POD
// context (authorizing the driver) and, after a verified OTP, asks
// booking-service to run the in_transit → completed transition.
// -----------------------------------------------------------

export type PodContext = {
  booking_id: string
  status: string
  receiver_email: string | null
}

export interface BookingClient {
  /** Authorize the driver + fetch POD context. `bearer` is the driver's forwarded JWT. */
  getPodContext(bookingId: string, bearer: string): Promise<PodContext>
  /** Trusted internal call: drive in_transit → completed. Returns the new status. */
  completeViaPod(bookingId: string): Promise<{ status: string }>
}

async function readBody(res: Response): Promise<any> {
  return res.json().catch(() => ({}))
}

export class HttpBookingClient implements BookingClient {
  constructor(private readonly baseUrl: string, private readonly internalSecret: string) {}

  async getPodContext(bookingId: string, bearer: string): Promise<PodContext> {
    const res = await fetch(`${this.baseUrl}/bookings/${bookingId}/pod-context`, {
      headers: { authorization: bearer },
    })
    const body = await readBody(res)
    if (!res.ok) {
      throw new PodError(body?.error ?? 'Failed to fetch POD context', mapCode(body?.code), res.status)
    }
    return body.data as PodContext
  }

  async completeViaPod(bookingId: string): Promise<{ status: string }> {
    const res = await fetch(`${this.baseUrl}/internal/bookings/${bookingId}/complete-pod`, {
      method: 'POST',
      headers: { 'x-internal-secret': this.internalSecret },
    })
    const body = await readBody(res)
    if (!res.ok) {
      throw new PodError(body?.error ?? 'Failed to complete booking', mapCode(body?.code), res.status)
    }
    return { status: body.data?.status }
  }
}

// Preserve booking-service's meaningful codes; default to UPSTREAM_ERROR.
function mapCode(code: unknown): PodError['code'] {
  switch (code) {
    case 'FORBIDDEN': return 'FORBIDDEN'
    case 'NOT_FOUND': return 'NOT_FOUND'
    case 'INVALID_TRANSITION': return 'INVALID_TRANSITION'
    default: return 'UPSTREAM_ERROR'
  }
}

export function defaultBookingClient(): BookingClient {
  const baseUrl = process.env.BOOKING_SERVICE_URL
  const secret = process.env.INTERNAL_SERVICE_SECRET
  if (!baseUrl) throw new Error('BOOKING_SERVICE_URL must be set')
  if (!secret) throw new Error('INTERNAL_SERVICE_SECRET must be set')
  return new HttpBookingClient(baseUrl, secret)
}
