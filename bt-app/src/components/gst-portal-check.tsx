'use client'

/**
 * "Check on the GST portal" — the public record behind a GSTIN: is it real, is it active,
 * whose is it, and does the business file its returns. Read-only; nothing is saved. Shown
 * under a GSTIN field once the number is well-formed, and only when the deployment has the
 * GST lookup switched on (GET /kyc/config → gst_lookup).
 */

import { useState } from 'react'
import { CheckCircle2, Landmark, XCircle } from 'lucide-react'

import { ApiError, getGstFilingSummary, getGstinProfile } from '@/lib/api'
import { gstinProblem } from '@/lib/gst'
import { BTN_BLUE, MONO, cx } from '@/lib/ui'
import type { GstFilingSummary, GstinProfile } from '@/lib/types'

const monthName = (prd: string | null) => {
  if (!prd || !/^\d{6}$/.test(prd)) return null
  const m = Number(prd.slice(0, 2)) - 1
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m]} ${prd.slice(2)}`
}

export default function GstPortalCheck({ gstin, enabled, className }: { gstin: string; enabled: boolean; className?: string }) {
  const [busy, setBusy] = useState(false)
  const [profile, setProfile] = useState<GstinProfile | null>(null)
  const [filing, setFiling] = useState<GstFilingSummary | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [checked, setChecked] = useState<string | null>(null)

  const g = gstin.trim().toUpperCase()
  if (!enabled || gstinProblem(g)) return null

  async function run() {
    setBusy(true)
    setErr(null)
    try {
      const p = await getGstinProfile(g)
      setProfile(p)
      setChecked(g)
      // Filing history only means something for a registration that exists.
      setFiling(p.valid ? await getGstFilingSummary(g).catch(() => null) : null)
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not reach the GST portal.')
      setProfile(null)
      setFiling(null)
    } finally {
      setBusy(false)
    }
  }

  const stale = checked !== null && checked !== g

  return (
    <div className={cx('space-y-2.5', className)}>
      <button type="button" onClick={run} disabled={busy} className={cx(BTN_BLUE, 'gap-2')}>
        <Landmark className="w-4 h-4" aria-hidden />
        {busy ? 'Checking…' : profile && !stale ? 'Check again' : 'Check on the GST portal'}
      </button>

      {err && <p className="text-sm font-medium text-red-600">{err}</p>}

      {profile && !stale && (
        profile.valid ? (
          <div className={cx(
            'rounded-xl border px-3.5 py-3 text-sm space-y-1',
            profile.active ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-amber-200 bg-amber-50 text-amber-900',
          )}>
            <p className="flex items-center gap-2 font-semibold">
              {profile.active ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-amber-600" />}
              {profile.active ? 'Registered and active' : `Registration is ${profile.status?.toLowerCase() ?? 'not active'}`}
            </p>
            {profile.trade_name && <p>Firm: <span className="font-semibold">{profile.trade_name}</span></p>}
            {profile.legal_name && (
              <p>{profile.trade_name ? 'Registered to' : 'Registered name'}: <span className="font-semibold">{profile.legal_name}</span>
                {!profile.trade_name && <span className="opacity-80"> (for a proprietorship this is the owner&apos;s name)</span>}
              </p>
            )}
            <p className="text-[0.8125rem] opacity-90">
              {[profile.state_name, profile.registered_since ? `registered since ${profile.registered_since}` : null, profile.business_nature].filter(Boolean).join(' · ')}
            </p>
            {filing && (
              <p className="text-[0.8125rem] opacity-90">
                GST returns {filing.financial_year}:{' '}
                {filing.verdict === 'regular' && <span className="font-semibold">filed every month</span>}
                {filing.verdict === 'behind' && <span className="font-semibold">{filing.gstr3b_missing} {filing.gstr3b_missing === 1 ? 'month' : 'months'} not filed</span>}
                {filing.verdict === 'none' && <span className="font-semibold">nothing filed yet</span>}
                {filing.last_period && <> · last filed {monthName(filing.last_period)}</>}
              </p>
            )}
          </div>
        ) : (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-800 flex items-center gap-2">
            <XCircle className="w-4 h-4 shrink-0 text-red-600" />
            <span>The GST portal has no registration <span className={MONO}>{g}</span>.{profile.reason ? ` ${profile.reason}` : ''}</span>
          </p>
        )
      )}
    </div>
  )
}
