'use client'

/**
 * Password-reset landing (D-34). The single-use, 30-min reset link bt-auth-service emails
 * lands here as /auth/reset?token=… — outside the (app) auth gate, so a signed-out user can
 * complete it. The token is read from the URL client-side (no useSearchParams Suspense dance).
 *
 * NOTE: the emailed link only lands here if bt-auth-service's PASSWORD_RESET_URL points at
 * this app's origin. That is a backend env, set per deployment.
 */

import { useEffect, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { AlertCircle, ArrowLeft, CheckCircle2, Lock } from 'lucide-react'
import { ApiError, resetPassword } from '@/lib/api'
import { AuthShell, AuthCard, PANEL_RESET } from '@/components/auth/auth-shell'
import { AuthAlert, IconField, PasswordInput, StrengthMeter } from '@/components/auth/auth-ui'
import { BTN_PRIMARY, BTN_SECONDARY, cx } from '@/lib/ui'

export default function ResetPasswordPage() {
  // undefined = not read from the URL yet; null = the link carries no token.
  const [token, setToken] = useState<string | null | undefined>(undefined)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => { setToken(new URLSearchParams(window.location.search).get('token')) }, [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault(); setError(null)
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return }
    if (password !== confirm) { setError('The two passwords do not match.'); return }
    if (!token) { setError('This reset link is missing its token — request a new one.'); return }
    setBusy(true)
    try { await resetPassword(token, password); setDone(true) }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Could not reset the password'); setBusy(false) }
  }

  return (
    <AuthShell panel={PANEL_RESET}>
      <AuthCard>
        <div className="mb-5">
          <h2 className="text-[1.625rem] font-bold leading-tight tracking-tight text-gray-900">Set a new password</h2>
          <p className="mt-1 text-[0.9375rem] text-gray-600">Choose a strong password to keep your account safe.</p>
        </div>

        {done ? (
          <div role="status" className="space-y-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
            <p className="flex items-center gap-2.5 text-sm font-medium text-emerald-800">
              <CheckCircle2 className="h-5 w-5 shrink-0 fill-emerald-500 text-[#fff]" aria-hidden />
              Your password has been reset.
            </p>
            <Link href="/login" className={cx(BTN_PRIMARY, 'h-11 w-full')}>Sign in</Link>
          </div>
        ) : token === null ? (
          /* The link has no token: nothing to submit. Offer a fresh link instead of a form
             that can only fail. */
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4">
            <div className="flex items-start gap-2.5 text-sm text-red-800">
              <AlertCircle className="mt-px h-[18px] w-[18px] shrink-0 fill-red-500 text-[#fff]" aria-hidden />
              <p>This reset link is missing its token — request a new one.</p>
            </div>
            <Link href="/login?mode=forgot" className={cx(BTN_SECONDARY, 'mt-4 h-11 w-full border-red-200 text-red-700 hover:bg-red-100')}>
              Request a new link
            </Link>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <IconField id="pw" label="New password" icon={<Lock />}>
                <PasswordInput id="pw" required minLength={8} autoComplete="new-password" value={password} onChange={e => { setPassword(e.target.value); setError(null) }} placeholder="Create a new password" />
              </IconField>
              <StrengthMeter password={password} />
            </div>
            <IconField id="pw2" label="Confirm password" icon={<Lock />}>
              <PasswordInput id="pw2" required autoComplete="new-password" value={confirm} onChange={e => { setConfirm(e.target.value); setError(null) }} placeholder="Re-enter it" />
            </IconField>
            <button type="submit" disabled={busy} className={cx(BTN_PRIMARY, 'h-11 w-full')}>
              {busy ? 'Saving…' : 'Reset password'}
            </button>
            {error && <AuthAlert tone="error" onDismiss={() => setError(null)}>{error}</AuthAlert>}
          </form>
        )}

        <div className="mt-5 border-t border-gray-200 pt-4 text-center">
          <Link href="/login" className="inline-flex items-center gap-1.5 rounded text-sm font-semibold text-blue-600 hover:text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
            <ArrowLeft className="h-4 w-4" aria-hidden /> Back to sign in
          </Link>
        </div>
      </AuthCard>
    </AuthShell>
  )
}
