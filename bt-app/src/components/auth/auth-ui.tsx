'use client'

/**
 * Presentational pieces shared by the sign-in, create-account, verify, forgot and
 * set-new-password screens (2026-10 light redesign). Nothing here talks to the API:
 * the pages own every call, state machine and validation rule.
 */

import { useState, type InputHTMLAttributes, type ReactNode } from 'react'
import { AlertCircle, CheckCircle2, Eye, EyeOff, X } from 'lucide-react'
import { INPUT, LABEL, cx } from '@/lib/ui'

/** A label above an input that carries a leading icon. */
export function IconField({ id, label, icon, aside, children }: {
  id: string; label: string; icon: ReactNode; aside?: ReactNode; children: ReactNode
}) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <label htmlFor={id} className={LABEL}>{label}</label>
        {aside}
      </div>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 [&_svg]:w-[18px] [&_svg]:h-[18px]" aria-hidden>
          {icon}
        </span>
        {children}
      </div>
    </div>
  )
}

/** Input classes for a field that sits inside IconField (room for the leading icon). */
export const ICON_INPUT = cx(INPUT, 'pl-10!')

/**
 * Password input with a show/hide toggle. Every attribute the page passes (required,
 * minLength, autoComplete, value, onChange) goes straight to the <input>; only `type`
 * flips between password and text while the eye is pressed.
 */
export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'>) {
  const [shown, setShown] = useState(false)
  return (
    <>
      <input {...props} type={shown ? 'text' : 'password'} className={cx(ICON_INPUT, 'pr-11!')} />
      <button
        type="button"
        onClick={() => setShown(s => !s)}
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
      >
        {shown ? <EyeOff className="w-[18px] h-[18px]" /> : <Eye className="w-[18px] h-[18px]" />}
      </button>
    </>
  )
}

/** Error (red) or notice (green) box with an icon and an optional dismiss button. */
export function AuthAlert({ tone, children, onDismiss }: { tone: 'error' | 'notice'; children: ReactNode; onDismiss?: () => void }) {
  const err = tone === 'error'
  return (
    <div
      role={err ? 'alert' : 'status'}
      className={cx(
        'flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-sm leading-snug',
        err ? 'border-red-200 bg-red-50 text-red-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800',
      )}
    >
      {err
        ? <AlertCircle className="mt-px w-[18px] h-[18px] shrink-0 fill-red-500 text-[#fff]" aria-hidden />
        : <CheckCircle2 className="mt-px w-[18px] h-[18px] shrink-0 fill-emerald-500 text-[#fff]" aria-hidden />}
      <div className="min-w-0 flex-1 break-words">{children}</div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss"
          className={cx('-mr-1 -mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600',
            err ? 'text-red-500 hover:bg-red-100' : 'text-emerald-600 hover:bg-emerald-100')}>
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  )
}

export function OrDivider() {
  return (
    <div className="flex items-center gap-3" aria-hidden>
      <span className="h-px flex-1 bg-gray-200" />
      <span className="text-xs font-medium text-gray-400">or</span>
      <span className="h-px flex-1 bg-gray-200" />
    </div>
  )
}

/**
 * Presentational password strength: four segments plus a word. It never blocks submit;
 * the real rule (at least 8 characters) stays on the input and in the page's validation.
 */
export function passwordStrength(pw: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  if (!pw) return { score: 0, label: '' }
  if (pw.length < 8) return { score: 1, label: 'Too short' }
  let s = 1
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++
  if (/\d/.test(pw)) s++
  if (/[^A-Za-z0-9]/.test(pw) || pw.length >= 14) s++
  const score = Math.min(4, s) as 1 | 2 | 3 | 4
  return { score, label: score === 4 ? 'Strong password' : score === 3 ? 'Good password' : 'Fair password' }
}

const BAR_ON: Record<number, string> = { 1: 'bg-red-500', 2: 'bg-amber-500', 3: 'bg-blue-600', 4: 'bg-blue-600' }
const WORD: Record<number, string> = { 1: 'text-red-600', 2: 'text-amber-700', 3: 'text-blue-700', 4: 'text-emerald-600' }

/** `hint` sits on the left (e.g. "At least 8 characters"); without it the word sits right. */
export function StrengthMeter({ password, hint }: { password: string; hint?: string }) {
  const { score, label } = passwordStrength(password)
  const bars = (
    <div className={cx('flex gap-1.5', hint ? 'w-28 sm:w-36' : 'flex-1')} aria-hidden>
      {[1, 2, 3, 4].map(i => (
        <span key={i} className={cx('h-1 flex-1 rounded-full transition-colors', i <= score ? BAR_ON[score] : 'bg-gray-200')} />
      ))}
    </div>
  )
  return (
    <div className="mt-2 flex items-center gap-3">
      {hint ? (
        <>
          <span className="flex-1 text-xs text-gray-500">{hint}{label && <span className="sr-only"> — {label}</span>}</span>
          {bars}
        </>
      ) : (
        <>
          {bars}
          <span className={cx('w-28 text-right text-xs font-semibold', score ? WORD[score] : 'text-gray-400')} aria-live="polite">
            {label || 'At least 8 characters'}
          </span>
        </>
      )}
    </div>
  )
}

/** A steering wheel (lucide has none): the driver glyph across the auth and landing screens. */
export function SteeringWheel({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" className={className} aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="2.2" />
      <path d="M3.6 10.5c2.6-.9 5.4-1.3 8.4-1.3s5.8.4 8.4 1.3" />
      <path d="M10.2 13.6 7 20" />
      <path d="M13.8 13.6 17 20" />
    </svg>
  )
}
