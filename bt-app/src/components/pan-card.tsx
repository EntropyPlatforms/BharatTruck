'use client'

/**
 * PAN — mandatory for every account (2026-10-15): a load cannot be posted and a bid cannot
 * be placed until the PAN is verified. Verification checks the number, the name on the card
 * and the date of birth against the PAN record (bt-auth-service /kyc/verify/pan). The number
 * itself is never stored — only a hash and the result.
 *
 * Two ways in: scan the card (fills all three fields) or type them. Both end in "Verify PAN".
 */

import { useEffect, useState, type FormEvent } from 'react'
import { CheckCircle2, IdCard } from 'lucide-react'
import { toast } from 'sonner'

import ScanDocument from '@/components/scan-document'
import { Card, CardHead, ErrorNote } from '@/components/stat'
import { ApiError, getKycStatus, verifyKyc } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { panProblem } from '@/lib/gst'
import { BTN_PRIMARY, INPUT, LABEL, MONO, cx } from '@/lib/ui'

export default function PanCard({ scan, providerWired }: { scan: boolean; providerWired: boolean }) {
  const { user, personas } = useAuth()
  const [status, setStatus] = useState<'loading' | 'verified' | 'pending' | 'none'>('loading')
  const [form, setForm] = useState({ pan: '', name: user?.full_name ?? '', dob: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }))

  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    getKycStatus(user.id)
      .then((s) => {
        if (cancelled) return
        const st = s.verifications?.pan?.status
        setStatus(st === 'success' ? 'verified' : st === 'manual_review' || st === 'pending' ? 'pending' : 'none')
      })
      .catch(() => { if (!cancelled) setStatus('none') })
    return () => { cancelled = true }
  }, [user?.id])

  async function submit(e: FormEvent) {
    e.preventDefault()
    const pan = form.pan.trim().toUpperCase()
    const problem = panProblem(pan)
    if (problem) { setErr(problem); return }
    if (form.name.trim().length < 2) { setErr('Enter the name exactly as printed on the PAN card.'); return }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.dob)) { setErr('Enter the date of birth (or incorporation) on the card.'); return }
    if (!user?.id) return
    setBusy(true)
    setErr(null)
    try {
      const role = personas?.driver_id ? 'DRIVER' : personas?.fleet_owner_id ? 'FLEET_OPERATOR' : 'CUSTOMER'
      const res = await verifyKyc('pan', user.id, role, { pan_number: pan, name: form.name.trim(), dob: form.dob })
      if (res.result.status === 'success') {
        setStatus('verified')
        toast.success('PAN verified')
      } else if (res.result.status === 'manual_review') {
        setStatus('pending')
        toast.message('PAN recorded for review — no verification service is wired yet.')
      } else {
        setErr(res.result.error ?? 'The PAN could not be verified.')
      }
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Could not verify the PAN.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHead
        icon={<IdCard />}
        tint="amber"
        title="PAN (required)"
        sub="Needed before you can post a load or bid on one. Checked against the PAN record; the number is not stored."
      />
      <div className="p-5 space-y-4">
        {status === 'verified' ? (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800 inline-flex items-center gap-2 w-full">
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
            <span>PAN verified.</span>
          </p>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            {status === 'pending' && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
                Your PAN is recorded and waiting for review. Verify it again once the checking service is on, or wait for ops.
              </p>
            )}
            {status === 'none' && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
                No PAN verified yet — posting loads and bidding are locked until it is.
              </p>
            )}
            {scan && (
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-blue-100 bg-blue-50/60 px-3.5 py-3">
                <ScanDocument
                  kind="pan"
                  enabled
                  label="Scan PAN card"
                  onFields={(f) => {
                    setForm((p) => ({ pan: f.pan ?? p.pan, name: f.name ?? p.name, dob: f.date_of_birth ?? p.dob }))
                    setErr(f.pan ? null : 'The PAN could not be read clearly — try a sharper photo or type it.')
                  }}
                />
                <p className="text-sm text-gray-600">Photograph the card and the fields fill in — or type them below.</p>
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label htmlFor="pan_number" className={LABEL}>PAN</label>
                <input id="pan_number" value={form.pan} onChange={(e) => set('pan', e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 10))} placeholder="ABCPD1234E" className={`${INPUT} ${MONO} uppercase`} autoComplete="off" />
              </div>
              <div>
                <label htmlFor="pan_name" className={LABEL}>Name as on card</label>
                <input id="pan_name" value={form.name} onChange={(e) => set('name', e.target.value.slice(0, 100))} className={INPUT} autoComplete="off" />
              </div>
              <div>
                <label htmlFor="pan_dob" className={LABEL}>Date of birth / incorporation</label>
                <input id="pan_dob" type="date" value={form.dob} onChange={(e) => set('dob', e.target.value)} className={INPUT} />
              </div>
            </div>
            {!providerWired && <p className="text-xs text-gray-500">The checking service is not switched on yet; the PAN will be recorded for ops review.</p>}
            {err && <ErrorNote message={err} />}
            <button type="submit" disabled={busy || status === 'loading'} className={cx(BTN_PRIMARY)}>{busy ? 'Checking…' : 'Verify PAN'}</button>
          </form>
        )}
      </div>
    </Card>
  )
}
