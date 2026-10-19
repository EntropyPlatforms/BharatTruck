'use client'

/**
 * Counter-offer modal for the shipper. Ported from shipper/src/components/
 * CounterModal.tsx into bt-app's light style — a dependency-free overlay, closed on
 * backdrop click or Escape.
 */

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'

import { BTN_PRIMARY, BTN_SECONDARY, INPUT, LABEL, cx } from '@/lib/ui'

export function CounterModal({
  onSubmit,
  onClose,
}: {
  onSubmit: (amount: number, message?: string) => Promise<void>
  onClose: () => void
}) {
  const [amount, setAmount] = useState('')
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const num = parseFloat(amount)
    if (!num || num <= 0) { setError('Enter a valid counter amount.'); return }
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit(num, message.trim() || undefined)
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not send the counter offer.')
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 sm:px-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="counter-title"
        className="bg-white rounded-t-2xl sm:rounded-2xl border border-gray-200 shadow-xl w-full sm:max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3 border-b border-gray-100">
          <h3 id="counter-title" className="text-base font-bold text-gray-900">Counter offer</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 -m-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label htmlFor="counter-amount" className={LABEL}>Amount (₹)</label>
            <input
              id="counter-amount"
              type="number"
              min="1"
              step="any"
              required
              autoFocus
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Your counter amount"
              className={cx(INPUT, 'tabular-nums')}
            />
          </div>
          <div>
            <label htmlFor="counter-message" className={LABEL}>Message (optional)</label>
            <input
              id="counter-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="e.g. Can you do it for this price?"
              className={INPUT}
            />
          </div>
          {error && <p className="text-sm font-medium text-red-600">{error}</p>}
          <div className="grid grid-cols-2 gap-3 pt-1">
            <button type="button" onClick={onClose} className={BTN_SECONDARY}>
              Cancel
            </button>
            <button type="submit" disabled={submitting} className={BTN_PRIMARY}>
              {submitting ? 'Sending…' : 'Send counter'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
