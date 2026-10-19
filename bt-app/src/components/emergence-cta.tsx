'use client'

/**
 * Emergence CTA — the growth-loop nudge (D-32/D-33 §3.5). When a fact about the user's
 * assets implies an un-taken next step, surface ONE contextual prompt: the app taking the
 * shape of the business, not a settings screen. Derived from the persona snapshot
 * (/auth/me), never chosen. Dismissible (D-21: a preference may SUPPRESS a surface, never
 * gate one) — a dismissed nudge stays gone, and the underlying capability is untouched.
 *
 * The primary moment: an owner-driver who RUNS trucks (`operate`) but has not set up fleet
 * management (no `fleet_owner_id`). The CTA PERFORMS the transition — POST /fleet-owners/me —
 * which, with the fleet-service de-role (feat/derole-fleet-service), is what opens the fleet
 * surfaces to them. It never links to a page that would 403; it makes the fact true first,
 * then routes.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowRight, Truck, X } from 'lucide-react'

import { IconTile } from '@/components/stat'

import { ApiError, becomeFleetOwner } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import type { PersonaSnapshot } from '@/lib/types'
import { cx } from '@/lib/ui'

type Prompt = {
  kind: string
  title: string
  body: string
  cta: string
  action: 'become_fleet_owner' | 'navigate'
  href?: string
}

function dismissKey(kind: string): string { return `bt-app-emergence-dismissed:${kind}` }

function isDismissed(kind: string): boolean {
  if (typeof window === 'undefined') return false
  try { return window.localStorage.getItem(dismissKey(kind)) === '1' } catch { return false }
}

// The single most relevant emergence prompt for the current assets, or null. Order is
// priority: the fleet-management setup gates the driver-invite step, so it wins first.
function computePrompt(p: PersonaSnapshot): Prompt | null {
  const caps = p.capabilities ?? []

  // 1) A DECLARED fleet owner (the D-32 front door: primary_persona picked at signup), or
  //    an owner-driver who already runs trucks — who has not created a fleet profile yet.
  //    This is what opens the (de-roled) fleet surfaces; without a profile they still 404,
  //    and a declared fleet owner would otherwise land on a bare ship view with no way in.
  const runsTrucks = caps.includes('operate')
  if ((runsTrucks || p.primary_persona === 'fleet_owner') && !p.fleet_owner_id) {
    return {
      kind: 'setup_fleet',
      title: runsTrucks ? `You run ${p.owned_vehicle_count} trucks` : 'Set up your fleet',
      body: runsTrucks
        ? 'Set up fleet management to invite drivers and assign them to your trucks.'
        : 'Create your fleet profile to add trucks, invite drivers, and bid on loads.',
      cta: 'Set up fleet management',
      action: 'become_fleet_owner',
      // A fresh fleet owner starts with no trucks, so send them to add the first one;
      // an owner-driver who already runs trucks needs the driver roster instead.
      href: runsTrucks ? '/drivers' : '/vehicles',
    }
  }

  // 2) Has a fleet but no drivers yet → invite the first one (the surface now works).
  if (p.fleet_owner_id && p.held_driver_count === 0 && p.owned_vehicle_count >= 1) {
    return {
      kind: 'invite_driver',
      title: "You're managing a fleet",
      body: 'Invite your first driver to start assigning trucks to trips.',
      cta: 'Invite a driver',
      action: 'navigate',
      href: '/drivers',
    }
  }

  return null
}

export default function EmergenceCta() {
  const { personas, refresh } = useAuth()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [, bumpDismissed] = useState(0)

  function dismiss(kind: string) {
    try { window.localStorage.setItem(dismissKey(kind), '1') } catch { /* storage may be unavailable */ }
    bumpDismissed((n) => n + 1)
  }

  async function act(p: Prompt) {
    if (p.action === 'navigate') { router.push(p.href ?? '/home'); return }
    // become_fleet_owner: make the fact true, refresh the snapshot so the shell + this CTA
    // re-evaluate (fleet_owner_id now set), then route into the newly-open fleet surface.
    setBusy(true)
    try {
      await becomeFleetOwner()
      await refresh()
      toast.success('Fleet management is set up')
      router.push(p.href ?? '/drivers')
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not set up fleet management')
      setBusy(false)
    }
  }

  if (!personas) return null
  const prompt = computePrompt(personas)
  if (!prompt || isDismissed(prompt.kind)) return null

  return (
    <div className="relative rounded-xl border border-gray-200 bg-white p-4 sm:px-5">
      <button
        onClick={() => dismiss(prompt.kind)}
        aria-label="Dismiss"
        className="absolute right-2.5 top-2.5 p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
      >
        <X className="w-4 h-4" />
      </button>
      <div className="flex flex-col sm:flex-row sm:items-center gap-4 pr-8">
        <div className="flex items-start gap-3.5 min-w-0 flex-1">
          <IconTile icon={<Truck />} tint="brand" size="lg" />
          <div className="min-w-0">
            <p className="text-[0.9375rem] font-bold text-gray-900">{prompt.title}</p>
            <p className="text-sm text-gray-600 mt-0.5">{prompt.body}</p>
          </div>
        </div>
        <button
          onClick={() => act(prompt)}
          disabled={busy}
          className={cx(
            'shrink-0 inline-flex items-center justify-center gap-1.5 h-10 px-4 rounded-xl bg-blue-50 border border-blue-100 text-blue-700 hover:bg-blue-100 font-semibold text-sm transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:opacity-50',
          )}
        >
          {busy && <span className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />}
          {prompt.cta}
          {!busy && <ArrowRight className="w-4 h-4" />}
        </button>
      </div>
    </div>
  )
}
