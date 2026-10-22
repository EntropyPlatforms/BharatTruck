'use client'

/**
 * Bahi Khata — link this account's accounting books through Bahi's own API. Sign in once
 * with a Bahi owner or manager login; BharatTruck keeps only Bahi's refresh token (sealed),
 * never the password. Then every paid load is posted automatically:
 *   shipper → a paid purchase invoice from the carrier, straight away;
 *   carrier → a sales invoice to the shipper, which Bahi emails to them to approve, and which
 *             is submitted and marked paid once they do ("Check approvals" picks that up).
 */

import { useEffect, useState, type FormEvent } from 'react'
import { BookOpen, CheckCircle2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

import { Card, CardHead, ErrorNote } from '@/components/stat'
import { ApiError, getBahiConnection, getBahiPostings, linkBahi, syncBahi, syncBahiPending, unlinkBahi, updateBahiSettings } from '@/lib/api'
import { inr } from '@/lib/format'
import { BTN_PRIMARY, BTN_SECONDARY, INPUT, LABEL, MONO, SELECT, cx } from '@/lib/ui'
import type { BahiConnectionView, BahiPostingView } from '@/lib/types'

const RATES = [0, 5, 12, 18, 28] as const
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback)
const rateLabel = (r: number) => (r === 0 ? '0% / reverse charge' : `${r}% included`)

const STATUS: Record<BahiPostingView['status'], { text: string; cls: string }> = {
  posted: { text: 'Posted', cls: 'text-emerald-700' },
  awaiting_approval: { text: 'Awaiting approval', cls: 'text-amber-700' },
  draft: { text: 'Draft in Bahi', cls: 'text-amber-700' },
  failed: { text: 'Failed', cls: 'text-red-700' },
}

export default function BahiLinkCard() {
  const [view, setView] = useState<BahiConnectionView | null>(null)
  const [postings, setPostings] = useState<BahiPostingView[]>([])
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
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
      .catch(() => { if (!cancelled) setView({ linked: false, email: null, company_name: null, gstin: null, gst_rate: 0, linked_at: null, available: false }) })
    return () => { cancelled = true }
  }, [])

  async function link(e: FormEvent) {
    e.preventDefault()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setErr('Enter the email you sign in to Bahi with.'); return }
    if (!password) { setErr('Enter your Bahi password.'); return }
    setBusy(true); setErr(null)
    try {
      const v = await linkBahi(email.trim(), password, rate)
      setView(v); setPassword('')
      toast.success(`Linked to ${v.company_name ?? 'your Bahi books'}`)
    } catch (e2) { setErr(errText(e2, 'Could not link Bahi.')) } finally { setBusy(false); setPassword('') }
  }

  async function changeRate(next: number) {
    setRate(next)
    try { setView(await updateBahiSettings(next)); toast.success(`GST on freight set to ${rateLabel(next)}`) }
    catch (e2) { setErr(errText(e2, 'Could not save the GST rate.')) }
  }

  async function unlink() {
    setBusy(true); setErr(null)
    try { setView(await unlinkBahi()); setPostings([]); toast.message('Bahi unlinked.') }
    catch (e2) { setErr(errText(e2, 'Could not unlink.')) } finally { setBusy(false) }
  }

  async function checkApprovals() {
    setBusy(true); setErr(null)
    try { setPostings(await syncBahiPending()); toast.success('Up to date with Bahi') }
    catch (e2) { setErr(errText(e2, 'Could not reach Bahi.')) } finally { setBusy(false) }
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
              <span>
                Linked to <span className="font-semibold">{view.company_name ?? 'your Bahi company'}</span>
                {view.gstin ? <> (<span className={MONO}>{view.gstin}</span>)</> : null}
                {view.email ? <> as {view.email}</> : null}
              </span>
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label htmlFor="bahi_rate" className={LABEL}>GST on freight</label>
                <select id="bahi_rate" value={rate} onChange={(e) => void changeRate(Number(e.target.value))} className={cx(SELECT, 'w-48')}>
                  {RATES.map((r) => <option key={r} value={r}>{rateLabel(r)}</option>)}
                </select>
              </div>
              <button type="button" onClick={checkApprovals} disabled={busy} className={cx(BTN_SECONDARY, 'inline-flex items-center gap-1.5')}><RefreshCw className="w-4 h-4" /> Check approvals</button>
              <button type="button" onClick={unlink} disabled={busy} className={BTN_SECONDARY}>Unlink</button>
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900">Recent postings</p>
              {postings.length === 0 ? (
                <p className="mt-1 text-sm text-gray-500">Nothing yet — your next paid load will appear here.</p>
              ) : (
                <ul className="mt-2 divide-y divide-gray-100 rounded-xl border border-gray-200">
                  {postings.slice(0, 10).map((p) => (
                    <li key={`${p.booking_id}-${p.kind}`} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                      <span className="min-w-0">
                        <span className="font-medium text-gray-900">{p.kind === 'income' ? 'Freight income' : 'Freight expense'}</span>
                        <span className="text-gray-500"> · load {p.booking_id.slice(0, 8)}{p.amount_inr != null ? ` · ${inr(p.amount_inr)}` : ''}{p.bahi_number ? ` · ${p.bahi_number}` : ''}</span>
                        {(p.error || p.note) && <span className="block text-xs text-gray-500 truncate">{p.error ?? p.note}</span>}
                      </span>
                      {p.status === 'failed' ? (
                        <button type="button" onClick={() => void retry(p.booking_id)} className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline"><RefreshCw className="w-3.5 h-3.5" /> Retry</button>
                      ) : (
                        <span className={cx('text-xs font-semibold whitespace-nowrap', STATUS[p.status].cls)}>{STATUS[p.status].text}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : (
          <form onSubmit={link} className="space-y-4">
            <p className="text-sm text-gray-600">
              Sign in with your <span className="font-semibold">Bahi owner or manager</span> login. BharatTruck keeps only Bahi&apos;s sign-in key, never your password, and posts each paid load into your books.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label htmlFor="bahi_email" className={LABEL}>Bahi email</label>
                <input id="bahi_email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={INPUT} autoComplete="off" />
              </div>
              <div>
                <label htmlFor="bahi_password" className={LABEL}>Bahi password</label>
                <input id="bahi_password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={INPUT} autoComplete="new-password" />
              </div>
              <div>
                <label htmlFor="bahi_rate_new" className={LABEL}>GST on freight</label>
                <select id="bahi_rate_new" value={rate} onChange={(e) => setRate(Number(e.target.value))} className={SELECT}>
                  {RATES.map((r) => <option key={r} value={r}>{rateLabel(r)}</option>)}
                </select>
              </div>
            </div>
            <button type="submit" disabled={busy} className={BTN_PRIMARY}>{busy ? 'Signing in to Bahi…' : 'Link Bahi'}</button>
          </form>
        )}
        {err && <ErrorNote message={err} />}
      </div>
    </Card>
  )
}
