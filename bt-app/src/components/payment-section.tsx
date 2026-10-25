'use client'

/**
 * Payment settlement (ship surface) — the CLOSING step of the trip lifecycle.
 *
 * A COMPLETED trip is paid and the booking flips completed → paid. Two ways:
 *   • PAY ONLINE — Razorpay's checkout (card / UPI / netbanking). Offered only when the
 *     server has Razorpay keys (GET /payments/config); the server confirms the payment
 *     with Razorpay before the trip closes. The carrier's payout is then PENDING.
 *   • RECORD A PAYMENT made outside the app — cash / UPI / bank transfer
 *     (POST /payments/settle). The only path when online payment is off.
 * This is the last thread of the North Star: one booking driven post → delivered →
 * PAID, entirely through the UI.
 *
 * Shown only to the SHIPPER (the payer, per the settle authorization) and only once
 * the trip is `completed` or `paid` — it renders nothing otherwise, so the surface
 * stays clean. The amount is LOCKED to the agreed price (final_price ?? quoted_price):
 * the server refuses a shipper self-discount, so the UI never offers one — it confirms
 * the figure and the shipper records how it was paid.
 */

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Check, Copy, Lock } from 'lucide-react'

import { Card, CardHead, ErrorNote, Loading } from '@/components/stat'
import {
  ApiError, createOnlineOrder, getPaymentConfig, getPaymentStatus, recordPayment, syncOnlinePayment, verifyOnlinePayment,
} from '@/lib/api'
import { openCheckout } from '@/lib/razorpay-checkout'
import { inr } from '@/lib/format'
import { BTN_PRIMARY, BTN_SECONDARY, INPUT, LABEL, LINK, MONO, SEG_OFF, SEG_ON, cx } from '@/lib/ui'
import type { Booking, PaymentConfig, PaymentMode, PaymentRecord, PaymentStatus } from '@/lib/types'

const MODES: { value: PaymentMode; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'direct', label: 'Bank transfer' },
]

const modeLabel = (m: PaymentRecord['mode'] | null) =>
  m === 'razorpay' ? 'online payment'
    : m === 'razorpay_test' ? 'online payment (TEST — no real money)'
    : MODES.find((x) => x.value === m)?.label ?? m ?? '—'

/** What this trip is contractually worth — the same precedence the server settles on. */
const agreedPrice = (b: Booking) => b.final_price ?? b.quoted_price

export default function PaymentSection({ booking, onChanged }: { booking: Booking; onChanged?: () => void }) {
  const isShipper = booking.viewer?.relations?.includes('shipper') ?? false
  const relevant = booking.status === 'completed' || booking.status === 'paid'

  const [status, setStatus] = useState<PaymentStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<PaymentMode>('cash')
  const [reference, setReference] = useState('')
  const [busy, setBusy] = useState(false)
  // Online payment: null until the server says whether it is switched on. A failed config
  // read is treated as "off" — the record-a-payment path must never be blocked by it.
  const [online, setOnline] = useState<PaymentConfig['razorpay'] | null>(null)
  const [paying, setPaying] = useState(false)
  const [outside, setOutside] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    Promise.all([
      getPaymentStatus(booking.id),
      getPaymentConfig().then((c) => c.razorpay).catch(() => null),
    ])
      .then(async ([st, rzp]) => {
        setOnline(rzp)
        // Paid online earlier but the confirmation never reached us (tab closed, network
        // dropped)? Ask the server to check with Razorpay and close the trip if so.
        if (rzp?.enabled && booking.status === 'completed' && !st.payment) {
          const synced = await syncOnlinePayment(booking.id).catch(() => null)
          if (synced?.synced) {
            setStatus(synced)
            toast.success('Your online payment was found — trip marked paid')
            onChanged?.()
            return
          }
        }
        setStatus(st)
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not load the payment status.'))
      .finally(() => setLoading(false))
    // onChanged is a fresh closure on every parent render; it must not retrigger the load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booking.id, booking.status])

  // Fetch only for the shipper on a delivered trip. booking.status is a dep so the
  // receipt re-pulls when the trip flips completed → paid after a settle elsewhere.
  useEffect(() => {
    if (isShipper && relevant) load()
    else setLoading(false)
  }, [isShipper, relevant, booking.status, load])

  // Not the payer, or nothing to settle yet → render nothing (keeps the surface clean).
  if (!isShipper || !relevant) return null

  const amount = agreedPrice(booking)

  async function submit() {
    setBusy(true)
    try {
      // The settle response already carries the payment + payout, so show the receipt
      // immediately; onChanged reloads the booking so the rest of the page sees `paid`.
      const res = await recordPayment(booking.id, amount, mode, reference.trim() || undefined)
      setStatus(res)
      toast.success('Payment recorded — trip marked paid')
      onChanged?.()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not record the payment.')
      setBusy(false)
    }
  }

  async function payOnline() {
    setPaying(true)
    try {
      const order = await createOnlineOrder(booking.id)
      if (order.already_paid) {
        setStatus(order.settlement)
        toast.success('This trip was already paid online — marked paid')
        onChanged?.()
        return
      }
      const outcome = await openCheckout({ ...order, description: `Freight for booking ${booking.id.slice(0, 8).toUpperCase()}` })
      if (outcome.kind === 'dismissed') return
      if (outcome.kind === 'failed') {
        toast.error(outcome.message)
        return
      }
      const res = await verifyOnlinePayment(booking.id, outcome.result)
      setStatus(res)
      toast.success('Payment received — trip marked paid')
      onChanged?.()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PAYMENT_PENDING') {
        toast.message('Your bank is still confirming the payment. This page will update — do not pay again.')
      } else {
        toast.error(e instanceof Error ? e.message : 'Could not start the payment.')
      }
    } finally {
      setPaying(false)
    }
  }

  const paid = booking.status === 'paid'
  const canPayOnline = !!online?.enabled
  // The record-a-payment form: the whole card when online payment is off, a disclosure
  // under the Pay button when it is on.
  const showRecordForm = !canPayOnline || outside
  const payment = status?.payment
  const payout = status?.payout

  async function copyRef(ref: string) {
    try {
      await navigator.clipboard.writeText(ref)
      toast.success('Reference copied')
    } catch {
      toast.error('Could not copy — select the reference instead')
    }
  }

  return (
    <div className="grid gap-5 md:grid-cols-2 max-w-4xl items-start">
      {/* Completed — record the settlement. */}
      {(loading || error || booking.status === 'completed' || (paid && !payment)) && (
        <Card>
          <CardHead
            title="Payment"
            sub={paid ? 'Settled' : canPayOnline ? 'Pay the agreed price to close this trip.' : 'Record the settlement to close this trip.'}
          />
          <div className="p-5">
            {loading && <Loading label="Loading payment" />}
            {error && !loading && <ErrorNote message={error} />}

            {!loading && !error && paid && !payment && (
              <p className="text-sm text-gray-500">This trip is marked paid.</p>
            )}

            {!loading && !error && booking.status === 'completed' && (
              <div className="space-y-5">
                <div className="rounded-xl border border-gray-200 px-4 py-3.5">
                  <p className="text-sm text-gray-500">Amount due</p>
                  <p className="mt-0.5 text-[1.875rem] leading-tight font-extrabold text-gray-900 tabular-nums">{inr(amount)}</p>
                </div>

                {canPayOnline && (
                  <div className="space-y-2.5">
                    <button onClick={payOnline} disabled={paying || busy || amount <= 0} className={cx(BTN_PRIMARY, 'w-full h-12 text-base')}>
                      {paying ? 'Opening payment…' : `Pay ${inr(amount)} online`}
                    </button>
                    <p className="flex items-center justify-center gap-1.5 text-[0.8125rem] text-gray-500">
                      <Lock className="w-3.5 h-3.5" aria-hidden />
                      Card, UPI or netbanking — secured by Razorpay
                    </p>
                    {online?.test_mode && (
                      <p className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[0.8125rem] text-amber-800">
                        Test mode: no real money is taken.
                      </p>
                    )}
                    {!outside && (
                      <p className="pt-1 text-center text-sm text-gray-500">
                        Already paid the carrier directly?{' '}
                        <button type="button" onClick={() => setOutside(true)} className={LINK}>Record that payment</button>
                      </p>
                    )}
                  </div>
                )}

                {showRecordForm && canPayOnline && (
                  <div className="flex items-center gap-3 text-xs font-semibold uppercase tracking-wide text-gray-400">
                    <span className="h-px flex-1 bg-gray-200" />
                    or record a payment made outside the app
                    <span className="h-px flex-1 bg-gray-200" />
                  </div>
                )}

                {showRecordForm && (<>
                <div>
                  <p id="paid-by" className={LABEL}>Paid by</p>
                  <div role="radiogroup" aria-labelledby="paid-by" className="grid grid-cols-3 rounded-xl border border-gray-200 bg-white p-1 gap-1">
                    {MODES.map((m) => (
                      <button
                        key={m.value}
                        type="button"
                        role="radio"
                        aria-checked={mode === m.value}
                        onClick={() => setMode(m.value)}
                        className={cx(
                          mode === m.value ? SEG_ON : SEG_OFF,
                          'h-10 px-2 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600',
                        )}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label htmlFor="pay-ref" className={LABEL}>
                    Reference <span className="font-normal text-gray-400">(optional)</span>
                  </label>
                  <input
                    id="pay-ref"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    maxLength={200}
                    placeholder="UTR / txn id / note"
                    className={INPUT}
                  />
                </div>

                <button
                  onClick={submit}
                  disabled={busy || paying || amount <= 0}
                  className={cx(canPayOnline ? BTN_SECONDARY : BTN_PRIMARY, 'w-full h-12 text-base')}
                >
                  {busy ? 'Recording…' : `Record ${inr(amount)} paid`}
                </button>
                </>)}
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Paid — the receipt. */}
      {!loading && !error && paid && payment && (
        <Card className="p-6 text-center">
          <span className="mx-auto w-16 h-16 rounded-full bg-emerald-500 text-[#fff] inline-flex items-center justify-center ring-8 ring-emerald-50">
            <Check className="w-8 h-8" strokeWidth={3} />
          </span>
          <p className="mt-4 text-lg font-bold text-gray-900">Paid</p>
          <p className="text-[2.125rem] leading-tight font-extrabold text-gray-900 tabular-nums">{inr(payment.amount)}</p>
          <p className="text-[0.9375rem] text-gray-600">by {modeLabel(payment.mode)}</p>

          <div className="mt-5 pt-4 border-t-2 border-blue-600/80 text-left space-y-4">
            {payment.reference && (
              <div>
                <p className="text-sm text-gray-500">{payment.mode === 'razorpay' || payment.mode === 'razorpay_test' ? 'Payment ID' : 'Reference'}</p>
                <div className="mt-0.5 flex items-center gap-2 min-w-0">
                  <p className={cx(MONO, 'text-[0.9375rem] font-medium text-gray-900 truncate')}>{payment.reference}</p>
                  <button
                    type="button"
                    onClick={() => copyRef(payment.reference!)}
                    aria-label="Copy reference"
                    className="p-1.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                  >
                    <Copy className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
            {payout && (
              <div>
                <p className="text-sm text-gray-500">{`Payout to ${payout.payee_type === 'fleet_owner' ? 'fleet' : 'driver'}`}</p>
                <p className="mt-0.5 text-2xl font-bold text-emerald-600 tabular-nums">{inr(payout.amount)}</p>
                {payout.status === 'pending' && (
                  <p className="mt-0.5 text-sm text-gray-500">Being paid out by BharatTruck</p>
                )}
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  )
}
