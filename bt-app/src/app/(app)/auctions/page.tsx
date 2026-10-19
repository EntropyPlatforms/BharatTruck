'use client'

// Auctions — the fleet's side of the bidding flow, now read AND write.
//
// WHAT CHANGED, and why the old page could not do this:
//
// The console previously had exactly one booking call, listFleetBookings() ->
// GET /fleet/bookings, scoped to `bookings.fleet_owner_id`. bt-booking-service writes
// that column in exactly one place — awardBooking(), at the moment a shipper ACCEPTS a
// quote. So the only rows reachable were auctions the fleet had ALREADY WON. Open loads,
// live bids and lost bids were all invisible, and the page carried a banner saying so.
//
// Bidding is anchored on `quotes.fleet_owner_id` instead, which is written at BID time.
// bt-fleet-service now serves two tenant-scoped reads off it — GET /fleet/auctions (the
// open board) and GET /fleet/bids (every bid this fleet has) — and the writes reuse
// bt-booking-service's existing /bookings/:id/quotes* routes, which already accept a
// fleet owner and already own the deadline and duplicate-bid rules.
//
// THE SHAPE OF THIS SCREEN is driven by the one thing a dispatcher actually does: run
// many auctions at once. Hence a board sorted by time pressure, a bid state visible
// inline on every row without a click, and counter-offers pulled to the top of My bids
// because they are the only rows that expire while you are not looking.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronRight, Clock, Hourglass, Info, Package, RefreshCw, Trophy, Users,
} from 'lucide-react'
import { PageHeader } from '@/components/app-shell'
import { Card, CardHead, Empty, ErrorNote, IconTile, Loading, Stat } from '@/components/stat'
import { RouteLine, TD, TH, THEAD_ROW, TR } from '@/components/fleet-ops/bits'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  ApiError, listOpenAuctions, listMyBids, listFleetBookings,
  placeBid, counterBid, withdrawBid, getBidHistory, justifyBid,
} from '@/lib/api'
import { quoteStatusConfig, bookingStatusConfig } from '@/lib/status'
import { inr, inrCompact, inrSigned, shortDate, tons, timeAgo, dateTime } from '@/lib/format'
import type {
  AuctionBooking, FleetBid, FleetBooking, JustifyBreakdown, NegotiationEntry, OpenAuction, QuoteStatus,
} from '@/lib/types'
import {
  BTN_BLUE, BTN_PRIMARY, BTN_SECONDARY, HINT, INPUT, LABEL, MONO, SELECT, TAB_OFF, TAB_ON, TEXTAREA, cx, pill,
} from '@/lib/ui'

type Tab = 'open' | 'bids' | 'won'

const TABS: { key: Tab; label: string }[] = [
  { key: 'open', label: 'Open loads' },
  { key: 'bids', label: 'My bids' },
  { key: 'won',  label: 'Won' },
]

/** A bid the shipper has countered — the fleet owes a reply, and the clock is running. */
function needsReply(b: FleetBid): boolean {
  return b.status === 'countered'
}

/** Live = still in play. Anything else is history. */
function isLive(status: string): boolean {
  return status === 'submitted' || status === 'countered'
}

/**
 * Time left on an auction, in the coarsest unit that is still honest.
 *
 * Returns null when there is no deadline (a load that never expires), and an
 * `expired` flag rather than a negative string — the caller styles those differently
 * because bidding on one is a 409, not a slow bid.
 */
function deadlineIn(iso: string | null): { text: string; expired: boolean; urgent: boolean } | null {
  if (!iso) return null
  const ms = new Date(iso).getTime() - Date.now()
  if (Number.isNaN(ms)) return null
  if (ms <= 0) return { text: 'closed', expired: true, urgent: false }

  const mins = Math.floor(ms / 60_000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)

  const text = days > 0 ? `${days}d ${hours % 24}h` : hours > 0 ? `${hours}h ${mins % 60}m` : `${mins}m`
  // Under two hours is the band where a dispatcher has to act now rather than think.
  return { text, expired: false, urgent: ms < 2 * 3600_000 }
}

/** "General · 16.0 t" — the load line shared by every table and card. */
function loadLine(b: { load_type: string; weight_kg: number }): string {
  return `${b.load_type} · ${tons(b.weight_kg)}`
}

function routeKey(b: { source_address: string; destination_address: string }): string {
  return `${b.source_address} → ${b.destination_address}`
}

/** Distinct, sorted values for a client-side filter select. */
function distinct(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v && v.trim())))].sort((a, b) => a.localeCompare(b))
}

export default function AuctionsPage() {
  const [tab, setTab] = useState<Tab>('open')

  const [auctions, setAuctions] = useState<OpenAuction[] | null>(null)
  const [bids, setBids] = useState<FleetBid[] | null>(null)
  const [won, setWon] = useState<FleetBooking[] | null>(null)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const [bidTarget, setBidTarget] = useState<OpenAuction | null>(null)
  const [counterTarget, setCounterTarget] = useState<FleetBid | null>(null)
  const [historyTarget, setHistoryTarget] = useState<FleetBid | null>(null)

  // All three lists load together on every refresh. They are cheap (one query plus a
  // bounded hydrate each), and the tab counts have to be correct before the dispatcher
  // picks a tab — a count that only fills in after you click it is worse than no count.
  useEffect(() => {
    let cancelled = false

    // "Won" is the fleet's truck-assignment queue. A solo owner-driver has no fleet (404 there):
    // a load they win becomes their own trip under My Trips, so for them the list is simply empty.
    const won = listFleetBookings().catch((err: unknown) => {
      if (err instanceof ApiError && err.code === 'NOT_FOUND') return []
      throw err
    })

    Promise.all([listOpenAuctions(), listMyBids(), won])
      .then(([a, b, w]) => {
        if (cancelled) return
        setAuctions(a?.auctions ?? [])
        setBids(b?.bids ?? [])
        setWon(w ?? [])
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Could not load auctions')
      })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [reloadKey])

  const refresh = useCallback(() => {
    setLoading(true)
    setError(null)
    setReloadKey(k => k + 1)
  }, [])

  const openRows = useMemo(() => {
    // Soonest deadline first — the board's whole job is surfacing time pressure.
    // Loads with no deadline sort last; they are not urgent by definition.
    return [...(auctions ?? [])].sort((a, b) => {
      const da = a.auction_deadline ? new Date(a.auction_deadline).getTime() : Infinity
      const db = b.auction_deadline ? new Date(b.auction_deadline).getTime() : Infinity
      return da - db
    })
  }, [auctions])

  const bidRows = useMemo(() => {
    // Countered first (they need a reply), then live, then history.
    return [...(bids ?? [])].sort((a, b) => {
      const rank = (x: FleetBid) => (needsReply(x) ? 0 : isLive(x.status) ? 1 : 2)
      const r = rank(a) - rank(b)
      if (r !== 0) return r
      return new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime()
    })
  }, [bids])

  const liveBids = bidRows.filter(b => isLive(b.status))
  const countered = bidRows.filter(needsReply)
  const wonList = won ?? []
  const priced = wonList.filter(b => b.final_price !== null)
  const wonValue = priced.reduce((sum, b) => sum + (b.final_price ?? 0), 0)
  const awaitingCrew = wonList.filter(b => b.status === 'accepted' && (!b.vehicle_id || !b.driver_id))

  const counts: Record<Tab, number> = {
    open: openRows.length,
    bids: bidRows.length,
    won: wonList.length,
  }

  return (
    <div className="p-4 lg:p-8 max-w-[112rem] mx-auto">
      <PageHeader
        title="Find Work"
        info="Bid with the whole fleet; the truck and driver are chosen after you win."
        subtitle="Open loads from shippers, this fleet's live bids, and everything it has won"
        actions={
          <button onClick={refresh} disabled={loading} className={cx(BTN_BLUE, 'h-10 px-4')}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        }
      />

      {loading && <Loading label="Loading auctions" />}
      {!loading && error && <ErrorNote message={error} />}

      {!loading && !error && (
        <>
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 lg:gap-4 mb-5">
            <Stat
              label="Open loads"
              value={openRows.length}
              sub={openRows.length > 0 ? 'available to bid on' : 'nothing open right now'}
              icon={<Package />}
              tint="blue"
            />
            <Stat
              label="Live bids"
              value={liveBids.length}
              tone={countered.length > 0 ? 'warn' : 'neutral'}
              sub={countered.length > 0 ? `${countered.length} awaiting your reply` : 'none need a reply'}
              icon={<Clock />}
              tint="amber"
            />
            <Stat
              label="Won"
              value={wonList.length}
              sub={`${inrCompact(wonValue)} awarded`}
              icon={<Trophy />}
              tint="green"
            />
            <Stat
              label="Awaiting crew"
              value={awaitingCrew.length}
              tone={awaitingCrew.length > 0 ? 'warn' : 'good'}
              sub={awaitingCrew.length > 0 ? 'cannot depart until assigned' : 'every won load is crewed'}
              icon={<Users />}
              tint={awaitingCrew.length > 0 ? 'amber' : 'green'}
            />
          </div>

          {/* Counter-offers are the only thing on this screen that expires while the
              dispatcher is looking elsewhere, so they get a banner, not just a tab count. */}
          {countered.length > 0 && tab !== 'bids' && (
            <button
              onClick={() => setTab('bids')}
              className="w-full text-left rounded-xl border border-amber-200 bg-amber-50 px-4 py-3.5 mb-5 flex items-center gap-3.5 hover:bg-amber-100/70 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
            >
              <span className="w-8 h-8 rounded-full bg-amber-400 text-[#fff] inline-flex items-center justify-center shrink-0 font-bold">!</span>
              <span className="min-w-0 flex-1 text-sm">
                <span className="block font-semibold text-amber-900">
                  {countered.length} shipper counter-offer{countered.length === 1 ? '' : 's'} awaiting your reply
                </span>
                <span className="block mt-0.5 text-amber-800">
                  A countered bid is not live until you answer it.
                </span>
              </span>
              <ChevronRight className="w-5 h-5 text-amber-700 shrink-0" />
            </button>
          )}

          <div className="flex items-end gap-6 sm:gap-8 border-b border-gray-200 mb-5 overflow-x-auto" role="tablist" aria-label="Find Work">
            {TABS.map(t => {
              const active = tab === t.key
              return (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTab(t.key)}
                  className={cx(active ? TAB_ON : TAB_OFF, 'inline-flex items-center gap-2 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded-t-md')}
                >
                  {t.label}
                  <span className={cx(
                    'rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums',
                    active ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-500',
                  )}>
                    {counts[t.key]}
                  </span>
                </button>
              )
            })}
          </div>

          {tab === 'open' && <OpenBoard rows={openRows} onBid={setBidTarget} />}
          {tab === 'bids' && (
            <MyBids rows={bidRows} onCounter={setCounterTarget} onHistory={setHistoryTarget} onChanged={refresh} />
          )}
          {tab === 'won' && <WonTable rows={wonList} total={wonValue} />}

        </>
      )}

      <BidDialog
        auction={bidTarget}
        onClose={() => setBidTarget(null)}
        onDone={() => { setBidTarget(null); refresh() }}
      />
      <CounterDialog
        bid={counterTarget}
        onClose={() => setCounterTarget(null)}
        onDone={() => { setCounterTarget(null); refresh() }}
      />
      <HistoryDialog bid={historyTarget} onClose={() => setHistoryTarget(null)} />
    </div>
  )
}

// ── Small pieces ──────────────────────────────────────────────

function DeadlinePill({ iso }: { iso: string | null }) {
  const dl = deadlineIn(iso)
  if (!dl) return <span className="text-xs text-gray-400 whitespace-nowrap">no deadline</span>
  return (
    <span className={cx(pill(dl.expired ? 'slate' : dl.urgent ? 'red' : 'slate'), 'py-1', !dl.expired && !dl.urgent && 'bg-white')}>
      {dl.urgent ? <Clock className="w-3.5 h-3.5" /> : <Hourglass className="w-3.5 h-3.5" />}
      {dl.text}
    </span>
  )
}

function Delta({ delta, suffix = '' }: { delta: number | null; suffix?: string }) {
  if (delta === null || delta === 0) return null
  return (
    <span className={cx('text-xs tabular-nums whitespace-nowrap', delta > 0 ? 'text-emerald-600' : 'text-red-600')}>
      {inrSigned(delta)}{suffix}
    </span>
  )
}

function FilterSelect({
  label, value, onChange, all, options,
}: { label: string; value: string; onChange: (v: string) => void; all: string; options: string[] }) {
  return (
    <label className="block min-w-0">
      <span className="sr-only">{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)} className={cx(SELECT, 'h-10 xl:w-40')}>
        <option value="">{all}</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  )
}

// ── Open load board ───────────────────────────────────────────

function OpenBoard({ rows, onBid }: { rows: OpenAuction[]; onBid: (a: OpenAuction) => void }) {
  // Client-side narrowing only — the board is already loaded in full.
  const [routeF, setRouteF] = useState('')
  const [typeF, setTypeF] = useState('')
  const [shipperF, setShipperF] = useState('')

  const routes = useMemo(() => distinct(rows.map(routeKey)), [rows])
  const types = useMemo(() => distinct(rows.map(r => r.load_type)), [rows])
  const shippers = useMemo(() => distinct(rows.map(r => r.shipper_name)), [rows])
  const shown = rows.filter(a =>
    (!routeF || routeKey(a) === routeF) &&
    (!typeF || a.load_type === typeF) &&
    (!shipperF || a.shipper_name === shipperF))
  const filtered = routeF !== '' || typeF !== '' || shipperF !== ''
  const filters = (
    <>
      <FilterSelect label="Filter by route" value={routeF} onChange={setRouteF} all="All routes" options={routes} />
      <FilterSelect label="Filter by load type" value={typeF} onChange={setTypeF} all="All load types" options={types} />
      <FilterSelect label="Filter by shipper" value={shipperF} onChange={setShipperF} all="All shippers" options={shippers} />
    </>
  )

  return (
    <Card>
      <CardHead
        title="Open loads"
        icon={<Package />}
        sub={`${rows.length} load${rows.length === 1 ? '' : 's'} accepting bids · soonest deadline first`}
        actions={rows.length > 0 ? <div className="hidden xl:flex gap-2">{filters}</div> : undefined}
      />
      {rows.length > 0 && (
        <div className="xl:hidden px-4 sm:px-5 py-3 border-b border-gray-100 grid grid-cols-1 sm:grid-cols-3 gap-2">
          {filters}
        </div>
      )}
      {rows.length === 0 ? (
        <Empty
          title="No open loads right now"
          hint="Loads appear here as soon as a shipper posts one that is open to bidding."
          icon={<Package />}
        />
      ) : shown.length === 0 ? (
        <div className="px-5 py-10 text-center text-sm text-gray-500">
          No open load matches these filters.{' '}
          {filtered && (
            <button onClick={() => { setRouteF(''); setTypeF(''); setShipperF('') }} className="font-semibold text-blue-600 hover:text-blue-700">
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <>
          {/* Phones: one card per load, the action thumb-sized. */}
          <ul className="md:hidden divide-y divide-gray-100">
            {shown.map(a => {
              const dl = deadlineIn(a.auction_deadline)
              const mine = a.my_bid
              return (
                <li key={a.id} className="px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <RouteLine from={a.source_address} to={a.destination_address} max="max-w-[120px]" className="text-[0.9375rem] font-bold text-gray-900" />
                      <div className="mt-0.5 text-xs text-gray-500">{loadLine(a)}</div>
                      <div className="text-xs text-gray-500 truncate">
                        {a.shipper_name || '—'} · {shortDate(a.pickup_date)}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[0.9375rem] font-bold text-gray-900 tabular-nums">{inr(a.quoted_price)}</div>
                      <div className="mt-1"><DeadlinePill iso={a.auction_deadline} /></div>
                    </div>
                  </div>
                  {mine && (
                    <div className="mt-2 flex items-center gap-2 text-xs">
                      <span className="text-gray-500">Your bid</span>
                      <span className="font-semibold text-gray-900 tabular-nums">{inr(mine.amount)}</span>
                      <span className={quoteStatusConfig[mine.status].color}>{quoteStatusConfig[mine.status].label}</span>
                    </div>
                  )}
                  <button
                    onClick={() => onBid(a)}
                    disabled={dl?.expired}
                    className={cx(mine ? BTN_BLUE : BTN_PRIMARY, 'mt-3 w-full h-11')}
                  >
                    {mine ? 'Re-bid' : 'Place bid'}
                  </button>
                </li>
              )
            })}
          </ul>

          <div className="hidden md:block overflow-x-auto">
            <table className="w-full min-w-[1100px]">
              <thead>
                <tr className={THEAD_ROW}>
                  <th className={TH}>Route</th>
                  <th className={TH}>Load</th>
                  <th className={TH}>Shipper</th>
                  <th className={TH}>Pickup</th>
                  <th className={TH}>Closes</th>
                  <th className={cx(TH, 'text-right')}>Shipper ask</th>
                  <th className={cx(TH, 'text-center')}>Bids</th>
                  <th className={TH}>Your bid</th>
                  <th className={cx(TH, 'text-right sticky right-0 bg-gray-50')}>Action</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(a => {
                  const dl = deadlineIn(a.auction_deadline)
                  const mine = a.my_bid
                  const delta = mine ? mine.amount - a.quoted_price : null

                  return (
                    <tr key={a.id} className={cx(TR, 'group')}>
                      <td className={TD}>
                        <RouteLine from={a.source_address} to={a.destination_address} max="max-w-[104px]" className="font-semibold text-gray-900" />
                        {a.booking_type !== 'auction' && (
                          <span className="text-xs text-gray-400">Direct booking, open to bids</span>
                        )}
                      </td>

                      <td className={cx(TD, 'text-gray-700 whitespace-nowrap')}>
                        <span className="truncate inline-block max-w-[140px] align-bottom" title={a.load_type}>{a.load_type}</span>
                        <span className="text-gray-400"> · </span>
                        <span className="tabular-nums">{tons(a.weight_kg)}</span>
                      </td>

                      <td className={TD}>
                        <span className="text-gray-700 truncate block max-w-[130px]">{a.shipper_name || '—'}</span>
                      </td>

                      <td className={cx(TD, 'whitespace-nowrap')}>
                        <div className="text-gray-900">{shortDate(a.pickup_date)}</div>
                        {a.pickup_time_slot && <div className="text-xs text-gray-500">{a.pickup_time_slot}</div>}
                      </td>

                      <td className={TD}>
                        <DeadlinePill iso={a.auction_deadline} />
                      </td>

                      <td className={cx(TD, 'text-right text-gray-900 font-medium tabular-nums')}>{inr(a.quoted_price)}</td>

                      <td className={cx(TD, 'text-center tabular-nums text-gray-600')}>{a.bid_count}</td>

                      <td className={TD}>
                        {mine ? (
                          <div className="space-y-1">
                            <span className="inline-flex items-center rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 text-sm font-semibold text-blue-700 tabular-nums">
                              {inr(mine.amount)}
                            </span>
                            <div className="flex items-center gap-1.5 whitespace-nowrap">
                              <span className={cx(quoteStatusConfig[mine.status].color, 'px-1.5 py-0 text-[0.6875rem]')}>
                                {quoteStatusConfig[mine.status].label}
                              </span>
                              <Delta delta={delta} />
                            </div>
                          </div>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>

                      {/* Sticky so the primary action is reachable without horizontal
                          scrolling — at 1440px this table is wider than its container and the
                          button was landing just off-screen. Needs its own opaque background
                          (a transparent sticky cell shows the row sliding underneath it) and
                          must track the row's hover via `group`. */}
                      <td className={cx(TD, 'text-right whitespace-nowrap sticky right-0 bg-white group-hover:bg-gray-50 transition-colors')}>
                        <button
                          onClick={() => onBid(a)}
                          disabled={dl?.expired}
                          className={cx(mine ? BTN_BLUE : BTN_PRIMARY, 'h-9 px-3.5 min-w-[96px]')}
                        >
                          {mine ? 'Re-bid' : 'Place bid'}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  )
}

// ── My bids ───────────────────────────────────────────────────

const BID_STATUS_FILTERS: { key: '' | QuoteStatus; label: string }[] = [
  { key: '', label: 'All status' },
  { key: 'countered', label: quoteStatusConfig.countered.label },
  { key: 'submitted', label: quoteStatusConfig.submitted.label },
  { key: 'accepted', label: quoteStatusConfig.accepted.label },
  { key: 'rejected', label: quoteStatusConfig.rejected.label },
  { key: 'withdrawn', label: quoteStatusConfig.withdrawn.label },
  { key: 'expired', label: quoteStatusConfig.expired.label },
]

function MyBids({
  rows, onCounter, onHistory, onChanged,
}: {
  rows: FleetBid[]
  onCounter: (b: FleetBid) => void
  onHistory: (b: FleetBid) => void
  onChanged: () => void
}) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)
  const [statusF, setStatusF] = useState<'' | QuoteStatus>('')

  async function handleWithdraw(b: FleetBid) {
    setBusyId(b.id)
    setRowError(null)
    try {
      await withdrawBid(b.booking_id, b.id)
      onChanged()
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : 'Could not withdraw that bid')
    } finally {
      setBusyId(null)
    }
  }

  const shown = statusF ? rows.filter(b => b.status === statusF) : rows
  const live = rows.filter(b => isLive(b.status)).length
  const replies = rows.filter(needsReply).length

  return (
    <Card>
      <CardHead
        title="My bids"
        icon={<Package />}
        sub={`${rows.length} bid${rows.length === 1 ? '' : 's'} · ${live} live${replies > 0 ? ` · ${replies} awaiting your reply` : ''} · counter-offers first`}
        actions={rows.length > 0 ? (
          <label className="hidden sm:block">
            <span className="sr-only">Filter bids by status</span>
            <select value={statusF} onChange={e => setStatusF(e.target.value as '' | QuoteStatus)} className={cx(SELECT, 'h-10 w-40')}>
              {BID_STATUS_FILTERS.map(f => <option key={f.key || 'all'} value={f.key}>{f.label}</option>)}
            </select>
          </label>
        ) : undefined}
      />
      {rows.length > 0 && (
        <div className="sm:hidden px-4 py-3 border-b border-gray-100">
          <label className="block">
            <span className="sr-only">Filter bids by status</span>
            <select value={statusF} onChange={e => setStatusF(e.target.value as '' | QuoteStatus)} className={SELECT}>
              {BID_STATUS_FILTERS.map(f => <option key={f.key || 'all'} value={f.key}>{f.label}</option>)}
            </select>
          </label>
        </div>
      )}
      {rowError && <div className="px-4 pt-3"><ErrorNote message={rowError} /></div>}

      {rows.length === 0 ? (
        <Empty
          title="No bids yet"
          hint="Place a bid from the Open loads tab and it will appear here with its full price history."
          icon={<Package />}
        />
      ) : shown.length === 0 ? (
        <div className="px-5 py-10 text-center text-sm text-gray-500">No bid has this status.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px]">
            <thead>
              <tr className={THEAD_ROW}>
                <th className={TH}>Route</th>
                <th className={TH}>Shipper</th>
                <th className={cx(TH, 'text-right')}>Your bid</th>
                <th className={cx(TH, 'text-right')}>Shipper ask</th>
                <th className={TH}>Status</th>
                <th className={TH}>Placed</th>
                <th className={cx(TH, 'text-right sticky right-0 bg-gray-50')}>Action</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(b => {
                const bk = b.booking
                const delta = bk ? b.amount - bk.quoted_price : null
                const cfg = quoteStatusConfig[b.status]
                const busy = busyId === b.id
                const reply = needsReply(b)

                return (
                  <tr
                    key={b.id}
                    className={cx(
                      'group border-b border-gray-100 last:border-b-0 transition-colors',
                      reply ? 'bg-amber-50/70 hover:bg-amber-50' : 'hover:bg-gray-50/70',
                    )}
                  >
                    <td className={cx(TD, reply && 'shadow-[inset_3px_0_0_0_var(--color-amber-400)]')}>
                      {bk ? (
                        <>
                          <RouteLine from={bk.source_address} to={bk.destination_address} max="max-w-[150px]" className="font-semibold text-gray-900" />
                          <div className="text-xs text-gray-500 truncate max-w-[300px]">{loadLine(bk)}</div>
                        </>
                      ) : (
                        // The bid is ours and real even when its load is no longer readable —
                        // dropping the row would silently shrink the fleet's own history.
                        <span className="text-gray-400 italic">Load no longer available</span>
                      )}
                    </td>

                    <td className={TD}>
                      <span className="text-gray-700 truncate block max-w-[150px]">{bk?.shipper_name || '—'}</span>
                    </td>

                    <td className={cx(TD, 'text-right')}>
                      <div className="font-semibold text-gray-900 tabular-nums">{inr(b.amount)}</div>
                      <Delta delta={delta} suffix=" vs ask" />
                    </td>

                    <td className={cx(TD, 'text-right text-gray-600 tabular-nums')}>
                      {bk ? inr(bk.quoted_price) : '—'}
                    </td>

                    <td className={TD}>
                      <span className={cfg.color}>{cfg.label}</span>
                      {reply && <div className="text-xs text-orange-700 mt-1">shipper countered</div>}
                    </td>

                    <td className={cx(TD, 'text-gray-700 whitespace-nowrap')}>
                      <div>{timeAgo(b.submitted_at)}</div>
                      <div className="text-xs text-gray-400">{shortDate(b.submitted_at)}</div>
                    </td>

                    {/* Sticky for the same reason the Open loads table already is: at 1000px
                        minimum width this table outruns its container and the actions were
                        landing off-screen. This tab is the one that most needs them reachable —
                        a countered bid is the only row here that expires while nobody is
                        looking, which is why those rows are pulled to the top and tinted.

                        A sticky cell must be OPAQUE (a transparent one shows the row sliding
                        underneath it), so it carries its own background mirroring the row's,
                        and tracks hover via `group` on the <tr>. */}
                    <td
                      className={cx(
                        TD, 'text-right whitespace-nowrap sticky right-0 transition-colors',
                        reply ? 'bg-amber-50' : 'bg-white group-hover:bg-gray-50',
                      )}
                    >
                      <div className="inline-flex items-center gap-2">
                        <button onClick={() => onHistory(b)} className={cx(BTN_SECONDARY, 'h-9 px-3')}>
                          History
                        </button>
                        {reply && (
                          <button onClick={() => onCounter(b)} className={cx(BTN_PRIMARY, 'h-9 px-3.5')}>
                            Reply
                          </button>
                        )}
                        {isLive(b.status) && (
                          <button
                            onClick={() => handleWithdraw(b)}
                            disabled={busy}
                            className={cx(BTN_SECONDARY, 'h-9 px-3 text-red-600 border-red-200 hover:bg-red-50')}
                          >
                            {busy ? 'Withdrawing…' : 'Withdraw'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

// ── Won ───────────────────────────────────────────────────────

function WonTable({ rows, total }: { rows: FleetBooking[]; total: number }) {
  return (
    <Card>
      <CardHead
        title="Won"
        icon={<Trophy />}
        tint="green"
        sub={`${rows.length} load${rows.length === 1 ? '' : 's'} awarded to this fleet${rows.length > 0 ? ` · ${inrCompact(total)} awarded` : ''}`}
      />
      {rows.length === 0 ? (
        <Empty
          title="Nothing won yet"
          hint="Loads land here the moment a shipper accepts one of this fleet's bids."
          icon={<Trophy />}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px]">
            <thead>
              <tr className={THEAD_ROW}>
                <th className={TH}>Route</th>
                <th className={TH}>Load</th>
                <th className={TH}>Shipper</th>
                <th className={TH}>Pickup</th>
                <th className={cx(TH, 'text-right')}>Awarded</th>
                <th className={TH}>Status</th>
                <th className={TH}>Crew</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(b => {
                const status = bookingStatusConfig[b.status]
                const crewed = Boolean(b.vehicle_id && b.driver_id)
                const delta = b.final_price === null ? null : b.final_price - b.quoted_price

                return (
                  <tr key={b.id} className={TR}>
                    <td className={TD}>
                      <RouteLine from={b.source_address} to={b.destination_address} max="max-w-[150px]" className="font-semibold text-gray-900" />
                    </td>
                    <td className={cx(TD, 'text-gray-700 whitespace-nowrap')}>
                      <span className="truncate inline-block max-w-[140px] align-bottom" title={b.load_type}>{b.load_type}</span>
                      <span className="text-gray-400"> · </span>
                      <span className="tabular-nums">{tons(b.weight_kg)}</span>
                    </td>
                    <td className={TD}>
                      <span className="text-gray-700 truncate block max-w-[150px]">{b.shipper_name || '—'}</span>
                    </td>
                    <td className={cx(TD, 'text-gray-700 whitespace-nowrap')}>{shortDate(b.pickup_date)}</td>
                    <td className={cx(TD, 'text-right')}>
                      <div className="font-semibold text-gray-900 tabular-nums">{inr(b.final_price)}</div>
                      <Delta delta={delta} suffix=" vs ask" />
                    </td>
                    <td className={TD}>
                      {status
                        ? <span className={status.color}>{status.label}</span>
                        : <span className={pill('slate')}>{String(b.status).replace(/_/g, ' ')}</span>}
                    </td>
                    <td className={TD}>
                      {crewed ? (
                        <>
                          <div className={cx(MONO, 'text-sm font-semibold text-blue-700')}>{b.vehicle?.rc_number ?? 'Truck assigned'}</div>
                          {b.driver?.full_name && (
                            <div className="text-xs text-gray-500 truncate max-w-[140px]">{b.driver.full_name}</div>
                          )}
                        </>
                      ) : b.status === 'accepted' ? (
                        <span className={cx(pill('orange'), 'py-1')}>
                          Needs truck + driver
                        </span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

// ── Dialogs ───────────────────────────────────────────────────

/** Shared amount+message body, so the bid and counter forms cannot drift apart. */
function AmountForm({
  ask, amount, setAmount, message, setMessage, error,
}: {
  ask: number | null
  amount: string
  setAmount: (v: string) => void
  message: string
  setMessage: (v: string) => void
  error: string | null
}) {
  const n = Number(amount)
  const valid = Number.isFinite(n) && n > 0
  const delta = valid && ask !== null ? n - ask : null

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="bid-amount" className={LABEL}>
          Your price (₹)
        </label>
        <input
          id="bid-amount"
          type="number"
          inputMode="numeric"
          min={1}
          value={amount}
          onChange={e => setAmount(e.target.value)}
          placeholder={ask !== null ? String(ask) : 'Amount in rupees'}
          className={cx(INPUT, 'h-11 text-base font-semibold tabular-nums')}
        />
        {ask !== null && (
          <p className={HINT}>
            Shipper asked <span className="tabular-nums font-medium text-gray-700">{inr(ask)}</span>
            {delta !== null && delta !== 0 && (
              <span className={`ml-1.5 tabular-nums ${delta > 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                ({inrSigned(delta)})
              </span>
            )}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="bid-message" className={LABEL}>
          Message <span className="font-normal text-gray-400">(optional)</span>
        </label>
        <textarea
          id="bid-message"
          rows={4}
          value={message}
          onChange={e => setMessage(e.target.value)}
          placeholder="Anything the shipper should know — truck type, availability, terms."
          className={TEXTAREA}
        />
      </div>

      {error && <ErrorNote message={error} />}
    </div>
  )
}

function LoadSummary({ booking }: { booking: AuctionBooking }) {
  const dl = deadlineIn(booking.auction_deadline)
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50/70 px-4 py-3.5 flex items-start gap-3.5">
      <IconTile icon={<Package />} tint="brand" />
      <div className="min-w-0 flex-1 text-sm">
        <RouteLine from={booking.source_address} to={booking.destination_address} max="max-w-[220px]" className="text-base font-bold text-gray-900" />
        <div className="mt-1 text-gray-600 flex flex-wrap items-center gap-x-1.5">
          <span>{booking.load_type} · {tons(booking.weight_kg)} · pickup {shortDate(booking.pickup_date)}</span>
          {dl && !dl.expired && (
            <span className={cx('inline-flex items-center gap-1', dl.urgent ? 'text-red-600 font-semibold' : '')}>
              · closes in {dl.urgent && <Clock className="w-3.5 h-3.5" />}{dl.text}
            </span>
          )}
        </div>
        {booking.shipper_name && <div className="mt-0.5 text-gray-600">Shipper: {booking.shipper_name}</div>}
        {booking.special_instructions && (
          <p className="mt-1 text-gray-600">Special instructions: {booking.special_instructions}</p>
        )}
      </div>
    </div>
  )
}

/**
 * Mode B (P4): shows the fleet where their self-named bid lands — a cost breakdown that sums to the
 * amount they typed, from the load + route only. Never nudges; a below-cost bid is stated, not raised.
 */
function JustifyPanel({ breakdown }: { breakdown: JustifyBreakdown }) {
  const c = breakdown.components
  const rows: [string, number][] = [
    ['Fuel', c.fuel],
    ['Tolls', c.tolls],
    ['Driver', c.driver],
    ['Maintenance', c.maintenance],
    ['Handling', c.handling],
  ]
  const belowCost = breakdown.position === 'below_typical_cost'
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-bold text-gray-900">Where this bid goes · {breakdown.distance_km} km</div>
          <div className="text-xs text-gray-500">load &amp; route only</div>
        </div>
        <Info className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" aria-hidden />
      </div>
      <dl className="mt-3 space-y-2 text-sm text-gray-600">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between">
            <dt>{label}</dt>
            <dd className="tabular-nums text-gray-900">{inr(value)}</dd>
          </div>
        ))}
        <div className="flex justify-between border-t border-gray-200 pt-2 font-semibold text-gray-900">
          <dt>{belowCost ? 'Bid (scaled to cost)' : 'Operating cost'}</dt>
          <dd className="tabular-nums">{inr(breakdown.cost_subtotal)}</dd>
        </div>
        {!belowCost && (
          <div className="flex justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 font-bold text-emerald-700">
            <dt>Your margin</dt>
            <dd className="tabular-nums">{inr(breakdown.margin)}</dd>
          </div>
        )}
      </dl>
      <p className={cx('mt-3 text-xs leading-snug', belowCost ? 'text-amber-700' : 'text-gray-500')}>
        {breakdown.note}
      </p>
    </div>
  )
}

function BidDialog({
  auction, onClose, onDone,
}: {
  auction: OpenAuction | null
  onClose: () => void
  onDone: () => void
}) {
  const [amount, setAmount] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Mode B (P4): the engine justifies THIS bid — a breakdown that sums to the number the fleet types,
  // from the load + route only. It never nudges; it just shows where the price would go.
  const [justify, setJustify] = useState<JustifyBreakdown | null>(null)

  // Reset per target, so one load's numbers never leak into the next dialog.
  useEffect(() => {
    setAmount(auction?.my_bid ? String(auction.my_bid.amount) : '')
    setMessage('')
    setError(null)
    setJustify(null)
  }, [auction])

  // Debounced justify preview. Recomputes as the fleet edits the amount; sends load + route only.
  useEffect(() => {
    const n = Number(amount)
    if (!auction || !Number.isFinite(n) || n <= 0) { setJustify(null); return }
    let cancelled = false
    const t = setTimeout(() => {
      justifyBid({
        amount: n,
        load_type: auction.load_type,
        weight_kg: auction.weight_kg,
        source_lat: auction.source_lat, source_lng: auction.source_lng,
        dest_lat: auction.dest_lat, dest_lng: auction.dest_lng,
      })
        .then((b) => { if (!cancelled) setJustify(b) })
        .catch(() => { if (!cancelled) setJustify(null) }) // preview only — never blocks bidding
    }, 400)
    return () => { cancelled = true; clearTimeout(t) }
  }, [amount, auction])

  async function submit() {
    if (!auction) return
    const n = Number(amount)
    if (!Number.isFinite(n) || n <= 0) {
      setError('Enter a price greater than zero.')
      return
    }
    setSaving(true)
    setError(null)

    // Re-bidding replaces a live quote, and the DB allows only one live quote per bidder,
    // so the old one has to come out first. There is no atomic swap available: the only
    // update path (`/counter`) is legal solely while a quote is `countered`.
    //
    // That makes the window between the two calls real — if the withdraw lands and the
    // place then fails (network drop, deadline passed in between, booking just awarded),
    // the fleet is left with NO bid where it previously had one. This tracks that so the
    // failure can say what actually happened, because silently reporting "could not place
    // that bid" while having already destroyed the old one is the worst of both.
    let withdrew = false
    try {
      if (auction.my_bid && isLive(auction.my_bid.status)) {
        await withdrawBid(auction.id, auction.my_bid.id)
        withdrew = true
      }
      await placeBid(auction.id, n, message.trim() || undefined)
      onDone()
    } catch (err) {
      const base = err instanceof ApiError ? err.message : 'Could not place that bid'
      setError(
        withdrew
          ? `${base} — and your previous bid of ${inr(auction.my_bid?.amount ?? null)} has already been withdrawn, so this load currently has no bid from you. Try again.`
          : base,
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={auction !== null} onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-3xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{auction?.my_bid ? 'Replace your bid' : 'Place a bid'}</DialogTitle>
          <DialogDescription>
            {auction?.my_bid
              ? 'Your current bid is withdrawn and replaced with this one.'
              : 'You can change or withdraw it until the shipper accepts.'}
          </DialogDescription>
        </DialogHeader>

        {auction && (
          <div className="space-y-5">
            <LoadSummary booking={auction} />
            <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
              <AmountForm
                ask={auction.quoted_price}
                amount={amount}
                setAmount={setAmount}
                message={message}
                setMessage={setMessage}
                error={error}
              />
              {justify ? (
                <JustifyPanel breakdown={justify} />
              ) : (
                <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50/60 p-4 text-sm text-gray-500 flex items-center justify-center text-center">
                  Type a price to see where it goes.
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <button onClick={onClose} disabled={saving} className={cx(BTN_SECONDARY, 'h-11 sm:min-w-[120px]')}>Cancel</button>
          <button onClick={submit} disabled={saving} className={cx(BTN_PRIMARY, 'h-11 sm:min-w-[200px]')}>
            {saving ? 'Placing…' : auction?.my_bid ? 'Replace bid' : 'Place bid'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CounterDialog({
  bid, onClose, onDone,
}: {
  bid: FleetBid | null
  onClose: () => void
  onDone: () => void
}) {
  const [amount, setAmount] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setAmount(bid ? String(bid.amount) : '')
    setMessage('')
    setError(null)
  }, [bid])

  async function submit() {
    if (!bid) return
    const n = Number(amount)
    if (!Number.isFinite(n) || n <= 0) {
      setError('Enter a price greater than zero.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await counterBid(bid.booking_id, bid.id, n, message.trim() || undefined)
      onDone()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send that counter-offer')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={bid !== null} onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-lg max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Reply to the counter-offer</DialogTitle>
          <DialogDescription>
            Send a new price to keep it live.
          </DialogDescription>
        </DialogHeader>

        {bid && (
          <div className="space-y-4">
            {bid.booking && <LoadSummary booking={bid.booking} />}
            <AmountForm
              ask={bid.booking?.quoted_price ?? null}
              amount={amount}
              setAmount={setAmount}
              message={message}
              setMessage={setMessage}
              error={error}
            />
          </div>
        )}

        <DialogFooter>
          <button onClick={onClose} disabled={saving} className={cx(BTN_SECONDARY, 'h-11')}>Cancel</button>
          <button onClick={submit} disabled={saving} className={cx(BTN_PRIMARY, 'h-11 sm:min-w-[160px]')}>{saving ? 'Sending…' : 'Send counter'}</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The append-only price thread for one bid — who offered what, in order. */
function HistoryDialog({ bid, onClose }: { bid: FleetBid | null; onClose: () => void }) {
  const [entries, setEntries] = useState<NegotiationEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!bid) { setEntries(null); setError(null); return }
    let cancelled = false
    setEntries(null)
    setError(null)
    getBidHistory(bid.booking_id, bid.id)
      .then(rows => { if (!cancelled) setEntries(rows ?? []) })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load the price history')
      })
    return () => { cancelled = true }
  }, [bid])

  const roleLabel: Record<NegotiationEntry['actor_role'], string> = {
    shipper: 'Shipper',
    fleet_owner: 'Your fleet',
    driver: 'Driver',
  }

  return (
    <Dialog open={bid !== null} onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Price history</DialogTitle>
          <DialogDescription>
            {bid?.booking
              ? `${routeKey(bid.booking)} · ${loadLine(bid.booking)}`
              : 'Every offer and counter, oldest first.'}
          </DialogDescription>
        </DialogHeader>

        {error && <ErrorNote message={error} />}
        {!error && entries === null && <Loading label="Loading history" />}
        {!error && entries?.length === 0 && (
          <Empty title="No history yet" hint="The thread fills in as prices are exchanged." />
        )}

        {entries && entries.length > 0 && (
          <ol className="relative">
            {entries.map((e, i) => {
              const mine = e.actor_role === 'fleet_owner'
              const last = i === entries.length - 1
              return (
                <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
                  {!last && <span aria-hidden className="absolute left-[7px] top-4 bottom-0 w-px bg-gray-200" />}
                  <span
                    aria-hidden
                    className={cx(
                      'relative mt-1 w-[15px] h-[15px] rounded-full ring-4 shrink-0',
                      mine ? 'bg-blue-600 ring-blue-50' : 'bg-gray-300 ring-gray-50',
                      last && !mine && 'bg-orange-500 ring-orange-50',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className={cx('text-sm font-semibold', mine ? 'text-blue-700' : 'text-gray-800')}>
                        {roleLabel[e.actor_role] ?? e.actor_role}
                      </span>
                      <span className="text-sm font-bold text-gray-900 tabular-nums">{inr(e.amount)}</span>
                    </div>
                    {e.message && <p className="mt-0.5 text-sm text-gray-600">{e.message}</p>}
                    <p className="mt-0.5 text-xs text-gray-400">{dateTime(e.created_at)}</p>
                  </div>
                </li>
              )
            })}
          </ol>
        )}

        <DialogFooter>
          <button onClick={onClose} className={cx(BTN_SECONDARY, 'h-11 w-full')}>Close</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
