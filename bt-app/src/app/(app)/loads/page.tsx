'use client'

/**
 * My Loads (ship surface — Phase 2 of docs/UNIFIED_APP_PLAN.md).
 *
 * The loads the caller POSTED. GET /bookings returns the caller's own bookings, and
 * each row carries a `viewer` block naming the caller's relations to it — so for a
 * unified human who is BOTH a shipper and a carrier (whose list also includes the
 * open load board they may bid on), this keeps only the ones they actually posted
 * (viewer.relations includes 'shipper'). Falls back to shipper_id on a backend that
 * predates the viewer block.
 *
 * Three states, all rendered — never a blank screen:
 *  - LOADING  → a spinner with a label.
 *  - ERROR    → an ErrorNote with a retry.
 *  - EMPTY    → "No loads yet" with a Post-a-Load call to action.
 *
 * The list endpoint carries no per-load bid count, so rather than block the whole
 * list on an N+1, the rows render immediately from the list response and the bid
 * count for auction loads fills in afterwards as a best-effort enhancement (its
 * failure is swallowed — the row is already complete without it).
 *
 * The stat strip, status tabs and search are all computed client-side from the list
 * already loaded — no extra reads.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { CheckCircle2, ChevronRight, IndianRupee, MapPin, PackageOpen, Plus, Search, Truck } from 'lucide-react'

import { PageHeader } from '@/components/app-shell'
import { Card, Empty, ErrorNote, Loading, Stat } from '@/components/stat'
import { cityOf } from '@/components/shipper/route-text'
import { ApiError, getQuotes, listBookings } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { inr, shortDate, tons } from '@/lib/format'
import { bookingStatusConfig } from '@/lib/status'
import { BTN_PRIMARY, BTN_SECONDARY, INPUT, TAB_OFF, TAB_ON, cx, type PillTone } from '@/lib/ui'
import type { Booking, BookingStatus, Quote } from '@/lib/types'

// A load is "mine" if the server says I'm its shipper (viewer.relations) OR its
// shipper_id is my user id. Either alone is enough: the relations block is the
// intended signal (and correctly excludes the open board a unified shipper+carrier
// can also see), and shipper_id is a robust fallback so a transient relations hiccup
// can never hide a shipper's own load. The open board never matches shipper_id.
function postedByCaller(b: Booking, userId: string | null): boolean {
  const byRelation = b.viewer?.relations.includes('shipper') ?? false
  const byOwnership = userId != null && b.shipper_id === userId
  return byRelation || byOwnership
}

/** What we keep from a load's bids: how many, and the best live amount. */
type BidSummary = { count: number; best: number | null }

function summarise(quotes: Quote[]): BidSummary {
  const live = quotes.filter((q) => q.status === 'submitted' || q.status === 'countered')
  return { count: quotes.length, best: live.length ? Math.min(...live.map((q) => q.amount)) : null }
}

type TabKey = 'all' | 'bids' | 'accepted' | 'transit' | 'delivered' | 'paid' | 'cancelled'
const TABS: { key: TabKey; label: string; statuses: BookingStatus[] | null }[] = [
  { key: 'all', label: 'All', statuses: null },
  { key: 'bids', label: 'Getting bids', statuses: ['pending', 'negotiating'] },
  { key: 'accepted', label: 'Accepted', statuses: ['accepted'] },
  { key: 'transit', label: 'In transit', statuses: ['in_transit', 'delivery_asserted'] },
  { key: 'delivered', label: 'Delivered', statuses: ['completed'] },
  { key: 'paid', label: 'Paid', statuses: ['paid'] },
  { key: 'cancelled', label: 'Cancelled', statuses: ['cancelled'] },
]

/** YYYY-MM of an instant, in India. */
function monthInIndia(ms: number): string {
  return new Date(ms + (5 * 60 + 30) * 60 * 1000).toISOString().slice(0, 7)
}

const PIN_TONE: Record<PillTone, string> = {
  amber: 'text-amber-500', blue: 'text-blue-600', indigo: 'text-indigo-500', violet: 'text-violet-500',
  green: 'text-emerald-500', teal: 'text-teal-500', slate: 'text-gray-400', red: 'text-red-500',
  orange: 'text-orange-500', brand: 'text-brand-500',
}

export default function LoadsPage() {
  const { user } = useAuth()
  const [loads, setLoads] = useState<Booking[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [bids, setBids] = useState<Record<string, BidSummary>>({})
  const [nonce, setNonce] = useState(0)
  const [tab, setTab] = useState<TabKey>('all')
  const [query, setQuery] = useState('')

  const retry = useCallback(() => {
    setLoading(true)
    setError(null)
    setLoads(null)
    setBids({})
    setNonce((n) => n + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    const userId = user?.id ?? null

    listBookings()
      .then((all) => {
        if (cancelled) return
        const mine = all.filter((b) => postedByCaller(b, userId))
        setLoads(mine)

        // Best-effort bid counts for auction loads — a progressive enhancement that
        // must never blank or block the list. Failures are intentionally ignored.
        const auctions = mine.filter((b) => b.booking_type === 'auction')
        if (auctions.length > 0) {
          Promise.allSettled(auctions.map((b) => getQuotes(b.id))).then((results) => {
            if (cancelled) return
            const next: Record<string, BidSummary> = {}
            results.forEach((r, i) => {
              if (r.status === 'fulfilled') next[auctions[i].id] = summarise(r.value)
            })
            setBids(next)
          })
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load your loads.')
      })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [user?.id, nonce])

  const items = useMemo(() => loads ?? [], [loads])

  // "This month" is fixed at mount — the page is not left open across a month boundary.
  const [now] = useState(() => Date.now())
  const stats = useMemo(() => {
    const thisMonth = monthInIndia(now)
    const d = new Date(now)
    const lastMonth = monthInIndia(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15))
    const open = items.filter((b) => b.status === 'pending' || b.status === 'negotiating')
    const openBids = open.reduce((n, b) => n + (bids[b.id]?.count ?? 0), 0)
    const awaiting = items.filter((b) => b.status === 'completed')
    const deliveredIn = (m: string) =>
      items.filter((b) => (b.status === 'completed' || b.status === 'paid') && b.completed_at && monthInIndia(new Date(b.completed_at).getTime()) === m).length
    return {
      open: open.length,
      openBids,
      transit: items.filter((b) => b.status === 'in_transit').length,
      awaiting: awaiting.length,
      awaitingWorth: awaiting.reduce((s, b) => s + (b.final_price ?? b.quoted_price), 0),
      deliveredThisMonth: deliveredIn(thisMonth),
      deliveredLastMonth: deliveredIn(lastMonth),
    }
  }, [items, bids, now])

  const counts = useMemo(() => {
    const c = {} as Record<TabKey, number>
    for (const t of TABS) c[t.key] = t.statuses ? items.filter((b) => t.statuses!.includes(b.status)).length : items.length
    return c
  }, [items])

  const visible = useMemo(() => {
    const t = TABS.find((x) => x.key === tab)!
    const q = query.trim().toLowerCase()
    return items.filter((b) => {
      if (t.statuses && !t.statuses.includes(b.status)) return false
      if (!q) return true
      return [b.source_address, b.destination_address, b.consignee?.name, b.consignee?.city, b.id]
        .some((s) => s?.toLowerCase().includes(q))
    })
  }, [items, tab, query])

  const postButton = (
    <Link href="/post" className={cx(BTN_PRIMARY, 'h-11 px-5')}>
      <Plus className="w-4 h-4" strokeWidth={2.5} />
      Post a Load
    </Link>
  )
  const header = (
    <PageHeader title="My Loads" subtitle="Loads you've posted, their bids, and delivery status." actions={postButton} />
  )

  if (loading && !loads) {
    return (
      <div className="p-4 lg:p-8 max-w-[112rem] mx-auto">
        {header}
        <Loading label="Loading your loads" />
      </div>
    )
  }

  if (error && !loads) {
    return (
      <div className="p-4 lg:p-8 max-w-[112rem] mx-auto">
        {header}
        <div className="space-y-3">
          <ErrorNote message={error} />
          <button onClick={retry} className={BTN_SECONDARY}>Try again</button>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 lg:p-8 max-w-[112rem] mx-auto">
      {header}

      {items.length === 0 ? (
        <Card>
          <Empty
            art title="No loads yet"
            hint="Post your first load and carriers can start bidding on it."
            icon={<PackageOpen />}
            action={postButton}
          />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4 mb-5">
            <Stat
              label="Open for bids" value={stats.open} icon={<PackageOpen />} tint="blue"
              sub={stats.openBids > 0 ? `${stats.openBids} ${stats.openBids === 1 ? 'bid' : 'bids'} so far` : 'Waiting for carriers'}
            />
            <Stat label="In transit" value={stats.transit} icon={<Truck />} tint="blue" sub="On the road now" />
            <Stat
              label="Awaiting payment" value={stats.awaiting} icon={<IndianRupee />} tint="amber"
              sub={stats.awaiting > 0 ? `Worth ${inr(stats.awaitingWorth)}` : 'Nothing to settle'}
            />
            <Stat
              label="Delivered this month" value={stats.deliveredThisMonth} icon={<CheckCircle2 />} tint="green"
              sub={`${stats.deliveredLastMonth} last month`}
            />
          </div>

          <div className="flex flex-col lg:flex-row lg:items-end gap-3 lg:gap-6 mb-4 lg:border-b lg:border-gray-200">
            <div className="-mx-4 px-4 lg:mx-0 lg:px-0 overflow-x-auto border-b border-gray-200 lg:border-0 flex-1 min-w-0">
              <div role="tablist" aria-label="Filter loads by status" className="flex gap-6 min-w-max">
                {TABS.map((t) => (
                  <button
                    key={t.key}
                    role="tab"
                    aria-selected={tab === t.key}
                    onClick={() => setTab(t.key)}
                    className={cx(tab === t.key ? TAB_ON : TAB_OFF, 'inline-flex items-center gap-2 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded-sm')}
                  >
                    {t.label}
                    <span className={cx(
                      'min-w-[22px] h-[22px] px-1.5 rounded-md text-xs font-semibold tabular-nums inline-flex items-center justify-center',
                      tab === t.key ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-600',
                    )}>
                      {counts[t.key]}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <label className="relative block lg:w-72 lg:mb-2 shrink-0">
              <span className="sr-only">Search loads</span>
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search city or consignee…"
                className={cx(INPUT, 'pl-9')}
              />
            </label>
          </div>

          {visible.length === 0 ? (
            <Card>
              <Empty title="No loads match" hint="Try another status or search term." icon={<Search />} />
            </Card>
          ) : (
            <div className="space-y-2.5">
              {visible.map((b) => <LoadRow key={b.id} booking={b} bids={bids[b.id]} />)}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function LoadRow({ booking, bids }: { booking: Booking; bids?: BidSummary }) {
  const status = bookingStatusConfig[booking.status] ?? bookingStatusConfig.pending
  const open = booking.status === 'pending' || booking.status === 'negotiating'

  // What sits in the "activity" slot: bids for an auction (once counted), otherwise
  // the routing kind. The status badge already carries the load's progress.
  const activity =
    booking.booking_type === 'auction'
      ? bids === undefined
        ? 'Auction'
        : `${bids.count} ${bids.count === 1 ? 'bid' : 'bids'}`
      : 'Direct'

  const meta = [
    `${inr(booking.quoted_price)} quoted`,
    activity,
    tons(booking.weight_kg),
    booking.load_type ? booking.load_type.replace(/_/g, ' ') : null,
    `pickup ${shortDate(booking.pickup_date)}`,
  ].filter(Boolean) as string[]

  // The right-hand slot shows the one fact this stage is about, only when the data has it.
  let aside: ReactNode = null
  if (open && bids?.best != null) {
    aside = (
      <>
        <span className="block text-xs text-gray-500">Best bid</span>
        <span className="block text-lg font-bold text-emerald-600 tabular-nums">{inr(bids.best)}</span>
      </>
    )
  } else if (booking.status === 'accepted' && booking.final_price != null) {
    aside = (
      <>
        <span className="block text-xs text-gray-500">Agreed price</span>
        <span className="block text-base font-bold text-gray-900 tabular-nums">{inr(booking.final_price)}</span>
      </>
    )
  } else if (booking.status === 'in_transit' && booking.in_transit_at) {
    aside = <span className="text-[0.8125rem] text-gray-600">On the road since {shortDate(booking.in_transit_at)}</span>
  } else if ((booking.status === 'completed' || booking.status === 'paid') && booking.completed_at) {
    aside = (
      <span className="text-[0.8125rem] text-gray-600 leading-snug">
        Delivered {shortDate(booking.completed_at)}
        <span className="block">{booking.status === 'paid' ? 'Paid' : 'Awaiting payment'}</span>
      </span>
    )
  } else if (booking.status === 'cancelled') {
    aside = <span className="text-[0.8125rem] text-gray-600 leading-snug">Cancelled<span className="block">{shortDate(booking.updated_at)}</span></span>
  }

  return (
    <Link
      href={`/loads/${booking.id}`}
      className="group block bg-white rounded-xl border border-gray-200 hover:border-gray-300 hover:shadow-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
    >
      <div className="flex items-center gap-3 lg:gap-4 px-4 lg:px-5 py-3.5">
        <MapPin className={cx('w-5 h-5 shrink-0 self-start mt-0.5 lg:self-center lg:mt-0 fill-current [&>circle]:fill-white', PIN_TONE[status.tone])} />

        <div className="min-w-0 flex-1 lg:grid lg:grid-cols-[minmax(0,13rem)_11rem_minmax(0,1fr)_10rem] lg:items-center lg:gap-4">
          <div className="min-w-0 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[0.9375rem] font-bold text-gray-900 truncate">
                {cityOf(booking.source_address)} <span className="text-gray-400 font-medium">→</span> {cityOf(booking.destination_address)}
              </p>
              <p className="text-[0.8125rem] text-gray-500 truncate">{booking.consignee?.name ?? booking.destination_address}</p>
            </div>
            <span className={cx(status.color, 'lg:hidden shrink-0 mt-0.5')}>{status.label}</span>
          </div>
          <div className="hidden lg:block"><span className={status.color}>{status.label}</span></div>
          <p className="mt-1.5 lg:mt-0 text-[0.8125rem] text-gray-600 flex flex-wrap gap-x-1.5 gap-y-0.5 min-w-0">
            {meta.map((m, i) => (
              <span key={i} className="inline-flex items-center gap-1.5">
                {i > 0 && <span className="text-gray-300" aria-hidden>·</span>}
                <span className="tabular-nums">{m}</span>
              </span>
            ))}
          </p>
          {aside && <div className="mt-1.5 lg:mt-0 lg:text-left">{aside}</div>}
        </div>

        <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-gray-600 shrink-0" />
      </div>
    </Link>
  )
}
