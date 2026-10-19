'use client'

// The non-fleet panels of the dashboard (GET /me/summary). Each answers its person's
// 5-second question first, in the same tiles and cards as the fleet dashboard:
//
//   My driving    — where am I going next, and by when?   (no freight money — §1.1)
//   My truck      — will my truck cover its EMI this month? (own-truck trips only)
//   My shipments  — are my goods moving, and what is it costing?
//
// The server already decided what each person may see; these components only render it.

import type { ReactNode } from 'react'
import Link from 'next/link'
import {
  Bell, CalendarDays, Clock, Gavel, IdCard, IndianRupee, MapPin, Navigation, PackagePlus, Route, Truck, Wallet,
} from 'lucide-react'
import { Card, CardHead, Empty, Meter } from '@/components/stat'
import { HeadlineTile, MiniStat } from '@/components/fleet-core/kpi'
import { inr, inrCompact, shortDate, timeAgo, tons } from '@/lib/format'
import { bookingStatusConfig } from '@/lib/status'
import { BTN_PRIMARY, BTN_SECONDARY, LINK, cx, pill } from '@/lib/ui'
import type { DrivingPanelData, ShipmentsPanelData, SummaryTripCard, TruckPanelData } from '@/lib/types'

function SectionTitle({ title, sub, actions }: { title: string; sub: string; actions?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3 flex-wrap">
      <div>
        <h2 className="text-xl font-extrabold tracking-tight text-gray-900">{title}</h2>
        <p className="text-sm text-gray-500 mt-0.5">{sub}</p>
      </div>
      {actions}
    </div>
  )
}

type Tone = 'neutral' | 'good' | 'bad' | 'warn'
const ageTone = (days: number | null): Tone => (days == null ? 'neutral' : days >= 7 ? 'bad' : days >= 3 ? 'warn' : 'neutral')
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
/** How old the oldest unpaid trip is, for a tile's sub-line. */
const ageNote = (days: number | null) => (days == null ? '' : days === 0 ? ' · delivered today' : ` · oldest ${plural(days, 'day')}`)

function AlertsStat({ count }: { count: number }) {
  return (
    <Link href="/home" className="block rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
      <MiniStat label="Open alerts" value={count} sub={count ? 'See them on Home' : 'Nothing needs you'} tone={count ? 'warn' : 'neutral'} icon={<Bell />} />
    </Link>
  )
}

// ── My driving ───────────────────────────────────────────────────────────────

function TripRoute({ trip }: { trip: SummaryTripCard }) {
  const status = bookingStatusConfig[trip.status] ?? bookingStatusConfig.pending
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xl font-extrabold tracking-tight text-gray-900">{trip.from} → {trip.to}</span>
        <span className={pill(status.tone)}>{status.label}</span>
      </div>
      <p className="text-sm text-gray-500 mt-1">
        {trip.load_type} · {tons(trip.weight_kg)} · pickup {shortDate(trip.pickup_date)}
        {trip.started_at ? ` · started ${timeAgo(trip.started_at)}` : ''}
      </p>
    </div>
  )
}

export function DrivingPanel({ data }: { data: DrivingPanelData }) {
  const trip = data.current_trip
  const lic = data.licence
  const days = lic?.days_left ?? null
  const licValue = !lic?.expiry_date ? 'Add it' : days == null ? '—' : days < 0 ? 'Expired' : days === 0 ? 'Expires today' : plural(days, 'day')
  const licSub = !lic?.expiry_date ? 'Add it on your profile'
    : days != null && days < 0 ? `Expired on ${shortDate(lic.expiry_date)}` : `Valid to ${shortDate(lic.expiry_date)}`
  const licTone: Tone = days == null ? 'neutral' : days < 0 ? 'bad' : days <= 30 ? 'warn' : 'good'
  return (
    <section className="space-y-4" aria-label="My driving">
      <SectionTitle title="My driving" sub="Your trips — where you are going next, and by when. Freight amounts stay with the truck’s owner." />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card>
          <CardHead icon={<Navigation />} tint="green" title={trip && trip.status !== 'accepted' ? 'Current trip' : 'Next trip'}
            actions={trip ? <Link href={`/my-trips/${trip.booking_id}`} className={BTN_PRIMARY}>Open trip</Link> : undefined} />
          <div className="px-5 py-4">
            {trip ? <TripRoute trip={trip} /> : (
              <Empty title="No trip right now" hint="Trips appear here the moment one is assigned to you." icon={<Route />} />
            )}
          </div>
        </Card>
        <div className="grid grid-cols-2 gap-3 content-start">
          <MiniStat label="Delivered this month" value={data.month.delivered} icon={<Truck />} />
          <MiniStat label="Average transit" value={data.month.avg_transit_hours != null ? `${data.month.avg_transit_hours} h` : '—'} sub="Start to delivery" icon={<Clock />} />
          <Link href="/driver-profile" className="block rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
            <MiniStat label="Licence" value={licValue} sub={licSub} tone={licTone} icon={<IdCard />} />
          </Link>
          <AlertsStat count={data.open_alerts} />
        </div>
      </div>
      {data.upcoming.length > 0 && (
        <Card>
          <CardHead icon={<CalendarDays />} tint="slate" title="Coming up" sub={plural(data.upcoming.length, 'trip')} />
          <ul className="divide-y divide-gray-100">
            {data.upcoming.map((t) => (
              <li key={t.booking_id}>
                <Link href={`/my-trips/${t.booking_id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-gray-50">
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-gray-900 truncate">{t.from} → {t.to}</span>
                    <span className="block text-[0.8125rem] text-gray-500">{t.load_type} · {tons(t.weight_kg)}</span>
                  </span>
                  <span className="shrink-0 text-sm text-gray-600 tabular-nums">{shortDate(t.pickup_date)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  )
}

// ── My truck ─────────────────────────────────────────────────────────────────

export function TruckPanel({ data }: { data: TruckPanelData }) {
  const { month, owed } = data
  const cover = month.emi_inr ? (month.earned_inr / month.emi_inr) * 100 : null
  return (
    <section className="space-y-4" aria-label="My truck">
      <SectionTitle title="My truck" sub={data.vehicle ? `${data.vehicle.rc_number} · this month, from trips on your own truck` : 'This month, from trips on your own truck'}
        actions={<Link href="/auctions" className={cx(BTN_SECONDARY)}>Find work</Link>} />
      <div className="grid gap-4 md:grid-cols-3">
        <HeadlineTile label="Earned" value={inrCompact(month.earned_inr)} tone={month.earned_inr > 0 ? 'good' : 'neutral'}
          sub={`${plural(month.trips_paid, 'paid trip')} · before fuel and costs`} icon={<IndianRupee />} tint="green" />
        <Card className="p-5 flex flex-col justify-center">
          <div className="text-sm font-semibold text-gray-700 mb-2 inline-flex items-center gap-1.5"><Wallet className="w-4 h-4 text-gray-400" />EMI this month</div>
          {month.emi_inr ? (
            <>
              <Meter pct={cover} label={month.earned_inr >= month.emi_inr ? `${inr(month.emi_inr)} covered` : `${inr(month.earned_inr)} of ${inr(month.emi_inr)}`} />
              <p className="text-xs text-gray-500 mt-2">
                {month.earned_inr >= month.emi_inr
                  ? `${inr(month.earned_inr - month.emi_inr)} to spare after the EMI, before fuel and running costs.`
                  : `${inr(month.emi_inr - month.earned_inr)} more to cover it. Earnings are before fuel and running costs.`}
              </p>
            </>
          ) : (
            <p className="text-sm text-gray-500">No EMI recorded for this truck yet, so there is nothing to measure against.</p>
          )}
        </Card>
        <HeadlineTile label="Owed to you" value={inrCompact(owed.amount_inr)} tone={ageTone(owed.oldest_days)}
          sub={owed.trips ? `${plural(owed.trips, 'delivered trip')} unpaid${ageNote(owed.oldest_days)}` : 'Nothing owed'} icon={<IndianRupee />} tint="amber" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MiniStat label="Trips in progress" value={data.in_progress} icon={<Route />} />
        <MiniStat label="Live bids" value={data.bids.live} icon={<Gavel />} />
        <MiniStat label="Countered — your reply" value={data.bids.countered} tone={data.bids.countered ? 'warn' : 'neutral'} icon={<Gavel />} />
        <AlertsStat count={data.open_alerts} />
      </div>
    </section>
  )
}

// ── My shipments ─────────────────────────────────────────────────────────────

export function ShipmentsPanel({ data }: { data: ShipmentsPanelData }) {
  const { month, due } = data
  const maxLane = Math.max(1, ...data.lanes.map((l) => l.spend_inr))
  return (
    <section className="space-y-4" aria-label="My shipments">
      <SectionTitle title="My shipments" sub="This month — your loads and your spend"
        actions={<Link href="/post" className={cx(BTN_PRIMARY, '[&_svg]:w-4 [&_svg]:h-4')}><PackagePlus />Post a load</Link>} />
      <div className="grid gap-4 md:grid-cols-3">
        <HeadlineTile label="Paid this month" value={inrCompact(month.paid_inr)} sub={`${month.delivered} delivered · ${month.posted} posted`} icon={<IndianRupee />} tint="blue" />
        <HeadlineTile label="Payment due" value={inrCompact(due.amount_inr)} tone={ageTone(due.oldest_days)}
          sub={due.trips ? `${plural(due.trips, 'delivered load')}${ageNote(due.oldest_days)}` : 'Nothing due'} icon={<Wallet />} tint="amber" />
        <HeadlineTile label="Average transit" value={month.avg_transit_hours != null ? `${month.avg_transit_hours} h` : '—'}
          sub="Start to delivery, this month" icon={<Clock />} tint="violet" />
      </div>
      {data.bids_waiting.bids > 0 && (
        <Link href="/loads" className={cx(LINK, 'inline-flex items-center gap-1.5 text-sm')}>
          <Gavel className="w-4 h-4" />{plural(data.bids_waiting.bids, 'bid')} waiting on {plural(data.bids_waiting.loads, 'load')} — review
        </Link>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHead icon={<MapPin />} tint="green" title="On the road" sub={data.on_the_road.length ? plural(data.on_the_road.length, 'load') + ' in transit' : undefined} />
          {data.on_the_road.length ? (
            <ul className="divide-y divide-gray-100">
              {data.on_the_road.map((l) => (
                <li key={l.booking_id}>
                  <Link href={`/loads/${l.booking_id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-gray-50">
                    <span className="text-sm font-semibold text-gray-900 truncate">{l.from} → {l.to}</span>
                    <span className="shrink-0 text-sm text-gray-500">{l.started_at ? `started ${timeAgo(l.started_at)}` : 'in transit'}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : <Empty title="Nothing on the road" hint="Loads appear here once the driver starts the trip." icon={<Truck />} />}
        </Card>
        <Card>
          <CardHead icon={<Route />} tint="blue" title="Spend by lane" sub="Delivered and paid loads, last 90 days" />
          {data.lanes.length ? (
            <ul className="px-5 py-4 space-y-3">
              {data.lanes.map((l) => (
                <li key={l.lane}>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="font-semibold text-gray-900 truncate">{l.lane}</span>
                    <span className="shrink-0 tabular-nums text-gray-700">{inr(l.spend_inr)} · {plural(l.loads, 'load')}</span>
                  </div>
                  <div className="h-2 rounded-full bg-gray-100 overflow-hidden mt-1.5">
                    <div className="h-full rounded-full bg-blue-600" style={{ width: `${(l.spend_inr / maxLane) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          ) : <Empty title="No delivered loads yet" hint="Your lanes appear here after your first delivery." icon={<Route />} />}
        </Card>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <AlertsStat count={data.open_alerts} />
      </div>
    </section>
  )
}
