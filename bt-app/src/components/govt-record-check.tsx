'use client'

/**
 * Checks against the transport department's own records (2026-11-12):
 *   • VahanRcCard: a truck's RC against Vahan (the vehicle register).
 *   • SarathiCheck: a driver's licence against Sarathi (the licence register).
 * Both go through bt-auth-service /kyc/verify (rc | dl), which routes them to the vendor in
 * KYC_RC_PROVIDER / KYC_DL_PROVIDER (Surepass). They only show a button when /kyc/config says
 * the check is switched on; otherwise the record stays with the ops team, as before.
 */

import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'

import { Card, CardHead, ErrorNote } from '@/components/stat'
import { ApiError, verifyKyc } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import type { KycVerifyResult } from '@/lib/types'
import { BTN_BLUE_SOLID, INPUT, LABEL, cx, pill, type PillTone } from '@/lib/ui'

type Details = Record<string, unknown>

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

function roleOf(personas: { driver_id?: string | null; fleet_owner_id?: string | null } | null | undefined) {
  return personas?.fleet_owner_id ? 'FLEET_OPERATOR' : personas?.driver_id ? 'DRIVER' : 'CUSTOMER'
}

function errOf(e: unknown, fallback: string) {
  return e instanceof ApiError ? e.message : fallback
}

const STATUS_TONE: Record<string, PillTone> = { verified: 'green', pending: 'amber', rejected: 'red' }

/** What Vahan says about the truck: dates the owner should act on. */
function VahanFacts({ d }: { d: Details }) {
  const rows: Array<[string, string | null, boolean | null]> = [
    ['RC status', text(d.rc_status), null],
    ['Model', text(d.maker_model), null],
    ['Class', text(d.vehicle_category), null],
    ['Registered', [text(d.registration_date), text(d.registered_at)].filter(Boolean).join(' · ') || null, null],
    ['Fitness valid till', text(d.fitness_upto), d.fitness_lapsed === true],
    ['Insurance valid till', text(d.insurance_upto), d.insurance_lapsed === true],
    ['Permit valid till', text(d.permit_valid_upto), null],
  ]
  const shown = rows.filter(([, v]) => v)
  if (shown.length === 0) return null
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
      {shown.map(([k, v, bad]) => (
        <div key={k} className="flex justify-between gap-3 border-b border-gray-100 py-1.5">
          <dt className="text-gray-500">{k}</dt>
          <dd className={cx('font-medium text-right', bad ? 'text-red-600' : 'text-gray-900')}>{v}{bad ? ' (lapsed)' : ''}</dd>
        </div>
      ))}
    </dl>
  )
}

export function VahanRcCard({ rcNumber, rcStatus, enabled, onVerified }: {
  rcNumber: string
  rcStatus: string | null | undefined
  /** /kyc/config rc_check: an RC vendor is wired. */
  enabled: boolean
  onVerified: () => void
}) {
  const { user, personas } = useAuth()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [res, setRes] = useState<KycVerifyResult | null>(null)
  const status = res?.result.status === 'success' ? 'verified' : (rcStatus ?? 'pending')

  async function run() {
    if (!user?.id) return
    setBusy(true); setErr(null)
    try {
      const r = await verifyKyc('rc', user.id, roleOf(personas), { rc_number: rcNumber })
      setRes(r)
      if (r.result.status === 'success') { toast.success('RC verified on Vahan'); onVerified() }
      else if (r.result.status === 'manual_review') toast.message('Recorded for review by our ops team.')
      else setErr(r.result.error ?? 'Vahan could not confirm this RC.')
    } catch (e) {
      setErr(errOf(e, 'Could not reach Vahan right now. Try again in a minute.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHead
        icon={<ShieldCheck />}
        tint="green"
        title="RC on Vahan"
        sub="Checked against the transport department's vehicle register: RC status, fitness and insurance dates."
      />
      <div className="p-5 space-y-4">
        <p className="text-sm flex flex-wrap items-center gap-2">
          <span className="text-gray-500">Status:</span>
          <span className={cx(pill(STATUS_TONE[status] ?? 'slate'), 'capitalize')}>{status}</span>
        </p>
        {res?.details && <VahanFacts d={res.details} />}
        {err && <ErrorNote message={err} />}
        {enabled ? (
          status !== 'verified' || res ? (
            <button type="button" onClick={run} disabled={busy} className={BTN_BLUE_SOLID}>
              {busy ? 'Checking Vahan…' : res ? 'Check again' : 'Check on Vahan'}
            </button>
          ) : (
            <button type="button" onClick={run} disabled={busy} className="text-sm font-semibold text-blue-600 hover:text-blue-700">
              {busy ? 'Checking Vahan…' : 'Re-check fitness and insurance dates'}
            </button>
          )
        ) : (
          status !== 'verified' && <p className="text-sm text-gray-500">Our ops team checks the RC. Automatic Vahan checks are not switched on yet.</p>
        )}
      </div>
    </Card>
  )
}

/** A block inside the licence card: DOB in, the Sarathi record out. Not a form (it sits in one). */
export function SarathiCheck({ dlNumber, onVerified }: { dlNumber: string; onVerified: () => void }) {
  const { user, personas } = useAuth()
  const [dob, setDob] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [details, setDetails] = useState<Details | null>(null)

  async function run() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) { setErr('Enter your date of birth as printed on the licence.'); return }
    if (!user?.id) return
    setBusy(true); setErr(null)
    try {
      const r = await verifyKyc('dl', user.id, roleOf(personas), { dl_number: dlNumber, dob, name: user.full_name ?? '' })
      setDetails(r.details ?? null)
      if (r.result.status === 'success') { toast.success('Licence verified on Sarathi'); onVerified() }
      else if (r.result.status === 'manual_review') toast.message('Recorded for review by our ops team.')
      else setErr(r.result.error ?? 'Sarathi could not confirm this licence.')
    } catch (e) {
      setErr(errOf(e, 'Could not reach Sarathi right now. Try again in a minute.'))
    } finally {
      setBusy(false)
    }
  }

  const transportLapsed = details?.transport_valid === false
  return (
    <div className="rounded-xl border border-emerald-100 bg-emerald-50/60 px-3.5 py-3 space-y-3">
      <p className="text-sm text-gray-700">Verify now against the transport department&apos;s licence register (Sarathi). We need the date of birth on the licence.</p>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="sarathi-dob" className={LABEL}>Date of birth</label>
          <input id="sarathi-dob" type="date" value={dob} onChange={(e) => setDob(e.target.value)} className={cx(INPUT, 'w-48')} />
        </div>
        <button type="button" onClick={run} disabled={busy || !dlNumber} className={BTN_BLUE_SOLID}>
          {busy ? 'Checking Sarathi…' : 'Verify on Sarathi'}
        </button>
      </div>
      {transportLapsed && (
        <p className="text-sm text-red-600">The transport (commercial) endorsement on this licence has lapsed{text(details?.transport_expiry) ? ` (${text(details?.transport_expiry)})` : ''}. It must be renewed to drive a goods vehicle.</p>
      )}
      {err && <ErrorNote message={err} />}
    </div>
  )
}
