'use client'

/**
 * Fleet settings.
 *
 * Three things live here and nothing else: the company profile, the ONE cost
 * input the owner actually owns (monthly overhead), and a plain statement of how
 * the P&L is modelled.
 *
 * The two forms PATCH the same endpoint but are saved separately, because they
 * answer different questions — "who are we on an invoice" and "what does the
 * business cost me before a single truck moves". Each save sends only the fields
 * that changed: PATCH /fleet/owners/me (bt-fleet-service/src/routes/owners.ts)
 * rejects an empty body, and the schema there is the exact contract this page
 * validates against, so a bad value is caught before the round-trip.
 *
 * One asymmetry worth knowing: gstin, pan and contact_phone are length-checked
 * (`.length(15)`, `.length(10)`, `.min(8)`) and are NOT nullable in that schema,
 * so once set they can be corrected but not blanked from this console. The form
 * says so instead of sending a value the service will bounce.
 */

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  Building2, CheckCircle2, CircleUser, FileText, Gauge, Moon, Palette, Receipt, Sun, SunMoon, Wallet,
} from 'lucide-react'
import { toast } from 'sonner'

import { PageHeader } from '@/components/app-shell'
import { Card, CardHead, Empty, ErrorNote, Loading } from '@/components/stat'
import CompletenessSection from '@/components/completeness-section'
import { ApiError, becomeFleetOwner, getDocumentScanConfig, getMyFleet, updateMyFleet, updateMyGstin } from '@/lib/api'
import ScanDocument from '@/components/scan-document'
import { gstinProblem, panMatchesGstin, panProblem } from '@/lib/gst'
import { useAuth } from '@/lib/auth'
import GstPortalCheck from '@/components/gst-portal-check'
import GstOtpVerify from '@/components/gst-otp-verify'
import { EwayPortalCredentialsCard } from '@/components/eway-nic'
import PanCard from '@/components/pan-card'
import { getKycConfig } from '@/lib/api'
import { dateTime, inr } from '@/lib/format'
import { readTheme, saveTheme, type ThemeChoice } from '@/lib/theme'
import type { FleetOwner } from '@/lib/types'
import {
  BTN_PRIMARY, BTN_SECONDARY, INPUT as UI_INPUT, LABEL, MONO, TEXTAREA, cx, pill,
} from '@/lib/ui'

// GSTIN / PAN are checked by lib/gst.ts (shape, state code, embedded PAN, check digit) —
// the same rules PATCH /auth/me/gstin and the fleet profile route apply.

// Mirrors OwnerProfileBody in bt-fleet-service/src/routes/owners.ts exactly.
const COMPANY_MIN = 2
const COMPANY_MAX = 120
const GSTIN_LEN = 15
const PAN_LEN = 10
const PHONE_MIN = 8
const PHONE_MAX = 20
const ADDRESS_MAX = 500
const CITY_MAX = 100
const STATE_MAX = 100
const OVERHEAD_MAX = 100_000_000

const INPUT = UI_INPUT

const PRIMARY_BTN = BTN_PRIMARY

const SECONDARY_BTN = BTN_SECONDARY

/** The in-page section menu. Anchors only — every section stays on this one page. */
const SECTIONS: { id: string; label: string; icon: ReactNode; fleetOnly?: boolean }[] = [
  { id: 'completeness', label: 'Profile completeness', icon: <Gauge /> },
  { id: 'pan', label: 'PAN (required)', icon: <Receipt /> },
  { id: 'gstin', label: 'Your GSTIN', icon: <Receipt /> },
  { id: 'eway', label: 'E-way bill portal', icon: <Receipt /> },
  { id: 'appearance', label: 'Appearance', icon: <Palette /> },
  { id: 'company', label: 'Company profile', icon: <Building2 />, fleetOnly: true },
  { id: 'overhead', label: 'Monthly overhead', icon: <Wallet />, fleetOnly: true },
  { id: 'account', label: 'Account', icon: <CircleUser />, fleetOnly: true },
]

type ProfileForm = {
  company_name: string
  gstin: string
  pan: string
  contact_phone: string
  billing_address: string
  city: string
  state: string
}

type ProfilePatch = Partial<ProfileForm>

function errText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error) return e.message
  return fallback
}

/** numeric(12,2) columns arrive as strings from PostgREST often enough to guard. */
function overheadOf(owner: FleetOwner): number {
  const n = Number(owner.monthly_overhead_inr)
  return Number.isFinite(n) ? n : 0
}

const orig = (v: string | null) => (v ?? '').trim()

export default function SettingsPage() {
  const [owner, setOwner] = useState<FleetOwner | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  const [activeSection, setActiveSection] = useState(SECTIONS[0].id)
  // The public GST-portal lookup needs the server's Sandbox keys; off until they exist.
  const [gstLookup, setGstLookup] = useState(false)
  const [gstOtp, setGstOtp] = useState(false)
  const [providerWired, setProviderWired] = useState(false)
  useEffect(() => {
    let cancelled = false
    getKycConfig().then(c => { if (!cancelled) { setGstLookup(c.gst_lookup); setGstOtp(Boolean(c.gst_otp)); setProviderWired(c.provider !== 'console') } }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  // Document scan is offered only when the server has OCR configured; a failed read means "off".
  const [scan, setScan] = useState(false)
  useEffect(() => {
    let cancelled = false
    getDocumentScanConfig().then(c => { if (!cancelled) setScan(c.enabled) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    getMyFleet()
      .then(data => {
        if (cancelled) return
        setOwner(data)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        // NOT_FOUND is a different situation from a broken call: the account is
        // real but has never registered a fleet profile, so say that plainly.
        if (e instanceof ApiError && e.code === 'NOT_FOUND') setMissing(true)
        else setError(errText(e, 'Could not load your fleet profile'))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [nonce])

  function retry() {
    setLoading(true)
    setError(null)
    setMissing(false)
    setNonce(n => n + 1)
  }

  const fleetReady = !loading && !error && !missing && owner !== null
  const sections = SECTIONS.filter(s => !s.fleetOnly || fleetReady)

  return (
    <div className="p-4 lg:p-8 max-w-[112rem] mx-auto">
      <PageHeader
        title="Settings"
        subtitle="Your tax identity, company profile, and monthly overhead."
      />

      <div className="lg:grid lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:gap-6 items-start">
        {/* Section menu: a sticky list on desktop, a row of chips on a phone. */}
        <nav aria-label="Settings sections" className="mb-5 lg:mb-0 lg:sticky lg:top-6">
          <ul className="flex lg:flex-col gap-1.5 lg:gap-1 overflow-x-auto -mx-4 px-4 lg:mx-0 lg:px-0 pb-1 lg:pb-0 lg:rounded-xl lg:border lg:border-gray-200 lg:bg-white lg:p-2">
            {sections.map(s => {
              const on = activeSection === s.id
              return (
                <li key={s.id} className="shrink-0">
                  <a
                    href={`#${s.id}`}
                    onClick={() => setActiveSection(s.id)}
                    aria-current={on ? 'true' : undefined}
                    className={cx(
                      'flex items-center gap-2.5 rounded-lg px-3 h-10 text-sm whitespace-nowrap transition-colors [&_svg]:w-4 [&_svg]:h-4',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600',
                      on
                        ? 'bg-brand-50 text-gray-900 font-semibold border border-brand-200 lg:border-transparent [&_svg]:text-brand-600'
                        : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900 border border-gray-200 bg-white lg:border-transparent lg:bg-transparent [&_svg]:text-gray-400',
                    )}
                  >
                    {s.icon}
                    {s.label}
                  </a>
                </li>
              )
            })}
          </ul>
        </nav>

        <div className="min-w-0 space-y-5">
          {/* Persona completeness (D-33) — cross-persona, so it sits ABOVE the fleet-owner-gated
              content below and shows for every account (shipper / driver / fleet owner). */}
          <section id="completeness" className="scroll-mt-6">
            <CompletenessSection />
          </section>

          {/* Light / dark theme — for every account, saved on this device. */}
          <section id="appearance" className="scroll-mt-6"><AppearanceCard /></section>

          {/* Two independent columns, so a short card never leaves a hole beside a tall one:
              GSTIN then overhead on the left, company profile then account on the right.
              The GSTIN card keeps one position in the tree whatever the fleet call does, so
              a half-typed GSTIN survives the profile load. */}
          <div className={cx('grid grid-cols-1 gap-5 items-start', fleetReady && 'xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]')}>
            <div className="min-w-0 space-y-5">
              {/* FB-04: shipper GSTIN on users.gstin — required before posting a load. Always shown. */}
              {/* PAN is mandatory (2026-10-15): posting and bidding are locked until it is verified. */}
              <section id="pan" className="scroll-mt-6"><PanCard scan={scan} providerWired={providerWired} /></section>
              <section id="gstin" className="scroll-mt-6"><ShipperGstinCard scan={scan} gstLookup={gstLookup} gstOtp={gstOtp} /></section>
              <section id="eway" className="scroll-mt-6"><EwayPortalCredentialsCard /></section>
              {fleetReady && owner && (
                <section id="overhead" className="scroll-mt-6"><OverheadCard owner={owner} onSaved={setOwner} /></section>
              )}
            </div>
            {fleetReady && owner && (
              <div className="min-w-0 space-y-5">
                <section id="company" className="scroll-mt-6"><ProfileCard owner={owner} gstLookup={gstLookup} gstOtp={gstOtp} onSaved={setOwner} /></section>
                <section id="account" className="scroll-mt-6"><AccountCard owner={owner} /></section>
              </div>
            )}
          </div>

          {loading ? (
            <Loading label="Loading fleet profile" />
          ) : error ? (
            <div className="space-y-3">
              <ErrorNote message={error} />
              <button onClick={retry} className={SECONDARY_BTN}>Try again</button>
            </div>
          ) : missing ? (
            <SetUpFleetCard onDone={retry} />
          ) : !owner ? (
            <Card>
              <Empty title="Nothing to show" hint="The service returned no fleet profile." />
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** Card footer: a save-state line on the left, the save button on the right. */
function SaveBar({ dirty, savedText, children }: { dirty: boolean; savedText: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-t border-gray-100">
      <p className={cx('text-xs inline-flex items-center gap-1.5', dirty ? 'text-amber-700' : 'text-gray-500')}>
        <span className={cx('w-2 h-2 rounded-full', dirty ? 'bg-amber-500' : 'bg-emerald-500')} aria-hidden />
        {dirty ? 'Unsaved changes' : savedText}
      </p>
      {children}
    </div>
  )
}

// ── Shipper GSTIN (users.gstin via PATCH /auth/me/gstin) ───────
//
// FB-04: posting a load hard-requires a GSTIN on the user profile or the fleet
// owner row. Fleet owners already edit fleet_owners.gstin in Company profile
// below; this card is the shipper-facing path for accounts without a fleet.

function ShipperGstinCard({ scan, gstLookup, gstOtp }: { scan: boolean; gstLookup: boolean; gstOtp: boolean }) {
  const { user, refresh } = useAuth()
  const [value, setValue] = useState((user?.gstin ?? '').toUpperCase())
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // What the scans read, shown beside the field so the person can see the number came from
  // their own certificate and that their PAN card belongs to the same registration.
  const [readFrom, setReadFrom] = useState<{ legal_name: string | null; trade_name: string | null; source: 'certificate' | 'portal' } | null>(null)
  const [scannedPan, setScannedPan] = useState<{ pan: string; name: string | null } | null>(null)

  useEffect(() => {
    setValue((user?.gstin ?? '').toUpperCase())
  }, [user?.gstin])

  const saved = (user?.gstin ?? '').trim().toUpperCase()
  const draft = value.trim().toUpperCase()
  const dirty = draft !== saved

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (draft === '') {
      setErr('Enter a 15-character GSTIN — clear is not allowed from here while post-load requires one.')
      return
    }
    const problem = gstinProblem(draft)
    if (problem) { setErr(problem); return }
    if (scannedPan && !panMatchesGstin(scannedPan.pan, draft)) {
      setErr(`The PAN card you scanned (${scannedPan.pan}) is not the PAN this GSTIN was issued against (${draft.slice(2, 12)}). Scan the PAN card of the registered business.`)
      return
    }
    if (draft === saved) return
    setBusy(true)
    setErr(null)
    try {
      await updateMyGstin(draft)
      await refresh()
      toast.success('GSTIN saved — you can post a load')
    } catch (e2) {
      setErr(errText(e2, 'Could not save GSTIN'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHead
        icon={<Receipt />}
        tint="brand"
        title="Your GSTIN"
        sub="Required before you can post a load or add a truck. Saved on your account (not only on a fleet profile)."
      />
      <form onSubmit={submit}>
        <div className="p-5 space-y-4">
          {scan && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-blue-100 bg-blue-50/60 px-3.5 py-3">
              <ScanDocument
                kind="gst"
                enabled
                label="Scan GST certificate"
                onFields={(f) => {
                  if (f.gstin) setValue(f.gstin)
                  setReadFrom({ legal_name: f.legal_name, trade_name: f.trade_name, source: 'certificate' })
                  setErr(f.gstin ? null : 'The GSTIN on the certificate could not be read clearly — type it in.')
                }}
              />
              <ScanDocument
                kind="pan"
                enabled
                label="Scan PAN card"
                onFields={(f) => {
                  if (f.pan) setScannedPan({ pan: f.pan, name: f.name })
                  setErr(f.pan ? null : 'The PAN could not be read clearly — try a sharper photo.')
                }}
              />
              <p className="text-sm text-gray-600 basis-full">Photograph the GST registration certificate (REG-06) and the PAN card; the number is filled in and the two are checked against each other.</p>
            </div>
          )}
          <Field
            id="user_gstin"
            label="GSTIN"
            hint={`${GSTIN_LEN} characters. Same format as GST filings.`}
          >
            <input
              id="user_gstin"
              type="text"
              autoComplete="off"
              value={value}
              onChange={e => setValue(alnum(e.target.value, GSTIN_LEN))}
              placeholder="29ABCDE1234F1Z5"
              className={`${INPUT} ${MONO} uppercase`}
            />
          </Field>
          {readFrom && (readFrom.legal_name || readFrom.trade_name) && (
            <p className="text-sm text-gray-600">
              {readFrom.source === 'portal' ? 'Registered on the GST portal as' : 'Certificate reads'}: <span className="font-semibold text-gray-900">{readFrom.trade_name ?? readFrom.legal_name}</span>
              {readFrom.legal_name && readFrom.trade_name && readFrom.trade_name !== readFrom.legal_name && <> (registered to {readFrom.legal_name})</>}
            </p>
          )}
          {scannedPan && draft.length === 15 && (
            panMatchesGstin(scannedPan.pan, draft) ? (
              <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800 inline-flex items-center gap-2 w-full">
                <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
                <span>PAN <span className={MONO}>{scannedPan.pan}</span>{scannedPan.name ? ` (${scannedPan.name})` : ''} matches this GSTIN.</span>
              </p>
            ) : (
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">
                PAN <span className={MONO}>{scannedPan.pan}</span> does not belong to this GSTIN (its PAN is <span className={MONO}>{draft.slice(2, 12)}</span>).
              </p>
            )
          )}
          <GstPortalCheck gstin={value} enabled={gstLookup} />
          <GstOtpVerify
            gstin={value}
            enabled={gstOtp}
            onVerified={(r) => {
              // The server has already saved the GSTIN on the account; refresh() brings it in.
              setValue(r.gstin)
              setReadFrom({ legal_name: r.legal_name, trade_name: r.trade_name, source: 'portal' })
              setErr(null)
              void refresh()
              toast.success(r.gstin_saved ? 'GSTIN verified by OTP and saved' : 'GSTIN verified by OTP')
            }}
          />
          {saved ? (
            <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800 inline-flex items-center gap-2 w-full">
              <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
              <span>On file: <span className={MONO}>{saved}</span></span>
            </p>
          ) : (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">No GSTIN on file — Post a Load and Add truck will refuse until you save one (here or on the company profile).</p>
          )}
          {err && <ErrorNote message={err} />}
        </div>
        <SaveBar dirty={dirty} savedText="Saved">
          <button type="submit" disabled={busy || !dirty} className={PRIMARY_BTN}>
            {busy ? 'Saving…' : 'Save GSTIN'}
          </button>
        </SaveBar>
      </form>
    </Card>
  )
}

// ── Become a fleet owner ──────────────────────────────────────
//
// The self-serve path into the fleet persona for an account that has no profile yet
// — a driver who buys a truck, or a shipper standing up a carrier arm. becomeFleetOwner
// creates the profile; refreshing the auth snapshot opens the fleet console (the rail
// gates on having a profile now), and the page reloads into the company-details form.

function SetUpFleetCard({ onDone }: { onDone: () => void }) {
  const { refresh } = useAuth()
  const [busy, setBusy] = useState(false)

  async function setUp() {
    setBusy(true)
    try {
      await becomeFleetOwner()
      await refresh()
      toast.success('Fleet profile created — fill in your company details below')
      onDone()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not create the fleet profile')
      setBusy(false)
    }
  }

  return (
    <Card>
      <Empty
        icon={<Building2 />}
        title="Run your own trucks?"
        hint="Add trucks, invite drivers, and bid on loads."
        action={
          <button
            onClick={setUp}
            disabled={busy}
            className={PRIMARY_BTN}
          >
            {busy && <span className="w-4 h-4 border-2 border-gray-900 border-t-transparent rounded-full animate-spin" />}
            Set up fleet management
          </button>
        }
      />
    </Card>
  )
}

// ── Company profile ───────────────────────────────────────────

function ProfileCard({ owner, gstLookup, gstOtp, onSaved }: { owner: FleetOwner; gstLookup: boolean; gstOtp: boolean; onSaved: (o: FleetOwner) => void }) {
  const [form, setForm] = useState<ProfileForm>(() => toForm(owner))
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const patch = buildProfilePatch(form, owner)
  // Dirty is measured on the RAW form, not on the sendable patch: a change the
  // service would reject still has to be submittable, otherwise the button sits
  // disabled and the reason never gets shown.
  const dirty = (Object.keys(form) as (keyof ProfileForm)[])
    .some(k => form[k].trim() !== orig(owner[k]))

  function set<K extends keyof ProfileForm>(key: K, value: string) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (patch.message) { setErr(patch.message); return }
    if (Object.keys(patch.fields).length === 0) return
    setBusy(true)
    setErr(null)
    try {
      const updated = await updateMyFleet(patch.fields)
      onSaved(updated)
      setForm(toForm(updated))
      toast.success('Company profile saved')
    } catch (e2) {
      setErr(errText(e2, 'Could not save the company profile'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHead
        icon={<Building2 />}
        tint="blue"
        title="Company profile"
        sub="What shippers, invoices and your GST filings see."
      />
      <form onSubmit={submit}>
        <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-x-5 gap-y-4">
          <div className="space-y-4">
            <Field id="company_name" label="Company name">
              <input
                id="company_name"
                type="text"
                value={form.company_name}
                onChange={e => set('company_name', e.target.value.slice(0, COMPANY_MAX))}
                placeholder="Sharma Transport Company"
                className={INPUT}
              />
            </Field>

            <Field
              id="gstin"
              label="GSTIN"
              hint={`${GSTIN_LEN} characters. Needed before you can add trucks. Leave blank only if you are not registered.`}
            >
              <input
                id="gstin"
                type="text"
                autoComplete="off"
                value={form.gstin}
                onChange={e => set('gstin', alnum(e.target.value, GSTIN_LEN))}
                placeholder="29ABCDE1234F1Z5"
                className={`${INPUT} ${MONO} uppercase`}
              />
            </Field>
            <GstPortalCheck gstin={form.gstin} enabled={gstLookup} />
            <GstOtpVerify
              gstin={form.gstin}
              enabled={gstOtp}
              onVerified={(r) => {
                // Verified = the registration is this person's, so the form takes its registered
                // name: the trade name (how the firm is known), else the legal name.
                const registered = r.trade_name ?? r.legal_name
                setForm(f => ({ ...f, gstin: r.gstin, company_name: registered ? registered.slice(0, COMPANY_MAX) : f.company_name }))
                toast.success(registered ? 'GSTIN verified — company name filled from the GST registration. Save the profile to keep it.' : 'GSTIN verified by OTP.')
              }}
            />
            <Field id="pan" label="PAN" hint={`${PAN_LEN} characters.`}>
              <input
                id="pan"
                type="text"
                autoComplete="off"
                value={form.pan}
                onChange={e => set('pan', alnum(e.target.value, PAN_LEN))}
                placeholder="ABCDE1234F"
                className={`${INPUT} ${MONO} uppercase`}
              />
            </Field>

            <Field id="contact_phone" label="Contact phone" hint="The number a shipper or our ops team calls.">
              <input
                id="contact_phone"
                type="tel"
                inputMode="tel"
                autoComplete="off"
                value={form.contact_phone}
                onChange={e => set('contact_phone', e.target.value.replace(/[^\d+\-\s]/g, '').slice(0, PHONE_MAX))}
                placeholder="+91 98765 43210"
                className={`${INPUT} tabular-nums`}
              />
            </Field>
          </div>

          <div className="space-y-4">
            <Field id="billing_address" label="Billing address">
              <textarea
                id="billing_address"
                rows={4}
                value={form.billing_address}
                onChange={e => set('billing_address', e.target.value.slice(0, ADDRESS_MAX))}
                placeholder="Plot 14, Transport Nagar, near NH-48"
                className={TEXTAREA}
              />
            </Field>

            <Field id="city" label="City">
              <input
                id="city"
                type="text"
                value={form.city}
                onChange={e => set('city', e.target.value.slice(0, CITY_MAX))}
                placeholder="Bengaluru"
                className={INPUT}
              />
            </Field>
            <Field id="state" label="State">
              <input
                id="state"
                type="text"
                value={form.state}
                onChange={e => set('state', e.target.value.slice(0, STATE_MAX))}
                placeholder="Karnataka"
                className={INPUT}
              />
            </Field>
          </div>

          {err && <div className="md:col-span-2"><ErrorNote message={err} /></div>}
        </div>

        <SaveBar dirty={dirty} savedText="Everything here is saved">
          <button type="submit" disabled={busy || !dirty} className={PRIMARY_BTN}>
            {busy ? 'Saving…' : 'Save profile'}
          </button>
        </SaveBar>
      </form>
    </Card>
  )
}

function toForm(owner: FleetOwner): ProfileForm {
  return {
    company_name: owner.company_name ?? '',
    gstin: owner.gstin ?? '',
    pan: owner.pan ?? '',
    contact_phone: owner.contact_phone ?? '',
    billing_address: owner.billing_address ?? '',
    city: owner.city ?? '',
    state: owner.state ?? '',
  }
}

function alnum(value: string, max: number): string {
  return value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, max)
}

/**
 * The changed subset, plus the first reason it cannot be sent. Validation is a
 * transcription of OwnerProfileBody, so the button is only ever pressed with a
 * body the service will accept.
 */
function buildProfilePatch(form: ProfileForm, owner: FleetOwner): { fields: ProfilePatch; message: string | null } {
  const fields: ProfilePatch = {}
  let message: string | null = null
  const fail = (m: string) => { if (!message) message = m }

  const name = form.company_name.trim()
  if (name.length < COMPANY_MIN || name.length > COMPANY_MAX) {
    fail(`Company name must be between ${COMPANY_MIN} and ${COMPANY_MAX} characters.`)
  } else if (name !== orig(owner.company_name)) {
    fields.company_name = name
  }

  for (const f of [
    { key: 'gstin' as const, label: 'GSTIN', length: GSTIN_LEN, current: owner.gstin },
    { key: 'pan' as const, label: 'PAN', length: PAN_LEN, current: owner.pan },
  ]) {
    const value = form[f.key].trim()
    const before = orig(f.current)
    if (value === before) continue
    if (value === '') {
      fail(`${f.label} cannot be cleared from here — it can only be corrected to another ${f.length}-character value.`)
      continue
    }
    if (value.length !== f.length) {
      fail(`${f.label} must be exactly ${f.length} characters.`)
      continue
    }
    const problem = f.key === 'gstin' ? gstinProblem(value) : panProblem(value)
    if (problem) { fail(`${f.label}: ${problem}`); continue }
    fields[f.key] = value
  }

  // Characters 3–12 of a GSTIN ARE the registrant's PAN, so the two fields must agree —
  // whichever of them is being changed.
  {
    const gstin = form.gstin.trim().toUpperCase()
    const pan = form.pan.trim().toUpperCase()
    if (gstin.length === 15 && pan.length === 10 && !gstinProblem(gstin) && !panProblem(pan) && !panMatchesGstin(pan, gstin)) {
      fail(`PAN ${pan} is not the PAN this GSTIN was issued against (${gstin.slice(2, 12)}). One of the two is wrong.`)
    }
  }

  const phone = form.contact_phone.trim()
  const phoneBefore = orig(owner.contact_phone)
  if (phone !== phoneBefore) {
    if (phone === '') {
      fail('Contact phone cannot be cleared from here — replace it with another number instead.')
    } else if (phone.length < PHONE_MIN || phone.length > PHONE_MAX) {
      fail(`Contact phone must be between ${PHONE_MIN} and ${PHONE_MAX} characters.`)
    } else {
      fields.contact_phone = phone
    }
  }

  // Address, city and state are length-capped only, so blanking them is a legal
  // update — unlike the three above.
  for (const f of [
    { key: 'billing_address' as const, label: 'Billing address', max: ADDRESS_MAX, current: owner.billing_address },
    { key: 'city' as const, label: 'City', max: CITY_MAX, current: owner.city },
    { key: 'state' as const, label: 'State', max: STATE_MAX, current: owner.state },
  ]) {
    const value = form[f.key].trim()
    if (value === orig(f.current)) continue
    if (value.length > f.max) { fail(`${f.label} must be ${f.max} characters or fewer.`); continue }
    fields[f.key] = value
  }

  return { fields, message }
}

// ── Monthly overhead ──────────────────────────────────────────

function OverheadCard({ owner, onSaved }: { owner: FleetOwner; onSaved: (o: FleetOwner) => void }) {
  const saved = overheadOf(owner)
  const [value, setValue] = useState(String(saved))
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const parsed = value.trim() === '' ? null : Number(value)
  const valid = parsed !== null && Number.isFinite(parsed) && parsed >= 0 && parsed <= OVERHEAD_MAX
  // Same rule as the profile form: enable on any edit, so an empty or oversized
  // figure produces a message rather than a dead button.
  const dirty = value.trim() !== String(saved)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!valid) {
      setErr(`Enter a monthly overhead between ${inr(0)} and ${inr(OVERHEAD_MAX)}.`)
      return
    }
    if (parsed === saved) { setValue(String(saved)); return }
    setBusy(true)
    setErr(null)
    try {
      const updated = await updateMyFleet({ monthly_overhead_inr: parsed })
      onSaved(updated)
      setValue(String(overheadOf(updated)))
      toast.success('Monthly overhead saved')
    } catch (e2) {
      setErr(errText(e2, 'Could not save the monthly overhead'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHead
        icon={<Wallet />}
        tint="green"
        title="Monthly overhead"
        sub="Fixed monthly business cost, not tied to any truck."
      />
      <form onSubmit={submit}>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
            <Field
              id="monthly_overhead_inr"
              label="Overhead per month (₹)"
            >
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-500 pointer-events-none" aria-hidden>₹</span>
                <input
                  id="monthly_overhead_inr"
                  type="text"
                  inputMode="numeric"
                  value={value}
                  onChange={e => setValue(e.target.value.replace(/\D/g, '').slice(0, 9))}
                  placeholder="120000"
                  className={`${INPUT} pl-7 tabular-nums`}
                />
              </div>
            </Field>
            <div className="rounded-xl bg-gray-50 border border-gray-200 px-3.5 py-2">
              <div className="text-xs text-gray-500">Currently saved</div>
              <div className="text-lg font-bold text-gray-900 tabular-nums leading-tight">
                {inr(saved)} <span className="text-xs font-normal text-gray-500">per month</span>
              </div>
            </div>
          </div>

          {err && <ErrorNote message={err} />}
        </div>

        <SaveBar dirty={dirty} savedText="Saved">
          <button type="submit" disabled={busy || !dirty} className={PRIMARY_BTN}>
            {busy ? 'Saving…' : 'Save overhead'}
          </button>
        </SaveBar>
      </form>
    </Card>
  )
}

// ── Appearance ────────────────────────────────────────────────

const THEMES: { value: ThemeChoice; label: string; hint: string; icon: ReactNode }[] = [
  { value: 'auto', label: 'Automatic', hint: 'Light by day, dark from 7 pm to 6 am (IST)', icon: <SunMoon /> },
  { value: 'light', label: 'Light', hint: 'Always light', icon: <Sun /> },
  { value: 'dark', label: 'Dark', hint: 'Always dark', icon: <Moon /> },
]

/** Automatic (by Indian time) / light / dark. Saved on this device only (see lib/theme.ts). */
function AppearanceCard() {
  // 'auto' on the server and the first client render; the stored choice is read after mount.
  const [choice, setChoice] = useState<ThemeChoice>('auto')
  useEffect(() => { setChoice(readTheme()) }, [])
  return (
    <Card>
      <CardHead icon={<Palette />} tint="violet" title="Appearance" sub="How BharatTruck looks on this device. The home and sign-in pages are always automatic." />
      <div className="p-5 grid grid-cols-1 sm:grid-cols-3 gap-3" role="radiogroup" aria-label="Theme">
        {THEMES.map(t => {
          const on = choice === t.value
          return (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => { setChoice(t.value); saveTheme(t.value) }}
              className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                on ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500' : 'border-gray-200 bg-white hover:bg-gray-50'
              }`}
            >
              <span className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl [&_svg]:h-5 [&_svg]:w-5 ${on ? 'bg-brand-500 text-ink' : 'bg-gray-100 text-gray-600'}`} aria-hidden>{t.icon}</span>
              <span className="min-w-0">
                <span className="block text-sm font-bold text-gray-900">{t.label}</span>
                <span className="block text-xs text-gray-500">{t.hint}</span>
              </span>
            </button>
          )
        })}
      </div>
    </Card>
  )
}

// ── Account meta ──────────────────────────────────────────────

function AccountCard({ owner }: { owner: FleetOwner }) {
  return (
    <Card>
      <CardHead icon={<FileText />} tint="slate" title="Account" />
      <dl className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
        <Row label="Status">
          <span className={pill(owner.is_active ? 'green' : 'slate')}>
            {owner.is_active ? 'Active' : 'Inactive'}
          </span>
        </Row>
        <Row label="Fleet ID">
          <span className={cx(MONO, 'text-sm text-gray-900 break-all')}>{owner.id}</span>
        </Row>
        <Row label="Registered">
          <span className="text-sm font-medium text-gray-900">{dateTime(owner.created_at)}</span>
        </Row>
        <Row label="Last updated">
          <span className="text-sm font-medium text-gray-900">{dateTime(owner.updated_at)}</span>
        </Row>
      </dl>
    </Card>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="mt-1 min-w-0">{children}</dd>
    </div>
  )
}

// ── Field wrapper ─────────────────────────────────────────────

function Field({
  id, label, hint, children,
}: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className={LABEL}>{label}</label>
      <div>{children}</div>
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  )
}
