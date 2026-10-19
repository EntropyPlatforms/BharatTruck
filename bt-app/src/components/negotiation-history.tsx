'use client'

/**
 * The price thread for one bid — every offer and counter, oldest first. Ported from
 * shipper/src/components/NegotiationHistory.tsx into bt-app's light style, reusing
 * this app's existing getBidHistory (GET /bookings/:id/quotes/:qid/history).
 *
 * The carrier side of a negotiation is a fleet owner as often as a driver now, so an
 * unknown role falls back to the neutral "Carrier" rather than naming the wrong party.
 */

import { useEffect, useRef, useState } from 'react'
import { Building2, UserRound } from 'lucide-react'
import { ApiError, getBidHistory } from '@/lib/api'
import type { NegotiationEntry } from '@/lib/types'

const ACTOR_LABEL: Record<NegotiationEntry['actor_role'], string> = {
  shipper: 'You',
  driver: 'Driver',
  fleet_owner: 'Fleet operator',
}

export function NegotiationHistory({ bookingId, quoteId }: { bookingId: string; quoteId: string }) {
  const [entries, setEntries] = useState<NegotiationEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    getBidHistory(bookingId, quoteId)
      .then((e) => { if (!cancelled) setEntries(e) })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load the negotiation history.')
      })
    return () => { cancelled = true }
  }, [bookingId, quoteId])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [entries])

  if (error) return <p className="text-sm text-red-600 py-2">{error}</p>
  if (!entries) return <p className="text-sm text-gray-500 py-2">Loading negotiation history…</p>
  if (entries.length === 0) return <p className="text-sm text-gray-500 py-2">No negotiation history yet.</p>

  return (
    <div ref={scrollRef} className="max-h-[420px] overflow-y-auto space-y-4 py-1 px-0.5">
      {entries.map((entry) => {
        const isShipper = entry.actor_role === 'shipper'
        return (
          <div key={entry.id} className={`flex items-end gap-2 ${isShipper ? 'justify-end' : 'justify-start'}`}>
            {!isShipper && (
              <span className="w-7 h-7 rounded-lg bg-gray-100 text-gray-500 inline-flex items-center justify-center shrink-0 mb-5" aria-hidden>
                {entry.actor_role === 'fleet_owner' ? <Building2 className="w-4 h-4" /> : <UserRound className="w-4 h-4" />}
              </span>
            )}
            <div className={`max-w-[80%] ${isShipper ? 'text-right' : ''}`}>
              <div
                className={`rounded-xl px-3.5 py-2.5 text-left border ${
                  isShipper ? 'bg-blue-50 border-blue-100 rounded-br-sm' : 'bg-gray-50 border-gray-100 rounded-bl-sm'
                }`}
              >
                <p className={`text-xs font-semibold mb-0.5 ${isShipper ? 'text-blue-700' : 'text-gray-500'}`}>{ACTOR_LABEL[entry.actor_role] ?? 'Carrier'}</p>
                <p className={`text-base font-bold tabular-nums ${isShipper ? 'text-blue-700' : 'text-gray-900'}`}>₹{entry.amount.toLocaleString('en-IN')}</p>
                {entry.message && <p className="text-sm mt-1 text-gray-700">{entry.message}</p>}
              </div>
              <p className="text-[0.6875rem] mt-1 text-gray-400 px-1">
                {new Date(entry.created_at).toLocaleString('en-IN', {
                  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                })}
              </p>
            </div>
          </div>
        )
      })}
    </div>
  )
}
