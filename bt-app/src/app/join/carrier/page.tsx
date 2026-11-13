'use client'

/**
 * /join/carrier#<token> — where a SHIPPER's invite link lands (public: outside the (app) shell).
 *
 * Same token handling as /join (the fleet's driver link): the token lives in the URL fragment,
 * which the browser never sends to a server, is moved to sessionStorage on arrival, and survives
 * the trip through sign-in (/login?next=/join/carrier) without entering a query string.
 *
 * Who sees what:
 *   - anyone: who sent the link (the shipper's name) and until when it works
 *   - signed out: sign in, or create a fleet owner / driver account, both coming back here
 *   - a fleet owner, or a driver with their own truck: "Join <shipper>'s preferred carriers"
 *   - a driver without a truck: add your truck first (Trucks page), then come back
 *   - anyone else: this link is for fleet owners and truck drivers
 *   - bad / expired / replaced link: the server's own reason
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Building2, CalendarClock, LogIn, Package, Star, Truck, UserPlus } from 'lucide-react'
import { AuthCard, AuthShell, type PanelCopy } from '@/components/auth/auth-shell'
import { AuthAlert } from '@/components/auth/auth-ui'
import { IconTile } from '@/components/stat'
import { ApiError, acceptCarrierInvite, previewCarrierInvite, type CarrierJoinPreview } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { dateTime } from '@/lib/format'
import { BTN_PRIMARY, BTN_SECONDARY, LINK, cx } from '@/lib/ui'

const TOKEN_KEY = 'bt_carrier_join_token'
const HERE = '/join/carrier'

const PANEL: PanelCopy = {
  lines: [{ text: 'Loads from' }, { text: 'shippers who', accent: true }, { text: 'prefer you.' }],
  sub: 'Join a shipper\'s preferred carriers and their loads show a Preferred badge for you.',
  rows: [
    { icon: <Star />, tint: 'brand', title: 'Stand out on their loads', text: 'Your bids carry a Preferred badge.' },
    { icon: <Package />, tint: 'blue', title: 'See their loads first', text: 'Find Work marks the loads from shippers who prefer you.' },
    { icon: <Truck />, tint: 'green', title: 'For fleets and truck owners', text: 'Drivers need their own truck on BharatTruck.' },
  ],
}

function readToken(): string | null {
  if (typeof window === 'undefined') return null
  const fromHash = decodeURIComponent(window.location.hash.replace(/^#/, '')).trim()
  try {
    if (fromHash) {
      window.sessionStorage.setItem(TOKEN_KEY, fromHash)
      window.history.replaceState(null, '', window.location.pathname)
      return fromHash
    }
    return window.sessionStorage.getItem(TOKEN_KEY)
  } catch {
    return fromHash || null
  }
}

function forgetToken() {
  try { window.sessionStorage.removeItem(TOKEN_KEY) } catch { /* storage blocked */ }
}

type Dead = { title: string; message: string }

export default function CarrierJoinPage() {
  const router = useRouter()
  const { token: session, isReady, capabilities, user, logout } = useAuth()
  const [linkToken] = useState<string | null>(readToken)
  const [preview, setPreview] = useState<CarrierJoinPreview | null>(null)
  const [dead, setDead] = useState<Dead | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const work = linkToken ? previewCarrierInvite(linkToken) : Promise.reject(new ApiError('', 'NO_TOKEN'))
    work
      .then(setPreview)
      .catch((e) => {
        if (e instanceof ApiError && e.code === 'NO_TOKEN') {
          setDead({ title: 'No invite link found', message: 'Open the whole link the shipper sent you. If it still does not work, ask them to share it again.' })
        } else if (e instanceof ApiError && e.code === 'VALIDATION_ERROR') {
          // Every link refusal (invalid, expired, replaced, turned off) is a validation error.
          forgetToken()
          setDead({ title: 'This link does not work', message: e.message })
        } else {
          setError(e instanceof ApiError ? e.message : 'Could not open this invite link. Check your connection and try again.')
        }
      })
      .finally(() => setLoaded(true))
  }, [linkToken])

  const join = useCallback(async () => {
    if (!linkToken) return
    setBusy(true); setError(null)
    try {
      const res = await acceptCarrierInvite(linkToken)
      forgetToken()
      const who = res.shipper_name ?? 'this shipper'
      toast.success(res.added
        ? `You're now a preferred carrier for ${who}. Their loads show a Preferred badge on Find Work.`
        : `You're already a preferred carrier for ${who}.`)
      router.replace('/auctions')
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VALIDATION_ERROR') {
        forgetToken()
        setDead({ title: 'This link does not work any more', message: e.message })
      } else {
        setError(e instanceof ApiError ? e.message : 'Could not join. Please try again.')
      }
      setBusy(false)
    }
  }, [linkToken, router])

  function switchAccount() {
    logout()
    router.push(`/login?next=${HERE}`)
  }

  const shipper = preview?.shipper_name ?? 'this shipper'
  const runsFleet = capabilities?.includes('operate') ?? false
  const ownsTruck = capabilities?.includes('carry') ?? false
  const drives = capabilities?.includes('drive') ?? false
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
            <p className="text-sm font-medium text-gray-500">You&apos;re invited to be a preferred carrier for</p>
            <h1 className="text-xl font-bold leading-snug text-gray-900 break-words">{shipper}</h1>
          </div>
        </div>

        <p className="rounded-xl bg-gray-50 px-3.5 py-3 text-sm text-gray-700">
          When you join, {shipper} sees a Preferred badge on your bids, and you see one on their loads in Find Work.
          It does not give them access to your trucks, drivers or money.
          <span className="mt-1 block text-xs text-gray-500">This link works until {dateTime(preview.expires_at)}.</span>
        </p>

        {error && <AuthAlert tone="error">{error}</AuthAlert>}

        {!session ? (
          <div className="space-y-2.5">
            <Link href={`/login?next=${HERE}`} className={cx(BTN_PRIMARY, 'w-full h-12 text-base')}>
              <LogIn className="h-5 w-5" />
              Sign in to join
            </Link>
            <Link href={`/login?mode=register&as=fleet_owner&next=${HERE}`} className={cx(BTN_SECONDARY, 'w-full h-11')}>
              <UserPlus className="h-5 w-5" />
              New here? I run a fleet
            </Link>
            <Link href={`/login?mode=register&as=driver&next=${HERE}`} className={cx(BTN_SECONDARY, 'w-full h-11')}>
              <Truck className="h-5 w-5" />
              New here? I drive my own truck
            </Link>
          </div>
        ) : runsFleet || ownsTruck ? (
          <button type="button" onClick={() => void join()} disabled={busy} className={cx(BTN_PRIMARY, 'w-full h-12 text-base')}>
            <Star className="h-5 w-5" />
            {busy ? 'Joining…' : `Join ${shipper}'s preferred carriers`}
          </button>
        ) : drives ? (
          <div className="space-y-3">
            <AuthAlert tone="notice">
              Only drivers with their own truck can be a shipper&apos;s preferred carrier. Add your truck, then open this link again.
            </AuthAlert>
            <Link href="/vehicles" className={cx(BTN_PRIMARY, 'w-full h-11')}>
              <Truck className="h-4 w-4" />
              Add my truck
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            <AuthAlert tone="error">
              This link is for fleet owners and truck drivers. You&apos;re signed in as <strong>{who}</strong>, which has
              neither a fleet nor a truck. Sign in with your carrier account, or set up your fleet first.
            </AuthAlert>
            <button type="button" onClick={switchAccount} className={cx(BTN_SECONDARY, 'w-full h-11')}>
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
