'use client'

/**
 * /join#<token> — where a fleet owner's invite link lands (public: outside the (app) shell).
 *
 * The token is in the URL FRAGMENT, which the browser never sends to any server, so it never
 * reaches a request log. On arrival it is moved into sessionStorage and the fragment is dropped
 * from the address bar; that is also how it survives the trip through sign-in / create-account
 * (/login?next=/join) without ever being put in a query string.
 *
 * Who sees what:
 *   - anyone: which fleet the link is for (name + city only) and when it expires
 *   - signed out: "Sign in to join" / "Create a driver account", both coming back here
 *   - a driver: "Join <fleet>" — joined as ACTIVE at once (the link is the owner's approval)
 *   - a shipper: why they can't yet, and a one-tap "set up my driver profile and join"
 *   - a fleet owner account: that this link is for drivers, and how to switch account
 *   - bad / expired / replaced link, already in another fleet, etc.: the server's own reason
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Building2, CalendarClock, IdCard, LogIn, MapPin, ShieldCheck, Truck, UserPlus } from 'lucide-react'
import { AuthCard, AuthShell, type PanelCopy } from '@/components/auth/auth-shell'
import { AuthAlert, SteeringWheel } from '@/components/auth/auth-ui'
import { IconTile } from '@/components/stat'
import {
  ApiError, acceptJoinLink, becomeDriver, previewJoinLink, type JoinPreview,
} from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { dateTime } from '@/lib/format'
import { BTN_PRIMARY, BTN_SECONDARY, LINK, cx } from '@/lib/ui'

const TOKEN_KEY = 'bt_join_token'

const PANEL: PanelCopy = {
  lines: [{ text: 'Your fleet' }, { text: 'is waiting', accent: true }, { text: 'for you.' }],
  sub: 'Join with one tap — your trips, routes and proof of delivery in one app.',
  rows: [
    { icon: <SteeringWheel />, tint: 'blue', title: 'See the trips your fleet assigns you', text: 'Pickup, drop and the route, on your phone.' },
    { icon: <MapPin />, tint: 'green', title: 'Navigate and share live location', text: 'Only while a trip is running.' },
    { icon: <ShieldCheck />, tint: 'brand', title: 'Prove every delivery', text: 'Delivery code and geotagged photos at the drop.' },
  ],
}

// Codes that mean "this link is no good" — nothing to retry, ask the owner for a new one.
const DEAD_LINK = new Set(['LINK_INVALID', 'LINK_EXPIRED', 'LINK_REPLACED'])

function readToken(): string | null {
  if (typeof window === 'undefined') return null
  const fromHash = decodeURIComponent(window.location.hash.replace(/^#/, '')).trim()
  try {
    if (fromHash) {
      window.sessionStorage.setItem(TOKEN_KEY, fromHash)
      // Drop the fragment so the token is not left in the address bar or in screenshots.
      window.history.replaceState(null, '', window.location.pathname)
      return fromHash
    }
    return window.sessionStorage.getItem(TOKEN_KEY)
  } catch {
    return fromHash || null
  }
}

function forgetToken() {
  try { window.sessionStorage.removeItem(TOKEN_KEY) } catch { /* storage blocked: nothing kept */ }
}

type Dead = { title: string; message: string }

export default function JoinPage() {
  const router = useRouter()
  const { token: session, isReady, capabilities, user, logout, refresh } = useAuth()
  // Read once, on the client (null while prerendering; the first paint is a spinner either way).
  const [linkToken] = useState<string | null>(readToken)
  const [preview, setPreview] = useState<JoinPreview | null>(null)
  const [dead, setDead] = useState<Dead | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const work = linkToken ? previewJoinLink(linkToken) : Promise.reject(new ApiError('', 'NO_TOKEN'))
    work
      .then(setPreview)
      .catch(e => {
        if (e instanceof ApiError && e.code === 'NO_TOKEN') {
          setDead({ title: 'No invite link found', message: 'Open the whole link the fleet owner sent you. If it still does not work, ask them to share it again.' })
        } else if (e instanceof ApiError && DEAD_LINK.has(e.code)) {
          forgetToken()
          setDead({
            title: e.code === 'LINK_EXPIRED' ? 'This link has expired' : 'This link does not work',
            message: e.message,
          })
        } else {
          setError(e instanceof ApiError ? e.message : 'Could not open this invite link. Check your connection and try again.')
        }
      })
      .finally(() => setLoaded(true))
  }, [linkToken])

  const join = useCallback(async (opts: { becomeDriverFirst?: boolean } = {}) => {
    if (!linkToken) return
    setBusy(true); setError(null)
    try {
      if (opts.becomeDriverFirst) await becomeDriver()
      const res = await acceptJoinLink(linkToken)
      forgetToken()
      await refresh().catch(() => {}) // capabilities change: an employed driver sees a different product
      toast.success(res.already_member
        ? `You're already a driver with ${res.fleet.company_name}`
        : `You joined ${res.fleet.company_name}. Your trips will appear here when they assign you one.`)
      router.replace('/home')
    } catch (e) {
      if (e instanceof ApiError && DEAD_LINK.has(e.code)) {
        forgetToken()
        setDead({ title: 'This link does not work any more', message: e.message })
      } else {
        setError(e instanceof ApiError ? e.message : 'Could not join the fleet. Please try again.')
      }
      setBusy(false)
    }
  }, [linkToken, refresh, router])

  function switchAccount() {
    logout()
    router.push('/login?next=/join')
  }

  const fleetName = preview?.fleet.company_name ?? 'this fleet'
  const place = preview ? [preview.fleet.city, preview.fleet.state].filter(Boolean).join(', ') : ''
  const canDrive = capabilities?.includes('drive') ?? false
  const runsFleet = capabilities?.includes('operate') ?? false
  const who = user?.full_name || user?.email || user?.phone || 'this account'

  let body: React.ReactNode
  if (!loaded || (preview && session && (!isReady || capabilities === null))) {
    body = (
      <div className="flex items-center justify-center py-10" role="status" aria-label="Loading">
        <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-brand-500 border-t-transparent" />
      </div>
    )
  } else if (dead) {
    body = (
      <div className="space-y-5 text-center">
        <div className="flex justify-center"><IconTile icon={<CalendarClock />} tint="amber" size="lg" /></div>
        <div>
          <h1 className="text-xl font-bold text-gray-900">{dead.title}</h1>
          <p className="mt-2 text-sm text-gray-600">{dead.message}</p>
        </div>
        <Link href={session ? '/home' : '/'} className={cx(BTN_SECONDARY, 'w-full h-11')}>
          {session ? 'Go to my home' : 'Go to BharatTruck'}
        </Link>
      </div>
    )
  } else if (!preview) {
    body = (
      <div className="space-y-4">
        {error && <AuthAlert tone="error">{error}</AuthAlert>}
        <button type="button" onClick={() => window.location.reload()} className={cx(BTN_SECONDARY, 'w-full h-11')}>Try again</button>
      </div>
    )
  } else {
    body = (
      <div className="space-y-5">
        <div className="flex items-start gap-3.5">
          <IconTile icon={<Building2 />} tint="green" size="lg" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-500">You&apos;re invited to drive for</p>
            <h1 className="text-xl font-bold leading-snug text-gray-900 break-words">{fleetName}</h1>
            {place && (
              <p className="mt-0.5 flex items-center gap-1.5 text-sm text-gray-600">
                <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden />{place}
              </p>
            )}
          </div>
        </div>

        <p className="rounded-xl bg-gray-50 px-3.5 py-3 text-sm text-gray-700">
          When you join, {fleetName} can assign you trucks and trips.
          <span className="mt-1 block text-xs text-gray-500">This link works until {dateTime(preview.expires_at)}.</span>
        </p>

        {error && <AuthAlert tone="error">{error}</AuthAlert>}

        {!session ? (
          <div className="space-y-2.5">
            <Link href="/login?next=/join" className={cx(BTN_PRIMARY, 'w-full h-12 text-base')}>
              <LogIn className="h-5 w-5" />
              Sign in to join
            </Link>
            <Link href="/login?mode=register&as=driver&next=/join" className={cx(BTN_SECONDARY, 'w-full h-12 text-base')}>
              <UserPlus className="h-5 w-5" />
              New here? Create a driver account
            </Link>
          </div>
        ) : canDrive ? (
          <button type="button" onClick={() => void join()} disabled={busy} className={cx(BTN_PRIMARY, 'w-full h-12 text-base')}>
            <Truck className="h-5 w-5" />
            {busy ? 'Joining…' : `Join ${fleetName}`}
          </button>
        ) : runsFleet ? (
          <div className="space-y-3">
            <AuthAlert tone="error">
              This link is for drivers. You&apos;re signed in as <strong>{who}</strong>, a fleet owner account.
              Sign in with your driver account to join.
            </AuthAlert>
            <button type="button" onClick={switchAccount} className={cx(BTN_SECONDARY, 'w-full h-11')}>
              Use a different account
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <AuthAlert tone="notice">
              To join a fleet you need a driver profile. You&apos;re signed in as <strong>{who}</strong>, which
              doesn&apos;t have one yet — set it up now on this same account (you can add your licence later).
            </AuthAlert>
            <button type="button" onClick={() => void join({ becomeDriverFirst: true })} disabled={busy} className={cx(BTN_PRIMARY, 'w-full h-12 text-base')}>
              <IdCard className="h-5 w-5" />
              {busy ? 'Joining…' : `Become a driver and join ${fleetName}`}
            </button>
            <button type="button" onClick={switchAccount} disabled={busy} className={cx(BTN_SECONDARY, 'w-full h-11')}>
              Use a different account
            </button>
          </div>
        )}

        {session && (
          <p className="text-center text-xs text-gray-500">
            Not you? <button type="button" onClick={switchAccount} className={LINK}>Sign in as someone else</button>
          </p>
        )}
      </div>
    )
  }

  return (
    <AuthShell panel={PANEL} footer={false}>
      <AuthCard>{body}</AuthCard>
    </AuthShell>
  )
}
