'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  AlertTriangle, ChartColumn, Clock, Pencil, RotateCcw, Search, Star, UserRound, UserPlus,
  Users, Wallet,
} from 'lucide-react'
import { PageHeader } from '@/components/app-shell'
import { Card, CardHead, Empty, ErrorNote, InfoDot, Loading, Stat } from '@/components/stat'
import { Avatar, COL_RULE, Modal, TD, TH, THEAD_ROW, TR, fmtPhone } from '@/components/fleet-ops/bits'
import {
  ApiError, getDriverAnalytics, inviteDriver, listFleetDrivers, removeFleetDriver,
  updateFleetDriver,
} from '@/lib/api'
import { inr, inrSigned, km, shortDate, timeAgo } from '@/lib/format'
import type { DriverAnalytics, FleetDriver, FleetDriverStatus, Period } from '@/lib/types'
import {
  BTN_PRIMARY, BTN_SECONDARY, HINT, INPUT, LABEL, SEG_OFF, SEG_ON, SELECT, cx, pill,
} from '@/lib/ui'

/**
 * The driver roster.
 *
 * CONSENT IS THE WHOLE DESIGN OF THIS PAGE. bt-fleet-service/src/routes/drivers.ts
 * refuses PATCH status on a 'pending' row ("CONSENT GATE") — only the driver can
 * move an invitation to 'active', from their own app via
 * POST /fleet/drivers/invites/:id/respond, which this console cannot call. So the
 * pending section deliberately renders NO activate/accept control at all: an owner
 * conscripting a driver who never agreed was a real defect, and a disabled-looking
 * button here would still imply the owner is the one who decides. Salary is the
 * only thing editable before acceptance.
 */

// GET /fleet/drivers returns the affiliation row with the identity NESTED under
// `driver` (routes/drivers.ts maps `{ ...row, driver: identities.get(...) }`),
// while FleetDriver in lib/types.ts declares those fields flat. Read both and
// prefer the nested one, so the page renders whichever shape the service sends.
type DriverIdentity = {
  driver_id: string
  user_id: string
  full_name: string | null
  phone_number: string | null
  kyc_status: string | null
  average_rating: number | null
  total_trips: number | null
}
type RosterRow = FleetDriver & { driver?: DriverIdentity | null }

const PHONE_RE = /^[6-9]\d{9}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_SALARY = 10_000_000

const nameOf = (r: RosterRow) => r.driver?.full_name ?? r.full_name ?? null
const phoneOf = (r: RosterRow) => r.driver?.phone_number ?? r.phone_number ?? null
const ratingOf = (r: RosterRow) => r.driver?.average_rating ?? r.average_rating ?? null
const lifetimeTripsOf = (r: RosterRow) => r.driver?.total_trips ?? r.total_trips ?? null
const kycOf = (r: RosterRow) => r.driver?.kyc_status ?? null

const FORMER_LABEL: Record<'left' | 'rejected' | 'suspended', { label: string; color: string }> = {
  left:      { label: 'Left',                color: pill('slate') },
  rejected:  { label: 'Declined invitation', color: pill('red') },
  suspended: { label: 'Suspended',           color: pill('amber') },
}

/** Client-side narrowing of the Active table — the roster is already loaded in full. */
type ActiveFilter = 'all' | 'kyc_verified' | 'kyc_pending' | 'no_salary'
const ACTIVE_FILTERS: { key: ActiveFilter; label: string }[] = [
  { key: 'all', label: 'All status' },
  { key: 'kyc_verified', label: 'KYC verified' },
  { key: 'kyc_pending', label: 'KYC not verified' },
  { key: 'no_salary', label: 'No salary set' },
]

function errText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error) return e.message
  return fallback
}

function sum(ns: number[]): number {
  return ns.reduce((a, b) => a + b, 0)
}

export default function DriversPage() {
  const [rows, setRows] = useState<RosterRow[] | null>(null)
  const [analytics, setAnalytics] = useState<{ period: Period; drivers: DriverAnalytics[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [analyticsError, setAnalyticsError] = useState<string | null>(null)

  const [inviteOpen, setInviteOpen] = useState(false)
  const [salaryTarget, setSalaryTarget] = useState<RosterRow | null>(null)
  const [removeTarget, setRemoveTarget] = useState<RosterRow | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ActiveFilter>('all')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setAnalyticsError(null)
    // Settled, not all: a failing analytics roll-up must not blank the roster —
    // the roster is the part of this page you cannot work without.
    const [roster, ana] = await Promise.allSettled([listFleetDrivers(), getDriverAnalytics()])
    if (roster.status === 'fulfilled') setRows(roster.value)
    else setError(errText(roster.reason, 'Could not load the driver roster'))
    if (ana.status === 'fulfilled') setAnalytics(ana.value)
    else setAnalyticsError(errText(ana.reason, 'Could not load per-driver economics'))
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  function mergeRow(updated: FleetDriver) {
    // PATCH returns the bare affiliation row (no nested identity), so spread the
    // existing row first and keep the name/phone we already have.
    setRows(prev => prev?.map(r => (r.id === updated.id ? { ...r, ...updated } : r)) ?? prev)
  }

  async function handleReinstate(row: RosterRow) {
    setBusyId(row.id)
    setRowError(null)
    try {
      mergeRow(await updateFleetDriver(row.id, { status: 'active' }))
    } catch (e) {
      // The client maps CONFLICT to a truck-centric string; the real cause here is
      // fleet_drivers_one_live_per_driver — they joined someone else meanwhile.
      setRowError(e instanceof ApiError && e.code === 'CONFLICT'
        ? 'That driver has since taken a pending or active affiliation with another fleet.'
        : errText(e, 'Could not reinstate this driver'))
    } finally {
      setBusyId(null)
    }
  }

  const anaById = new Map((analytics?.drivers ?? []).map(d => [d.driver_id, d]))
  const periodLabel = analytics
    ? `${shortDate(analytics.period.from)} – ${shortDate(analytics.period.to)}`
    : null

  const active = rows?.filter(r => r.status === 'active') ?? []
  const pending = rows?.filter(r => r.status === 'pending') ?? []
  const former = rows?.filter(
    (r): r is RosterRow & { status: 'left' | 'rejected' | 'suspended' } =>
      r.status === 'left' || r.status === 'rejected' || r.status === 'suspended',
  ) ?? []

  const salaried = active.filter(r => r.monthly_salary_inr !== null)
  const wageBill = sum(salaried.map(r => r.monthly_salary_inr ?? 0))
  const unsalaried = active.length - salaried.length
  const periodProfit = analytics ? sum(analytics.drivers.map(d => d.net_profit_inr)) : null
  const periodTrips = analytics ? sum(analytics.drivers.map(d => d.trips)) : null
  const periodDistance = analytics ? sum(analytics.drivers.map(d => d.distance_km)) : null

  const q = query.trim().toLowerCase()
  const qDigits = q.replace(/\D/g, '')
  const shownActive = active.filter(r => {
    if (q) {
      const nameHit = (nameOf(r) ?? '').toLowerCase().includes(q)
      const phoneHit = qDigits.length > 0 && (phoneOf(r) ?? '').replace(/\D/g, '').includes(qDigits)
      if (!nameHit && !phoneHit) return false
    }
    const kyc = (kycOf(r) ?? '').toLowerCase()
    if (filter === 'kyc_verified') return kyc === 'verified'
    if (filter === 'kyc_pending') return kyc !== 'verified'
    if (filter === 'no_salary') return r.monthly_salary_inr === null
    return true
  })

  return (
    <div className="p-4 lg:p-8 max-w-[112rem] mx-auto">
      <PageHeader
        title="Drivers"
        info="Fleet drivers see the job, not the price — you assign their truck and trip."
        subtitle={rows ? `${active.length} active · ${pending.length} invited · ${former.length} former` : undefined}
        actions={
          <button onClick={() => setInviteOpen(true)} className={BTN_PRIMARY}>
            <UserPlus className="w-4 h-4" />
            Invite driver
          </button>
        }
      />

      {loading ? (
        <Loading label="Loading roster" />
      ) : error ? (
        <div className="space-y-3">
          <ErrorNote message={error} />
          <button onClick={() => void load()} className={BTN_SECONDARY}>
            Try again
          </button>
        </div>
      ) : !rows || rows.length === 0 ? (
        <Card>
          <Empty
            art title="No drivers on the roster yet"
            hint="Invite a driver by their BharatTruck phone number."
            icon={<Users />}
            action={
              <button onClick={() => setInviteOpen(true)} className={BTN_PRIMARY}>
                <UserPlus className="w-4 h-4" />
                Invite driver
              </button>
            }
          />
        </Card>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-1 min-[420px]:grid-cols-2 xl:grid-cols-4 gap-3 lg:gap-4">
            <Stat
              label="Active drivers"
              value={active.length}
              sub={lifetimeTripsLine(active)}
              icon={<Users />}
              tint="blue"
            />
            <Stat
              label="Awaiting acceptance"
              value={pending.length}
              tone={pending.length > 0 ? 'warn' : 'neutral'}
              sub={pending.length > 0 ? 'The driver has to accept' : 'No open invitations'}
              icon={<Clock />}
              tint="amber"
            />
            <Stat
              label="Monthly wage bill"
              value={inr(wageBill)}
              sub={unsalaried > 0 ? `${unsalaried} without a salary set` : `${salaried.length} salaried`}
              icon={<Wallet />}
              tint="slate"
            />
            <Stat
              label="Net profit contributed"
              value={periodProfit === null ? inr(periodProfit) : inrSigned(periodProfit)}
              tone={periodProfit === null ? 'neutral' : periodProfit >= 0 ? 'good' : 'bad'}
              sub={periodTrips !== null ? `${periodTrips} trips · ${km(periodDistance)}` : 'Not available'}
              icon={<ChartColumn />}
            />
          </div>

          {analyticsError && <ErrorNote message={`Per-driver economics unavailable — ${analyticsError}`} />}
          {rowError && <ErrorNote message={rowError} />}

          {/* ── Active ─────────────────────────────────────────── */}
          <Card>
            <div className="flex flex-col lg:flex-row lg:items-start gap-3 lg:justify-between [&>div:first-child]:border-b-0 [&>div:first-child]:pb-3">
              <CardHead
                title="Active"
                icon={<UserRound />}
                tint="green"
                sub={periodLabel
                  ? `${active.length} on the roster · trips, distance, profit and wages are for ${periodLabel}`
                  : `${active.length} on the roster`}
              />
              {active.length > 0 && (
                <div className="flex flex-col sm:flex-row gap-2 px-5 lg:pt-4 pb-3 lg:pb-0 lg:pl-0">
                  <label className="relative block sm:w-72">
                    <span className="sr-only">Search active drivers</span>
                    <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="search"
                      value={query}
                      onChange={e => setQuery(e.target.value)}
                      placeholder="Search driver name or phone…"
                      className={cx(INPUT, 'pl-9')}
                    />
                  </label>
                  <label className="block sm:w-44">
                    <span className="sr-only">Filter active drivers</span>
                    <select value={filter} onChange={e => setFilter(e.target.value as ActiveFilter)} className={SELECT}>
                      {ACTIVE_FILTERS.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                    </select>
                  </label>
                </div>
              )}
            </div>
            {active.length === 0 ? (
              <Empty title="Nobody active" hint="Invited drivers appear here once they accept." />
            ) : shownActive.length === 0 ? (
              <div className="border-t border-gray-100 px-5 py-8 text-center text-sm text-gray-500">
                No active driver matches this search.
              </div>
            ) : (
              <div className="overflow-x-auto border-t border-gray-100">
                <table className="w-full min-w-[1040px]">
                  <thead>
                    <tr className={THEAD_ROW}>
                      <th className={TH}>Driver</th>
                      <th className={TH}>Phone</th>
                      <th className={cx(TH, 'text-right')}>Rating</th>
                      <th className={cx(TH, 'text-right')}>Lifetime trips</th>
                      <th className={cx(TH, 'text-right')}>Monthly salary</th>
                      <th className={cx(TH, 'text-right', COL_RULE)}>Trips</th>
                      <th className={cx(TH, 'text-right')}>Distance</th>
                      <th className={cx(TH, 'text-right')}>Net profit</th>
                      <th className={cx(TH, 'text-right')}>Wage allocated</th>
                      <th className={cx(TH, 'text-right')}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownActive.map(row => {
                      const a = anaById.get(row.driver_id)
                      return (
                        <tr key={row.id} className={TR}>
                          <td className={TD}>
                            <DriverCell row={row} />
                          </td>
                          <td className={cx(TD, 'text-gray-700 tabular-nums whitespace-nowrap')}>{fmtPhone(phoneOf(row)) ?? '—'}</td>
                          <td className={cx(TD, 'text-right')}>
                            <Rating value={ratingOf(row)} />
                          </td>
                          <td className={cx(TD, 'text-right tabular-nums text-gray-700')}>
                            {lifetimeTripsOf(row)?.toLocaleString('en-IN') ?? '—'}
                          </td>
                          <td className={cx(TD, 'text-right')}>
                            <SalaryButton row={row} onEdit={setSalaryTarget} />
                          </td>
                          <td className={cx(TD, 'text-right tabular-nums text-gray-700', COL_RULE)}>
                            {a ? a.trips.toLocaleString('en-IN') : '—'}
                          </td>
                          <td className={cx(TD, 'text-right tabular-nums text-gray-700 whitespace-nowrap')}>
                            {a ? km(a.distance_km) : '—'}
                          </td>
                          <td className={cx(TD, 'text-right tabular-nums font-semibold whitespace-nowrap',
                            !a ? 'text-gray-400' : a.net_profit_inr >= 0 ? 'text-emerald-600' : 'text-red-600',
                          )}>
                            {a ? inrSigned(a.net_profit_inr) : '—'}
                          </td>
                          <td className={cx(TD, 'text-right tabular-nums text-gray-700')}>
                            {a ? inr(a.wage_allocated_inr) : '—'}
                          </td>
                          <td className={cx(TD, 'text-right')}>
                            <button
                              onClick={() => { setRowError(null); setRemoveTarget(row) }}
                              className="rounded-lg px-2 py-1.5 -mr-2 text-sm font-semibold text-red-600 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 transition-colors"
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* ── Pending ────────────────────────────────────────── */}
          {pending.length > 0 && (
            <Card>
              <CardHead
                icon={<Clock />}
                tint="amber"
                title={
                  <>
                    Pending invitation
                    <span className="hidden sm:inline-flex items-center gap-1.5 ml-2 text-sm font-normal text-gray-500">
                      <InfoDot text="Only the driver can accept, from their own app." />
                      Only the driver can accept, from their own app.
                    </span>
                  </>
                }
                sub={`${pending.length} waiting on the driver`}
              />
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px]">
                  <thead>
                    <tr className={THEAD_ROW}>
                      <th className={TH}>Driver</th>
                      <th className={TH}>Phone</th>
                      <th className={TH}>Invited</th>
                      <th className={TH}>Waiting on</th>
                      <th className={cx(TH, 'text-right')}>Monthly salary</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pending.map(row => (
                      <tr key={row.id} className={TR}>
                        <td className={TD}>
                          <DriverCell row={row} />
                        </td>
                        <td className={cx(TD, 'text-gray-700 tabular-nums whitespace-nowrap')}>{fmtPhone(phoneOf(row)) ?? '—'}</td>
                        <td className={cx(TD, 'text-gray-700 whitespace-nowrap')}>
                          Invited {timeAgo(row.invited_at)}
                          <div className="text-xs text-gray-400">{shortDate(row.invited_at)}</div>
                        </td>
                        <td className={TD}>
                          <span className={cx(pill('orange'), 'py-1')}>
                            <Clock className="w-3.5 h-3.5" />
                            The driver must accept
                          </span>
                        </td>
                        <td className={cx(TD, 'text-right')}>
                          <SalaryButton row={row} onEdit={setSalaryTarget} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* ── Former ─────────────────────────────────────────── */}
          {former.length > 0 && (
            <Card>
              <CardHead title="Former" sub="Left, declined or suspended" icon={<UserRound />} tint="slate" />
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px]">
                  <thead>
                    <tr className={THEAD_ROW}>
                      <th className={TH}>Driver</th>
                      <th className={TH}>Phone</th>
                      <th className={TH}>Status</th>
                      <th className={TH}>Since</th>
                      <th className={cx(TH, 'text-right')}>Last salary</th>
                      <th className={cx(TH, 'text-right')}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {former.map(row => {
                      const cfg = FORMER_LABEL[row.status]
                      return (
                        <tr key={row.id} className={TR}>
                          <td className={TD}>
                            <span className="flex items-center gap-3 min-w-0">
                              <Avatar name={nameOf(row)} muted />
                              <span className="font-semibold text-gray-900 truncate">{nameOf(row) ?? 'Unnamed driver'}</span>
                            </span>
                          </td>
                          <td className={cx(TD, 'text-gray-700 tabular-nums whitespace-nowrap')}>{fmtPhone(phoneOf(row)) ?? '—'}</td>
                          <td className={TD}>
                            <span className={cfg.color}>{cfg.label}</span>
                          </td>
                          <td className={cx(TD, 'text-gray-700 whitespace-nowrap')}>
                            {shortDate(row.left_at ?? row.responded_at ?? row.invited_at)}
                          </td>
                          <td className={cx(TD, 'text-right tabular-nums text-gray-700')}>
                            {inr(row.monthly_salary_inr)}
                          </td>
                          <td className={cx(TD, 'text-right')}>
                            {row.status === 'suspended' ? (
                              <button
                                onClick={() => void handleReinstate(row)}
                                disabled={busyId === row.id}
                                title="Put this driver back on the active roster"
                                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 -mr-2 text-sm font-semibold text-blue-600 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 transition-colors disabled:opacity-50"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                                {busyId === row.id ? 'Reinstating…' : 'Reinstate'}
                              </button>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      )}

      {inviteOpen && (
        <InviteDialog
          onClose={() => setInviteOpen(false)}
          onInvited={created => {
            setRows(prev => (prev ? [created, ...prev] : [created]))
            setInviteOpen(false)
          }}
        />
      )}

      {salaryTarget && (
        <SalaryDialog
          row={salaryTarget}
          onClose={() => setSalaryTarget(null)}
          onSaved={updated => { mergeRow(updated); setSalaryTarget(null) }}
        />
      )}

      {removeTarget && (
        <RemoveDialog
          row={removeTarget}
          onClose={() => setRemoveTarget(null)}
          onRemoved={id => {
            // The service soft-deletes: the row becomes 'left' and keeps its history,
            // so it moves to the Former section rather than disappearing.
            setRows(prev => prev?.map(r => (
              r.id === id
                ? { ...r, status: 'left' as FleetDriverStatus, left_at: new Date().toISOString() }
                : r
            )) ?? prev)
            setRemoveTarget(null)
          }}
        />
      )}
    </div>
  )
}

// ── Small pieces ──────────────────────────────────────────────

function lifetimeTripsLine(active: RosterRow[]): string {
  const known = active.map(r => lifetimeTripsOf(r)).filter((n): n is number => n !== null)
  if (known.length === 0) return 'No trip history yet'
  return `${sum(known).toLocaleString('en-IN')} lifetime trips`
}

function DriverCell({ row }: { row: RosterRow }) {
  return (
    <span className="flex items-center gap-3 min-w-0">
      <Avatar name={nameOf(row)} />
      <span className="min-w-0">
        <span className="block font-semibold text-gray-900 truncate max-w-[180px]">{nameOf(row) ?? 'Unnamed driver'}</span>
        <KycPill status={kycOf(row)} />
      </span>
    </span>
  )
}

function Rating({ value }: { value: number | null }) {
  if (value === null) return <span className="text-gray-400">—</span>
  return (
    <span className="inline-flex items-center gap-1 tabular-nums font-medium text-gray-900">
      <Star className="w-4 h-4 text-brand-500 fill-brand-500" />
      {value.toFixed(1)}
    </span>
  )
}

/** KYC state from users.kyc_status — the only verification signal the roster returns. */
function KycPill({ status }: { status: string | null }) {
  if (!status) return null
  const verified = status.toLowerCase() === 'verified'
  return (
    <span className={cx(pill(verified ? 'green' : 'slate'), 'mt-1 text-[0.6875rem] px-1.5 py-0')}>
      {verified ? 'KYC verified' : `KYC ${status.replace(/_/g, ' ')}`}
    </span>
  )
}

function SalaryButton({ row, onEdit }: { row: RosterRow; onEdit: (r: RosterRow) => void }) {
  const set = row.monthly_salary_inr !== null
  return (
    <button
      onClick={() => onEdit(row)}
      aria-label={set ? `Edit monthly salary for ${nameOf(row) ?? 'this driver'}` : `Set a monthly salary for ${nameOf(row) ?? 'this driver'}`}
      className={cx(
        'inline-flex items-center justify-center gap-2 h-9 min-w-[104px] rounded-lg border px-3 text-sm tabular-nums transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600',
        set
          ? 'border-gray-200 bg-white text-gray-900 font-medium hover:border-blue-300 hover:bg-blue-50/50'
          : 'border-blue-200 bg-blue-50 text-blue-700 font-semibold hover:bg-blue-100',
      )}
    >
      {set ? inr(row.monthly_salary_inr) : 'Set salary'}
      {set && <Pencil className="w-3.5 h-3.5 text-blue-600" />}
    </button>
  )
}

// ── Invite ────────────────────────────────────────────────────

function InviteDialog({ onClose, onInvited }: { onClose: () => void; onInvited: (r: RosterRow) => void }) {
  // The owner invites by whichever channel they have for the driver — phone or email.
  const [channel, setChannel] = useState<'phone' | 'email'>('phone')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    // Phones are stored E.164 (+91…), so the lookup needs the country code prefixed.
    let payload: { driver_phone: string } | { driver_email: string }
    if (channel === 'phone') {
      if (!PHONE_RE.test(phone)) {
        setErr('Enter a valid 10-digit Indian mobile number (starting 6, 7, 8 or 9).')
        return
      }
      payload = { driver_phone: `+91${phone}` }
    } else {
      if (!EMAIL_RE.test(email.trim())) {
        setErr('Enter a valid email address.')
        return
      }
      payload = { driver_email: email.trim() }
    }
    setBusy(true)
    try {
      onInvited(await inviteDriver(payload))
    } catch (e2) {
      if (e2 instanceof ApiError && e2.code === 'NOT_FOUND') {
        setErr(channel === 'phone'
          ? 'No driver account with that number — ask them to sign up first.'
          : 'No driver account with that email — ask them to sign up first.')
      } else if (e2 instanceof ApiError && e2.code === 'CONFLICT') {
        // The shared client maps CONFLICT to a truck-centric message; on invite the
        // real cause is fleet_drivers_one_live_per_driver.
        setErr('That driver already has a pending or active fleet affiliation.')
      } else {
        setErr(errText(e2, 'Could not send the invitation'))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Invite a driver" sub="Send an invitation to join your fleet." onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {/* Channel: phone or email — the owner's choice. */}
        <div className="grid grid-cols-2 gap-1 rounded-xl border border-gray-200 bg-white p-1" role="group" aria-label="Invite by">
          {(['phone', 'email'] as const).map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={channel === c}
              onClick={() => { setChannel(c); setErr(null) }}
              className={cx(channel === c ? SEG_ON : SEG_OFF, 'capitalize text-center')}
            >
              {c}
            </button>
          ))}
        </div>

        {channel === 'phone' ? (
          <div>
            <label htmlFor="invite-phone" className={LABEL}>
              Driver mobile number
            </label>
            <div className="flex gap-2">
              <span className="inline-flex items-center h-[42px] px-3 rounded-[10px] border border-gray-200 bg-gray-50 text-sm font-medium text-gray-700 select-none">
                +91
              </span>
              <input
                id="invite-phone"
                type="tel"
                inputMode="numeric"
                autoFocus
                autoComplete="off"
                placeholder="9876543210"
                value={phone}
                onChange={e => { setPhone(e.target.value.replace(/\D/g, '').slice(0, 10)); setErr(null) }}
                className={cx(INPUT, 'tabular-nums')}
              />
            </div>
          </div>
        ) : (
          <div>
            <label htmlFor="invite-email" className={LABEL}>
              Driver email
            </label>
            <input
              id="invite-email"
              type="email"
              autoFocus
              autoComplete="off"
              placeholder="driver@example.com"
              value={email}
              onChange={e => { setEmail(e.target.value); setErr(null) }}
              className={INPUT}
            />
          </div>
        )}

        {err && <ErrorNote message={err} />}
        <div className="grid grid-cols-2 gap-3 pt-1">
          <button type="button" onClick={onClose} className={BTN_SECONDARY}>
            Cancel
          </button>
          <button type="submit" disabled={busy} className={BTN_PRIMARY}>
            {busy ? 'Sending…' : 'Send invitation'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

// ── Salary ────────────────────────────────────────────────────

function SalaryDialog({
  row, onClose, onSaved,
}: { row: RosterRow; onClose: () => void; onSaved: (updated: FleetDriver) => void }) {
  const [value, setValue] = useState(row.monthly_salary_inr !== null ? String(row.monthly_salary_inr) : '')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const n = Number(value)
    if (value.trim() === '' || !Number.isFinite(n) || n < 0 || n > MAX_SALARY) {
      setErr(`Enter a monthly salary between ${inr(0)} and ${inr(MAX_SALARY)}.`)
      return
    }
    setBusy(true)
    setErr(null)
    try {
      onSaved(await updateFleetDriver(row.id, { monthly_salary_inr: Math.round(n) }))
    } catch (e2) {
      setErr(errText(e2, 'Could not update the salary'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Monthly salary" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-gray-50/70 px-3.5 py-3">
          <Avatar name={nameOf(row)} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-gray-900 truncate">{nameOf(row) ?? 'Unnamed driver'}</div>
            <div className="text-xs text-gray-500 tabular-nums">{fmtPhone(phoneOf(row)) ?? 'No phone on file'}</div>
          </div>
          <KycPill status={kycOf(row)} />
        </div>
        <div>
          <label htmlFor="salary" className={cx(LABEL, 'inline-flex items-center gap-1.5')}>
            Monthly salary (₹)
            <InfoDot text="Allocated across this driver's trips as wage cost." />
          </label>
          <input
            id="salary"
            type="text"
            inputMode="numeric"
            autoFocus
            value={value}
            onChange={e => setValue(e.target.value.replace(/\D/g, '').slice(0, 8))}
            placeholder="25000"
            aria-describedby="salary-hint"
            className={cx(INPUT, 'tabular-nums')}
          />
          <p id="salary-hint" className={HINT}>Allocated across this driver&apos;s trips as wage cost.</p>
        </div>
        {row.status === 'pending' && (
          <p className="text-xs text-gray-600 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2">
            Setting a salary does not accept the invitation for them.
          </p>
        )}
        {err && <ErrorNote message={err} />}
        <div className="grid grid-cols-2 gap-3 pt-1">
          <button type="button" onClick={onClose} className={BTN_SECONDARY}>
            Cancel
          </button>
          <button type="submit" disabled={busy} className={BTN_PRIMARY}>
            {busy ? 'Saving…' : 'Save salary'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

// ── Remove ────────────────────────────────────────────────────

function RemoveDialog({
  row, onClose, onRemoved,
}: { row: RosterRow; onClose: () => void; onRemoved: (id: string) => void }) {
  const [err, setErr] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function confirm() {
    setBusy(true)
    setErr(null)
    setHint(null)
    try {
      await removeFleetDriver(row.id)
      onRemoved(row.id)
    } catch (e) {
      setErr(errText(e, 'Could not remove this driver'))
      // Both codes the service can raise here mean the same thing on the ground, and
      // the shared client rewrites them to something generic — say what to do next.
      if (e instanceof ApiError && (e.code === 'INVALID_TRANSITION' || e.code === 'CONFLICT')) {
        setHint('This driver is on a live trip. It has to finish before they can leave the fleet.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Remove from fleet" onClose={onClose}>
      <div className="space-y-4">
        <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-900">
            Removing is blocked while the driver is on a live trip — release or finish the assignment first.
          </p>
        </div>
        <div>
          <p className="text-base font-bold text-gray-900">
            Remove {nameOf(row) ?? 'this driver'} from your fleet?
          </p>
          <p className="mt-1 text-sm text-gray-500">Their past trips and records are kept.</p>
        </div>
        {err && <ErrorNote message={err} />}
        {hint && <p className="text-xs text-gray-500">{hint}</p>}
        <div className="grid grid-cols-2 gap-3 pt-1">
          <button type="button" onClick={onClose} className={BTN_SECONDARY}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy}
            className={cx(BTN_SECONDARY, 'bg-red-600 border-red-600 text-[#fff] hover:bg-red-700 hover:border-red-700')}
          >
            {busy ? 'Removing…' : 'Remove driver'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
