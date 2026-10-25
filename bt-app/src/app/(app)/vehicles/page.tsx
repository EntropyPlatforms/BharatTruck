'use client'

// Trucks — the asset register.
//
// One row per truck, joined to the per-asset analytics run so the owner can see
// "does this thing pay for itself" without opening it. The join is by vehicle_id
// and is deliberately tolerant: analytics is a SEPARATE call that can fail or
// come back short, and a missing row must read as '—', never as a crash or a
// fabricated zero.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import Link from 'next/link'
import {
  AlertCircle, CheckCircle2, ChevronRight, FileText, FileUp, Gauge, Info, Plus, Search, Truck, Upload,
} from 'lucide-react'

import { PageHeader } from '@/components/app-shell'
import {
  Card, CoverPill, Empty, ErrorNote, IconTile, Loading, Stat, WarnBanner,
} from '@/components/stat'
import { ChipGroup, InlineMeter, TruckTile } from '@/components/fleet-core/bits'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  BTN_PRIMARY, BTN_SECONDARY, HINT, INPUT, INPUT_ERROR, LABEL, MONO, SELECT, cx,
} from '@/lib/ui'
import {
  ApiError, bulkImportVehicles, createVehicle, getMyFleet, getVehicleAnalytics,
  listModelCategories, listVehicles,
  type BulkImportFormat, type BulkImportResult,
} from '@/lib/api'
import { inrSigned, km, pct, shortDate, vehicleAge } from '@/lib/format'
import { useAuth } from '@/lib/auth'
import type { EmissionNorm, Period, Vehicle, VehicleAnalytics } from '@/lib/types'

// ── Allowed values ────────────────────────────────────────────
// body_type / axle_config are constrained values, not free text — these lists
// mirror bt-auth-service/src/routes/onboarding.ts and the seeded rows. A value
// outside them is a 400, so the form only ever offers these.

// Typed against EmissionNorm on purpose: if the union moves in types.ts, this
// list is a compile error rather than a select that offers a rejected value.
const EMISSION_NORMS: readonly EmissionNorm[] = ['BS4', 'BS6', 'BS6_PH2']
const BODY_TYPES = ['open', 'closed', 'container', 'flatbed', 'tanker', 'refrigerated'] as const
const AXLE_CONFIGS = ['4x2', '6x2', '6x4', '8x4', '10x2'] as const

/** Narrow a raw <select> value back to its literal union, or null if unknown. */
function oneOf<T extends string>(allowed: readonly T[], value: string): T | null {
  return (allowed as readonly string[]).includes(value) ? (value as T) : null
}

function normLabel(norm: string): string {
  return norm === 'BS6_PH2' ? 'BS6 Ph2' : norm
}

function messageOf(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong'
}

function toNumber(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

function toInt(raw: string): number | null {
  const n = toNumber(raw)
  return n === null ? null : Math.round(n)
}

/**
 * The model-category endpoint is typed as ModelCategory[] in the client but the
 * service returns the bare category names. Read both shapes rather than render
 * a list of blanks.
 */
function categoryName(entry: unknown): string | null {
  if (typeof entry === 'string') return entry.trim() || null
  if (entry !== null && typeof entry === 'object') {
    const value = (entry as Record<string, unknown>).model_category
    if (typeof value === 'string') return value.trim() || null
  }
  return null
}

// ── Add-truck form ────────────────────────────────────────────

type FormState = {
  rc_number: string
  maker_model: string
  model_category: string
  emission_norm: string
  manufacture_year: string
  capacity_tons: string
  volume_cuft: string
  body_type: string
  axle_config: string
  current_odometer_km: string
  rc_expiry: string
}

const EMPTY_FORM: FormState = {
  rc_number: '', maker_model: '', model_category: '', emission_norm: '',
  manufacture_year: '', capacity_tons: '', volume_cuft: '', body_type: '',
  axle_config: '', current_odometer_km: '', rc_expiry: '',
}

const FIELD_KEYS: (keyof FormState)[] = [
  'rc_number', 'maker_model', 'model_category', 'emission_norm', 'manufacture_year',
  'capacity_tons', 'volume_cuft', 'body_type', 'axle_config', 'current_odometer_km', 'rc_expiry',
]

/**
 * The service returns only the FIRST failing field message ("rc_number must be
 * at least 4 characters"), with no field key. Recover the field from the message
 * so the error lands on the input the owner has to fix.
 */
function fieldForMessage(message: string): keyof FormState | null {
  const lower = message.toLowerCase()
  return FIELD_KEYS.find(key => lower.includes(key)) ?? null
}

const labelClass = LABEL
const inputClass = INPUT
const errorInputClass = INPUT_ERROR
const primaryBtn = BTN_PRIMARY
const secondaryBtn = BTN_SECONDARY

// ── Loading ───────────────────────────────────────────────────

type RegisterData = {
  vehicles: Vehicle[]
  analytics: VehicleAnalytics[]
  period: Period | null
  analyticsError: string | null
}

/**
 * Fetch, no state. Analytics is settled SEPARATELY from the vehicle list: the
 * register is the page and must render even when the economics report fails, so
 * a rejected analytics call degrades two columns instead of the whole screen.
 */
async function fetchRegister(): Promise<RegisterData> {
  const [vehicles, report] = await Promise.all([
    listVehicles(),
    getVehicleAnalytics().then(
      res => ({ ok: true as const, res }),
      (err: unknown) => ({ ok: false as const, err }),
    ),
  ])
  return report.ok
    ? {
        vehicles,
        analytics: report.res.vehicles,
        period: report.res.period,
        analyticsError: null,
      }
    : {
        vehicles,
        analytics: [],
        period: null,
        analyticsError: messageOf(report.err),
      }
}

// ── Page ──────────────────────────────────────────────────────

export default function VehiclesPage() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [analytics, setAnalytics] = useState<VehicleAnalytics[]>([])
  const [period, setPeriod] = useState<Period | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [analyticsError, setAnalyticsError] = useState<string | null>(null)

  const [categoryRows, setCategoryRows] = useState<unknown[]>([])

  const [query, setQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')

  const [addOpen, setAddOpen] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)

  // GST gate (2026-09-30): adding a truck needs a GSTIN on file — on the fleet profile or
  // on the owner's own account. The service enforces it (403 GSTIN_REQUIRED, see
  // bt-fleet-service/src/lib/vehicle-gate.ts); this is the same rule read up front so the
  // owner is sent to Settings before filling a form that would be refused. Only the OWNER
  // can read /fleet/owners/me — for delegated staff `fleetGstin` stays undefined and the
  // server's answer is the only gate, which is correct rather than blocking them blind.
  const { user, personas } = useAuth()
  const [fleetGstin, setFleetGstin] = useState<string | null | undefined>(undefined)
  const ownsFleet = Boolean(personas?.fleet_owner_id)
  useEffect(() => {
    if (!ownsFleet) return
    let live = true
    getMyFleet().then(
      owner => { if (live) setFleetGstin(owner.gstin ?? null) },
      () => { if (live) setFleetGstin(undefined) },
    )
    return () => { live = false }
  }, [ownsFleet])
  const gstMissing = ownsFleet && fleetGstin === null && !(user?.gstin ?? '').trim()

  const applyData = useCallback((data: RegisterData) => {
    setVehicles(data.vehicles)
    setAnalytics(data.analytics)
    setPeriod(data.period)
    setAnalyticsError(data.analyticsError)
    setError(null)
    setLoading(false)
  }, [])

  const applyError = useCallback((err: unknown) => {
    setError(messageOf(err))
    setLoading(false)
  }, [])

  useEffect(() => {
    let live = true
    fetchRegister().then(
      data => { if (live) applyData(data) },
      (err: unknown) => { if (live) applyError(err) },
    )
    // The owner can navigate away mid-flight; without this a late response sets
    // state on an unmounted page.
    return () => { live = false }
  }, [applyData, applyError])

  /**
   * Post-write reload. `loading` is deliberately NOT raised again — the table is
   * already correct enough to look at, so a create or import swaps the rows in
   * place under an "Updating" hint instead of blanking the page. A failure here
   * is reported ABOVE the table rather than through `error`, which would replace
   * a register the owner is mid-read with an error card.
   */
  const refresh = useCallback(async () => {
    setRefreshing(true)
    setRefreshError(null)
    try {
      applyData(await fetchRegister())
    } catch (err) {
      setRefreshError(messageOf(err))
    } finally {
      setRefreshing(false)
    }
  }, [applyData])

  useEffect(() => {
    listModelCategories().then(
      rows => setCategoryRows(rows),
      () => setCategoryRows([]),
    )
  }, [])

  const categories = useMemo(
    () => {
      const names = categoryRows
        .map(categoryName)
        .filter((name): name is string => name !== null)
      return [...new Set(names)].sort()
    },
    [categoryRows],
  )

  const analyticsById = useMemo(
    () => new Map(analytics.map((row): [string, VehicleAnalytics] => [row.vehicle_id, row])),
    [analytics],
  )

  // Filter options come from the fleet itself — offering a category with no
  // trucks behind it is a dead end.
  const fleetCategories = useMemo(() => {
    const names = vehicles
      .map(v => v.model_category)
      .filter((name): name is string => Boolean(name))
    return [...new Set(names)].sort()
  }, [vehicles])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return vehicles.filter(v => {
      if (categoryFilter && v.model_category !== categoryFilter) return false
      if (!q) return true
      return v.rc_number.toLowerCase().includes(q)
        || (v.maker_model ?? '').toLowerCase().includes(q)
    })
  }, [vehicles, query, categoryFilter])

  const coveredCount = useMemo(
    () => vehicles.filter(v => analyticsById.get(v.id)?.score.covered === true).length,
    [vehicles, analyticsById],
  )
  const shortCount = useMemo(
    () => vehicles.filter(v => analyticsById.get(v.id)?.score.covered === false).length,
    [vehicles, analyticsById],
  )
  const avgDistancePct = useMemo(() => {
    const values = vehicles
      .map(v => analyticsById.get(v.id)?.utilization.distance_pct)
      .filter((n): n is number => typeof n === 'number')
    if (values.length === 0) return null
    return values.reduce((sum, n) => sum + n, 0) / values.length
  }, [vehicles, analyticsById])

  const periodLabel = period ? `${shortDate(period.from)} – ${shortDate(period.to)}` : null

  const actionButtons = (
    <>
      <button type="button" className={secondaryBtn} onClick={() => setBulkOpen(true)} disabled={gstMissing}>
        <Upload className="w-4 h-4" />
        Bulk upload
      </button>
      <button type="button" className={primaryBtn} onClick={() => setAddOpen(true)} disabled={gstMissing}>
        <Plus className="w-4 h-4" />
        Add truck
      </button>
    </>
  )

  return (
    <div className="p-4 lg:p-8 max-w-[112rem] mx-auto">
      <PageHeader
        title="Trucks"
        subtitle="Every asset you own, and whether it clears its own EMI."
        actions={gstMissing ? undefined : actionButtons}
      />

      {gstMissing && (
        <div className="mb-5">
          <WarnBanner action={<div className="hidden md:flex items-center gap-2">{actionButtons}</div>}>
            <span className="font-semibold">GST registration needed before adding trucks.</span>{' '}
            Save your GSTIN in{' '}
            <Link href="/settings" className="underline font-semibold">Settings</Link>
            {' '}(company profile or your account) and come back. Trucks you already run are unaffected.
          </WarnBanner>
        </div>
      )}

      {loading ? (
        <Loading label="Loading trucks" />
      ) : error ? (
        <ErrorNote message={error} />
      ) : (
        <>
          {vehicles.length > 0 && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
              <Stat label="Trucks" value={vehicles.length} icon={<Truck />} tint="blue" />
              <Stat
                label="Clearing EMI"
                value={analyticsError ? '—' : coveredCount}
                tone={!analyticsError && coveredCount > 0 ? 'good' : 'neutral'}
                sub={periodLabel ?? undefined}
                icon={<CheckCircle2 />}
                tint="green"
              />
              <Stat
                label="Short"
                value={analyticsError ? '—' : shortCount}
                tone={!analyticsError && shortCount > 0 ? 'bad' : 'neutral'}
                sub={periodLabel ?? undefined}
                icon={<AlertCircle />}
                tint="red"
              />
              <Stat
                label="Avg distance use"
                value={pct(avgDistancePct)}
                sub={avgDistancePct === null ? 'Not enough data' : 'Against category norm'}
                icon={<Gauge />}
                tint="amber"
              />
            </div>
          )}

          {refreshError && (
            <div className="mb-4">
              <ErrorNote message={`Could not refresh the register — ${refreshError}. The rows below may be out of date.`} />
            </div>
          )}

          <Card>
            {/* Header: title on the left, search + category filter on the right (stacked on a phone). */}
            <div className="flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-4 px-5 py-4 border-b border-gray-100">
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <IconTile icon={<FileText />} tint="blue" />
                <div className="min-w-0">
                  <h2 className="text-base font-bold text-gray-900 inline-flex items-center gap-2">
                    Fleet register
                    {refreshing && (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-400">
                        <span className="w-3.5 h-3.5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                        Updating
                      </span>
                    )}
                  </h2>
                  {vehicles.length > 0 && (
                    <p className="text-sm text-gray-500 mt-0.5">
                      {`Showing ${filtered.length} of ${vehicles.length}${periodLabel ? ` · utilisation ${periodLabel}` : ''}`}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-2 lg:w-[30rem] shrink-0">
                <div className="relative flex-1 min-w-0">
                  <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="search"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder="Search RC number or make / model"
                    aria-label="Search trucks"
                    className={cx(INPUT, 'pl-9')}
                  />
                </div>
                <select
                  value={categoryFilter}
                  onChange={e => setCategoryFilter(e.target.value)}
                  aria-label="Filter by model category"
                  className={cx(SELECT, 'sm:w-48')}
                >
                  <option value="">All categories</option>
                  {fleetCategories.map(name => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </div>
            </div>

            {analyticsError && (
              <div className="px-4 pt-4">
                <WarnBanner>
                  Utilisation and EMI coverage could not be loaded ({analyticsError}). The register
                  below is complete; those two columns read as dashes until the report comes back.
                </WarnBanner>
              </div>
            )}

            {vehicles.length === 0 ? (
              <Empty
                icon={<Truck />}
                title="No trucks yet"
                hint={gstMissing
                  ? 'Save your GSTIN in Settings first — then add your first truck here.'
                  : 'Add your first truck, or bulk upload the register you already keep.'}
                action={gstMissing ? undefined : (
                  <div className="flex flex-wrap justify-center gap-2">
                    <button type="button" className={primaryBtn} onClick={() => setAddOpen(true)}>
                      <Plus className="w-4 h-4" />
                      Add truck
                    </button>
                    <button type="button" className={secondaryBtn} onClick={() => setBulkOpen(true)}>
                      <Upload className="w-4 h-4" />
                      Bulk upload
                    </button>
                  </div>
                )}
              />
            ) : filtered.length === 0 ? (
              <Empty
                icon={<Search />}
                title="No trucks match"
                hint="Clear the search box or pick a different category."
              />
            ) : (
              <>
                {/* Phone: one card per truck. */}
                <ul className="md:hidden divide-y divide-gray-100">
                  {filtered.map(v => {
                    const row = analyticsById.get(v.id)
                    const age = vehicleAge(v.manufacture_year)
                    return (
                      <li key={v.id}>
                        <Link
                          href={`/vehicles/${v.id}`}
                          className="flex gap-3 px-4 py-3.5 hover:bg-gray-50 focus-visible:outline-none focus-visible:bg-blue-50"
                        >
                          <TruckTile />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className={cx(MONO, 'text-[0.9375rem] font-semibold text-blue-600')}>{v.rc_number}</span>
                              {row && <CoverPill covered={row.score.covered} />}
                              <ChevronRight className="w-4 h-4 text-gray-400 ml-auto shrink-0" />
                            </div>
                            <p className="text-sm text-gray-700 mt-0.5 truncate">
                              {[v.maker_model, v.emission_norm ? normLabel(v.emission_norm) : null].filter(Boolean).join(' · ') || '—'}
                            </p>
                            <p className="text-xs text-gray-500 truncate">
                              {[v.model_category, age === null ? null : `${age} yr`].filter(Boolean).join(' · ') || '—'}
                            </p>
                            {row && (
                              <div className="mt-2 flex items-center gap-2">
                                <InlineMeter pct={row.utilization.distance_pct} className="flex-1" />
                                <span className="text-xs text-gray-500 tabular-nums shrink-0">
                                  {Math.round(row.utilization.distance_km).toLocaleString('en-IN')}
                                  {row.utilization.expected_distance_km !== null
                                    ? ` / ${km(row.utilization.expected_distance_km)}`
                                    : ' km'}
                                </span>
                              </div>
                            )}
                          </div>
                        </Link>
                      </li>
                    )
                  })}
                </ul>

                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full min-w-[1060px]">
                    <thead>
                      <tr className="text-[0.8125rem] text-gray-500 border-b border-gray-100 bg-gray-50/60">
                        <th className="py-3 pl-4 pr-1 w-16"><span className="sr-only">Truck</span></th>
                        <th className="py-3 px-2 text-left font-medium whitespace-nowrap">RC number</th>
                        <th className="py-3 px-2 text-left font-medium whitespace-nowrap">Make / model</th>
                        <th className="py-3 px-2 text-left font-medium">Category</th>
                        <th className="py-3 px-2 text-left font-medium">Norm</th>
                        <th className="py-3 px-2 text-right font-medium">Age</th>
                        <th className="py-3 px-2 text-right font-medium">Capacity</th>
                        <th className="py-3 px-2 text-right font-medium">Odometer</th>
                        <th className="py-3 px-2 text-left font-medium whitespace-nowrap">Distance use</th>
                        <th className="py-3 px-2 text-left font-medium">EMI</th>
                        <th className="py-3 pr-3 w-8"><span className="sr-only">Open</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map(v => {
                        const row = analyticsById.get(v.id)
                        const age = vehicleAge(v.manufacture_year)
                        return (
                          <tr key={v.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50 transition-colors">
                            <td className="py-3 pl-4 pr-1"><TruckTile /></td>
                            <td className="py-3 px-2 text-sm">
                              <Link
                                href={`/vehicles/${v.id}`}
                                className={cx(MONO, 'font-semibold text-blue-600 hover:text-blue-700 underline underline-offset-2 decoration-blue-300')}
                              >
                                {v.rc_number}
                              </Link>
                            </td>
                            <td className="py-3 px-2 text-sm text-gray-900 min-w-[8.5rem]">
                              {v.maker_model ?? <span className="text-gray-400">—</span>}
                            </td>
                            <td className="py-3 px-2 text-sm text-gray-700 whitespace-nowrap">
                              {v.model_category ?? <span className="text-gray-400">—</span>}
                            </td>
                            <td className="py-3 px-2 text-sm">
                              {v.emission_norm ? (
                                <span className="inline-flex items-center rounded-md border border-gray-200 bg-white px-1.5 py-0.5 text-xs font-semibold text-gray-700 whitespace-nowrap">
                                  {normLabel(v.emission_norm)}
                                </span>
                              ) : (
                                <span className="text-gray-400">—</span>
                              )}
                            </td>
                            <td className="py-3 px-2 text-sm text-right text-gray-900 tabular-nums whitespace-nowrap">
                              {age === null ? <span className="text-gray-400">—</span> : `${age} yr`}
                            </td>
                            <td className="py-3 px-2 text-sm text-right text-gray-900 tabular-nums whitespace-nowrap">
                              {v.capacity_tons === null
                                ? <span className="text-gray-400">—</span>
                                : `${v.capacity_tons.toFixed(1)} t`}
                            </td>
                            <td className="py-3 px-2 text-sm text-right text-gray-900 tabular-nums whitespace-nowrap">
                              {v.current_odometer_km === null
                                ? <span className="text-gray-400">—</span>
                                : km(v.current_odometer_km)}
                            </td>
                            <td className="py-3 px-2 text-sm">
                              {row ? (
                                <InlineMeter
                                  className="w-28"
                                  pct={row.utilization.distance_pct}
                                  caption={row.utilization.expected_distance_km !== null
                                    ? `${Math.round(row.utilization.distance_km).toLocaleString('en-IN')} / ${km(row.utilization.expected_distance_km)}`
                                    : km(row.utilization.distance_km)}
                                />
                              ) : (
                                <span className="text-gray-400">—</span>
                              )}
                            </td>
                            <td className="py-3 px-2 text-sm">
                              {row ? (
                                <div className="flex items-center gap-2 whitespace-nowrap">
                                  <CoverPill covered={row.score.covered} />
                                  <span className={`text-sm font-semibold tabular-nums ${
                                    row.score.surplus_inr >= 0 ? 'text-emerald-700' : 'text-red-600'
                                  }`}>
                                    {inrSigned(row.score.surplus_inr)}
                                  </span>
                                </div>
                              ) : (
                                <span className="text-gray-400">—</span>
                              )}
                            </td>
                            <td className="py-3 pr-3">
                              <Link
                                href={`/vehicles/${v.id}`}
                                aria-label={`Open ${v.rc_number}`}
                                className="inline-flex w-8 h-8 items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                              >
                                <ChevronRight className="w-4 h-4" />
                              </Link>
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
        </>
      )}

      <AddTruckDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        categories={categories}
        onCreated={() => { setAddOpen(false); void refresh() }}
      />

      <BulkUploadDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        onImported={() => { void refresh() }}
      />
    </div>
  )
}

// ── Add truck ─────────────────────────────────────────────────

function AddTruckDialog({
  open, onOpenChange, categories, onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  categories: string[]
  onCreated: () => void
}) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [errorField, setErrorField] = useState<keyof FormState | null>(null)

  function set(key: keyof FormState, value: string) {
    setForm(prev => ({ ...prev, [key]: value }))
    if (errorField === key) setErrorField(null)
  }

  function reset() {
    setForm(EMPTY_FORM)
    setFormError(null)
    setErrorField(null)
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError(null)
    setErrorField(null)

    // model_category and manufacture_year are required by the service even though
    // the columns are nullable — without them the asset has no cost model.
    const body: Partial<Vehicle> = { rc_number: form.rc_number.trim() }

    const category = form.model_category.trim()
    if (category) body.model_category = category

    const year = toInt(form.manufacture_year)
    if (year !== null) body.manufacture_year = year

    const norm = oneOf(EMISSION_NORMS, form.emission_norm)
    if (norm !== null) body.emission_norm = norm

    const makerModel = form.maker_model.trim()
    if (makerModel) body.maker_model = makerModel

    const capacity = toNumber(form.capacity_tons)
    if (capacity !== null) body.capacity_tons = capacity

    const volume = toNumber(form.volume_cuft)
    if (volume !== null) body.volume_cuft = volume

    const odometer = toInt(form.current_odometer_km)
    if (odometer !== null) body.current_odometer_km = odometer

    // RC validity (YYYY-MM-DD). Without it the RC-expiry warning can never fire for this truck.
    if (/^\d{4}-\d{2}-\d{2}$/.test(form.rc_expiry)) body.rc_expiry = form.rc_expiry

    const bodyType = oneOf(BODY_TYPES, form.body_type)
    if (bodyType !== null) body.body_type = bodyType

    const axle = oneOf(AXLE_CONFIGS, form.axle_config)
    if (axle !== null) body.axle_config = axle

    setSubmitting(true)
    try {
      await createVehicle(body)
      reset()
      onCreated()
    } catch (err) {
      const message = messageOf(err)
      setFormError(message)
      setErrorField(fieldForMessage(message))
    } finally {
      setSubmitting(false)
    }
  }

  const cls = (key: keyof FormState) => (errorField === key ? errorInputClass : inputClass)

  const section = 'rounded-xl border border-gray-200 bg-gray-50/60 p-4'
  const sectionTitle = 'text-sm font-bold text-gray-900 mb-3'

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-3xl bg-white border border-gray-200 max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-lg font-bold">Add truck</DialogTitle>
          <DialogDescription>
            Category and year are required.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="grid gap-4">
          {formError && <ErrorNote message={formError} />}

          <div className="grid md:grid-cols-[1.35fr_1fr] gap-4 items-start">
            <div className="grid gap-4">
              <section className={section} aria-labelledby="add-identity">
                <h3 id="add-identity" className={sectionTitle}>1. Identity</h3>
                <div className="grid sm:grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="rc_number" className={labelClass}>RC number *</label>
                    <input
                      id="rc_number"
                      value={form.rc_number}
                      onChange={e => set('rc_number', e.target.value.toUpperCase())}
                      required
                      minLength={4}
                      maxLength={20}
                      placeholder="MH31CQ4512"
                      className={cx(cls('rc_number'), MONO)}
                    />
                    {errorField === 'rc_number' && formError && (
                      <p className="mt-1 text-xs text-red-600">{formError}</p>
                    )}
                  </div>
                  <div>
                    <label htmlFor="maker_model" className={labelClass}>Make / model</label>
                    <input
                      id="maker_model"
                      value={form.maker_model}
                      onChange={e => set('maker_model', e.target.value)}
                      maxLength={100}
                      placeholder="Tata Signa 4825.TK"
                      className={cls('maker_model')}
                    />
                  </div>
                </div>
              </section>

              <section className={section} aria-labelledby="add-cost">
                <h3 id="add-cost" className={sectionTitle}>2. Cost model</h3>
                <div className="grid gap-3">
                  <div>
                    <label htmlFor="model_category" className={labelClass}>Model category *</label>
                    {categories.length > 0 ? (
                      <select
                        id="model_category"
                        value={form.model_category}
                        onChange={e => set('model_category', e.target.value)}
                        required
                        className={cx(cls('model_category'), SELECT.replace(INPUT, ''))}
                      >
                        <option value="">Select a category</option>
                        {categories.map(name => (
                          <option key={name} value={name}>{name}</option>
                        ))}
                      </select>
                    ) : (
                      <>
                        <input
                          id="model_category"
                          value={form.model_category}
                          onChange={e => set('model_category', e.target.value)}
                          required
                          placeholder="HCV Cargo 42-48T"
                          className={cls('model_category')}
                        />
                        <p className={HINT}>
                          Category list unavailable — type the exact value or it&apos;s rejected.
                        </p>
                      </>
                    )}
                  </div>

                  <ChipGroup
                    id="emission_norm"
                    label="Emission norm"
                    value={form.emission_norm}
                    onChange={value => set('emission_norm', value)}
                    invalid={errorField === 'emission_norm'}
                    options={[
                      { value: '', label: 'Older than BS4' },
                      ...EMISSION_NORMS.map(norm => ({ value: norm, label: normLabel(norm) })),
                    ]}
                  />

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="manufacture_year" className={labelClass}>Year *</label>
                      <input
                        id="manufacture_year"
                        type="number"
                        inputMode="numeric"
                        min={1990}
                        max={2100}
                        step={1}
                        value={form.manufacture_year}
                        onChange={e => set('manufacture_year', e.target.value)}
                        required
                        placeholder="2023"
                        className={cls('manufacture_year')}
                      />
                    </div>
                    <div>
                      <label htmlFor="current_odometer_km" className={labelClass}>Odometer km</label>
                      <input
                        id="current_odometer_km"
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={5000000}
                        step={1}
                        value={form.current_odometer_km}
                        onChange={e => set('current_odometer_km', e.target.value)}
                        placeholder="214500"
                        className={cls('current_odometer_km')}
                      />
                    </div>
                    <div>
                      <label htmlFor="rc_expiry" className={labelClass}>RC valid until</label>
                      <input
                        id="rc_expiry"
                        type="date"
                        value={form.rc_expiry}
                        onChange={e => set('rc_expiry', e.target.value)}
                        className={cls('rc_expiry')}
                      />
                    </div>
                  </div>
                </div>
              </section>
            </div>

            <section className={section} aria-labelledby="add-body">
              <h3 id="add-body" className={sectionTitle}>3. Body</h3>
              <div className="grid gap-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="capacity_tons" className={labelClass}>Capacity (t)</label>
                    <input
                      id="capacity_tons"
                      type="number"
                      inputMode="decimal"
                      min={0.1}
                      max={100}
                      step="any"
                      value={form.capacity_tons}
                      onChange={e => set('capacity_tons', e.target.value)}
                      placeholder="45"
                      className={cls('capacity_tons')}
                    />
                  </div>
                  <div>
                    <label htmlFor="volume_cuft" className={labelClass}>Volume (cu ft)</label>
                    <input
                      id="volume_cuft"
                      type="number"
                      inputMode="decimal"
                      min={1}
                      max={100000}
                      step="any"
                      value={form.volume_cuft}
                      onChange={e => set('volume_cuft', e.target.value)}
                      placeholder="2048"
                      className={cls('volume_cuft')}
                    />
                  </div>
                </div>

                <ChipGroup
                  id="body_type"
                  label="Body type"
                  value={form.body_type}
                  onChange={value => set('body_type', value)}
                  invalid={errorField === 'body_type'}
                  options={[
                    { value: '', label: 'Not set' },
                    ...BODY_TYPES.map(type => ({ value: type, label: type.charAt(0).toUpperCase() + type.slice(1) })),
                  ]}
                />

                <ChipGroup
                  id="axle_config"
                  label="Axle config"
                  value={form.axle_config}
                  onChange={value => set('axle_config', value)}
                  invalid={errorField === 'axle_config'}
                  options={[
                    { value: '', label: 'Not set' },
                    ...AXLE_CONFIGS.map(config => ({ value: config, label: config })),
                  ]}
                />
              </div>
            </section>
          </div>

          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1">
            <button
              type="button"
              className={cx(secondaryBtn, 'sm:min-w-[8rem]')}
              onClick={() => handleOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </button>
            <button type="submit" className={cx(primaryBtn, 'sm:min-w-[9rem]')} disabled={submitting}>
              {submitting ? 'Adding…' : 'Add truck'}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── Bulk upload ───────────────────────────────────────────────

/** The /bulk route raises its body limit for OCR scans; base64 inflates a file ~33%, so cap the
 *  raw upload at ~10 MB (≈13 MB encoded, under the route's 15 MiB). A CSV register is tiny. */
const MAX_UPLOAD_BYTES = 10_000_000

/** File -> base64 with no `data:` prefix, for sending a PDF/image scan inside the JSON body. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const s = String(reader.result)
      const comma = s.indexOf(',')
      resolve(comma >= 0 ? s.slice(comma + 1) : s)
    }
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'))
    reader.readAsDataURL(file)
  })
}

function BulkUploadDialog({
  open, onOpenChange, onImported,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<BulkImportResult | null>(null)

  const fileName = file?.name ?? ''

  function reset() {
    setFile(null)
    setError(null)
    setResult(null)
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  /** Extension -> the service's `format` enum. Anything unrecognised is sent as csv so the
   *  server's own validation decides, rather than this component silently guessing. */
  function formatOf(name: string): BulkImportFormat {
    const ext = name.split('.').pop()?.toLowerCase()
    if (ext === 'xlsx' || ext === 'xls') return 'xlsx'
    if (ext === 'pdf') return 'pdf'
    if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp'
      || ext === 'tif' || ext === 'tiff' || ext === 'gif' || ext === 'bmp') return 'image'
    return 'csv'
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!file) return
    setError(null)
    setResult(null)

    // The file rides inside a JSON body and the service runs on Fastify's default
    // 1 MiB limit, so an oversized upload would come back as an opaque 413. Say it
    // here instead. A 500-row register is ~50 KB, so this is not a real ceiling.
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(
        `${fileName} is ${(file.size / 1_000_000).toFixed(1)} MB. Uploads are capped at about 10 MB `
        + '— export just the truck rows, or split the file.',
      )
      return
    }

    setSubmitting(true)
    try {
      // CSV is sent as text (that is what the importer parses). A PDF/image scan is sent as
      // base64 with its exact mime type for the OCR path; when OCR is not enabled the service
      // answers a clean 501, which we surface as-is rather than pretending it worked.
      const format = formatOf(file.name)
      const content = format === 'csv' ? await file.text() : await fileToBase64(file)
      const mimeType = format === 'csv' ? undefined : (file.type || undefined)
      const res = await bulkImportVehicles(format, content, mimeType)
      setResult(res)
      onImported()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl bg-white border border-gray-200 max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-lg font-bold">Bulk upload trucks</DialogTitle>
          <DialogDescription>
            Import your existing truck register.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 flex items-start gap-3">
          <span className="w-6 h-6 rounded-full bg-blue-600 text-[#fff] inline-flex items-center justify-center shrink-0">
            <Info className="w-4 h-4" />
          </span>
          <span className="pt-0.5">Upload a CSV, or a PDF / photo of your register — scans are read with OCR. (xlsx isn&apos;t supported — export to CSV.)</span>
        </div>

        <form onSubmit={submit} className="grid gap-4">
          <div>
            <label htmlFor="bulk_file" className="sr-only">Document</label>
            {/* The real file input covers the whole dashed zone (transparent), so clicking it opens
                the picker and dropping a file on it works natively — no extra handlers. */}
            <div className="relative rounded-xl border-2 border-dashed border-gray-300 bg-gray-50/60 hover:border-blue-400 hover:bg-blue-50/40 focus-within:border-blue-600 focus-within:ring-2 focus-within:ring-blue-100 transition-colors px-4 py-7 text-center">
              <input
                id="bulk_file"
                type="file"
                accept=".csv,.pdf,.xlsx,.png,.jpg,.jpeg,.webp,.tif,.tiff,image/*"
                onChange={e => {
                  setFile(e.target.files?.[0] ?? null)
                  setError(null)
                  setResult(null)
                }}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
              <span className="mx-auto mb-2 w-11 h-11 rounded-xl bg-white border border-gray-200 text-gray-600 inline-flex items-center justify-center" aria-hidden>
                <FileUp className="w-5 h-5" />
              </span>
              {fileName ? (
                <p className="text-sm font-semibold text-gray-900 break-all">{fileName}</p>
              ) : (
                <p className="text-sm font-semibold text-gray-900">
                  Drop a CSV, PDF or photo here, or <span className="text-blue-600">browse</span>
                </p>
              )}
              <p className="mt-1 text-xs text-gray-500">
                CSV, PDF or a photo — up to 500 rows; needs rc_number and model_category columns
                (a scan should show them as a table).
              </p>
            </div>
            {fileName && formatOf(fileName) === 'xlsx' && (
              <p className="mt-1.5 text-xs text-orange-700">
                {fileName} is a spreadsheet — export it to CSV first; xlsx isn&apos;t parsed.
              </p>
            )}
          </div>

          {error && <ErrorNote message={error} />}

          {result !== null && (
            <div className="grid gap-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="rounded-xl border border-gray-200 p-3.5 flex items-start gap-3">
                  <IconTile icon={<CheckCircle2 />} tint="green" size="sm" />
                  <div>
                    <div className="text-sm font-medium text-gray-600">Created</div>
                    <div className="text-2xl font-bold tabular-nums text-emerald-600 leading-tight">{result.imported}</div>
                    <div className="text-xs text-gray-500">Added to the register</div>
                  </div>
                </div>
                <div className="rounded-xl border border-gray-200 p-3.5 flex items-start gap-3">
                  <IconTile icon={<AlertCircle />} tint="amber" size="sm" />
                  <div>
                    <div className="text-sm font-medium text-gray-600">Skipped</div>
                    <div className="text-2xl font-bold tabular-nums text-amber-600 leading-tight">{result.skipped}</div>
                    <div className="text-xs text-gray-500">Rows not imported</div>
                  </div>
                </div>
                <div className="rounded-xl border border-gray-200 p-3.5 flex items-start gap-3">
                  <IconTile icon={<AlertCircle />} tint="red" size="sm" />
                  <div>
                    <div className="text-sm font-medium text-gray-600">Errors</div>
                    <div className="text-2xl font-bold tabular-nums text-red-600 leading-tight">{result.errors.length}</div>
                    <div className="text-xs text-gray-500">Reasons listed below</div>
                  </div>
                </div>
              </div>

              {result.errors.length > 0 && (
                <div className="rounded-xl border border-gray-200">
                  <p className="px-3.5 py-2.5 text-sm font-bold text-gray-900 border-b border-gray-100">
                    Errors ({result.errors.length})
                  </p>
                  <ul className="max-h-40 overflow-y-auto divide-y divide-gray-100">
                    {result.errors.map((rowError, index) => (
                      <li key={`${rowError.row}-${index}`} className="px-3.5 py-2 text-sm text-gray-800 flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-600" />
                        <span>
                          <span className="font-semibold">Row {rowError.row}</span>
                          {rowError.rc_number ? <> · <span className={MONO}>{rowError.rc_number}</span></> : ''} — {rowError.message}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {result.imported === 0 && result.errors.length === 0 && (
                <p className="text-xs text-gray-500 text-center">
                  Nothing was imported and nothing was reported as failing. Check that the sheet has
                  a header row and at least one truck under it.
                </p>
              )}

              {result.imported > 0 && (
                <WarnBanner>
                  Imported rows are already in the register behind this dialog. Review them before
                  trusting the economics — an import fills in only what the sheet carried.
                </WarnBanner>
              )}
            </div>
          )}

          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1">
            <button
              type="button"
              className={cx(secondaryBtn, 'sm:min-w-[8rem]')}
              onClick={() => handleOpenChange(false)}
              disabled={submitting}
            >
              {result === null ? 'Cancel' : 'Done'}
            </button>
            <button type="submit" className={cx(primaryBtn, 'sm:min-w-[9rem]')} disabled={submitting || !fileName}>
              {submitting ? 'Importing…' : 'Run import'}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
