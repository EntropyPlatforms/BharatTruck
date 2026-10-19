'use client'

/**
 * The ONE front door (D-36). Every persona signs in here and lands on the same Home feed;
 * capabilities decide what they see. This page carries the full auth surface (D-32/D-34):
 *   - sign in (email + password)
 *   - create an account, declaring a PRIMARY PERSONA (shipper / driver / fleet owner) — the
 *     front door that shapes onboarding, and gates nothing — then verify a 6-digit email code
 *   - forgot password (single-origin, single-use, expiring reset link → /auth/reset)
 *   - Continue with Google (shown only when a Google client id is configured)
 *
 * `?mode=register` / `?mode=forgot` open the page on that screen (the landing page's
 * "Create account" links here). Any other value, or none, opens sign-in.
 */

import { Suspense, useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, ArrowRight, CheckCircle2, Lock, Mail, Package, Truck } from 'lucide-react'
import { InfoDot } from '@/components/stat'
import {
  AuthShell, AuthCard, PANEL_SIGNIN, PANEL_VERIFY, PANEL_FORGOT, panelRegister,
} from '@/components/auth/auth-shell'
import {
  AuthAlert, IconField, ICON_INPUT, OrDivider, PasswordInput, StrengthMeter, SteeringWheel,
} from '@/components/auth/auth-ui'
import {
  ApiError, loginWithEmail, registerWithEmail, verifyEmailOtp, resendEmailOtp,
  forgotPassword, googleSignIn, type PrimaryPersona,
} from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { BTN_PRIMARY, INPUT, LABEL, LINK, TINT, cx, type Tint } from '@/lib/ui'
import type { AuthUser } from '@/lib/types'

type Mode = 'signin' | 'register' | 'verify' | 'forgot'

const PERSONAS: { value: PrimaryPersona; label: string; short: string; hint: string; tint: Tint }[] = [
  { value: 'shipper', label: 'I ship goods', short: 'Ship', hint: 'Post loads, track deliveries', tint: 'brand' },
  { value: 'driver', label: 'I drive a truck', short: 'Drive', hint: 'Just your DL to start — no truck needed', tint: 'blue' },
  { value: 'fleet_owner', label: 'I run a fleet', short: 'Fleet', hint: 'Trucks, drivers, bids', tint: 'green' },
]

function PersonaIcon({ value, className = 'w-5 h-5' }: { value: PrimaryPersona; className?: string }) {
  if (value === 'driver') return <SteeringWheel className={className} />
  if (value === 'fleet_owner') return <Truck className={className} />
  return <Package className={className} />
}

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID

const SUBMIT = cx(BTN_PRIMARY, 'h-12 w-full text-base shadow-[0_6px_16px_rgba(242,165,22,0.3)]')

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary so the static shell can prerender.
  return (
    <Suspense fallback={<div className="min-h-full bg-gray-50" />}>
      <LoginScreen />
    </Suspense>
  )
}

function initialMode(q: string | null): Mode {
  return q === 'register' || q === 'forgot' ? q : 'signin'
}

function LoginScreen() {
  const router = useRouter()
  const params = useSearchParams()
  const { login } = useAuth()
  const [mode, setMode] = useState<Mode>(() => initialMode(params.get('mode')))
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [persona, setPersona] = useState<PrimaryPersona>('shipper')
  const [otp, setOtp] = useState('')
  const [otpFocused, setOtpFocused] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const finishLogin = useCallback((d: { access_token: string; refresh_token: string; user?: AuthUser }) => {
    login(d.access_token, d.refresh_token, d.user)
    router.replace('/home')
  }, [login, router])

  function go(next: Mode) { setMode(next); setError(null); setNotice(null) }

  // An unverified account is not a failed sign-in: the server has just emailed a fresh
  // code (login 403 / register 409, both EMAIL_NOT_VERIFIED), so take the user to the
  // code screen instead of showing an error with nowhere to type it. Before this, the
  // only way into `verify` was a brand-new registration, so anyone whose first code
  // expired (10-minute TTL) or arrived late was locked out for good.
  function toVerify() {
    setOtp('')
    setError(null)
    setNotice(`This email isn't verified yet — we've sent a new 6-digit code to ${email.trim()}.`)
    setMode('verify')
    setBusy(false)
  }

  async function doSignin(e: FormEvent) {
    e.preventDefault(); setError(null); setBusy(true)
    try { finishLogin(await loginWithEmail(email.trim(), password)) }
    catch (err) {
      if (err instanceof ApiError && err.code === 'EMAIL_NOT_VERIFIED') return toVerify()
      setError(err instanceof ApiError ? err.message : 'Could not sign in'); setBusy(false)
    }
  }

  async function doRegister(e: FormEvent) {
    e.preventDefault(); setError(null); setBusy(true)
    try {
      await registerWithEmail(email.trim(), password, fullName.trim(), persona)
      setNotice(`We sent a 6-digit code to ${email.trim()}.`)
      setMode('verify'); setBusy(false)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'EMAIL_NOT_VERIFIED') return toVerify()
      setError(err instanceof ApiError ? err.message : 'Could not create the account'); setBusy(false)
    }
  }

  async function doVerify(e: FormEvent) {
    e.preventDefault(); setError(null); setBusy(true)
    try {
      // /auth/email/verify mints the session itself. Use it: a second password login here
      // is a wasted bcrypt round-trip, and it can 429 on the per-email lockout (wrong
      // guesses made on the sign-in screen count) right after a successful verify. The
      // password fallback only matters if a server ever answers without tokens.
      const v = await verifyEmailOtp(email.trim(), otp.trim())
      if (v?.access_token && v?.refresh_token) finishLogin({ access_token: v.access_token, refresh_token: v.refresh_token, user: v.user })
      else finishLogin(await loginWithEmail(email.trim(), password))
    } catch (err) { setError(err instanceof ApiError ? err.message : 'That code did not work — check it or resend.'); setBusy(false) }
  }

  async function doResend() {
    setError(null)
    try { await resendEmailOtp(email.trim()); setNotice('A new code has been sent.') }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Could not resend the code') }
  }

  async function doForgot(e: FormEvent) {
    e.preventDefault(); setError(null); setBusy(true)
    try { await forgotPassword(email.trim()); setNotice('If an account exists for that email, a reset link is on its way.'); setBusy(false) }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Could not send the reset link'); setBusy(false) }
  }

  // Google Identity Services — rendered only when a client id is configured (else the
  // button is a dead end, since bt-auth-service's /auth/google needs GOOGLE_CLIENT_ID too).
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || (mode !== 'signin' && mode !== 'register')) return
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'; script.async = true; script.defer = true
    script.onload = () => {
      const g = (window as unknown as { google?: { accounts?: { id?: { initialize: (o: unknown) => void; renderButton: (el: HTMLElement, o: unknown) => void } } } }).google
      if (!g?.accounts?.id) return
      g.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: async (resp: { credential: string }) => {
          try { finishLogin(await googleSignIn(resp.credential, persona)) }
          catch (err) { setError(err instanceof ApiError ? err.message : 'Google sign-in failed') }
        },
      })
      const el = document.getElementById('google-btn')
      // Google's own dark button in the dark theme (the theme is fixed when the button is drawn).
      const dark = document.documentElement.classList.contains('dark')
      if (el) g.accounts.id.renderButton(el, { theme: dark ? 'filled_black' : 'outline', size: 'large', width: 320, text: 'continue_with' })
    }
    document.body.appendChild(script)
    return () => { script.remove() }
  }, [mode, persona, finishLogin])

  const panel = mode === 'register' ? panelRegister(persona)
    : mode === 'verify' ? PANEL_VERIFY
      : mode === 'forgot' ? PANEL_FORGOT : PANEL_SIGNIN

  const alerts = <Alerts error={error} notice={notice} onDismissError={() => setError(null)} onDismissNotice={() => setNotice(null)} />
  const backLink = (
    <button type="button" onClick={() => go('signin')}
      className="mb-3 inline-flex items-center gap-1.5 rounded-md text-sm font-semibold text-blue-600 hover:text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
      <ArrowLeft className="h-4 w-4" aria-hidden /> Back to sign in
    </button>
  )

  return (
    <AuthShell panel={panel}>
      <AuthCard>
        {/* ── SIGN IN ── */}
        {mode === 'signin' && (
          <form onSubmit={doSignin} className="space-y-4">
            <Heading title="Welcome back" sub="Sign in to your BharatTruck account." />
            {alerts}
            <IconField id="email" label="Email" icon={<Mail />}>
              <input id="email" type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} className={ICON_INPUT} placeholder="you@company.in" />
            </IconField>
            <IconField id="password" label="Password" icon={<Lock />}
              aside={<button type="button" onClick={() => go('forgot')} className="mb-1.5 rounded text-sm font-semibold text-blue-600 hover:text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">Forgot?</button>}>
              <PasswordInput id="password" required autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter your password" />
            </IconField>
            <Submit busy={busy} label="Sign in" busyLabel="Signing in…" arrow />
            {GOOGLE_CLIENT_ID && <><OrDivider /><div id="google-btn" className="flex justify-center [color-scheme:light]" /></>}
            <p className="pt-1 text-center text-sm text-gray-600">
              New here? <button type="button" onClick={() => go('register')} className={cx(LINK, 'rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600')}>Create an account</button>
            </p>
          </form>
        )}

        {/* ── REGISTER ── */}
        {mode === 'register' && (
          <form onSubmit={doRegister} className="space-y-4">
            <div>
              {backLink}
              <Heading title="Create your account" sub="One account for shippers, drivers and fleet owners on BharatTruck." />
            </div>
            <fieldset>
              <legend className={cx(LABEL, 'flex items-center gap-1.5')}>I am a… <InfoDot text="Shapes where you start — never limits what you can do." /></legend>
              {/* Phones: three compact tiles, as in the mobile reference. */}
              <div className="grid grid-cols-3 gap-2 sm:hidden">
                {PERSONAS.map(p => {
                  const on = persona === p.value
                  return (
                    <button key={p.value} type="button" onClick={() => setPersona(p.value)} aria-pressed={on} aria-label={p.label}
                      className={cx('flex min-h-[72px] flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-2.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600',
                        on ? 'border-blue-600 bg-blue-600 text-[#fff]' : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50')}>
                      <span className={cx('inline-flex h-8 w-8 items-center justify-center rounded-lg', on ? 'bg-white/15 text-[#fff]' : TINT[p.tint])}>
                        <PersonaIcon value={p.value} />
                      </span>
                      {p.short}
                    </button>
                  )
                })}
              </div>
              <p className="mt-2 text-xs text-gray-500 sm:hidden">{PERSONAS.find(p => p.value === persona)?.hint}</p>
              {/* Wider screens: full rows with the hint. */}
              <div className="hidden space-y-2 sm:block">
                {PERSONAS.map(p => {
                  const on = persona === p.value
                  return (
                    <button key={p.value} type="button" onClick={() => setPersona(p.value)} aria-pressed={on}
                      className={cx('flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600',
                        on ? 'border-blue-600 bg-blue-50' : 'border-gray-200 bg-white hover:bg-gray-50')}>
                      <span className={cx('inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', TINT[p.tint])}>
                        <PersonaIcon value={p.value} className="h-[22px] w-[22px]" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={cx('block text-sm font-semibold', on ? 'text-blue-700' : 'text-gray-900')}>{p.label}</span>
                        <span className="block text-xs text-gray-500">{p.hint}</span>
                      </span>
                      {on && <CheckCircle2 className="h-5 w-5 shrink-0 fill-blue-600 text-[#fff]" aria-hidden />}
                    </button>
                  )
                })}
              </div>
            </fieldset>
            <div>
              <label htmlFor="full_name" className={LABEL}>Full name</label>
              <input id="full_name" type="text" required minLength={2} maxLength={100} autoComplete="name" value={fullName} onChange={e => setFullName(e.target.value)} className={INPUT} placeholder="Rajesh Kumar" />
            </div>
            <IconField id="r-email" label="Email" icon={<Mail />}>
              <input id="r-email" type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} className={ICON_INPUT} placeholder="you@company.in" />
            </IconField>
            <div>
              <IconField id="r-password" label="Password" icon={<Lock />}>
                <PasswordInput id="r-password" required minLength={8} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Create a password" />
              </IconField>
              <StrengthMeter password={password} hint="At least 8 characters" />
            </div>
            {alerts}
            <Submit busy={busy} label="Create account" busyLabel="Creating…" />
            {GOOGLE_CLIENT_ID && <><OrDivider /><div id="google-btn" className="flex justify-center [color-scheme:light]" /></>}
          </form>
        )}

        {/* ── VERIFY EMAIL OTP ── */}
        {mode === 'verify' && (
          <form onSubmit={doVerify} className="space-y-5">
            <div className="flex flex-col items-center text-center">
              <span className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-brand-100 text-brand-600" aria-hidden>
                <Mail className="h-7 w-7" />
              </span>
              <h2 className="mt-4 text-2xl font-bold tracking-tight text-gray-900">Verify your email</h2>
              <p className="mt-2 text-[0.9375rem] text-gray-600">
                Enter the 6-digit code we sent to<span className="block break-words font-semibold text-gray-900">{email}.</span>
              </p>
            </div>
            <OtpCells value={otp} focused={otpFocused}>
              <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={otp}
                aria-label="6-digit code"
                onFocus={() => setOtpFocused(true)} onBlur={() => setOtpFocused(false)}
                onChange={e => { setOtp(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(null) }}
                className="absolute inset-0 h-full w-full cursor-text bg-transparent text-transparent caret-transparent outline-none selection:bg-transparent" />
            </OtpCells>
            {alerts}
            <Submit busy={busy} label="Verify & continue" busyLabel="Verifying…" disabled={otp.length !== 6} />
            <p className="text-center text-sm text-gray-600">
              Didn&apos;t get it? <button type="button" onClick={doResend} className={cx(LINK, 'rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600')}>Resend code</button>
            </p>
            <div className="border-t border-gray-200 pt-4 text-center">
              <button type="button" onClick={() => go('signin')} className="inline-flex items-center gap-1.5 rounded text-sm font-semibold text-blue-600 hover:text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
                <ArrowLeft className="h-4 w-4" aria-hidden /> Back to sign in
              </button>
            </div>
          </form>
        )}

        {/* ── FORGOT ── */}
        {mode === 'forgot' && (
          <form onSubmit={doForgot} className="space-y-4">
            <div>
              {backLink}
              <Heading title="Reset your password" sub="Enter your email and we'll send a link to reset your password." />
            </div>
            <IconField id="f-email" label="Email" icon={<Mail />}>
              <input id="f-email" type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} className={ICON_INPUT} placeholder="you@company.in" />
            </IconField>
            <Submit busy={busy} label="Send reset link" busyLabel="Sending…" />
            {alerts}
            <p className="border-t border-gray-200 pt-4 text-center text-sm text-gray-600">
              Remember your password? <button type="button" onClick={() => go('signin')} className={cx(LINK, 'rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600')}>Sign in</button>
            </p>
          </form>
        )}
      </AuthCard>
    </AuthShell>
  )
}

function Heading({ title, sub }: { title: string; sub: string }) {
  return (
    <div>
      <h2 className="text-[1.625rem] font-bold leading-tight tracking-tight text-gray-900">{title}</h2>
      <p className="mt-1 text-[0.9375rem] text-gray-600">{sub}</p>
    </div>
  )
}

/**
 * Six code cells drawn behind ONE real input (which stays the source of truth), so paste,
 * SMS/email autofill and the submitted value are exactly what a single field gives.
 */
function OtpCells({ value, focused, children }: { value: string; focused: boolean; children: ReactNode }) {
  const active = Math.min(value.length, 5)
  return (
    <div className="relative mx-auto grid max-w-[380px] grid-cols-6 gap-2 sm:gap-3">
      {Array.from({ length: 6 }, (_, i) => {
        const ch = value[i]
        const isActive = focused && i === active
        return (
          <div key={i} aria-hidden
            className={cx('flex aspect-[5/6] items-center justify-center rounded-xl border bg-white font-mono text-2xl font-semibold text-gray-900 transition-colors sm:text-[1.625rem]',
              isActive ? 'border-blue-600 ring-2 ring-blue-100' : ch ? 'border-gray-300' : 'border-gray-200')}>
            {ch ?? (isActive ? <span className="h-6 w-px animate-pulse bg-blue-600" /> : '')}
          </div>
        )
      })}
      {children}
    </div>
  )
}

function Alerts({ error, notice, onDismissError, onDismissNotice }: {
  error: string | null; notice: string | null; onDismissError: () => void; onDismissNotice: () => void
}) {
  return (
    <>
      {error && <AuthAlert tone="error" onDismiss={onDismissError}>{error}</AuthAlert>}
      {notice && !error && <AuthAlert tone="notice" onDismiss={onDismissNotice}>{notice}</AuthAlert>}
    </>
  )
}

function Submit({ busy, label, busyLabel, disabled, arrow }: { busy: boolean; label: string; busyLabel: string; disabled?: boolean; arrow?: boolean }) {
  return (
    <button type="submit" disabled={busy || disabled} className={SUBMIT}>
      {busy ? busyLabel : label}
      {arrow && !busy && <ArrowRight className="h-4 w-4" aria-hidden />}
    </button>
  )
}
