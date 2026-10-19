'use client'

// Truck detail — the per-asset P&L, and the screen the whole console exists for.
//
// Everything on this page comes from two calls: GET /fleet/vehicles/:id (the
// record: finance, permits, corridors) and GET /fleet/analytics/vehicles/:id
// (the money: score, utilization, cost_breakdown_inr). No other fetches.

import { use, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import Link from 'next/link'
import {
  AlertCircle, ArrowLeft, BarChart3, Box, CheckCircle2, Coins, FileBadge, FileText, Landmark,
  PieChart, Plus, Weight, Route, ShieldCheck, Trash2, TrendingUp, Wallet, Wrench, X,
} from 'lucide-react'
import {
  ApiError, getOneVehicleAnalytics, getVehicle,
  setVehicleFinance, setVehicleLanes, setVehiclePermits,
} from '@/lib/api'
import type { CostBreakdown, Vehicle, VehicleFinance, VehicleLane, VehiclePermit } from '@/lib/types'
import { inr, inrCompact, km, pct, periodDays, shortDate, tons, vehicleAge, inrSigned } from '@/lib/format'
import { Card, CardHead, CoverPill, Empty, ErrorNote, IconTile, InfoDot, Loading } from '@/components/stat'
import { TruckTile, meterColour } from '@/components/fleet-core/bits'
import {
  BTN_BLUE, BTN_PRIMARY as UI_BTN_PRIMARY, BTN_SECONDARY as UI_BTN_SECONDARY, INPUT,
  LABEL as UI_LABEL, MONO, SEG_OFF, SEG_ON, SEG_WRAP, SELECT, TAB_OFF, TAB_ON, cx, pill,
} from '@/lib/ui'

const PERIODS = [30, 90, 180] as const
type PeriodDays = (typeof PERIODS)[number]

type VehicleDetail = Awaited<ReturnType<typeof getVehicle>>
type VehicleReport = Awaited<ReturnType<typeof getOneVehicleAnalytics>>

const FIELD = cx(INPUT, 'tabular-nums')
const FIELD_SELECT = SELECT
const LABEL = UI_LABEL
/** Small grey caption used above a read-only value (definition grids, tiles). */
const CAPTION = 'text-[0.8125rem] text-gray-500'
const BTN_PRIMARY = UI_BTN_PRIMARY
const BTN_SECONDARY = UI_BTN_SECONDARY
const BTN_LINK = BTN_BLUE

type Tab = 'performance' | 'finance'

// ?tab=finance opens the second tab. Read through useSyncExternalStore so the server
// render (no URL) and the first client render agree; nothing here subscribes to changes.
const noopSubscribe = () => () => {}
function readTabParam(): string | null {
  return new URLSearchParams(window.location.search).get('tab')
}

// ── Shape adapters ────────────────────────────────────────────
//
// Two places where the client types in src/lib/types.ts and what
// bt-fleet-service actually sends have drifted. Both are read defensively here
// rather than by editing the shared foundation files.

/**
 * GET /fleet/vehicles/:id (bt-fleet-service/src/routes/vehicles.ts) spreads the
 * vehicle row at the TOP level next to finance/permits/lanes, while api.ts types
 * it nested under `vehicle`. Accept either so the page is never blank.
 */
function readVehicle(detail: VehicleDetail): Vehicle | null {
  if (detail.vehicle) return detail.vehicle
  const flat = detail as unknown as Partial<Vehicle>
  return typeof flat.rc_number === 'string' ? (flat as Vehicle) : null
}

/**
 * analytics.ts costBreakdown() emits bare keys — fuel, def, tyres, driver_wage —
 * while the CostBreakdown type declares the *_inr suffixed form. Read both.
 */
function costOf(cb: CostBreakdown, primary: keyof CostBreakdown, wire: string): number {
  const rec = cb as unknown as Record<string, unknown>
  const value = rec[primary] ?? rec[wire]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

type CostLine = {
  label: string
  key: keyof CostBreakdown
  wire: string
  /** Toll and recorded "other" spend sit OUTSIDE modelled running cost. */
  outsideRunning?: boolean
}

const COST_LINES: CostLine[] = [
  { label: 'Fuel',        key: 'fuel_inr',        wire: 'fuel' },
  { label: 'DEF',         key: 'def_inr',         wire: 'def' },
  { label: 'Engine oil',  key: 'engine_oil_inr',  wire: 'engine_oil' },
  { label: 'Gear oil',    key: 'gear_oil_inr',    wire: 'gear_oil' },
  { label: 'Service',     key: 'service_inr',     wire: 'service' },
  { label: 'Tyres',       key: 'tyre_inr',        wire: 'tyres' },
  { label: 'Driver wage', key: 'driver_wage_inr', wire: 'driver_wage' },
  { label: 'Toll',        key: 'toll_inr',        wire: 'toll',  outsideRunning: true },
  { label: 'Other',       key: 'other_inr',       wire: 'other', outsideRunning: true },
]

// ── Small presentational helpers ──────────────────────────────

function Field({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0 bg-white px-4 py-3">
      <div className={CAPTION}>{label}</div>
      <div className={cx('mt-1 text-base font-semibold text-gray-900 tabular-nums truncate', mono && MONO)}>{value}</div>
    </div>
  )
}

function cuft(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return `${Math.round(n).toLocaleString('en-IN')} cu ft`
}

/** shortDate() drops the year, which an expiry or loan date needs. */
function longDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${shortDate(iso)} ${d.getFullYear()}`
}

/** Days from now — negative once the date is past. */
function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.ceil((t - Date.now()) / 86_400_000)
}

const PERMIT_LABELS: Record<VehiclePermit['permit_type'], string> = {
  national: 'National permit',
  state: 'State permit',
  contract_carriage: 'Contract carriage',
  goods: 'Goods permit',
}

// ── Modal ─────────────────────────────────────────────────────

function Modal({
  title, sub, onClose, children,
}: { title: string; sub?: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] overflow-y-auto">
      <div className="min-h-full flex items-start sm:items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className="bg-white rounded-2xl ring-1 ring-gray-200 shadow-2xl w-full max-w-2xl my-6"
        >
          <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-4 border-b border-gray-100">
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-gray-900">{title}</h2>
              {sub && <p className="text-sm text-gray-500 mt-0.5">{sub}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="w-9 h-9 -mr-2 -mt-1 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}

// ── Form value coercion ───────────────────────────────────────

function textOrNull(s: string): string | null {
  const t = s.trim()
  return t === '' ? null : t
}

function numOrNull(s: string): number | null {
  const t = s.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

function numOrZero(s: string): number {
  return numOrNull(s) ?? 0
}

function str(n: number | null | undefined): string {
  return n === null || n === undefined ? '' : String(n)
}

/** <input type="date"> wants yyyy-mm-dd; the column may come back as a timestamp. */
function dateInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}

// ── Finance dialog ────────────────────────────────────────────

type FinanceForm = {
  lender: string
  loan_account_no: string
  principal_inr: string
  emi_amount_inr: string
  emi_day_of_month: string
  tenure_months: string
  interest_rate_pct: string
  start_date: string
  end_date: string
  outstanding_inr: string
  insurance_annual_inr: string
  permit_annual_inr: string
  fitness_annual_inr: string
}

function financeForm(f: VehicleFinance | null): FinanceForm {
  return {
    lender: f?.lender ?? '',
    loan_account_no: f?.loan_account_no ?? '',
    principal_inr: str(f?.principal_inr),
    emi_amount_inr: str(f?.emi_amount_inr ?? 0),
    emi_day_of_month: str(f?.emi_day_of_month),
    tenure_months: str(f?.tenure_months),
    interest_rate_pct: str(f?.interest_rate_pct),
    start_date: dateInput(f?.start_date),
    end_date: dateInput(f?.end_date),
    outstanding_inr: str(f?.outstanding_inr),
    insurance_annual_inr: str(f?.insurance_annual_inr ?? 0),
    permit_annual_inr: str(f?.permit_annual_inr ?? 0),
    fitness_annual_inr: str(f?.fitness_annual_inr ?? 0),
  }
}

/** Mirrors FinanceBody in bt-fleet-service/src/routes/vehicles.ts. */
function validateFinance(f: FinanceForm): string | null {
  const emi = numOrNull(f.emi_amount_inr)
  if (emi === null) return 'EMI is required — enter 0 for a truck with no loan'
  if (emi < 0 || emi > 10_000_000) return 'EMI must be between ₹0 and ₹1,00,00,000'

  const principal = numOrNull(f.principal_inr)
  if (principal !== null && (principal <= 0 || principal > 100_000_000)) {
    return 'Principal must be greater than 0 (leave blank if unknown)'
  }
  const day = numOrNull(f.emi_day_of_month)
  if (day !== null && (!Number.isInteger(day) || day < 1 || day > 31)) {
    return 'EMI day must be a whole number between 1 and 31'
  }
  const tenure = numOrNull(f.tenure_months)
  if (tenure !== null && (!Number.isInteger(tenure) || tenure <= 0 || tenure > 600)) {
    return 'Tenure must be a whole number of months between 1 and 600'
  }
  const rate = numOrNull(f.interest_rate_pct)
  if (rate !== null && (rate < 0 || rate > 100)) return 'Interest rate must be between 0 and 100'

  const outstanding = numOrNull(f.outstanding_inr)
  if (outstanding !== null && (outstanding < 0 || outstanding > 100_000_000)) {
    return 'Outstanding cannot be negative'
  }
  for (const [label, value] of [
    ['Insurance', numOrZero(f.insurance_annual_inr)],
    ['Permit', numOrZero(f.permit_annual_inr)],
    ['Fitness', numOrZero(f.fitness_annual_inr)],
  ] as const) {
    if (value < 0 || value > 10_000_000) return `${label} annual cost is out of range`
  }
  return null
}

function FinanceDialog({
  vehicleId, finance, onClose, onSaved,
}: {
  vehicleId: string
  finance: VehicleFinance | null
  onClose: () => void
  onSaved: (saved: VehicleFinance) => void
}) {
  const [form, setForm] = useState<FinanceForm>(() => financeForm(finance))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function set(key: keyof FinanceForm, value: string) {
    setForm(prev => {
      const next: FinanceForm = { ...prev }
      next[key] = value
      return next
    })
  }

  async function submit() {
    const invalid = validateFinance(form)
    if (invalid) { setError(invalid); return }
    setSaving(true)
    setError(null)
    try {
      const saved = await setVehicleFinance(vehicleId, {
        lender: textOrNull(form.lender),
        loan_account_no: textOrNull(form.loan_account_no),
        principal_inr: numOrNull(form.principal_inr),
        emi_amount_inr: numOrZero(form.emi_amount_inr),
        emi_day_of_month: numOrNull(form.emi_day_of_month),
        tenure_months: numOrNull(form.tenure_months),
        interest_rate_pct: numOrNull(form.interest_rate_pct),
        start_date: textOrNull(form.start_date),
        end_date: textOrNull(form.end_date),
        outstanding_inr: numOrNull(form.outstanding_inr),
        insurance_annual_inr: numOrZero(form.insurance_annual_inr),
        permit_annual_inr: numOrZero(form.permit_annual_inr),
        fitness_annual_inr: numOrZero(form.fitness_annual_inr),
      })
      onSaved(saved)
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'Could not save finance')
      setSaving(false)
    }
  }

  const text = (label: string, key: keyof FinanceForm, placeholder?: string, mono = false) => (
    <div>
      <label className={LABEL} htmlFor={`fin-${key}`}>{label}</label>
      <input
        id={`fin-${key}`}
        className={cx(FIELD, mono && MONO)}
        value={form[key]}
        placeholder={placeholder}
        onChange={e => set(key, e.target.value)}
      />
    </div>
  )
  const num = (label: string, key: keyof FinanceForm, step = '1', hint?: string) => (
    <div>
      <label className={LABEL} htmlFor={`fin-${key}`}>{label}</label>
      <input
        id={`fin-${key}`}
        type="number"
        step={step}
        className={FIELD}
        value={form[key]}
        onChange={e => set(key, e.target.value)}
      />
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  )
  const date = (label: string, key: keyof FinanceForm) => (
    <div>
      <label className={LABEL} htmlFor={`fin-${key}`}>{label}</label>
      <input
        id={`fin-${key}`}
        type="date"
        className={FIELD}
        value={form[key]}
        onChange={e => set(key, e.target.value)}
      />
    </div>
  )

  return (
    <Modal
      title="Edit finance"
      sub="Update the loan and carrying cost details for this truck."
      onClose={onClose}
    >
      <div className="px-6 py-5 space-y-5">
        {error && <ErrorNote message={error} />}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
          {text('Lender', 'lender', 'e.g. Shriram Finance')}
          {text('Loan account no', 'loan_account_no', undefined, true)}
          {num('EMI (₹ / month)', 'emi_amount_inr', '1', 'Enter 0 for a truck with no loan.')}
          {num('EMI day of month', 'emi_day_of_month')}
          {num('Principal (₹)', 'principal_inr')}
          {num('Outstanding (₹)', 'outstanding_inr')}
          {num('Interest rate (%)', 'interest_rate_pct', '0.01')}
          {num('Tenure (months)', 'tenure_months')}
          {date('Start date', 'start_date')}
          {date('End date', 'end_date')}
        </div>

        <div className="border-t border-gray-100 pt-4">
          <p className="text-sm font-bold text-gray-900 inline-flex items-center gap-1.5">
            Annual carrying costs
            <InfoDot text="Charged monthly, one-twelfth each, alongside the EMI" />
            <span className="hidden sm:inline text-xs font-normal text-gray-500">Charged monthly, one-twelfth each, alongside the EMI.</span>
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3 rounded-xl border border-gray-200 bg-gray-50/60 p-3">
            {num('Insurance (₹ / yr)', 'insurance_annual_inr')}
            {num('Permit (₹ / yr)', 'permit_annual_inr')}
            {num('Fitness (₹ / yr)', 'fitness_annual_inr')}
          </div>
        </div>
      </div>

      <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 px-6 py-4 border-t border-gray-100">
        <button type="button" className={cx(BTN_SECONDARY, 'sm:min-w-[7rem]')} onClick={onClose} disabled={saving}>Cancel</button>
        <button type="button" className={cx(BTN_PRIMARY, 'sm:min-w-[8rem]')} onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Save finance'}
        </button>
      </div>
    </Modal>
  )
}

// ── Permits dialog ────────────────────────────────────────────

type PermitForm = {
  permit_type: VehiclePermit['permit_type']
  allowed_states: string
  permit_number: string
  issued_on: string
  expiry_date: string
  is_active: boolean
}

function permitForms(permits: VehiclePermit[]): PermitForm[] {
  return permits.map(p => ({
    permit_type: p.permit_type,
    allowed_states: (p.allowed_states ?? []).join(', '),
    permit_number: p.permit_number ?? '',
    issued_on: dateInput(p.issued_on),
    expiry_date: dateInput(p.expiry_date),
    is_active: p.is_active,
  }))
}

function parseStates(raw: string): string[] {
  return raw.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean)
}

function PermitsDialog({
  vehicleId, permits, onClose, onSaved,
}: {
  vehicleId: string
  permits: VehiclePermit[]
  onClose: () => void
  onSaved: (saved: VehiclePermit[]) => void
}) {
  const [rows, setRows] = useState<PermitForm[]>(() => permitForms(permits))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function patch(index: number, next: Partial<PermitForm>) {
    setRows(prev => prev.map((row, i) => (i === index ? { ...row, ...next } : row)))
  }

  async function submit() {
    for (const row of rows) {
      const states = parseStates(row.allowed_states)
      if (states.some(s => s.length > 5)) {
        setError('State codes are at most 5 characters — use codes like MH, KA, TN')
        return
      }
      if (states.length > 40) { setError('At most 40 states per permit'); return }
      if (row.permit_type === 'state' && states.length === 0) {
        setError('A state permit needs at least one state code')
        return
      }
    }
    setSaving(true)
    setError(null)
    try {
      const saved = await setVehiclePermits(vehicleId, rows.map(row => ({
        permit_type: row.permit_type,
        allowed_states: parseStates(row.allowed_states),
        permit_number: textOrNull(row.permit_number),
        issued_on: textOrNull(row.issued_on),
        expiry_date: textOrNull(row.expiry_date),
        is_active: row.is_active,
      })))
      onSaved(saved)
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'Could not save permits')
      setSaving(false)
    }
  }

  return (
    <Modal
      title="Edit permits"
      sub="Add or update permit details."
      onClose={onClose}
    >
      <div className="px-6 py-5 space-y-3">
        {error && <ErrorNote message={error} />}

        {rows.length === 0 && (
          <Empty title="No permits on this truck" hint="Add one to record where it is allowed to run." />
        )}

        {rows.map((row, i) => (
          <div key={i} className="rounded-xl border border-gray-200 bg-gray-50/60 p-4">
            <div className="flex items-center justify-between gap-2 mb-3">
              <span className="text-sm font-bold text-gray-900">Permit {i + 1}</span>
              <button
                type="button"
                aria-label={`Remove permit ${i + 1}`}
                className="w-9 h-9 -m-1.5 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                onClick={() => setRows(prev => prev.filter((_, idx) => idx !== i))}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className={LABEL} htmlFor={`permit-type-${i}`}>Type</label>
                <select
                  id={`permit-type-${i}`}
                  className={FIELD_SELECT}
                  value={row.permit_type}
                  onChange={e => patch(i, { permit_type: e.target.value as VehiclePermit['permit_type'] })}
                >
                  {(Object.keys(PERMIT_LABELS) as VehiclePermit['permit_type'][]).map(t => (
                    <option key={t} value={t}>{PERMIT_LABELS[t]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={LABEL} htmlFor={`permit-no-${i}`}>Permit number</label>
                <input
                  id={`permit-no-${i}`}
                  className={cx(FIELD, MONO)}
                  value={row.permit_number}
                  onChange={e => patch(i, { permit_number: e.target.value })}
                />
              </div>
              <div className="sm:col-span-2">
                <label className={LABEL} htmlFor={`permit-states-${i}`}>Allowed states</label>
                <input
                  id={`permit-states-${i}`}
                  className={FIELD}
                  placeholder="MH, KA, TN — leave blank for a national permit"
                  value={row.allowed_states}
                  onChange={e => patch(i, { allowed_states: e.target.value })}
                />
              </div>
              <div>
                <label className={LABEL} htmlFor={`permit-issued-${i}`}>Issued on</label>
                <input
                  id={`permit-issued-${i}`}
                  type="date"
                  className={FIELD}
                  value={row.issued_on}
                  onChange={e => patch(i, { issued_on: e.target.value })}
                />
              </div>
              <div>
                <label className={LABEL} htmlFor={`permit-expiry-${i}`}>Expiry</label>
                <input
                  id={`permit-expiry-${i}`}
                  type="date"
                  className={FIELD}
                  value={row.expiry_date}
                  onChange={e => patch(i, { expiry_date: e.target.value })}
                />
              </div>
              <label className="flex items-center gap-2.5 text-sm font-medium text-gray-700 sm:col-span-2 min-h-[36px]">
                <input
                  type="checkbox"
                  className="w-4 h-4 rounded border-gray-300 accent-blue-600"
                  checked={row.is_active}
                  onChange={e => patch(i, { is_active: e.target.checked })}
                />
                Active
              </label>
            </div>
          </div>
        ))}

        {rows.length < 20 && (
          <button
            type="button"
            className={BTN_LINK}
            onClick={() => setRows(prev => [...prev, {
              permit_type: 'national', allowed_states: '', permit_number: '',
              issued_on: '', expiry_date: '', is_active: true,
            }])}
          >
            <span className="inline-flex items-center gap-1.5"><Plus className="w-4 h-4" /> Add permit</span>
          </button>
        )}
      </div>

      <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 px-6 py-4 border-t border-gray-100">
        <button type="button" className={cx(BTN_SECONDARY, 'sm:min-w-[7rem]')} onClick={onClose} disabled={saving}>Cancel</button>
        <button type="button" className={BTN_PRIMARY} onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Save permits'}
        </button>
      </div>
    </Modal>
  )
}

// ── Corridors dialog ──────────────────────────────────────────

type LaneForm = {
  origin_city: string
  destination_city: string
  typical_distance_km: string
  is_primary: boolean
  // Carried through untouched — PUT replaces the row set, so dropping the
  // coordinates here would quietly erase them.
  origin_lat: number | null
  origin_lng: number | null
  dest_lat: number | null
  dest_lng: number | null
}

function laneForms(lanes: VehicleLane[]): LaneForm[] {
  return lanes.map(l => ({
    origin_city: l.origin_city,
    destination_city: l.destination_city,
    typical_distance_km: str(l.typical_distance_km),
    is_primary: l.is_primary,
    origin_lat: l.origin_lat,
    origin_lng: l.origin_lng,
    dest_lat: l.dest_lat,
    dest_lng: l.dest_lng,
  }))
}

function LanesDialog({
  vehicleId, lanes, onClose, onSaved,
}: {
  vehicleId: string
  lanes: VehicleLane[]
  onClose: () => void
  onSaved: (saved: VehicleLane[]) => void
}) {
  const [rows, setRows] = useState<LaneForm[]>(() => laneForms(lanes))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function patch(index: number, next: Partial<LaneForm>) {
    setRows(prev => prev.map((row, i) => (i === index ? { ...row, ...next } : row)))
  }

  // vehicle_lanes_one_primary is a DB constraint — only one row may be primary,
  // so selecting one clears the rest instead of erroring on save.
  function makePrimary(index: number) {
    setRows(prev => prev.map((row, i) => ({ ...row, is_primary: i === index })))
  }

  async function submit() {
    for (const row of rows) {
      if (!row.origin_city.trim() || !row.destination_city.trim()) {
        setError('Every corridor needs both an origin and a destination')
        return
      }
      const distance = numOrNull(row.typical_distance_km)
      if (distance !== null && (distance <= 0 || distance > 10_000)) {
        setError('Typical distance must be between 1 and 10,000 km')
        return
      }
    }
    setSaving(true)
    setError(null)
    try {
      const saved = await setVehicleLanes(vehicleId, rows.map(row => ({
        origin_city: row.origin_city.trim(),
        destination_city: row.destination_city.trim(),
        typical_distance_km: numOrNull(row.typical_distance_km),
        is_primary: row.is_primary,
        origin_lat: row.origin_lat,
        origin_lng: row.origin_lng,
        dest_lat: row.dest_lat,
        dest_lng: row.dest_lng,
      })))
      onSaved(saved)
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'Could not save corridors')
      setSaving(false)
    }
  }

  return (
    <Modal
      title="Edit corridors"
      sub="Add or update the corridors this truck runs."
      onClose={onClose}
    >
      <div className="px-6 py-5 space-y-3">
        {error && <ErrorNote message={error} />}

        {rows.length === 0 && (
          <Empty title="No corridors yet" hint="Add the lanes this truck actually runs." />
        )}

        {rows.map((row, i) => (
          <div key={i} className="rounded-xl border border-gray-200 bg-gray-50/60 p-4">
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 min-w-0">
                <span className="text-sm font-bold text-gray-900">Corridor {i + 1}</span>
                <label className="flex items-center gap-2 text-sm font-medium text-gray-700 min-h-[32px]">
                  <input
                    type="radio"
                    name="primary-lane"
                    className="w-4 h-4 accent-blue-600"
                    checked={row.is_primary}
                    onChange={() => makePrimary(i)}
                  />
                  Primary corridor
                </label>
              </div>
              <button
                type="button"
                aria-label={`Remove corridor ${i + 1}`}
                className="w-9 h-9 -m-1.5 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                onClick={() => setRows(prev => prev.filter((_, idx) => idx !== i))}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className={LABEL} htmlFor={`lane-origin-${i}`}>Origin</label>
                <input
                  id={`lane-origin-${i}`}
                  className={FIELD}
                  value={row.origin_city}
                  onChange={e => patch(i, { origin_city: e.target.value })}
                />
              </div>
              <div>
                <label className={LABEL} htmlFor={`lane-dest-${i}`}>Destination</label>
                <input
                  id={`lane-dest-${i}`}
                  className={FIELD}
                  value={row.destination_city}
                  onChange={e => patch(i, { destination_city: e.target.value })}
                />
              </div>
              <div>
                <label className={LABEL} htmlFor={`lane-km-${i}`}>Typical distance (km)</label>
                <input
                  id={`lane-km-${i}`}
                  type="number"
                  className={FIELD}
                  value={row.typical_distance_km}
                  onChange={e => patch(i, { typical_distance_km: e.target.value })}
                />
              </div>
            </div>
          </div>
        ))}

        {rows.length < 20 && (
          <button
            type="button"
            className={BTN_LINK}
            onClick={() => setRows(prev => [...prev, {
              origin_city: '', destination_city: '', typical_distance_km: '',
              is_primary: prev.length === 0,
              origin_lat: null, origin_lng: null, dest_lat: null, dest_lng: null,
            }])}
          >
            <span className="inline-flex items-center gap-1.5"><Plus className="w-4 h-4" /> Add corridor</span>
          </button>
        )}
      </div>

      <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 px-6 py-4 border-t border-gray-100">
        <button type="button" className={cx(BTN_SECONDARY, 'sm:min-w-[7rem]')} onClick={onClose} disabled={saving}>Cancel</button>
        <button type="button" className={BTN_PRIMARY} onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Save corridors'}
        </button>
      </div>
    </Modal>
  )
}

// ── Page ──────────────────────────────────────────────────────

export default function VehicleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)

  const [days, setDays] = useState<PeriodDays>(30)
  const [detail, setDetail] = useState<VehicleDetail | null>(null)
  const [report, setReport] = useState<VehicleReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [editing, setEditing] = useState<'finance' | 'permits' | 'lanes' | null>(null)

  // The effect only kicks the requests off; every setState happens in a callback.
  // Flipping `loading`/`error` synchronously here would trip
  // react-hooks/set-state-in-effect, so whoever changes the inputs owns that
  // transition — same convention as the dashboard.
  useEffect(() => {
    let cancelled = false
    Promise.all([getVehicle(id), getOneVehicleAnalytics(id, periodDays(days))])
      .then(([nextDetail, nextReport]) => {
        if (cancelled) return
        setDetail(nextDetail)
        setReport(nextReport)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Could not load this truck')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id, days, reloadKey])

  const vehicle = detail ? readVehicle(detail) : null

  function reload() {
    setLoading(true)
    setError(null)
    setReloadKey(k => k + 1)
  }

  // Tabs are client state only. ?tab=finance opens the second one (read once, hydration-safe).
  const tabParam = useSyncExternalStore(noopSubscribe, readTabParam, () => null)
  const [pickedTab, setPickedTab] = useState<Tab | null>(null)
  const tab: Tab = pickedTab ?? (tabParam === 'finance' ? 'finance' : 'performance')

  const periodSwitcher = (
    <div className={cx(SEG_WRAP, 'w-full sm:w-auto')} role="group" aria-label="Reporting period">
      {PERIODS.map(d => (
        <button
          key={d}
          type="button"
          onClick={() => {
            if (d === days) return
            setLoading(true)
            setError(null)
            setDays(d)
          }}
          aria-pressed={days === d}
          className={cx(
            days === d ? SEG_ON : SEG_OFF,
            'flex-1 sm:flex-none sm:min-w-[64px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600',
          )}
        >
          {d}d
        </button>
      ))}
    </div>
  )

  const age = vehicle ? vehicleAge(vehicle.manufacture_year) : null
  const subtitle = vehicle
    ? [
        vehicle.maker_model,
        vehicle.model_category,
        vehicle.emission_norm?.replace('_', ' '),
        age === null ? null : age === 0 ? 'new this year' : `${age} yr old`,
      ].filter((part): part is string => Boolean(part)).join(' · ')
    : undefined

  const tabs: { key: Tab; label: string }[] = [
    { key: 'performance', label: 'Performance' },
    { key: 'finance', label: 'Finance & permits' },
  ]

  return (
    <div className="p-4 lg:p-8 max-w-[112rem] mx-auto">
      <Link
        href="/vehicles"
        className="inline-flex items-center gap-1.5 text-sm font-semibold text-blue-600 hover:text-blue-700 mb-4"
      >
        <ArrowLeft className="w-4 h-4" /> All trucks
      </Link>

      {/* Header: truck tile, RC number, the record line, period switch; tabs underneath. */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4 min-w-0">
          <span className="hidden sm:inline-flex"><TruckTile size="lg" /></span>
          <div className="min-w-0">
            <h1 className={cx(MONO, 'text-[1.75rem] sm:text-[2rem] leading-tight font-bold text-gray-900 truncate')}>
              {vehicle?.rc_number ?? 'Truck'}
            </h1>
            {subtitle && <p className="text-[0.9375rem] text-gray-500 mt-1">{subtitle}</p>}
          </div>
        </div>
        {/* The period only changes the Performance numbers. */}
        <div className={cx('w-full sm:w-auto', tab !== 'performance' && 'sm:invisible hidden sm:block')}>{periodSwitcher}</div>
      </div>

      <div className="mt-4 mb-6 border-b border-gray-200 flex gap-6 sm:pl-20" role="tablist" aria-label="Truck detail">
        {tabs.map(t => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls={`panel-${t.key}`}
            onClick={() => setPickedTab(t.key)}
            className={cx(tab === t.key ? TAB_ON : TAB_OFF, 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded-sm')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && !detail && <Loading label="Loading truck" />}
      {error && !detail && <ErrorNote message={error} />}
      {!loading && !error && detail && !vehicle && (
        <Card><Empty title="Truck not found" hint="It may have been removed, or it belongs to another fleet." /></Card>
      )}

      {detail && vehicle && (
        // Stale-while-revalidate: a period switch dims the last answer rather
        // than blanking the page.
        <div className={`space-y-5 transition-opacity ${loading ? 'opacity-60' : ''}`}>
          {error && <ErrorNote message={error} />}

          {tab === 'performance' ? (
            <div id="panel-performance" role="tabpanel" aria-labelledby="tab-performance" className="space-y-5">
              <VerdictCard report={report} days={days} loading={loading} />
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
                <UtilisationCard report={report} />
                <CostCard report={report} />
              </div>
            </div>
          ) : (
            <div id="panel-finance" role="tabpanel" aria-labelledby="tab-finance" className="space-y-5">
              <FinanceCard
                finance={detail.finance}
                onEdit={() => setEditing('finance')}
              />
              <PermitsCard
                permits={detail.permits ?? []}
                onEdit={() => setEditing('permits')}
              />
              <CorridorsCard lanes={detail.lanes ?? []} onEdit={() => setEditing('lanes')} />
            </div>
          )}
        </div>
      )}

      {editing === 'finance' && vehicle && (
        <FinanceDialog
          vehicleId={vehicle.id}
          finance={detail?.finance ?? null}
          onClose={() => setEditing(null)}
          onSaved={saved => {
            setDetail(prev => (prev ? { ...prev, finance: saved } : prev))
            setEditing(null)
            // EMI and the annual carrying costs change the verdict, so the score
            // has to be recomputed server-side.
            reload()
          }}
        />
      )}
      {editing === 'permits' && vehicle && (
        <PermitsDialog
          vehicleId={vehicle.id}
          permits={detail?.permits ?? []}
          onClose={() => setEditing(null)}
          onSaved={saved => {
            setDetail(prev => (prev ? { ...prev, permits: saved } : prev))
            setEditing(null)
          }}
        />
      )}
      {editing === 'lanes' && vehicle && (
        <LanesDialog
          vehicleId={vehicle.id}
          lanes={detail?.lanes ?? []}
          onClose={() => setEditing(null)}
          onSaved={saved => {
            setDetail(prev => (prev ? { ...prev, lanes: saved } : prev))
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

// ── 2. The verdict ────────────────────────────────────────────

function VerdictCard({
  report, days, loading,
}: { report: VehicleReport | null; days: PeriodDays; loading: boolean }) {
  if (!report) {
    return <Card>{loading ? <Loading label="Scoring this asset" /> : <Empty title="No P&L for this period" />}</Card>
  }

  const s = report.score
  const covered = s.covered
  const surplus = s.surplus_inr

  const verdict =
    report.trips === 0
      ? s.fixed_cost_inr > 0
        ? `No completed trips in this window, so ${inr(s.fixed_cost_inr)} of fixed cost was carried with nothing against it.`
        : 'No completed trips in this window, and no fixed cost is recorded against this truck.'
      : covered
        ? `This truck cleared its EMI by ${inr(Math.abs(surplus))} this period.`
        : `This truck fell ${inr(Math.abs(surplus))} short of its EMI this period.`

  // Stacked bar: the cost stack measured against revenue. The marker is where
  // revenue lands, so "does the bar clear the line" is the whole question. The
  // stack must be every line the surplus nets out — running, tolls/other, fixed —
  // or the bar and the number below it disagree.
  const stack = s.running_cost_inr + s.toll_other_inr + s.fixed_cost_inr
  const scale = Math.max(s.revenue_inr, stack, 1)
  const runW = Math.max(0, (s.running_cost_inr / scale) * 100)
  const tollW = Math.max(0, (s.toll_other_inr / scale) * 100)
  const fixedW = Math.max(0, (s.fixed_cost_inr / scale) * 100)
  // What is left of revenue once the stack is paid — the surplus, drawn only when positive.
  const surplusW = Math.max(0, ((s.revenue_inr - stack) / scale) * 100)
  const revMark = Math.min(100, Math.max(0, (s.revenue_inr / scale) * 100))

  const legend = [
    { label: 'Running cost', value: s.running_cost_inr, width: runW, dot: 'bg-gray-400' },
    { label: 'Tolls & other', value: s.toll_other_inr, width: tollW, dot: 'bg-violet-500' },
    { label: 'Fixed cost', value: s.fixed_cost_inr, width: fixedW, dot: 'bg-brand-500', info: 'EMI + carrying + overhead' },
    ...(surplusW > 0 ? [{ label: 'Surplus', value: s.revenue_inr - stack, width: surplusW, dot: 'bg-emerald-500' }] : []),
  ]

  const figures: { label: string; value: number; tone?: string; signed?: boolean }[] = [
    { label: 'Revenue', value: s.revenue_inr },
    { label: 'Running cost', value: s.running_cost_inr },
    { label: 'Gross margin', value: s.gross_margin_inr, tone: s.gross_margin_inr >= 0 ? 'text-emerald-600' : 'text-red-600', signed: true },
    { label: 'Tolls & other', value: s.toll_other_inr },
    { label: 'EMI', value: s.emi_inr },
    { label: 'Fixed cost', value: s.fixed_cost_inr },
    { label: 'Surplus', value: surplus, tone: covered ? 'text-emerald-600' : 'text-red-600', signed: true },
  ]

  return (
    <Card className={covered ? 'border-emerald-200' : 'border-red-200'}>
      <div className="px-5 sm:px-6 pt-5 pb-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4 min-w-0">
            <span className={cx(
              'w-12 h-12 rounded-full inline-flex items-center justify-center shrink-0',
              covered ? 'bg-emerald-500 text-[#fff]' : 'bg-red-500 text-[#fff]',
            )}>
              {covered ? <CheckCircle2 className="w-7 h-7" /> : <AlertCircle className="w-7 h-7" />}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <h2 className="text-lg font-bold text-gray-900 inline-flex items-center gap-1.5">
                  {covered ? 'Surplus' : 'Shortfall'} · last {days} days
                  <InfoDot text="Revenue less running cost, tolls & other actuals, EMI and pro-rated fixed costs" />
                </h2>
                <CoverPill covered={covered} />
              </div>
              <p className="text-sm text-gray-500 mt-0.5 hidden sm:block">
                Revenue less running cost, tolls &amp; other actuals, EMI and pro-rated fixed costs.
              </p>
              <div className={`mt-2 text-[2.125rem] leading-none font-extrabold tabular-nums tracking-tight ${
                covered ? 'text-emerald-600' : 'text-red-600'
              }`}>
                {inrSigned(surplus)}
              </div>
              <p className="mt-2 text-sm text-gray-700">{verdict}</p>
            </div>
          </div>
          <div className="text-sm text-gray-600 tabular-nums sm:text-right">
            <span className="font-semibold text-gray-900">{report.trips} {report.trips === 1 ? 'trip' : 'trips'}</span>
            {' · '}
            {shortDate(report.period.from)} – {shortDate(report.period.to)}
          </div>
        </div>

        <div className="mt-6 relative pt-7">
          {/* Where revenue lands, labelled above the bar. */}
          <div
            className="absolute top-0 -translate-x-1/2 whitespace-nowrap rounded-md bg-blue-600 px-2 py-0.5 text-xs font-semibold text-[#fff] tabular-nums"
            style={{ left: `clamp(3rem, ${revMark}%, calc(100% - 3rem))` }}
          >
            Revenue {inrCompact(s.revenue_inr)}
          </div>
          <div className="relative h-6 rounded-md bg-gray-100 overflow-hidden flex gap-px">
            <div className="h-6 bg-gray-400" style={{ width: `${runW}%` }} />
            <div className="h-6 bg-violet-500" style={{ width: `${tollW}%` }} />
            <div className="h-6 bg-brand-500" style={{ width: `${fixedW}%` }} />
            {surplusW > 0 && <div className="h-6 bg-emerald-500" style={{ width: `${surplusW}%` }} />}
          </div>
          {/* Does the cost stack clear the line? */}
          <div className="absolute bottom-[-6px] top-6 w-0.5 bg-blue-600" style={{ left: `calc(${revMark}% - 1px)` }} />
        </div>
        <div className="flex flex-wrap items-start gap-x-8 gap-y-2 mt-4">
          {legend.map(item => (
            <div key={item.label} className="flex items-start gap-2">
              <span className={cx('w-3 h-3 rounded-full mt-1 shrink-0', item.dot)} />
              <div className="text-sm leading-tight">
                <div className="text-gray-600 inline-flex items-center gap-1">
                  {item.label}
                  {item.info && <InfoDot text={item.info} />}
                </div>
                <div className="font-semibold text-gray-900 tabular-nums">
                  {inrCompact(item.value)} <span className="font-normal text-gray-500">({pct(item.width)})</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 border-t border-gray-100 bg-gray-50/50 rounded-b-xl">
        {figures.map((f, i) => (
          <div
            key={f.label}
            className={cx(
              'px-5 py-4 min-w-0 border-gray-100',
              i > 0 && 'xl:border-l',
              i % 2 === 1 && 'border-l sm:border-l-0',
              i % 4 !== 0 && 'sm:border-l',
              i >= 2 && 'border-t sm:border-t-0',
              i >= 4 && 'sm:border-t xl:border-t-0',
            )}
          >
            <div className={CAPTION}>{f.label}</div>
            <div className={cx('mt-1 text-xl font-bold tabular-nums truncate', f.tone ?? 'text-gray-900')}>
              {f.signed ? inrSigned(f.value) : inr(f.value)}
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

// ── 3. Utilisation ────────────────────────────────────────────

function UtilRow({
  icon, tint, label, value, rest, pctValue,
}: { icon: ReactNode; tint: 'blue' | 'violet' | 'teal'; label: string; value: string; rest: string; pctValue: number | null }) {
  const known = pctValue !== null && !Number.isNaN(pctValue)
  const clamped = known ? Math.max(0, Math.min(100, pctValue as number)) : 0
  return (
    <div className="rounded-xl border border-gray-200 p-4 flex items-center gap-4">
      <IconTile icon={icon} tint={tint} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-medium text-gray-600">{label}</span>
          <span className="text-base font-bold text-gray-900 tabular-nums">{known ? `${clamped.toFixed(0)}%` : '—'}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="text-sm text-gray-500 tabular-nums">
            <span className="text-xl font-bold text-gray-900 mr-1.5">{value}</span>
            {rest}
          </div>
          <div className="flex-1 min-w-[8rem] h-2 rounded-full bg-gray-100 overflow-hidden">
            {known
              ? <div className={cx('h-2 rounded-full', meterColour(clamped))} style={{ width: `${clamped}%` }} />
              : null}
          </div>
        </div>
        {!known && <p className="mt-1 text-xs text-gray-400">Not enough data</p>}
      </div>
    </div>
  )
}

function UtilisationCard({ report }: { report: VehicleReport | null }) {
  if (!report) return null
  const u = report.utilization

  return (
    <Card>
      <CardHead
        icon={<BarChart3 />}
        tint="blue"
        title="Utilisation"
        sub="How full it ran, and how hard it was worked"
        info="Tonnage, volume and distance are measured independently"
      />
      {report.trips === 0 ? (
        <Empty
          icon={<FileText />}
          title="No completed trips in this window"
          hint="Widen the period, or check that trips have been marked paid."
        />
      ) : (
        <div className="p-4 sm:p-5 space-y-3">
          <UtilRow
            icon={<Weight />}
            tint="blue"
            label="Tonnage"
            pctValue={u.tonnage_pct}
            value={tons(u.laden_weight_kg)}
            rest={`laden of ${tons(u.capacity_kg)} capacity`}
          />
          <UtilRow
            icon={<Box />}
            tint="violet"
            label="Volume"
            pctValue={u.volume_pct}
            value={cuft(u.volume_used_cuft).replace(' cu ft', '')}
            rest={`cu ft used of ${cuft(u.capacity_cuft)}`}
          />
          <UtilRow
            icon={<Route />}
            tint="teal"
            label="Distance"
            pctValue={u.distance_pct}
            value={km(u.distance_km)}
            rest={`run of ${km(u.expected_distance_km)} expected`}
          />
        </div>
      )}
    </Card>
  )
}

// ── 4. Cost breakdown ─────────────────────────────────────────

const LINE_DOT: Record<string, string> = {
  fuel_inr: 'bg-brand-500',
  def_inr: 'bg-violet-500',
  engine_oil_inr: 'bg-violet-400',
  gear_oil_inr: 'bg-pink-400',
  service_inr: 'bg-blue-500',
  tyre_inr: 'bg-sky-400',
  driver_wage_inr: 'bg-orange-400',
  toll_inr: 'bg-fuchsia-500',
  other_inr: 'bg-gray-400',
}

function CostCard({ report }: { report: VehicleReport | null }) {
  const lines = useMemo(() => {
    if (!report) return []
    return COST_LINES.map(line => ({
      ...line,
      value: costOf(report.cost_breakdown_inr, line.key, line.wire),
    }))
  }, [report])

  if (!report) return null

  const total = lines.reduce((sum, line) => sum + line.value, 0)
  const runningShare = total > 0 ? (report.score.running_cost_inr / total) * 100 : null

  const tiles = [
    { label: 'Cost per km', value: inr(report.cost_per_km_inr), sub: 'Modelled running cost ÷ distance', icon: <Coins />, tint: 'amber' as const, tone: 'text-gray-900' },
    { label: 'Revenue per km', value: inr(report.revenue_per_km_inr), sub: 'Freight earned ÷ distance', icon: <TrendingUp />, tint: 'blue' as const, tone: 'text-gray-900' },
    // revenue − modelled running cost. This was labelled "Net profit", but it is the
    // same figure as the Gross margin in the verdict above — the true net, after
    // tolls/other and EMI & fixed, is the Surplus up there.
    {
      label: 'Gross margin', value: inr(report.score.gross_margin_inr), sub: 'Revenue − running cost, before tolls, EMI & fixed',
      icon: <BarChart3 />, tint: report.score.gross_margin_inr >= 0 ? 'green' as const : 'red' as const,
      tone: report.score.gross_margin_inr >= 0 ? 'text-emerald-600' : 'text-red-600',
    },
  ]

  return (
    <Card>
      <CardHead
        icon={<PieChart />}
        tint="blue"
        title="Cost breakdown"
        sub="Where the money went this period"
        info="Modelled from category and age norms, not receipts"
      />

      {report.trips === 0 || total === 0 ? (
        <Empty title="No costs recorded in this window" hint="Costs are written once a trip is paid." />
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-4 sm:p-5 border-b border-gray-100">
            {tiles.map(t => (
              <div key={t.label} className="rounded-xl border border-gray-200 p-3.5 min-w-0" title={t.sub}>
                <div className="flex items-center gap-2.5">
                  <IconTile icon={t.icon} tint={t.tint} size="sm" />
                  <span className="text-sm font-medium text-gray-600 leading-tight">{t.label}</span>
                </div>
                <div className={cx('mt-2 text-xl font-bold tabular-nums', t.tone)}>{t.value}</div>
                <div className="mt-0.5 text-[0.6875rem] leading-snug text-gray-500">{t.sub}</div>
              </div>
            ))}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[30rem]">
              <thead>
                <tr className="text-[0.8125rem] text-gray-500 border-b border-gray-100">
                  <th className="py-2.5 pl-5 pr-3 text-left font-medium">Line item</th>
                  <th className="py-2.5 px-3 text-right font-medium">Amount</th>
                  <th className="py-2.5 px-3 text-right font-medium">Share</th>
                  <th className="py-2.5 pl-3 pr-5 text-left font-medium w-2/5"><span className="sr-only">Share bar</span></th>
                </tr>
              </thead>
              <tbody>
                {lines.map(line => {
                  const share = total > 0 ? (line.value / total) * 100 : null
                  const width = share ?? 0
                  return (
                    <tr key={line.key} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                      <td className="py-2 pl-5 pr-3 text-sm text-gray-900">
                        <span className="inline-flex items-center gap-2">
                          <span className={cx('w-2.5 h-2.5 rounded-full shrink-0', LINE_DOT[line.key] ?? 'bg-gray-400')} />
                          {line.label}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-sm text-gray-900 text-right tabular-nums">{inr(line.value)}</td>
                      <td className="py-2 px-3 text-sm text-gray-500 text-right tabular-nums">{pct(share, 1)}</td>
                      <td className="py-2 pl-3 pr-5">
                        <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                          <div
                            className={`h-2 rounded-full ${line.outsideRunning ? 'bg-gray-300' : 'bg-blue-500'}`}
                            style={{ width: `${width}%` }}
                          />
                        </div>
                      </td>
                    </tr>
                  )
                })}
                <tr className="border-t border-gray-200 bg-gray-50/60">
                  <td className="py-3 pl-5 pr-3 text-sm font-bold text-gray-900">Total recorded</td>
                  <td className="py-3 px-3 text-sm font-bold text-gray-900 text-right tabular-nums">{inr(total)}</td>
                  <td className="py-3 px-3 text-sm text-gray-500 text-right tabular-nums">100.0%</td>
                  <td className="py-3 pl-3 pr-5">
                    <div className="h-2 rounded-full bg-blue-600" />
                  </td>
                </tr>
                <tr>
                  <td className="py-3 pl-5 pr-3 text-sm text-gray-500">Of which modelled running cost</td>
                  <td className="py-3 px-3 text-sm text-gray-500 text-right tabular-nums">
                    {inr(report.score.running_cost_inr)}
                  </td>
                  <td className="py-3 px-3 text-sm text-gray-500 text-right tabular-nums">{pct(runningShare, 1)}</td>
                  <td className="py-3 pl-3 pr-5">
                    {runningShare !== null && (
                      <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                        <div className="h-2 rounded-full bg-gray-400" style={{ width: `${Math.min(100, runningShare)}%` }} />
                      </div>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  )
}

// ── 5. Finance ────────────────────────────────────────────────

function FinanceCard({ finance, onEdit }: { finance: VehicleFinance | null; onEdit: () => void }) {
  const carrying = finance
    ? [
        { label: 'Insurance', value: finance.insurance_annual_inr, icon: <ShieldCheck />, tint: 'blue' as const },
        { label: 'Permit', value: finance.permit_annual_inr, icon: <FileBadge />, tint: 'violet' as const },
        { label: 'Fitness', value: finance.fitness_annual_inr, icon: <Wrench />, tint: 'teal' as const },
      ]
    : []

  return (
    <Card>
      <CardHead
        icon={<Landmark />}
        tint="blue"
        title="Finance"
        sub="The loan and the fixed carrying costs"
        actions={
          <button type="button" className={BTN_LINK} onClick={onEdit}>
            {finance ? 'Edit finance' : 'Add finance'}
          </button>
        }
      />
      {!finance ? (
        <Empty
          icon={<Wallet />}
          title="No finance recorded"
          hint="Add the loan and annual carrying costs for this truck."
        />
      ) : (
        <div className="p-4 sm:p-5 space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-px bg-gray-200 rounded-xl overflow-hidden border border-gray-200">
            <Field label="Lender" value={finance.lender ?? '—'} />
            <Field label="Loan account" value={finance.loan_account_no ?? '—'} mono />
            <Field label="EMI" value={inr(finance.emi_amount_inr)} />
            <Field label="Outstanding" value={inr(finance.outstanding_inr)} />
            <Field
              label="Interest rate"
              value={finance.interest_rate_pct === null ? '—' : pct(finance.interest_rate_pct, 2)}
            />
            <Field
              label="EMI day"
              value={finance.emi_day_of_month === null ? '—' : `${finance.emi_day_of_month} of month`}
            />
            <Field label="Start date" value={longDate(finance.start_date)} />
            <Field label="End date" value={longDate(finance.end_date)} />
            <Field
              label="Tenure"
              value={finance.tenure_months === null ? '—' : `${finance.tenure_months} months`}
            />
            <div className="bg-white hidden lg:block" aria-hidden />
          </div>

          <div>
            <p className="text-sm font-bold text-gray-900 inline-flex flex-wrap items-center gap-1.5">
              Annual carrying costs
              <InfoDot text="Charged monthly, one-twelfth each, alongside the EMI" />
              <span className="text-xs font-normal text-gray-500 hidden sm:inline">Charged monthly, one-twelfth each, alongside the EMI.</span>
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
              {carrying.map(c => (
                <div key={c.label} className="rounded-xl border border-gray-200 p-4 flex items-center gap-3.5">
                  <IconTile icon={c.icon} tint={c.tint} />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-600">{c.label}</div>
                    <div className="text-xl font-bold text-gray-900 tabular-nums">{inr(c.value)}</div>
                    <div className="text-xs text-gray-500 tabular-nums">({inr(c.value / 12)} / month)</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Card>
  )
}

// ── 6. Permits ────────────────────────────────────────────────

const PERMIT_TINT: Record<VehiclePermit['permit_type'], 'teal' | 'amber' | 'violet' | 'brand'> = {
  national: 'teal',
  state: 'brand',
  contract_carriage: 'violet',
  goods: 'amber',
}

function PermitsCard({ permits, onEdit }: { permits: VehiclePermit[]; onEdit: () => void }) {
  return (
    <Card>
      <CardHead
        icon={<FileText />}
        tint="blue"
        title="Permits"
        sub="Where this truck is allowed to run"
        actions={
          <button type="button" className={BTN_LINK} onClick={onEdit}>
            Edit permits
          </button>
        }
      />
      {permits.length === 0 ? (
        <Empty icon={<FileBadge />} title="No permits recorded" hint="Add the national or state permits this truck holds." />
      ) : (
        <div className="p-4 sm:p-5 grid grid-cols-1 md:grid-cols-2 gap-3">
          {permits.map(permit => {
            const left = daysUntil(permit.expiry_date)
            const tone =
              left === null ? 'text-gray-400'
              : left < 0 ? 'text-red-600'
              : left <= 60 ? 'text-amber-600'
              : 'text-emerald-600'
            const note =
              left === null ? 'No expiry on record'
              : left < 0 ? `Expired ${Math.abs(left)} d ago`
              : left <= 60 ? `Expires in ${left} d`
              : 'Valid'
            const NoteIcon = left !== null && left >= 0 && left > 60 ? CheckCircle2 : AlertCircle

            return (
              <div key={permit.id} className="rounded-xl border border-gray-200 p-4 flex items-start gap-3.5">
                <IconTile icon={<FileBadge />} tint={PERMIT_TINT[permit.permit_type]} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-gray-900">{PERMIT_LABELS[permit.permit_type]}</span>
                        {!permit.is_active && <span className={pill('slate')}>Inactive</span>}
                      </div>
                      <div className={cx(MONO, 'text-[0.9375rem] text-gray-900 mt-0.5 truncate')}>
                        {permit.permit_number ?? <span className="font-sans text-sm text-gray-400">No permit number</span>}
                      </div>
                    </div>
                    <div className="flex flex-wrap justify-end gap-1 shrink-0 max-w-[45%]">
                      {permit.allowed_states.length === 0 ? (
                        <span className={pill('blue')}>
                          {permit.permit_type === 'national' ? 'All India' : 'No states listed'}
                        </span>
                      ) : (
                        permit.allowed_states.map(state => (
                          <span key={state} className={pill('slate')}>{state}</span>
                        ))
                      )}
                    </div>
                  </div>
                  <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
                    <span className={cx('inline-flex items-center gap-1.5 font-semibold', tone)}>
                      {left !== null && <NoteIcon className="w-4 h-4" />}
                      {note}
                    </span>
                    <span className="text-gray-600 tabular-nums">
                      {left !== null && left < 0 ? 'Expired' : 'Expires'} {longDate(permit.expiry_date)}
                    </span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

// ── 7. Corridors ──────────────────────────────────────────────

function CorridorsCard({ lanes, onEdit }: { lanes: VehicleLane[]; onEdit: () => void }) {
  return (
    <Card>
      <CardHead
        icon={<Route />}
        tint="blue"
        title="Corridors"
        sub="The lanes this truck actually runs"
        info="Observed from permits and completed trips, not hardcoded"
        actions={
          <button type="button" className={BTN_LINK} onClick={onEdit}>
            Edit corridors
          </button>
        }
      />
      {lanes.length === 0 ? (
        <Empty icon={<Route />} title="No corridors recorded" hint="Add the routes this truck runs so its work can be matched to loads." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem]">
            <thead>
              <tr className="text-[0.8125rem] text-gray-500 border-b border-gray-100 bg-gray-50/60">
                <th className="py-3 pl-5 pr-3 text-left font-medium w-12">#</th>
                <th className="py-3 px-3 text-left font-medium">Corridor</th>
                <th className="py-3 px-3 text-left font-medium">Primary</th>
                <th className="py-3 px-3 text-right font-medium">Typical distance</th>
                <th className="py-3 pl-3 pr-5 text-right font-medium">Trips observed</th>
              </tr>
            </thead>
            <tbody>
              {lanes.map((lane, i) => (
                <tr key={lane.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50 transition-colors">
                  <td className="py-3 pl-5 pr-3 text-sm text-gray-500 tabular-nums">{i + 1}</td>
                  <td className="py-3 px-3 text-sm text-gray-900">
                    <span className="inline-flex items-center gap-2 flex-wrap">
                      <span className="font-semibold">{lane.origin_city}</span>
                      <span className="text-gray-400">→</span>
                      <span className="font-semibold">{lane.destination_city}</span>
                    </span>
                  </td>
                  <td className="py-3 px-3 text-sm">
                    {lane.is_primary ? <span className={pill('blue')}>Primary</span> : <span className="text-gray-400">–</span>}
                  </td>
                  <td className="py-3 px-3 text-sm text-gray-900 text-right tabular-nums">
                    {km(lane.typical_distance_km)}
                  </td>
                  <td className="py-3 pl-3 pr-5 text-sm text-gray-700 text-right tabular-nums">
                    {lane.trips_observed}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
