'use client'

/**
 * Bahi Khata — link this account's accounting books. Once linked, every paid load is posted
 * there automatically: a carrier gets a paid sales invoice to the shipper, a shipper a paid
 * purchase invoice from the carrier. The token is created in Bahi (Settings → Integrations,
 * admin only), pasted here once, checked against Bahi, and stored encrypted; it is never shown
 * again. The GST rate is the account's own: the paid amount is treated as GST-inclusive.
 */

import { useEffect, useState, type FormEvent } from 'react'
import { BookOpen, CheckCircle2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

import { Card, CardHead, ErrorNote } from '@/components/stat'
import { ApiError, getBahiConnection, getBahiPostings, linkBahi, syncBahi, unlinkBahi, updateBahiSettings } from '@/lib/api'
import { inr } from '@/lib/format'
import { BTN_PRIMARY, BTN_SECONDARY, INPUT, LABEL, MONO, SELECT, cx } from '@/lib/ui'
import type { BahiConnectionView, BahiPostingView } from '@/lib/types'

const RATES = [0, 5, 12, 18, 28] as const
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback)

export default function BahiLinkCard() {
  const [view, setView] = useState<BahiConnectionView | null>(null)
  const [postings, setPostings] = useState<BahiPostingView[]>([])
  const [token, setToken] = useState('')
  const [rate, setRate] = useState<number>(0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getBahiConnection()
      .then(async (v) => {
        if (cancelled) return
        setView(v)
        setRate(v.gst_rate)
        if (v.linked) {
          const list = await getBahiPostings().catch(() => [])
          if (!cancelled) setPostings(list)
        }
      })
      .catch(() => { if (!cancelled) setView({ linked: false, company_name: null, gstin: null, gst_rate: 0, linked_at: null, available: false }) })
    return () => { cancelled = true }
  }, [])

  async function link(e: FormEvent) {
    e.preventDefault()
    if (!/^bahi_it_[A-Za-z0-9_-]{32,}$/.test(token.trim())) { setErr('Paste the token Bahi showed you — it starts with bahi_it_.'); return }
    setBusy(true); setErr(null)
    try {
      const v = await linkBahi(token.trim(), rate)
      setView(v); setToken('')
      toast.success(`Linked to ${v.company_name ?? 'your Bahi books'}`)
    } catch (e2) { setErr(errText(e2, 'Could not link Bahi.')) } finally { setBusy(false) }
  }

  async function changeRate(next: number) {
    setRate(next)
    if (!view?.linked) return
    try { setView(await updateBahiSettings(next)); toast.success(`GST on freight set to ${next}%`) }
    catch (e2) { setErr(errText(e2, 'Could not save the GST rate.')) }
  }

  async function unlink() {
    setBusy(true); setErr(null)
    try { setView(await unlinkBahi()); setPostings([]); toast.message('Bahi unlinked. Revoke the token in Bahi too if you no longer need it.') }
    catch (e2) { setErr(errText(e2, 'Could not unlink.')) } finally { setBusy(false) }
  }

  async function retry(bookingId: string) {
    try { await syncBahi(bookingId); setPostings(await getBahiPostings()); toast.success('Sent to Bahi again') }
    catch (e2) { toast.error(errText(e2, 'Could not post to Bahi.')) }
  }

  return (
    <Card>
      <CardHead icon={<BookOpen />} tint="brand" title="Bahi Khata (accounting)" sub="Paid loads go straight into your Bahi books — invoice, payment and GST, with no retyping." />
      <div className="p-5 space-y-4">
        {view === null ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : !view.available && !view.linked ? (
          <p className="text-sm text-gray-600">Bahi linking is not switched on for this deployment yet.</p>
        ) : view.linked ? (
          <>
            <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800 inline-flex items-center gap-2 w-full">
              <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
              <span>Linked to <span className="font-semibold">{view.company_name ?? 'your Bahi company'}</span>{view.gstin ? <> (<span className={MONO}>{view.gstin}</span>)</> : null}</span>
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label htmlFor="bahi_rate" className={LABEL}>GST on freight</label>
                <select id="bahi_rate" value={rate} onChange={(e) => void changeRate(Number(e.target.value))} className={cx(SELECT, 'w-40')}>
                  {RATES.map((r) => <option key={r} value={r}>{r === 0 ? '0% / reverse charge' : `${r}% included`}</option>)}
                </select>
              </div>
              <button type="button" onClick={unlink} disabled={busy} className={BTN_SECONDARY}>Unlink</button>
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900">Recent postings</p>
              {postings.length === 0 ? (
                <p className="mt-1 text-sm text-gray-500">Nothing yet — your next paid load will appear here.</p>
              ) : (
                <ul className="mt-2 divide-y divide-gray-100 rounded-xl border border-gray-200">
                  {postings.slice(0, 8).map((p) => (
                    <li key={`${p.booking_id}-${p.kind}`} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                      <span className="min-w-0">
                        <span className="font-medium text-gray-900">{p.kind === 'income' ? 'Freight income' : 'Freight expense'}</span>
                        <span className="text-gray-500"> · load {p.booking_id.slice(0, 8)}{p.amount_inr != null ? ` · ${inr(p.amount_inr)}` : ''}</span>
                        {(p.error || p.note) && <span className="block text-xs text-gray-500 truncate">{p.error ?? p.note}</span>}
                      </span>
                      {p.status === 'failed' ? (
                        <button type="button" onClick={() => void retry(p.booking_id)} className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline"><RefreshCw className="w-3.5 h-3.5" /> Retry</button>
                      ) : (
                        <span className={cx('text-xs font-semibold', p.status === 'posted' ? 'text-emerald-700' : 'text-amber-700')}>{p.bahi_number ?? (p.status === 'draft' ? 'Draft' : 'Posted')}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : (
          <form onSubmit={link} className="space-y-4">
            <ol className="list-decimal pl-5 text-sm text-gray-600 space-y-1">
              <li>In Bahi, open <span className="font-semibold">Settings → Integrations</span> (admin) and create a token named “BharatTruck”.</li>
              <li>Copy the token Bahi shows once, and paste it below.</li>
            </ol>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="sm:col-span-2">
                <label htmlFor="bahi_token" className={LABEL}>Bahi integration token</label>
                <input id="bahi_token" value={token} onChange={(e) => setToken(e.target.value.trim())} placeholder="bahi_it_…" className={cx(INPUT, MONO)} autoComplete="off" spellCheck={false} />
              </div>
              <div>
                <label htmlFor="bahi_rate_new" className={LABEL}>GST on freight</label>
                <select id="bahi_rate_new" value={rate} onChange={(e) => setRate(Number(e.target.value))} className={SELECT}>
                  {RATES.map((r) => <option key={r} value={r}>{r === 0 ? '0% / reverse charge' : `${r}% included`}</option>)}
                </select>
              </div>
            </div>
            <button type="submit" disabled={busy} className={BTN_PRIMARY}>{busy ? 'Checking with Bahi…' : 'Link Bahi'}</button>
          </form>
        )}
        {err && <ErrorNote message={err} />}
      </div>
    </Card>
  )
}
