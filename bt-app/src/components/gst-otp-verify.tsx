'use client'

/**
 * "Verify it's yours by OTP" — under a GSTIN field. The GST portal sends a one-time password to
 * the mobile / email registered against the GSTIN; entering it proves the registration belongs
 * to this account. Nothing is asked of the taxpayer but the username they sign in to gst.gov.in
 * with and the OTP — no API keys, no password.
 *
 * On success the server has already saved the GSTIN on the account and recorded the
 * verification; the registered names come back through onVerified so the surrounding form can
 * fill its own company-name field. One-time prerequisite on the GST portal (the server's error
 * says so when it is missing): View Profile → Manage API Access → Enable API Request: Yes.
 */

import { useEffect, useState, type FormEvent } from 'react'
import { CheckCircle2, ShieldCheck } from 'lucide-react'

import { ApiError, getKycStatus, sendGstOtp, verifyGstOtp } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { gstinProblem } from '@/lib/gst'
import { BTN_BLUE, BTN_PRIMARY, INPUT, LABEL, MONO, cx } from '@/lib/ui'
import type { GstOtpVerified } from '@/lib/types'

export default function GstOtpVerify({ gstin, enabled, onVerified, className }: {
  gstin: string
  enabled: boolean
  onVerified: (r: GstOtpVerified) => void
  className?: string
}) {
  const { user } = useAuth()
  const g = gstin.trim().toUpperCase()
  const [open, setOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [otp, setOtp] = useState('')
  const [sentFor, setSentFor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  // Already verified by OTP earlier (user_kyc.gst = success for the GSTIN on the account).
  const [priorVerified, setPriorVerified] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled || !user?.id) return
    let cancelled = false
    getKycStatus(user.id)
      .then((s) => { if (!cancelled && s.verifications?.gst?.status === 'success' && user.gstin) setPriorVerified(user.gstin.toUpperCase()) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [enabled, user?.id, user?.gstin])

  if (!enabled || gstinProblem(g)) return null

  const verifiedHere = done === g || priorVerified === g
  const stale = sentFor !== null && sentFor !== g

  async function send(e: FormEvent) {
    e.preventDefault()
    if (username.trim().length < 3) { setErr('Enter the username you sign in to gst.gov.in with.'); return }
    setBusy(true)
    setErr(null)
    try {
      await sendGstOtp(g, username.trim())
      setSentFor(g)
      setOtp('')
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Could not reach the GST portal.')
    } finally {
      setBusy(false)
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault()
    if (!/^\d{4,8}$/.test(otp)) { setErr('Enter the OTP digits from the SMS / email.'); return }
    setBusy(true)
    setErr(null)
    try {
      const r = await verifyGstOtp(g, username.trim(), otp)
      setDone(r.gstin)
      setOpen(false)
      onVerified(r)
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Could not verify the OTP.')
    } finally {
      setBusy(false)
    }
  }

  if (verifiedHere) {
    return (
      <p className={cx('rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800 inline-flex items-center gap-2 w-full', className)}>
        <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
        <span>Verified by OTP: <span className={MONO}>{g}</span> is registered to you.</span>
      </p>
    )
  }

  if (!open) {
    return (
      <div className={cx('flex flex-wrap items-center gap-3', className)}>
        <button type="button" onClick={() => setOpen(true)} className={cx(BTN_BLUE, 'inline-flex items-center gap-1.5')}>
          <ShieldCheck className="w-4 h-4" /> Verify it&apos;s yours by OTP
        </button>
        <p className="text-xs text-gray-500">An OTP goes to the mobile registered against this GSTIN — no API keys or passwords needed.</p>
      </div>
    )
  }

  return (
    <div className={cx('rounded-xl border border-blue-100 bg-blue-50/60 p-3.5 space-y-3', className)}>
      <p className="text-sm text-gray-700">
        The GST portal will send a one-time password to the mobile and email registered against <span className={MONO}>{g}</span>.
        Enter your <span className="font-medium">gst.gov.in username</span> (not the password) and then the OTP.
      </p>
      {(sentFor === null || stale) ? (
        <form onSubmit={send} className="flex flex-wrap items-end gap-3">
          <div className="grow basis-48">
            <label htmlFor="gst_otp_user" className={LABEL}>GST portal username</label>
            <input id="gst_otp_user" value={username} onChange={(e) => setUsername(e.target.value.slice(0, 60))} className={INPUT} autoComplete="off" autoCapitalize="none" />
          </div>
          <button type="submit" disabled={busy} className={BTN_PRIMARY}>{busy ? 'Sending…' : 'Send OTP'}</button>
          <button type="button" onClick={() => { setOpen(false); setErr(null) }} className="text-sm text-gray-500 hover:text-gray-800 px-2 py-2">Cancel</button>
        </form>
      ) : (
        <form onSubmit={verify} className="flex flex-wrap items-end gap-3">
          <div className="basis-40">
            <label htmlFor="gst_otp_code" className={LABEL}>OTP</label>
            <input id="gst_otp_code" inputMode="numeric" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 8))} placeholder="6 digits" className={cx(INPUT, MONO, 'tracking-widest')} autoComplete="one-time-code" />
          </div>
          <button type="submit" disabled={busy} className={BTN_PRIMARY}>{busy ? 'Checking…' : 'Verify'}</button>
          <button type="button" disabled={busy} onClick={(e) => void send(e as unknown as FormEvent)} className="text-sm text-blue-700 hover:underline px-2 py-2">Resend OTP</button>
          <p className="basis-full text-xs text-gray-500">Sent to the contact registered against <span className={MONO}>{sentFor}</span>. It is valid for about ten minutes.</p>
        </form>
      )}
      {err && <p className="text-sm text-red-700">{err}</p>}
    </div>
  )
}
