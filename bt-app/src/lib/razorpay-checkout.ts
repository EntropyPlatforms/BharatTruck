/**
 * Razorpay Standard Checkout, loaded on demand — only when a shipper presses "Pay online",
 * so no page pays for the script otherwise. The checkout is Razorpay's own hosted form
 * (card / UPI / netbanking); card details never touch this app.
 */

import type { CheckoutSuccess } from './types'

const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js'

type RazorpayOptions = {
  key: string
  order_id: string
  amount: number
  currency: string
  name: string
  description?: string
  prefill?: { name?: string; email?: string; contact?: string }
  theme?: { color?: string }
  handler: (result: CheckoutSuccess) => void
  modal?: { ondismiss?: () => void }
}

type RazorpayInstance = {
  open: () => void
  on: (event: 'payment.failed', cb: (res: { error?: { description?: string } }) => void) => void
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance
  }
}

let loading: Promise<void> | null = null

function loadCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve()
  if (!loading) {
    loading = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script')
      s.src = CHECKOUT_SRC
      s.async = true
      s.onload = () => resolve()
      s.onerror = () => {
        loading = null // let the next press try again
        s.remove()
        reject(new Error('Could not load the payment form. Check your connection and try again.'))
      }
      document.head.appendChild(s)
    })
  }
  return loading
}

export type CheckoutOutcome =
  | { kind: 'paid'; result: CheckoutSuccess }
  | { kind: 'dismissed' }
  | { kind: 'failed'; message: string }

/** Opens the checkout for an order and resolves when the shipper pays, fails or closes it. */
export async function openCheckout(order: {
  key_id: string
  order_id: string
  amount: number
  currency: string
  description: string
}): Promise<CheckoutOutcome> {
  await loadCheckout()
  const Razorpay = window.Razorpay
  if (!Razorpay) throw new Error('Could not load the payment form.')

  return new Promise<CheckoutOutcome>((resolve) => {
    // A failed attempt leaves the form open so the shipper can retry another method; the
    // last failure is only reported if they then close the form without paying.
    let lastFailure: string | null = null
    const rzp = new Razorpay({
      key: order.key_id,
      order_id: order.order_id,
      amount: order.amount,
      currency: order.currency,
      name: 'BharatTruck',
      description: order.description,
      theme: { color: '#1d4ed8' },
      handler: (result) => resolve({ kind: 'paid', result }),
      modal: { ondismiss: () => resolve(lastFailure ? { kind: 'failed', message: lastFailure } : { kind: 'dismissed' }) },
    })
    rzp.on('payment.failed', (res) => { lastFailure = res.error?.description ?? 'The payment did not go through.' })
    rzp.open()
  })
}
