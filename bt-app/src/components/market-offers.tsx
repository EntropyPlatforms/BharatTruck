'use client'

/**
 * Market load offers — a fleet wants to hire this driver's OWN truck for one load (a "market
 * truck"; the fleet badges it Outsider). The consent seam for that hire: nothing is bound until
 * the driver accepts here, and accepting puts the load on their trips straight away.
 *
 * Renders nothing unless the signed-in human can drive AND has an open offer. Offers lapse
 * after 24 hours. No price is shown: the hire is agreed between the driver and the fleet.
 */

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Check, Truck, X } from 'lucide-react'

import { Card, IconTile } from '@/components/stat'
import { ApiError, answerMarketOffer, listMyMarketOffers } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { shortDate, tons } from '@/lib/format'
import { BTN_PRIMARY, BTN_SECONDARY, MONO, cx } from '@/lib/ui'
import type { MarketLoadOffer } from '@/lib/types'

function hoursLeft(iso: string): number {
  return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 3_600_000))
}

export default function MarketOffers() {
  const { capabilities } = useAuth()
  const [offers, setOffers] = useState<MarketLoadOffer[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const canDrive = capabilities?.includes('drive') ?? false

  const load = useCallback(() => {
    listMyMarketOffers().then(setOffers).catch(() => setOffers([]))
  }, [])

  // Only a driver can be offered a load; for anyone else nothing is fetched and nothing renders.
  useEffect(() => {
    if (canDrive) load()
  }, [canDrive, load])

  if (!canDrive || !offers || offers.length === 0) return null

  async function answer(o: MarketLoadOffer, action: 'accept' | 'decline') {
    setBusyId(o.booking_id)
    try {
      await answerMarketOffer(o.booking_id, action)
      toast.success(action === 'accept'
        ? `The load is on your trips — start it when you're at pickup`
        : 'Offer declined')
      load()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not answer the offer')
      load()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-3">
      {offers.map((o) => (
        <Card key={o.booking_id}>
          <div className="p-4 sm:px-5 flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="flex items-start sm:items-center gap-3.5 min-w-0 flex-1">
              <IconTile icon={<Truck />} tint="amber" size="lg" />
              <div className="min-w-0">
                <p className="text-[0.9375rem] font-bold text-gray-900">
                  {o.fleet?.company_name ?? 'A fleet'} wants to hire your truck
                  {o.rc_number ? <> <span className={cx(MONO, 'text-blue-700')}>{o.rc_number}</span></> : null}
                </p>
                <p className="text-sm text-gray-700 mt-0.5 truncate">
                  {o.source_address} → {o.destination_address}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {(o.load_type || 'Load').replace(/_/g, ' ')} · {tons(o.weight_kg)} · pickup {shortDate(o.pickup_date)}
                  {' · '}one trip, you stay independent · agree the payment with the fleet · {hoursLeft(o.expires_at)} h left
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:flex gap-2.5 shrink-0">
              <button
                onClick={() => answer(o, 'accept')}
                disabled={busyId === o.booking_id}
                className={cx(BTN_PRIMARY, 'h-11 sm:min-w-[96px]')}
              >
                <Check className="w-4 h-4" /> Accept
              </button>
              <button
                onClick={() => answer(o, 'decline')}
                disabled={busyId === o.booking_id}
                className={cx(BTN_SECONDARY, 'h-11 sm:min-w-[96px]')}
              >
                <X className="w-4 h-4" /> Decline
              </button>
            </div>
          </div>
        </Card>
      ))}
    </div>
  )
}
