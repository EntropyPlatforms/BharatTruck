'use client'

/**
 * "Deliveries waiting for payment" — a popup for the shipper.
 *
 * A shipper with many loads should not have to open each one to find out which were
 * delivered. The home feed already carries a `payment_due` item for every delivered,
 * unpaid load they posted; this reads the same feed and, when there is one the shipper
 * has not been shown yet, lists them all with a Pay button each.
 *
 * Shown once per delivery, not once per page: the ids already shown are remembered for the
 * browser session, so "Later" stays dismissed until ANOTHER load is delivered. The items
 * remain in Latest activity on Home either way. Re-checked every couple of minutes, so a
 * delivery that lands while the shipper is working pops up without a refresh.
 */

import { useCallback, useEffect, useState } from 'react'
import { PackageCheck, X } from 'lucide-react'

import { getMyFeed } from '@/lib/api'
import { BTN_PRIMARY, BTN_SECONDARY, cx } from '@/lib/ui'
import type { FeedItem } from '@/lib/types'

const SEEN_KEY = 'bt_payment_due_seen'
const POLL_MS = 2 * 60 * 1000

function readSeen(): Set<string> {
  try { return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? '[]') as string[]) } catch { return new Set() }
}
function writeSeen(ids: Iterable<string>) {
  try { sessionStorage.setItem(SEEN_KEY, JSON.stringify([...ids])) } catch { /* private mode: the popup just shows again */ }
}

export const paymentHref = (item: FeedItem) => `/loads/${item.target.booking_id}?tab=payment`

export default function PaymentDuePrompt() {
  const [due, setDue] = useState<FeedItem[]>([])
  const [open, setOpen] = useState(false)

  const check = useCallback(() => {
    getMyFeed({ limit: 50 })
      .then((page) => {
        const items = page.items.filter((i) => i.type === 'payment_due' && i.target.booking_id)
        setDue(items)
        const seen = readSeen()
        if (items.some((i) => !seen.has(i.id))) setOpen(true)
      })
      .catch(() => { /* a prompt must never surface an error of its own */ })
  }, [])

  useEffect(() => {
    check()
    const t = setInterval(check, POLL_MS)
    return () => clearInterval(t)
  }, [check])

  const close = useCallback(() => {
    writeSeen(new Set([...readSeen(), ...due.map((i) => i.id)]))
    setOpen(false)
  }, [due])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  if (!open || due.length === 0) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 sm:px-4" onClick={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="payment-due-title"
        className="bg-white rounded-t-2xl sm:rounded-2xl border border-gray-200 shadow-xl w-full sm:max-w-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-gray-100">
          <div className="flex items-center gap-3 min-w-0">
            <span className="w-10 h-10 rounded-full bg-emerald-50 text-emerald-600 inline-flex items-center justify-center shrink-0">
              <PackageCheck className="w-5 h-5" />
            </span>
            <div className="min-w-0">
              <h3 id="payment-due-title" className="text-base font-bold text-gray-900">
                {due.length === 1 ? 'A load was delivered' : `${due.length} loads were delivered`}
              </h3>
              <p className="text-sm text-gray-500">Payment is due to close {due.length === 1 ? 'the trip' : 'these trips'}.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="p-1.5 -m-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <ul className="max-h-[50vh] overflow-y-auto divide-y divide-gray-100">
          {due.map((item) => (
            <li key={item.id} className="flex items-center gap-3 px-5 py-3">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-gray-900 truncate">{item.title.replace(/^Delivered — /, '')}</span>
                <span className="block text-[0.8125rem] text-gray-500 truncate">{item.subtitle}</span>
              </span>
              {/* A full navigation on purpose: the load page picks its tab from ?tab= when it
                  mounts, so a client-side hop from ANOTHER load's page would keep the old tab. */}
              <a href={paymentHref(item)} onClick={close} className={cx(BTN_PRIMARY, 'h-9! px-3.5 shrink-0')}>
                Pay
              </a>
            </li>
          ))}
        </ul>

        <div className="px-5 py-3.5 border-t border-gray-100">
          <button type="button" onClick={close} className={cx(BTN_SECONDARY, 'w-full')}>Later</button>
        </div>
      </div>
    </div>
  )
}
