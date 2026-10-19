import { PaymentError } from './errors.js'

// -----------------------------------------------------------
// BookingClient — payment-service's window into bt-booking-service.
// booking-service OWNS bookings + the state machine, so payment-service
// reads a booking for authorization/status (forwarding the actor's JWT,
// which also enforces shipper-ownership) and, after recording a
// settlement, asks booking-service to run completed → paid.
// -----------------------------------------------------------

export type BookingView = {
  id: string
  status: string
  shipper_id: string
  driver_id: string | null
  // Set only when a FLEET won the auction (migration 016). Absent on every
  // pre-fleet booking and on older booking-service builds, hence optional —
  // a missing field must read as "solo driver", never as an error.
  fleet_owner_id?: string | null
  // The D-22 receiving party (users.id), when the booking names one and that
  // party has claimed an account. Optional because a pre-0026 booking read omits
  // it — in which case no consignee relation resolves and the consignee-pays
  // settlement path never opens, which is the safe degradation.
  consignee_user_id?: string | null
  quoted_price: number
  final_price: number | null
}

export interface BookingClient {
  getBooking(bookingId: string, bearer: string): Promise<BookingView>
  /**
   * The same read with NO acting user — service-to-service, internal-secret gated. Only
   * for a caller that has authenticated the request some other way and has no JWT to
   * forward: the Razorpay webhook (signature-verified). Never use it to skip the
   * read-access check a user-facing route gets from getBooking().
   */
  getBookingInternal(bookingId: string): Promise<BookingView>
  /**
   * `detail` rides along so booking-service can put the amount actually settled on
   * the shipper's receipt, rather than re-deriving it from the booking. Optional:
   * booking-service falls back to the booking's own price when it is absent, so an
   * older caller (or a test fake) that omits it still behaves exactly as before.
   */
  markPaid(bookingId: string, detail?: SettlementDetail): Promise<{ status: string }>
}

async function readBody(res: Response): Promise<any> {
  return res.json().catch(() => ({}))
}

function mapCode(code: unknown): PaymentError['code'] {
  switch (code) {
    case 'FORBIDDEN': return 'FORBIDDEN'
    case 'NOT_FOUND': return 'NOT_FOUND'
    case 'INVALID_TRANSITION': return 'INVALID_STATE'
    default: return 'UPSTREAM_ERROR'
  }
}

/** What was settled, for the receipt booking-service emails the shipper. */
export type SettlementDetail = {
  amount?: number
  method?: string
  payment_id?: string
  payout_status?: string
}

export class HttpBookingClient implements BookingClient {
  constructor(private readonly baseUrl: string, private readonly internalSecret: string) {}

  async getBooking(bookingId: string, bearer: string): Promise<BookingView> {
    const res = await fetch(`${this.baseUrl}/bookings/${bookingId}`, { headers: { authorization: bearer } })
    const body = await readBody(res)
    if (!res.ok) {
      throw new PaymentError(body?.error ?? 'Failed to read booking', mapCode(body?.code), res.status)
    }
    return body.data as BookingView
  }

  async getBookingInternal(bookingId: string): Promise<BookingView> {
    const res = await fetch(`${this.baseUrl}/internal/bookings/${bookingId}`, {
      headers: { 'x-internal-secret': this.internalSecret },
    })
    const body = await readBody(res)
    if (!res.ok) {
      throw new PaymentError(body?.error ?? 'Failed to read booking', mapCode(body?.code), res.status)
    }
    return body.data as BookingView
  }

  async markPaid(bookingId: string, detail?: SettlementDetail): Promise<{ status: string }> {
    const res = await fetch(`${this.baseUrl}/internal/bookings/${bookingId}/mark-paid`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-secret': this.internalSecret },
      body: JSON.stringify(detail ?? {}),
    })
    const body = await readBody(res)
    if (!res.ok) {
      throw new PaymentError(body?.error ?? 'Failed to mark booking paid', mapCode(body?.code), res.status)
    }
    return { status: body.data?.status }
  }
}

export function defaultBookingClient(): BookingClient {
  const baseUrl = process.env.BOOKING_SERVICE_URL
  const secret = process.env.INTERNAL_SERVICE_SECRET
  if (!baseUrl) throw new Error('BOOKING_SERVICE_URL must be set')
  if (!secret) throw new Error('INTERNAL_SERVICE_SECRET must be set')
  return new HttpBookingClient(baseUrl, secret)
}
