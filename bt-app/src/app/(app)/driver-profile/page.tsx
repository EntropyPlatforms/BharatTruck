'use client'

/**
 * Driver profile — a driver's OWN record, completed with no truck (2026-09-30).
 *
 * Four things live here: the verification checklist, personal details (name, languages,
 * home base), the driving licence, and the bank account payouts go to. Every call goes to
 * bt-auth-service /onboarding/* (gateway /api/onboarding/), which needs only the 'drive'
 * capability — a drivers row — and nothing else.
 *
 * A truck is deliberately NOT on this page. Adding one is a business act that needs the
 * GST registration on file (POST /fleet/vehicles and POST /onboarding/vehicle both answer
 * 403 GSTIN_REQUIRED without it), so the page only points at Settings for that.
 *
 * Layout (2026-10 light redesign): a profile header card, then (phone only) a summary
 * list that jumps to each section, the three forms on the left and the verification
 * checklist + "Have a truck?" on the right. The badge shown anywhere on this page is the
 * server's verification_badge — never inferred.
 */

import { useCallback, useEffect, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import Link from 'next/link'
import {
  ArrowRight, BadgeCheck, Check, ChevronRight, IdCard, Landmark, Languages, MapPin, ShieldCheck, Truck, UserRound, X,
} from 'lucide-react'
import { toast } from 'sonner'

import { PageHeader } from '@/components/app-shell'
import { Card, CardHead, ErrorNote, IconTile, Loading } from '@/components/stat'
import ScanDocument from '@/components/scan-document'
import { DigiLockerButton, DigiLockerReturn } from '@/components/digilocker-licence'
import {
  ApiError, becomeDriver, getDocumentScanConfig, getDriverOnboarding, getKycConfig, getOnboardingStatus, linkBankAccount, verifyKyc,
  submitDriverLicense, updateDriverLicense, updateDriverProfile,
} from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { shortDate } from '@/lib/format'
import { BTN_PRIMARY, BTN_SECONDARY, HINT, INPUT, LABEL, LINK, cx, pill, type PillTone } from '@/lib/ui'
import type {
  AadhaarScan, BankAccount, BankScan, DriverLicense, DriverOnboarding, KycConfig, LicenceScan, OnboardingStatus, VerificationBadge,
} from '@/lib/types'

// Mirrors the zod schemas in bt-auth-service/src/routes/onboarding.ts exactly.
const NAME_MIN = 2
const NAME_MAX = 100
const CITY_MAX = 100
const LANG_MAX = 10
const DL_MIN = 5
const DL_MAX = 30
const ACCOUNT_MIN = 8
const ACCOUNT_MAX = 18
const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/

/** Indian DL vehicle classes as printed on the licence. */
const VEHICLE_CLASSES = ['LMV', 'MCWG', 'HMV', 'HGMV', 'HPMV', 'TRANS', 'MGV', 'HTV'] as const

function errText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error) return e.message
  return fallback
}

const BADGE_TONE: Record<VerificationBadge, PillTone> = {
  pending:  'amber',
  verified: 'green',
  premium:  'indigo',
}

/** The server's verification_badge as a pill. Never shows "Verified" unless the server says so. */
function BadgePill({ badge, className = '' }: { badge: VerificationBadge; className?: string }) {
  return (
    <span className={cx(pill(BADGE_TONE[badge] ?? 'slate'), 'capitalize', className)}>
      {badge === 'pending' ? <span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> : <BadgeCheck className="w-3.5 h-3.5" />}
      {badge}
    </span>
  )
}

function statusTone(s: string | null | undefined): PillTone {
  if (s === 'verified') return 'green'
  if (s === 'rejected' || s === 'failed') return 'red'
  return 'amber'
}

/** "14 Aug 2031" — a licence expiry needs the year, unlike a pickup date. */
function fullDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? shortDate(iso) : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

/** Initials in a tinted circle, or the driver's own photo link when one is on file. Never a stock photo. */
function Avatar({ name, photoUrl, size = 'lg' }: { name: string | null; photoUrl?: string | null; size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 'w-20 h-20 text-2xl' : 'w-14 h-14 text-lg'
  const usable = photoUrl && /^https?:\/\//.test(photoUrl)
  return (
    <span className={cx(box, 'rounded-full shrink-0 overflow-hidden bg-blue-100 text-blue-700 font-bold flex items-center justify-center ring-4 ring-white shadow-sm')}>
      {usable
        // eslint-disable-next-line @next/next/no-img-element -- an arbitrary external link the driver supplied; next/image would need it allow-listed
        ? <img src={photoUrl} alt="" className="w-full h-full object-cover" />
        : initialsOf(name)}
    </span>
  )
}

type PageData = { profile: DriverOnboarding; status: OnboardingStatus }

const PAGE = 'p-4 lg:p-8 max-w-[112rem] mx-auto'

export default function DriverProfilePage() {
  const { personas, refresh, user } = useAuth()
  const [data, setData] = useState<PageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [noDriverRow, setNoDriverRow] = useState(false)
  const [nonce, setNonce] = useState(0)
  // Document scan is offered only when the server has OCR configured; a failed read means "off".
  const [scan, setScan] = useState(false)
  // Which government checks the server can run (DigiLocker licence pull, bank penny-drop).
  const [kyc, setKyc] = useState<KycConfig | null>(null)

  useEffect(() => {
    let cancelled = false
    getDocumentScanConfig().then(c => { if (!cancelled) setScan(c.enabled) }).catch(() => {})
    getKycConfig().then(c => { if (!cancelled) setKyc(c) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([getDriverOnboarding(), getOnboardingStatus()])
      .then(([profile, status]) => {
        if (cancelled) return
        setData({ profile, status })
        setNoDriverRow(false)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        // 403 "Only drivers can access onboarding" / 404 "Driver profile not found":
        // the account has no drivers row yet. Offer the one-tap fix instead of an error.
        if (e instanceof ApiError && (e.code === 'FORBIDDEN' || e.code === 'NOT_FOUND')) setNoDriverRow(true)
        else setError(errText(e, 'Could not load your driver profile'))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [nonce])

  const reload = useCallback(() => {
    setLoading(true)
    setError(null)
    setNonce(n => n + 1)
  }, [])

  /** Post-write refresh: swap in fresh data without blanking the page. */
  const silentReload = useCallback(async () => {
    try {
      const [profile, status] = await Promise.all([getDriverOnboarding(), getOnboardingStatus()])
      setData({ profile, status })
    } catch { /* the toast on the write already told the driver it saved */ }
  }, [])

  const header = (
    <PageHeader
      title="Driver profile"
      subtitle="Your details, driving licence and payout account. No truck needed."
    />
  )

  if (loading) {
    return <div className={PAGE}>{header}<Loading label="Loading your driver profile" /></div>
  }

  if (noDriverRow || (!data && !error && !personas?.driver_id)) {
    return (
      <div className={PAGE}>
        {header}
        <BecomeDriverCard onDone={async () => { await refresh(); reload() }} />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className={PAGE}>
        {header}
        <div className="space-y-3">
          <ErrorNote message={error ?? 'No driver profile returned'} />
          <button onClick={reload} className={BTN_SECONDARY}>Try again</button>
        </div>
      </div>
    )
  }

  const { profile, status } = data

  return (
    <div className={PAGE}>
      {header}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
        <div className="lg:col-span-2 space-y-5">
          <ProfileHeaderCard profile={profile} status={status} />
          <SummaryList profile={profile} status={status} />
          <DetailsCard profile={profile} scan={scan} onSaved={silentReload} />
          <DigiLockerReturn onImported={silentReload} />
          <LicenceCard license={profile.license} scan={scan} digilocker={!!kyc?.digilocker} onSaved={silentReload} />
          <BankCard accounts={profile.bank_accounts} scan={scan} holderName={profile.user.full_name} verify={!!kyc && kyc.provider !== 'console' ? { userId: user?.id ?? '' } : null} onSaved={silentReload} />
        </div>
        <div className="space-y-5">
          <ChecklistCard status={status} />
          <TruckLaterCard />
        </div>
      </div>
    </div>
  )
}

// ── Profile header + phone summary ────────────────────────────

function ProfileHeaderCard({ profile, status }: { profile: DriverOnboarding; status: OnboardingStatus }) {
  const langs = profile.driver.languages ?? []
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-center gap-4">
        <Avatar name={profile.user.full_name} photoUrl={profile.driver.photo_url} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className="text-xl font-bold text-gray-900 truncate">{profile.user.full_name ?? 'Your name'}</p>
            <BadgePill badge={status.verification_badge} />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-600">
            {profile.driver.home_base_city && (
              <span className="inline-flex items-center gap-1.5"><MapPin className="w-4 h-4 text-gray-400" />{profile.driver.home_base_city}</span>
            )}
            {langs.length > 0 && (
              <span className="inline-flex items-center gap-1.5"><Languages className="w-4 h-4 text-gray-400" />{langs.join(', ')}</span>
            )}
          </div>
        </div>
      </div>
    </Card>
  )
}

function checklistRows(status: OnboardingStatus) {
  const c = status.checklist
  return [
    { label: 'Personal details', done: c.profile_complete, hint: 'Photo link, languages and home base' },
    { label: 'Driving licence submitted', done: c.license_submitted, hint: undefined as string | undefined },
    { label: 'Driving licence verified', done: c.license_verified, hint: 'Checked by our ops team' },
    { label: 'Bank account linked', done: c.bank_linked, hint: undefined as string | undefined },
  ]
}

/** Phone-only: one row per section, jumping to it — the reference's mobile profile list. */
function SummaryList({ profile, status }: { profile: DriverOnboarding; status: OnboardingStatus }) {
  const rows = checklistRows(status)
  const done = rows.filter(r => r.done).length
  const lic = profile.license
  const primary = profile.bank_accounts.find(a => a.is_primary) ?? profile.bank_accounts[0]

  const items: { href: string; icon: ReactNode; tint: 'green' | 'blue' | 'amber' | 'slate'; title: string; sub: ReactNode }[] = [
    { href: '#verification', icon: <ShieldCheck />, tint: done === rows.length ? 'green' : 'amber', title: 'Verification', sub: `${done} of ${rows.length} completed` },
    {
      href: '#personal', icon: <UserRound />, tint: 'blue', title: 'Personal details',
      sub: [profile.user.full_name, profile.driver.home_base_city].filter(Boolean).join(' · ') || 'Add your details',
    },
    {
      href: '#licence', icon: <IdCard />, tint: 'amber', title: 'Driving licence',
      sub: lic
        ? <><span className={cx('capitalize font-semibold', lic.status === 'verified' ? 'text-emerald-700' : 'text-amber-700')}>{lic.status}</span>{lic.expiry_date ? ` · Expires ${fullDate(lic.expiry_date)}` : ''}</>
        : 'Not submitted yet',
    },
    {
      href: '#bank', icon: <Landmark />, tint: 'blue', title: 'Bank account',
      sub: primary ? `${primary.bank_name ?? 'Bank'} ···· ${primary.account_number_last4}` : 'Not linked yet',
    },
  ]

  return (
    <nav aria-label="Profile sections" className="lg:hidden space-y-2.5">
      {items.map(it => (
        <a
          key={it.href}
          href={it.href}
          className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 min-h-[64px] hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
        >
          <IconTile icon={it.icon} tint={it.tint} />
          <span className="min-w-0 flex-1">
            <span className="block text-[0.9375rem] font-bold text-gray-900">{it.title}</span>
            <span className="block text-sm text-gray-500 truncate">{it.sub}</span>
          </span>
          <ChevronRight className="w-5 h-5 text-gray-400 shrink-0" />
        </a>
      ))}
    </nav>
  )
}

// ── Become a driver (no drivers row yet) ──────────────────────

function BecomeDriverCard({ onDone }: { onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  async function go() {
    setBusy(true)
    try {
      await becomeDriver()
      toast.success('Driver profile created — add your details below')
      await onDone()
    } catch (e) {
      toast.error(errText(e, 'Could not create the driver profile'))
      setBusy(false)
    }
  }
  return (
    <Card className="max-w-lg">
      <div className="py-10 px-6 flex flex-col items-center text-center">
        <span className="w-16 h-16 rounded-2xl bg-brand-50 text-brand-600 flex items-center justify-center mb-4">
          <IdCard className="w-8 h-8" />
        </span>
        <p className="text-lg font-bold text-gray-900">Drive for BharatTruck?</p>
        <p className="text-sm text-gray-500 mt-1 mb-5 max-w-sm">
          Register as a driver with just your driving licence and details. You do not need a truck.
        </p>
        <button onClick={go} disabled={busy} className={cx(BTN_PRIMARY, 'h-12! w-full max-w-xs text-base!')}>
          {busy ? 'Setting up…' : 'Register as a driver'}
        </button>
      </div>
    </Card>
  )
}

// ── Verification checklist ────────────────────────────────────

function ChecklistCard({ status }: { status: OnboardingStatus }) {
  const rows = checklistRows(status)
  return (
    <Card>
      <div id="verification" className="scroll-mt-20" />
      <div className="px-5 pt-5 pb-3 flex items-start gap-3">
        <IconTile icon={<ShieldCheck />} tint="green" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-bold text-gray-900">Verification</h2>
            <BadgePill badge={status.verification_badge} />
          </div>
          <p className="text-sm text-gray-500 mt-0.5">Your badge is earned on your own details — a truck is not required.</p>
        </div>
      </div>
      <ul className="px-5 pb-5 pt-1 space-y-3.5">
        {rows.map(r => (
          <li key={r.label} className="flex items-start gap-3">
            {r.done ? (
              <span className="w-6 h-6 rounded-full bg-emerald-500 text-[#fff] flex items-center justify-center shrink-0" aria-hidden>
                <Check className="w-3.5 h-3.5" strokeWidth={3} />
              </span>
            ) : (
              <span className="w-6 h-6 rounded-full border-2 border-gray-300 bg-white shrink-0" aria-hidden />
            )}
            <span className="min-w-0">
              <span className={cx('block text-sm font-medium', r.done ? 'text-gray-900' : 'text-gray-600')}>
                {r.label}
                <span className="sr-only">{r.done ? ' — done' : ' — not yet'}</span>
              </span>
              {r.hint && <span className="block text-xs text-gray-500 mt-0.5">{r.hint}</span>}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function TruckLaterCard() {
  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <IconTile icon={<Truck />} tint="blue" />
        <div className="min-w-0 text-sm text-gray-600 space-y-2">
          <h2 className="text-base font-bold text-gray-900">Have a truck?</h2>
          <p>Trucks are added separately and need the business&apos;s GST registration on file.</p>
          <p>
            Save your GSTIN in <Link href="/settings" className={LINK}>Settings</Link>,
            set up fleet management there, and then add trucks.
          </p>
          <Link href="/settings" className={cx(LINK, 'inline-flex items-center gap-1.5 h-10')}>
            Go to Settings <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </Card>
  )
}

// ── Personal details (PUT /onboarding/profile) ────────────────

function DetailsCard({ profile, scan, onSaved }: { profile: DriverOnboarding; scan: boolean; onSaved: () => Promise<void> }) {
  const initial = {
    full_name: profile.user.full_name ?? '',
    photo_url: profile.driver.photo_url ?? '',
    languages: (profile.driver.languages ?? []).join(', '),
    home_base_city: profile.driver.home_base_city ?? '',
  }
  const [form, setForm] = useState(initial)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const dirty = (Object.keys(form) as (keyof typeof form)[]).some(k => form[k].trim() !== initial[k].trim())
  // Which card was read, so the driver can tell it was theirs. The number itself never arrives.
  const [cardRead, setCardRead] = useState<string | null>(null)

  // Fill only what the card gave us; the fields stay editable, and nothing is saved until Save.
  function fillFromAadhaar(f: AadhaarScan) {
    setForm(prev => ({
      ...prev,
      full_name: f.name ?? prev.full_name,
      home_base_city: f.city ?? prev.home_base_city,
    }))
    setCardRead(f.aadhaar_last4 ? `Aadhaar ending ${f.aadhaar_last4}` : 'Aadhaar card')
    setErr(null)
  }

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const body: Parameters<typeof updateDriverProfile>[0] = {}
    const name = form.full_name.trim()
    if (name !== initial.full_name.trim()) {
      if (name.length < NAME_MIN || name.length > NAME_MAX) { setErr(`Name must be ${NAME_MIN}–${NAME_MAX} characters.`); return }
      body.full_name = name
    }
    const photo = form.photo_url.trim()
    if (photo !== initial.photo_url.trim()) {
      if (photo && !/^https?:\/\//.test(photo)) { setErr('Photo link must start with http:// or https://.'); return }
      if (photo) body.photo_url = photo
    }
    const langs = form.languages.split(',').map(s => s.trim()).filter(Boolean)
    if (form.languages.trim() !== initial.languages.trim()) {
      if (langs.length > LANG_MAX) { setErr(`At most ${LANG_MAX} languages.`); return }
      body.languages = langs
    }
    const city = form.home_base_city.trim()
    if (city !== initial.home_base_city.trim()) {
      if (!city || city.length > CITY_MAX) { setErr(`Home base city must be 1–${CITY_MAX} characters.`); return }
      body.home_base_city = city
    }
    if (Object.keys(body).length === 0) return

    setBusy(true)
    setErr(null)
    try {
      await updateDriverProfile(body)
      toast.success('Details saved')
      await onSaved()
    } catch (e2) {
      setErr(errText(e2, 'Could not save your details'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <div id="personal" className="scroll-mt-20" />
      <CardHead
        title="Personal details"
        sub="What a fleet owner or shipper sees about you."
        icon={<UserRound />}
        tint="blue"
      />
      <form onSubmit={submit}>
        <div className="p-5 space-y-4">
          {scan && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-blue-100 bg-blue-50/60 px-3.5 py-3">
              <ScanDocument kind="aadhaar" enabled label="Scan Aadhaar card" onFields={fillFromAadhaar} />
              <p className="text-sm text-gray-600">
                {cardRead
                  ? `Read from your ${cardRead}. Check the details, then save — or edit anything that is wrong.`
                  : 'Take a photo of your Aadhaar card to fill in your name and home city, or type them in below. The Aadhaar number is not kept.'}
              </p>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field id="full_name" label="Full name">
              <input id="full_name" type="text" value={form.full_name}
                onChange={e => set('full_name', e.target.value.slice(0, NAME_MAX))}
                placeholder="Ramesh Yadav" className={INPUT} />
            </Field>
            <Field id="home_base_city" label="Home base city" hint="Where you usually start and end.">
              <input id="home_base_city" type="text" value={form.home_base_city}
                onChange={e => set('home_base_city', e.target.value.slice(0, CITY_MAX))}
                placeholder="Nagpur" className={INPUT} />
            </Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field id="languages" label="Languages" hint="Type a language and press Enter, e.g. Hindi, Marathi">
              <LanguageChips id="languages" value={form.languages} onChange={v => set('languages', v)} />
            </Field>
            <Field id="photo_url" label="Photo link" hint="A link to your photo. Upload from the app is coming; a link works today.">
              <div className="flex items-center gap-3">
                <Avatar name={form.full_name || profile.user.full_name} photoUrl={form.photo_url.trim() || null} size="md" />
                <input id="photo_url" type="url" value={form.photo_url}
                  onChange={e => set('photo_url', e.target.value)}
                  placeholder="https://…" className={INPUT} />
              </div>
            </Field>
          </div>
          {(profile.user.phone_number || profile.user.email) && (
            <p className="text-xs text-gray-500">
              {profile.user.phone_number ? `Phone on file: ${profile.user.phone_number}. ` : ''}
              {profile.user.email ? `Email: ${profile.user.email}.` : ''}
            </p>
          )}
          {err && <ErrorNote message={err} />}
        </div>
        <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-t border-gray-100">
          <p className={cx('text-sm inline-flex items-center gap-1.5', dirty ? 'text-amber-700' : 'text-emerald-700')}>
            {!dirty && <span className="w-5 h-5 rounded-full bg-emerald-500 text-[#fff] flex items-center justify-center"><Check className="w-3 h-3" strokeWidth={3} /></span>}
            {dirty ? 'Unsaved changes' : 'Saved'}
          </p>
          <button type="submit" disabled={busy || !dirty} className={BTN_PRIMARY}>
            {busy ? 'Saving…' : 'Save details'}
          </button>
        </div>
      </form>
    </Card>
  )
}

/**
 * Languages as removable chips over the SAME comma-separated string the form has always
 * held (and validated on submit). Enter or a comma adds what is typed; blur adds it too.
 */
function LanguageChips({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState('')
  const chips = value.split(',').map(s => s.trim()).filter(Boolean)

  function commit(text: string) {
    const t = text.trim()
    if (!t) return
    if (!chips.some(c => c.toLowerCase() === t.toLowerCase())) onChange([...chips, t].join(', '))
    setDraft('')
  }
  function remove(i: number) {
    onChange(chips.filter((_, j) => j !== i).join(', '))
  }
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(draft) }
    else if (e.key === 'Backspace' && !draft && chips.length) remove(chips.length - 1)
  }

  return (
    <div className="min-h-[42px] w-full rounded-[10px] border border-gray-200 bg-white px-1.5 py-1.5 flex flex-wrap items-center gap-1.5 focus-within:border-blue-600 focus-within:ring-2 focus-within:ring-blue-100">
      {chips.map((c, i) => (
        <span key={`${c}-${i}`} className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-gray-50 pl-2 pr-0.5 h-7 text-sm text-gray-800">
          {c}
          <button type="button" onClick={() => remove(i)} aria-label={`Remove ${c}`}
            className="w-6 h-6 rounded inline-flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
            <X className="w-3.5 h-3.5" />
          </button>
        </span>
      ))}
      <input
        id={id}
        type="text"
        value={draft}
        onChange={e => {
          const v = e.target.value
          if (v.includes(',')) { v.split(',').slice(0, -1).forEach(commit); setDraft(v.split(',').pop() ?? '') }
          else setDraft(v)
        }}
        onKeyDown={onKeyDown}
        onBlur={() => commit(draft)}
        placeholder={chips.length ? 'Add a language…' : 'Hindi, Marathi'}
        className="flex-1 min-w-[110px] h-7 px-1.5 text-sm text-gray-900 placeholder:text-gray-400 outline-none bg-transparent"
      />
    </div>
  )
}

// ── Driving licence (POST / PUT /onboarding/license) ──────────

function LicenceCard({ license, scan, digilocker, onSaved }: { license: DriverLicense | null; scan: boolean; digilocker: boolean; onSaved: () => Promise<void> }) {
  const initial = {
    dl_number: license?.dl_number ?? '',
    expiry_date: license?.expiry_date ?? '',
    classes: new Set<string>(license?.vehicle_classes ?? []),
  }
  const [dl, setDl] = useState(initial.dl_number)
  const [expiry, setExpiry] = useState(initial.expiry_date)
  const [classes, setClasses] = useState<Set<string>>(initial.classes)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const classesChanged =
    classes.size !== initial.classes.size || [...classes].some(c => !initial.classes.has(c))
  const dirty = dl.trim() !== initial.dl_number || expiry !== initial.expiry_date || classesChanged

  // Fill only what the photo actually gave us; a field it could not read keeps what is typed.
  function fillFromScan(f: LicenceScan) {
    if (f.dl_number) setDl(f.dl_number.slice(0, DL_MAX))
    if (f.expiry_date) setExpiry(f.expiry_date)
    const known = f.vehicle_classes.filter(c => (VEHICLE_CLASSES as readonly string[]).includes(c))
    if (known.length) setClasses(new Set(known))
    setErr(null)
  }

  function toggle(c: string) {
    setClasses(prev => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c); else next.add(c)
      return next
    })
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const number = dl.trim().toUpperCase()
    if (number.length < DL_MIN || number.length > DL_MAX) {
      setErr(`DL number must be ${DL_MIN}–${DL_MAX} characters, as printed on the licence.`)
      return
    }
    if (expiry && !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) { setErr('Expiry must be a date.'); return }

    setBusy(true)
    setErr(null)
    try {
      if (license) {
        const patch: Parameters<typeof updateDriverLicense>[0] = {}
        if (number !== initial.dl_number) patch.dl_number = number
        if (expiry !== initial.expiry_date && expiry) patch.expiry_date = expiry
        if (classesChanged) patch.vehicle_classes = [...classes]
        if (Object.keys(patch).length === 0) return
        await updateDriverLicense(patch)
        toast.success('Licence updated — it will be re-checked')
      } else {
        await submitDriverLicense({
          dl_number: number,
          ...(expiry ? { expiry_date: expiry } : {}),
          ...(classes.size ? { vehicle_classes: [...classes] } : {}),
        })
        toast.success('Driving licence submitted')
      }
      await onSaved()
    } catch (e2) {
      setErr(errText(e2, 'Could not save the licence'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <div id="licence" className="scroll-mt-20" />
      <CardHead
        title="Driving licence"
        sub="Proof you may legally drive the vehicle class. Verified by our ops team."
        icon={<IdCard />}
        tint="amber"
      />
      <form onSubmit={submit}>
        <div className="p-5 space-y-4">
          {license && (
            <p className="text-sm flex flex-wrap items-center gap-2">
              <span className="text-gray-500">Status:</span>
              <span className={cx(pill(statusTone(license.status)), 'capitalize')}>{license.status}</span>
              {license.expiry_date && <span className="text-gray-500">expires {fullDate(license.expiry_date)}</span>}
            </p>
          )}
          {digilocker && license?.status !== 'verified' && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-emerald-100 bg-emerald-50/60 px-3.5 py-3">
              <DigiLockerButton enabled />
              <p className="text-sm text-gray-700">Fastest: pull your licence from the transport department's record through DigiLocker. It is verified on the spot — nothing to type.</p>
            </div>
          )}
          {scan && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-blue-100 bg-blue-50/60 px-3.5 py-3">
              <ScanDocument kind="licence" enabled label="Scan your licence" onFields={fillFromScan} />
              <p className="text-sm text-gray-600">Take a photo of the front of your licence and we fill this in for you.</p>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field id="dl_number" label="DL number" hint="As printed, e.g. MH1220110012345">
              <input id="dl_number" type="text" autoComplete="off" value={dl}
                onChange={e => setDl(e.target.value.toUpperCase().replace(/[^0-9A-Z\-\s/]/g, '').slice(0, DL_MAX))}
                placeholder="MH1220110012345" className={`${INPUT} font-mono tracking-wide uppercase`} />
            </Field>
            <Field id="expiry_date" label="Valid till">
              <input id="expiry_date" type="date" value={expiry}
                onChange={e => setExpiry(e.target.value)} className={INPUT} />
            </Field>
          </div>
          <fieldset>
            <legend className={LABEL}>Vehicle classes</legend>
            <div className="flex flex-wrap gap-2">
              {VEHICLE_CLASSES.map(c => (
                <label key={c} className={cx(
                  'cursor-pointer select-none rounded-lg border min-w-[64px] h-10 px-3 inline-flex items-center justify-center text-sm font-semibold transition-colors',
                  'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-blue-600',
                  classes.has(c) ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50',
                )}>
                  <input type="checkbox" className="sr-only" checked={classes.has(c)} onChange={() => toggle(c)} />
                  {c}
                </label>
              ))}
            </div>
          </fieldset>
          {err && <ErrorNote message={err} />}
        </div>
        <div className="flex flex-wrap items-center gap-3 px-5 py-3.5 border-t border-gray-100">
          <button type="submit" disabled={busy || !dirty} className={BTN_PRIMARY}>
            {busy ? 'Saving…' : license ? 'Update licence' : 'Submit licence'}
          </button>
          <p className="text-sm text-gray-500">
            {license ? (dirty ? 'Editing resets verification' : 'Saved') : 'Not submitted yet'}
          </p>
        </div>
      </form>
    </Card>
  )
}

// ── Bank account (POST /onboarding/bank-account) ──────────────

function BankCard({ accounts, scan, holderName, verify, onSaved }: {
  accounts: BankAccount[]; scan: boolean; holderName: string | null
  /** When set, a newly linked account is checked with the bank (penny-drop) right away. */
  verify: { userId: string } | null
  onSaved: () => Promise<void>
}) {
  const [adding, setAdding] = useState(accounts.length === 0)
  const [form, setForm] = useState({ account_number: '', ifsc: '', account_holder_name: '', bank_name: '' })
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  // A cheque rarely prints a labelled holder name, so fall back to the name on the profile —
  // the driver's own account is the usual case, and the field stays editable.
  function fillFromScan(f: BankScan) {
    setForm(prev => ({
      account_number: f.account_number?.slice(0, ACCOUNT_MAX) ?? prev.account_number,
      ifsc: f.ifsc ?? prev.ifsc,
      bank_name: f.bank_name ?? prev.bank_name,
      account_holder_name: f.account_holder_name ?? (prev.account_holder_name || holderName || ''),
    }))
    setErr(null)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const account = form.account_number.trim()
    const ifsc = form.ifsc.trim().toUpperCase()
    const holder = form.account_holder_name.trim()
    if (account.length < ACCOUNT_MIN || account.length > ACCOUNT_MAX || !/^\d+$/.test(account)) {
      setErr(`Account number must be ${ACCOUNT_MIN}–${ACCOUNT_MAX} digits.`); return
    }
    if (!IFSC_PATTERN.test(ifsc)) { setErr('IFSC must be 11 characters, e.g. HDFC0001234.'); return }
    if (holder.length < NAME_MIN || holder.length > NAME_MAX) { setErr('Enter the account holder name as on the passbook.'); return }

    setBusy(true)
    setErr(null)
    try {
      await linkBankAccount({
        account_number: account, ifsc, account_holder_name: holder,
        ...(form.bank_name.trim() ? { bank_name: form.bank_name.trim() } : {}),
      })
      toast.success('Bank account linked')
      // Best-effort: confirm the account exists and the holder's name matches, so payouts
      // never go to a mistyped number. A failed check leaves the account for ops to review.
      if (verify?.userId) {
        try {
          const v = await verifyKyc('bank', verify.userId, 'DRIVER', { account_number: account, ifsc, name: holder })
          if (v.result.status === 'success') toast.success('Account confirmed with the bank')
          else if (v.result.status === 'failed') toast.error(v.result.error ?? 'The bank could not confirm this account — check the number and IFSC')
        } catch { /* the link itself succeeded; verification is advisory */ }
      }
      setForm({ account_number: '', ifsc: '', account_holder_name: '', bank_name: '' })
      setAdding(false)
      await onSaved()
    } catch (e2) {
      setErr(errText(e2, 'Could not link the bank account'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <div id="bank" className="scroll-mt-20" />
      <CardHead
        title="Bank account"
        sub="Where your trip payouts are settled. The number is stored encrypted."
        icon={<Landmark />}
        tint="blue"
      />
      <div className="p-5 space-y-4">
        {accounts.length > 0 && (
          <ul className="space-y-2">
            {accounts.map(a => (
              <li key={a.id} className="flex items-center gap-3 rounded-xl border border-gray-200 px-3.5 py-3">
                <IconTile icon={<Landmark />} tint="slate" size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[0.9375rem] font-semibold text-gray-900">
                    {a.bank_name ?? 'Bank'} <span className="font-mono tracking-wide">···· {a.account_number_last4}</span>
                  </span>
                  <span className="block text-sm text-gray-500 truncate">
                    {a.account_holder_name} · <span className="font-mono tracking-wide">{a.ifsc}</span>
                  </span>
                  <AccountPills a={a} className="flex mt-1.5 sm:hidden" />
                </span>
                <AccountPills a={a} className="hidden sm:flex shrink-0 justify-end" />
              </li>
            ))}
          </ul>
        )}

        {adding ? (
          <form onSubmit={submit} className="space-y-4">
            {scan && (
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-blue-100 bg-blue-50/60 px-3.5 py-3">
                <ScanDocument kind="bank" enabled label="Scan cheque or passbook" onFields={fillFromScan} />
                <p className="text-sm text-gray-600">Take a photo of a cancelled cheque or the first page of your passbook.</p>
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              <Field id="account_number" label="Account number">
                <input id="account_number" type="text" inputMode="numeric" autoComplete="off" value={form.account_number}
                  onChange={e => set('account_number', e.target.value.replace(/\D/g, '').slice(0, ACCOUNT_MAX))}
                  className={`${INPUT} font-mono tracking-wide tabular-nums`} />
              </Field>
              <Field id="ifsc" label="IFSC">
                <input id="ifsc" type="text" autoComplete="off" value={form.ifsc}
                  onChange={e => set('ifsc', e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 11))}
                  placeholder="HDFC0001234" className={`${INPUT} font-mono tracking-wide uppercase`} />
              </Field>
              <Field id="account_holder_name" label="Account holder name">
                <input id="account_holder_name" type="text" value={form.account_holder_name}
                  onChange={e => set('account_holder_name', e.target.value.slice(0, NAME_MAX))}
                  className={INPUT} />
              </Field>
              <Field id="bank_name" label="Bank (optional)">
                <input id="bank_name" type="text" value={form.bank_name}
                  onChange={e => set('bank_name', e.target.value.slice(0, 100))}
                  placeholder="HDFC Bank" className={INPUT} />
              </Field>
            </div>
            {err && <ErrorNote message={err} />}
            <div className="flex items-center gap-2">
              {accounts.length > 0 && (
                <button type="button" onClick={() => { setAdding(false); setErr(null) }} className={BTN_SECONDARY}>Cancel</button>
              )}
              <button type="submit" disabled={busy} className={cx(BTN_PRIMARY, 'flex-1 h-11!')}>{busy ? 'Linking…' : 'Link account'}</button>
            </div>
          </form>
        ) : (
          <button type="button" onClick={() => setAdding(true)} className={BTN_SECONDARY}>Add another account</button>
        )}
      </div>
    </Card>
  )
}

function AccountPills({ a, className = '' }: { a: BankAccount; className?: string }) {
  if (!a.is_primary && !a.verification_status) return null
  return (
    <span className={cx('flex-wrap gap-1.5', className)}>
      {a.is_primary && <span className={pill('green')}>Primary</span>}
      {a.verification_status && (
        <span className={cx(pill(statusTone(a.verification_status)), 'capitalize')}>{a.verification_status}</span>
      )}
    </span>
  )
}

// ── Field wrapper ─────────────────────────────────────────────

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={LABEL}>{label}</label>
      {children}
      {hint && <p className={HINT}>{hint}</p>}
    </div>
  )
}
