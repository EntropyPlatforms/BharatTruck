'use client'

// The one home surface: "what needs me right now?" (D-38).
//
// A single action feed from GET /me/feed. Each row carries its OWN persona tag —
// the object supplies the context, not a mode switch — so a shipper row, a driver
// row and a fleet row interleave on one screen, each rendered in its idiom. For a
// single-capability human the list holds one kind of thing and reads exactly like a
// focused app's home. The server already resolved the caller's capabilities and
// queried only the sources they touch; this page renders whatever comes back and
// invents no persona logic of its own.

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { AlertTriangle, ChevronRight, PlusCircle, RotateCw, Search, Truck } from 'lucide-react'

import { PhotoHero } from '@/components/photo-hero'
import { Card, Empty, ErrorNote, Loading } from '@/components/stat'
import EmergenceCta from '@/components/emergence-cta'
import FleetInvites from '@/components/fleet-invites'
import { ApiError, getMyFeed } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { timeAgo } from '@/lib/format'
import { cx, pill, type PillTone } from '@/lib/ui'
import type { FeedItem, FeedPage, FeedPersonaTag } from '@/lib/types'

// Each row's persona tag → its label and pill tone. Shipper Marigold, carrier indigo,
// driver green, fleet blue, so the same event reads the same way wherever it appears.
const TAG_STYLE: Record<FeedPersonaTag, { label: string; tone: PillTone }> = {
  shipper:   { label: 'Shipper',   tone: 'brand' },
  carrier:   { label: 'Carrier',   tone: 'indigo' },
  driver:    { label: 'Driver',    tone: 'green' },
  fleet:     { label: 'Fleet',     tone: 'blue' },
  consignee: { label: 'Consignee', tone: 'amber' },
}

/** Priority dot — a glance-level "how much does this need me". */
const PRIORITY_DOT: Record<FeedItem['priority'], string> = {
  urgent: 'bg-red-500',
  high:   'bg-orange-400',
  normal: 'bg-gray-400',
  low:    'bg-gray-300',
}

/**
 * Where a row goes. The feed targets a booking / quote / roster row; bt-app routes
 * it to the SURFACE that owns that kind of item. In Phase 1 the fleet + carry
 * surfaces are real pages and the ship + drive surfaces are their placeholders, so
 * a row always lands somewhere honest — never a dead link.
 */
function targetHref(item: FeedItem): string {
  if (item.type === 'alert') return alertHref(item)
  switch (item.tag) {
    case 'fleet':
      return item.type === 'fleet_driver_joined' ? '/drivers' : '/trips'
    case 'carrier':
      return '/auctions'
    case 'driver':
      return '/my-trips'
    case 'shipper':
      // A delivered load goes straight to its Payment tab; any other row about one load opens
      // that load rather than the list the shipper would then have to search.
      if (item.type === 'payment_due' && item.target.booking_id) return `/loads/${item.target.booking_id}?tab=payment`
      return item.target.booking_id ? `/loads/${item.target.booking_id}` : '/loads'
    case 'consignee':
      return '/loads'
    default:
      return '/home'
  }
}

/**
 * An alert names one trip (or, for a licence, one driver), so it lands on the page that can fix
 * it: the shipper's load, the driver's own trip or profile, the owner-driver's trip, or the fleet
 * boards (which have no per-trip page). The tag is the persona the alert was raised FOR, so the
 * same trip can send a shipper and its carrier to different places.
 */
function alertHref(item: FeedItem): string {
  const id = item.target.booking_id
  const licence = item.alert?.kind === 'licence_expiring'
  switch (item.tag) {
    case 'shipper':
      // An overdue payment opens the Payment tab, like the payment-due row it replaces.
      if (id && item.alert?.kind === 'unpaid_overdue') return `/loads/${id}?tab=payment`
      return id ? `/loads/${id}` : '/loads'
    case 'driver':
      if (licence) return '/driver-profile'
      return id ? `/my-trips/${id}` : '/my-trips'
    case 'carrier':
      return id ? `/my-trips/${id}` : '/my-trips'
    case 'fleet':
      return licence ? '/drivers' : '/trips'
    default:
      return '/home'
  }
}

export default function HomePage() {
  const [page, setPage] = useState<FeedPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    getMyFeed()
      .then(data => { if (!cancelled) setPage(data) })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load your home feed')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [nonce])

  // The partial-data banner's "Reload" re-runs the same feed read.
  const reload = useCallback(() => { setLoading(true); setNonce(n => n + 1) }, [])

  const header = <PhotoHero subtitle="Here's what needs you right now." />

  if (loading && !page) {
    return (
      <div className="p-4 lg:p-8 max-w-[112rem] mx-auto">
        {header}
        <Loading label="Gathering what needs you" />
      </div>
    )
  }

  if (error && !page) {
    return (
      <div className="p-4 lg:p-8 max-w-[112rem] mx-auto">
        {header}
        <ErrorNote message={error} />
      </div>
    )
  }

  const items = page?.items ?? []
  const degraded = page?.degraded_sources ?? []

  return (
    <div className="p-4 lg:p-8 max-w-[112rem] mx-auto">
      {header}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem] items-start">
        <div className="min-w-0 space-y-4">
          {/* A pending fleet invitation is the one thing a driver must act on before anything
              else — the consent seam. Renders nothing unless they actually have one. */}
          <FleetInvites />

          {/* Emergence CTA (D-32/33): the one growth-loop nudge the user's assets imply — e.g.
              an owner-driver who runs trucks but hasn't set up fleet management. Renders nothing
              when there's no relevant step. */}
          <EmergenceCta />

          {/* Some sources errored and were skipped — the feed still rendered the rest.
              Name that plainly rather than showing a silently-partial list. */}
          {degraded.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 flex items-start sm:items-center gap-3">
              <AlertTriangle className="w-5 h-5 shrink-0 text-amber-500 fill-amber-100" />
              <span className="min-w-0 flex-1">
                Some of your activity could not be loaded ({degraded.join(', ')}). This list is partial — reload to try again.
              </span>
              <button
                type="button"
                onClick={reload}
                disabled={loading}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-semibold text-blue-600 hover:text-blue-700 hover:bg-amber-100/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 disabled:opacity-50"
              >
                Reload <RotateCw className={cx('w-4 h-4', loading && 'animate-spin')} />
              </button>
            </div>
          )}

          <Card>
            <div className="px-5 pt-4 pb-3">
              <h2 className="text-base font-bold text-gray-900">Latest activity</h2>
            </div>
            {items.length === 0 ? (
              <div className="border-t border-gray-100">
                <Empty
                  art title="Nothing needs you right now"
                  hint="Bids, trips, deliveries and fleet updates land here as they happen."
                />
              </div>
            ) : (
              <ul className="border-t border-gray-100 divide-y divide-gray-100">
                {items.map(item => (
                  <li key={item.id}><FeedRow item={item} /></li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <QuickActions />
      </div>
    </div>
  )
}

function FeedRow({ item }: { item: FeedItem }) {
  const tag = TAG_STYLE[item.tag]
  return (
    <Link
      href={targetHref(item)}
      className="group flex items-center gap-3 px-5 py-3.5 hover:bg-gray-50 transition-colors focus-visible:outline-none focus-visible:bg-gray-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600"
    >
      <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${PRIORITY_DOT[item.priority]}`} aria-label={`${item.priority} priority`} />

      <span className="min-w-0 flex-1 md:grid md:grid-cols-[minmax(0,15rem)_6.5rem_minmax(0,1fr)] md:items-center md:gap-4">
        <span className="block text-sm font-semibold text-gray-900 truncate">{item.title}</span>
        <span className="hidden md:block"><span className={pill(tag.tone)}>{tag.label}</span></span>
        <span className="mt-1 md:mt-0 flex items-center gap-2 min-w-0 text-[0.8125rem] text-gray-500">
          <span className={cx(pill(tag.tone), 'md:hidden shrink-0')}>{tag.label}</span>
          <span className="truncate">{item.subtitle}</span>
          <span className="shrink-0 text-gray-300" aria-hidden>·</span>
          <span className="shrink-0 tabular-nums">{timeAgo(item.timestamp)}</span>
        </span>
      </span>

      <ChevronRight className="w-4 h-4 text-gray-400 group-hover:text-gray-600 shrink-0" />
    </Link>
  )
}

/**
 * Shortcuts into the surfaces this human can actually use — one per capability they
 * hold, never a link into a surface that would turn them away.
 */
function QuickActions() {
  const { capabilities, personas } = useAuth()
  const caps = capabilities ?? []
  const actions: { href: string; label: string; icon: ReactNode; primary?: boolean }[] = []
  if (caps.includes('ship')) actions.push({ href: '/post', label: 'Post a Load', icon: <PlusCircle className="w-5 h-5" />, primary: true })
  if (caps.includes('carry')) actions.push({ href: '/auctions', label: 'Find Work', icon: <Search className="w-5 h-5" /> })
  if (caps.includes('operate') || personas?.fleet_owner_id) actions.push({ href: '/vehicles', label: 'Add truck', icon: <Truck className="w-5 h-5" /> })
  if (actions.length === 0) return null

  return (
    <Card className="p-4">
      <h2 className="text-base font-bold text-gray-900 mb-3">Quick actions</h2>
      <div className="space-y-2.5">
        {actions.map(a => (
          <Link
            key={a.href}
            href={a.href}
            className={cx(
              'flex items-center gap-3 h-12 px-4 rounded-xl text-sm font-semibold transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2',
              a.primary
                ? 'bg-brand-500 hover:bg-brand-400 text-ink'
                : 'bg-white border border-gray-200 hover:bg-gray-50 text-gray-800',
            )}
          >
            <span className={a.primary ? 'text-gray-900' : 'text-gray-700'}>{a.icon}</span>
            <span className="flex-1">{a.label}</span>
            <ChevronRight className="w-4 h-4 opacity-70" />
          </Link>
        ))}
      </div>
    </Card>
  )
}
