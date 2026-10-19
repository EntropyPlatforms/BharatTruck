'use client'

/**
 * Fleet-invitation inbox — the CONSENT SEAM. An owner invites a driver by phone (a
 * 'pending' fleet_drivers row); ONLY the driver may accept, and this is where they do it.
 * The owner's console deliberately has no accept control (bt-fleet-service refuses it).
 *
 * Renders nothing unless the signed-in human can drive AND actually has a pending invite,
 * so it costs everyone else nothing. Accepting makes the affiliation live server-side and
 * refreshes the auth snapshot, so the shell re-evaluates: a driver who owns no truck becomes
 * an EMPLOYED fleet driver — they see the job, not the money.
 */

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Building2, Check, X } from 'lucide-react'

import { Card, IconTile } from '@/components/stat'
import { ApiError, getMyInvites, respondToInvite } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { inr } from '@/lib/format'
import { BTN_PRIMARY, BTN_SECONDARY, cx } from '@/lib/ui'
import type { FleetInvite } from '@/lib/types'

export default function FleetInvites() {
  const { capabilities, refresh } = useAuth()
  const [invites, setInvites] = useState<FleetInvite[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const canDrive = capabilities?.includes('drive') ?? false

  const load = useCallback(() => {
    getMyInvites().then(setInvites).catch(() => setInvites([]))
  }, [])

  useEffect(() => {
    if (canDrive) load()
    else setInvites([])
  }, [canDrive, load])

  // Only a driver holds fleet invites; nothing to show otherwise.
  if (!canDrive || !invites || invites.length === 0) return null

  async function respond(inv: FleetInvite, action: 'accept' | 'reject') {
    setBusyId(inv.id)
    try {
      await respondToInvite(inv.id, action)
      toast.success(action === 'accept' ? `You joined ${inv.company_name ?? 'the fleet'}` : 'Invitation declined')
      await refresh() // an accepted driver's product may change (employed)
      load()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not respond to the invitation')
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-3">
      {invites.map((inv) => (
        <Card key={inv.id}>
          <div className="p-4 sm:px-5 flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="flex items-start sm:items-center gap-3.5 min-w-0 flex-1">
              <IconTile icon={<Building2 />} tint="blue" size="lg" />
              <div className="min-w-0">
                <p className="text-[0.9375rem] font-bold text-gray-900">
                  {inv.company_name ?? 'A fleet'} invited you to drive for them
                </p>
                <p className="text-sm text-gray-600 mt-0.5">
                  {inv.fleet_city ? `${inv.fleet_city} · ` : ''}
                  {inv.monthly_salary_inr != null ? `${inr(inv.monthly_salary_inr)} / month` : 'Salary to be agreed'}
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:flex gap-2.5 shrink-0">
              <button
                onClick={() => respond(inv, 'accept')}
                disabled={busyId === inv.id}
                className={cx(BTN_PRIMARY, 'h-11 sm:min-w-[96px]')}
              >
                <Check className="w-4 h-4" /> Accept
              </button>
              <button
                onClick={() => respond(inv, 'reject')}
                disabled={busyId === inv.id}
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
