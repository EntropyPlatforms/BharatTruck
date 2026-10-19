'use client'

/**
 * The consignee inbox the receiver-OTP delivery code is emailed to, with an inline
 * editor. Ported from shipper/src/components/ReceiverEmailSection.tsx into bt-app's
 * light house style.
 *
 * WHY IT MATTERS: a booking with no receiver email is a trip that cannot be closed
 * by the receiver-OTP POD — the driver's proof-of-delivery request has nowhere to
 * send the code, so the trip sticks in in_transit and the payout it gates never
 * happens. This is where the shipper sets or corrects it. Deliberately LOUD when it
 * is missing on a live trip (accepted / in_transit); a quiet prompt otherwise.
 */

import { useState } from 'react'
import { toast } from 'sonner'
import { Mail } from 'lucide-react'
import { setReceiverEmail } from '@/lib/api'
import { BTN_PRIMARY, BTN_SECONDARY, INPUT, cx } from '@/lib/ui'
import type { Booking } from '@/lib/types'

export function ReceiverEmailSection({ booking, onSaved }: { booking: Booking; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(booking.receiver_email ?? '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // The server refuses the edit on a terminal booking, so do not offer it there.
  const editable = ['pending', 'negotiating', 'accepted', 'in_transit'].includes(booking.status)
  const missing = !booking.receiver_email
  const blocking = missing && (booking.status === 'accepted' || booking.status === 'in_transit')

  async function save() {
    const email = value.trim()
    if (!email) { setErr('Enter the receiver’s email address.'); return }
    setSaving(true)
    setErr(null)
    try {
      await setReceiverEmail(booking.id, email)
      toast.success('Receiver email saved — your driver can now send the delivery code')
      setEditing(false)
      onSaved()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not save the receiver email.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-4 pt-4 border-t border-gray-100">
      <div className={blocking ? 'rounded-xl border border-amber-200 bg-amber-50 p-3.5' : ''}>
        <p className={`text-xs font-semibold mb-1 inline-flex items-center gap-1.5 ${blocking ? 'text-amber-800' : 'text-gray-500'}`}>
          <Mail className="w-3.5 h-3.5" /> Delivery code goes to
        </p>

        {editing ? (
          <div className="flex flex-col sm:flex-row gap-2 mt-2">
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') save() }}
              placeholder="consignee@example.com"
              disabled={saving}
              aria-label="Receiver email address"
              className={cx(INPUT, 'flex-1 min-w-0 disabled:opacity-60')}
            />
            <div className="flex gap-2">
              <button onClick={save} disabled={saving} className={cx(BTN_PRIMARY, 'flex-1 sm:flex-none')}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={() => { setEditing(false); setValue(booking.receiver_email ?? ''); setErr(null) }}
                disabled={saving}
                className={cx(BTN_SECONDARY, 'flex-1 sm:flex-none')}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              {booking.receiver_email ? (
                <p className="text-sm font-medium text-gray-900 break-all">{booking.receiver_email}</p>
              ) : (
                <p className={`text-sm ${blocking ? 'text-amber-900' : 'text-gray-500'}`}>
                  {blocking
                    ? 'Not set — delivery can’t be confirmed, and payment waits on it.'
                    : 'Not set. Add it before the trip reaches the drop.'}
                </p>
              )}
            </div>
            {editable && (
              <button
                onClick={() => setEditing(true)}
                className={cx(
                  'shrink-0 inline-flex items-center h-8 px-3 rounded-lg text-xs font-semibold transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600',
                  missing ? 'bg-brand-500 hover:bg-brand-400 text-ink' : 'border border-gray-200 bg-white text-gray-700 hover:bg-gray-50',
                )}
              >
                {missing ? 'Add email' : 'Edit'}
              </button>
            )}
          </div>
        )}

        {err && <p className="mt-2 text-xs font-medium text-red-600">{err}</p>}
      </div>
    </div>
  )
}
