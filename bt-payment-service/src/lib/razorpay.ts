import { createHmac, timingSafeEqual } from 'node:crypto'
import { PaymentError } from './errors.js'

// -----------------------------------------------------------
// Razorpay gateway — ONLINE COLLECTION from the shipper (Standard Checkout).
//
// Scope, deliberately narrow: an Order is created for the booking's agreed price, the
// shipper pays it in Razorpay's checkout, and the payment is confirmed SERVER-SIDE
// (signature + a read of the order and its payments from Razorpay) before the booking
// is closed. Disbursing the carrier's payout (Route / RazorpayX, D-12) is NOT here: an
// online collection leaves the carrier's payout row 'pending'.
//
// INERT UNTIL CONFIGURED: with RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET unset,
// defaultGateway() returns null, every Razorpay route answers 503
// GATEWAY_NOT_CONFIGURED, GET /payments/config says so, and the app keeps today's
// record-a-payment flow. Test keys (rzp_test_…) make the whole flow run without real
// money. RAZORPAY_WEBHOOK_SECRET is needed only by the webhook.
//
// No SDK: four REST calls over fetch with HTTP Basic auth, and two HMACs.
// -----------------------------------------------------------

export type RazorpayOrder = {
  id: string
  amount: number          // paise
  amount_paid: number     // paise
  currency: string
  receipt: string | null
  status: 'created' | 'attempted' | 'paid'
  notes: Record<string, string> | unknown[]
}

export type RazorpayPayment = {
  id: string
  order_id: string | null
  amount: number          // paise
  currency: string
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed'
  method?: string
}

export interface PaymentGateway {
  /** The PUBLIC key id — safe to hand to the browser; it opens the checkout. */
  readonly keyId: string
  /** rzp_test_… keys take no real money. */
  readonly testMode: boolean
  createOrder(args: { amountPaise: number; receipt: string; notes: Record<string, string> }): Promise<RazorpayOrder>
  fetchOrder(orderId: string): Promise<RazorpayOrder>
  fetchOrderPayments(orderId: string): Promise<RazorpayPayment[]>
  /** Orders created for one booking (receipt = booking id), newest first. */
  findOrdersByReceipt(receipt: string): Promise<RazorpayOrder[]>
  /** The checkout's success callback: HMAC-SHA256(order_id|payment_id, key secret). */
  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean
  /** A webhook delivery: HMAC-SHA256(raw body, webhook secret). False when no secret is set. */
  verifyWebhookSignature(rawBody: string, signature: string): boolean
}

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

export function hmacHex(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

/** `notes` comes back as `[]` when empty and as an object otherwise. */
export function orderNote(order: RazorpayOrder, key: string): string | null {
  const notes = order.notes
  if (!notes || Array.isArray(notes)) return null
  const v = (notes as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : null
}

export class HttpRazorpayGateway implements PaymentGateway {
  readonly testMode: boolean

  constructor(
    readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret: string | null,
    private readonly baseUrl = 'https://api.razorpay.com/v1',
  ) {
    this.testMode = keyId.startsWith('rzp_test_')
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      throw new PaymentError('Could not reach the payment gateway', 'UPSTREAM_ERROR', 502)
    }
    const json: any = await res.json().catch(() => ({}))
    if (!res.ok) {
      // Razorpay's own description is safe to surface (it never echoes the secret) and is
      // what an operator needs ("Authentication failed", "amount exceeds maximum…").
      const why = json?.error?.description ?? `HTTP ${res.status}`
      throw new PaymentError(`Payment gateway error: ${why}`, 'UPSTREAM_ERROR', 502)
    }
    return json as T
  }

  createOrder(args: { amountPaise: number; receipt: string; notes: Record<string, string> }): Promise<RazorpayOrder> {
    return this.call<RazorpayOrder>('POST', '/orders', {
      amount: args.amountPaise,
      currency: 'INR',
      receipt: args.receipt,
      notes: args.notes,
      // Capture as soon as the bank authorizes: there is no "hold then decide" step in
      // this flow, and an authorized-but-uncaptured payment auto-refunds after days.
      payment_capture: 1,
    })
  }

  fetchOrder(orderId: string): Promise<RazorpayOrder> {
    return this.call<RazorpayOrder>('GET', `/orders/${encodeURIComponent(orderId)}`)
  }

  async fetchOrderPayments(orderId: string): Promise<RazorpayPayment[]> {
    const res = await this.call<{ items?: RazorpayPayment[] }>('GET', `/orders/${encodeURIComponent(orderId)}/payments`)
    return res.items ?? []
  }

  async findOrdersByReceipt(receipt: string): Promise<RazorpayOrder[]> {
    const res = await this.call<{ items?: RazorpayOrder[] }>('GET', `/orders?receipt=${encodeURIComponent(receipt)}&count=25`)
    return res.items ?? []
  }

  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    return safeEqualHex(hmacHex(`${orderId}|${paymentId}`, this.keySecret), signature)
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    if (!this.webhookSecret) return false
    return safeEqualHex(hmacHex(rawBody, this.webhookSecret), signature)
  }
}

/** null when the keys are not set — the feature is then off everywhere. */
export function defaultGateway(): PaymentGateway | null {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim()
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim()
  if (!keyId || !keySecret) return null
  // Going live: RAZORPAY_REQUIRE_LIVE=true refuses rzp_test_ keys, so a forgotten test key can never
  // take 'payments' that close real trips. Off by default while the platform is tested on test keys.
  if (keyId.startsWith('rzp_test_') && (process.env.RAZORPAY_REQUIRE_LIVE ?? '').trim().toLowerCase() === 'true') return null
  return new HttpRazorpayGateway(keyId, keySecret, process.env.RAZORPAY_WEBHOOK_SECRET?.trim() || null)
}
