'use client'

// Re-drawn BharatTruck screens for the onboarding guide. Same kit as the live app (lib/ui.ts,
// brand marks, lucide icons) and the live wording, but inert: nothing here talks to a server.
// Every control the guide can point at carries data-guide="…" and reports clicks through `hit`.

import {
  ArrowLeft, ArrowRight, Camera, Check, CheckCircle2, ClipboardCheck, Fuel, Gavel, Home, IdCard, Info,
  LayoutDashboard, Lock, LogOut, Mail, Map, Navigation, Package, PackagePlus, PlusCircle, Route, Search,
  Settings, ShieldCheck, Truck, TrendingUp, Upload, UserPlus, Users, X,
} from 'lucide-react'
import type { ReactNode } from 'react'

import { BrandMark, Wordmark } from '@/components/brand'
import {
  BTN_BLUE, BTN_PRIMARY, BTN_SECONDARY, HINT, LABEL, MONO, PILL, PILL_BASE, SEG_OFF, SEG_ON, SEG_WRAP, SURFACE, cx,
} from '@/lib/ui'
import { DEMO, PERSONA_META, type DemoState, type Persona, type Step } from './steps'

export type ScreenProps = {
  persona: Persona
  step: Step
  state: DemoState
  /** A field being typed right now: its partial value wins over the stored one. */
  typing: { key: string; text: string } | null
  hit: (id: string) => void
}

type Ctx = ScreenProps & { v: (k: string) => string; g: (id: string) => { 'data-guide': string; onClick: () => void } }

const INPUT_BOX = 'flex items-center w-full h-[42px] rounded-[10px] border border-gray-200 bg-white px-3 text-sm text-gray-900'

function Field({ c, k, label, placeholder, guide, mono, icon, password, hint, className }: {
  c: Ctx; k: string; label?: string; placeholder?: string; guide?: string; mono?: boolean; icon?: ReactNode; password?: boolean; hint?: string; className?: string
}) {
  const val = c.v(k)
  const typing = c.typing?.key === k
  return (
    <div className={className}>
      {label && <div className={LABEL}>{label}</div>}
      <div {...(guide ? c.g(guide) : {})} className={cx(INPUT_BOX, !!icon && 'pl-3 gap-2.5', typing && 'border-blue-600 ring-2 ring-blue-100')}>
        {icon && <span className="text-gray-400 [&>svg]:w-[18px] [&>svg]:h-[18px]">{icon}</span>}
        {val
          ? <span className={cx('truncate', mono && MONO)}>{password ? '•'.repeat(val.length) : val}</span>
          : <span className="truncate text-gray-400">{placeholder}</span>}
        {typing && <span className="ml-px h-4 w-px animate-pulse bg-gray-900" />}
      </div>
      {hint && <p className={HINT}>{hint}</p>}
    </div>
  )
}

function Card({ title, sub, children, className, guide, c }: { title: string; sub?: string; children: ReactNode; className?: string; guide?: string; c?: Ctx }) {
  return (
    <section {...(guide && c ? c.g(guide) : {})} className={cx(SURFACE, className)}>
      <div className="px-5 py-4 border-b border-gray-100">
        <h3 className="text-[1.0625rem] font-extrabold tracking-tight text-gray-900">{title}</h3>
        {sub && <p className="text-sm text-gray-500">{sub}</p>}
      </div>
      <div className="p-5 space-y-4">{children}</div>
    </section>
  )
}

function ScanBox({ c, id, label, text }: { c: Ctx; id: string; label: string; text: string }) {
  return (
    <div className="rounded-xl border border-blue-100 bg-blue-50/60 px-3.5 py-3 flex items-center gap-3">
      <button type="button" {...c.g(id)} className={cx(BTN_BLUE, 'shrink-0 whitespace-nowrap')}><Camera className="w-4 h-4" />{label}</button>
      <p className="text-xs text-gray-600 leading-snug">{text}</p>
    </div>
  )
}

function Pill({ tone, children }: { tone: keyof typeof PILL; children: ReactNode }) {
  return <span className={cx(PILL_BASE, PILL[tone])}>{children}</span>
}

// ── shells ──────────────────────────────────────────────────────────────────

const NAV: Record<Persona, { cap?: string; items: { id: string; label: string; icon: ReactNode }[] }[]> = {
  shipper: [
    { items: [{ id: 'nav-home', label: 'Home', icon: <Home /> }, { id: 'nav-dashboard', label: 'Dashboard', icon: <LayoutDashboard /> }] },
    { cap: 'Shipping', items: [{ id: 'nav-loads', label: 'My Loads', icon: <Package /> }, { id: 'nav-post', label: 'Post a Load', icon: <PackagePlus /> }] },
  ],
  driver: [
    { items: [{ id: 'nav-home', label: 'Home', icon: <Home /> }, { id: 'nav-dashboard', label: 'Dashboard', icon: <LayoutDashboard /> }] },
    { cap: 'Shipping', items: [{ id: 'nav-loads', label: 'My Loads', icon: <Package /> }, { id: 'nav-post', label: 'Post a Load', icon: <PackagePlus /> }] },
    { cap: 'Driving', items: [{ id: 'nav-trips', label: 'My Trips', icon: <Navigation /> }, { id: 'nav-driver-profile', label: 'Driver profile', icon: <IdCard /> }] },
  ],
  fleet: [
    { items: [{ id: 'nav-home', label: 'Home', icon: <Home /> }, { id: 'nav-dashboard', label: 'Dashboard', icon: <LayoutDashboard /> }] },
    { cap: 'Shipping', items: [{ id: 'nav-loads', label: 'My Loads', icon: <Package /> }, { id: 'nav-post', label: 'Post a Load', icon: <PackagePlus /> }] },
    { cap: 'Fleet', items: [{ id: 'nav-live', label: 'Live Fleet', icon: <Map /> }] },
    { cap: 'Assets', items: [{ id: 'nav-trucks', label: 'Trucks', icon: <Truck /> }, { id: 'nav-drivers', label: 'Drivers', icon: <Users /> }] },
    { cap: 'Work', items: [{ id: 'nav-find', label: 'Find Work', icon: <Gavel /> }, { id: 'nav-trips', label: 'Trips', icon: <Route /> }, { id: 'nav-deliveries', label: 'Deliveries', icon: <ClipboardCheck /> }] },
    { cap: 'Analytics', items: [{ id: 'nav-util', label: 'Utilisation', icon: <TrendingUp /> }, { id: 'nav-fuel', label: 'Fuel', icon: <Fuel /> }] },
  ],
}

const ACTIVE_NAV: Partial<Record<string, string>> = {
  home: 'nav-home', settings: 'nav-settings', post: 'nav-post', 'driver-profile': 'nav-driver-profile', vehicles: 'nav-trucks', drivers: 'nav-drivers',
}

function AppShell({ c, children }: { c: Ctx; children: ReactNode }) {
  const active = ACTIVE_NAV[c.step.screen]
  const showFleetNav = c.persona !== 'fleet' || c.state.on.fleet
  const groups = c.persona === 'fleet' && !showFleetNav ? NAV.fleet.slice(0, 2) : NAV[c.persona]
  const who = PERSONA_META[c.persona].who
  const navItem = (it: { id: string; label: string; icon: ReactNode }) => (
    <div key={it.id} {...c.g(it.id)} className={cx(
      'flex items-center gap-3 rounded-xl px-3 py-1 text-[0.9375rem] [&>svg]:w-5 [&>svg]:h-5',
      active === it.id ? 'bg-gradient-to-r from-brand-100 to-brand-50 text-ink font-bold shadow-[inset_0_0_0_1px_rgba(242,165,22,0.18)] [&>svg]:text-brand-600' : 'text-gray-600 [&>svg]:text-gray-500',
    )}>{it.icon}{it.label}</div>
  )
  return (
    <div className="flex h-full">
      {/* The fleet menu is long; it scrolls (bar hidden) if it ever outgrows the 800px canvas. */}
      <aside data-guide-scroll className="w-60 shrink-0 bg-white border-r border-gray-200 flex flex-col px-3 py-3 gap-0.5 overflow-y-auto [scrollbar-width:none]">
        <div className="flex items-center gap-2 px-2 pb-2"><BrandMark className="w-8 h-8" /><Wordmark className="text-xl" /></div>
        <div className="mb-2 flex items-center gap-2.5 rounded-xl border border-gray-200 bg-gradient-to-br from-brand-50/70 to-white px-2.5 py-2">
          <span className="w-9 h-9 rounded-full bg-brand-100 text-brand-700 grid place-items-center text-sm font-bold">{who.split(' ').map((w) => w[0]).join('')}</span>
          <span className="min-w-0"><span className="block text-sm font-bold text-gray-900 truncate">{who}</span>
            <span className="block text-xs text-gray-500 truncate">{c.persona === 'fleet' && c.state.on.company ? DEMO.fleet.company : DEMO[c.persona].email}</span></span>
        </div>
        {groups.map((g, i) => (
          <div key={i} className="space-y-0.5">
            {g.cap && <div className="px-3 pt-2 pb-0.5 text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-gray-400">{g.cap}</div>}
            {g.items.map(navItem)}
          </div>
        ))}
        <div className="mt-auto border-t border-gray-100 pt-2 space-y-0.5">
          {navItem({ id: 'nav-settings', label: 'Settings', icon: <Settings /> })}
          <div className="flex items-center gap-3 px-3 py-2 text-[0.9375rem] text-gray-600"><LogOut className="w-5 h-5 text-gray-500" />Sign out</div>
        </div>
      </aside>
      <div data-guide-scroll className="flex-1 min-w-0 overflow-y-auto bg-gray-50">{children}</div>
    </div>
  )
}

function Hero({ title, sub, actions, tall }: { title: ReactNode; sub: string; actions?: ReactNode; tall?: boolean }) {
  return (
    <div className={cx('relative overflow-hidden', tall ? 'h-56' : 'h-40')}>
      <div className="absolute inset-0 bg-cover bg-center opacity-60" style={{ backgroundImage: 'url(/images/highway-milestone.webp)' }} />
      <div className="absolute inset-0 bg-gradient-to-r from-[#fffaf0] via-[#fffaf0]/85 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-b from-transparent to-gray-50" />
      <div className="relative px-8 pt-8">
        <h1 className={cx('font-extrabold tracking-[-0.025em] text-gray-900', tall ? 'text-[2.25rem]' : 'text-[1.875rem]')}>{title}</h1>
        <p className="mt-1 font-medium text-gray-800">{sub}</p>
        {actions && <div className="mt-3 flex gap-2">{actions}</div>}
      </div>
    </div>
  )
}

// ── public screens ──────────────────────────────────────────────────────────

function Landing({ c }: { c: Ctx }) {
  return (
    <div className="h-full overflow-hidden bg-[#fffaf0]">
      <div className="flex items-center justify-between px-8 py-4">
        <div className="flex items-center gap-2"><BrandMark className="w-8 h-8" /><Wordmark className="text-xl" /></div>
        <div className="flex gap-6 text-sm font-semibold text-gray-700">
          <span>For shippers</span><span>For drivers</span><span>For fleet owners</span><span>How it works</span>
        </div>
        <div className="flex gap-2">
          <span className={BTN_SECONDARY}>Sign in</span>
          <button type="button" {...c.g('create-account')} className={BTN_PRIMARY}>Create account</button>
        </div>
      </div>
      <div className="px-8 pt-10 grid grid-cols-[1.1fr_1fr] gap-8 items-center">
        <div>
          <span className="inline-flex rounded-full border border-brand-200 bg-white px-3 py-1 text-xs font-semibold text-brand-800">India&apos;s freight marketplace and fleet management platform</span>
          <h1 className="mt-4 text-[3.25rem] leading-[1.02] font-extrabold tracking-[-0.03em] text-gray-900">Every load, every truck,<br /><span className="text-brand-500">one login.</span></h1>
          <p className="mt-4 text-lg text-gray-600 max-w-xl">Post a load and get bids, run your trips with live tracking and proof of delivery, and see which truck actually pays its EMI.</p>
          <div className="mt-6 flex gap-3">
            <span className={cx(BTN_PRIMARY, 'h-12 px-6 text-base')}>Post a load <ArrowRight className="w-4 h-4" /></span>
            <span className={cx(BTN_SECONDARY, 'h-12 px-6 text-base')}>Run my fleet <ArrowRight className="w-4 h-4" /></span>
          </div>
        </div>
        <div className="h-72 rounded-3xl bg-cover bg-center shadow-xl" style={{ backgroundImage: 'url(/images/hero-truck.webp)' }} />
      </div>
      <div className="px-8 mt-10 grid grid-cols-3 gap-4">
        {[['For Shippers', 'Move goods with confidence', 'bg-brand-50'], ['For Drivers', 'Get trips. Get paid. Keep moving.', 'bg-blue-50'], ['For Fleet Owners', 'Higher utilisation. Lower headaches.', 'bg-emerald-50']].map(([t, s, bg]) => (
          <div key={t} className={cx(SURFACE, 'p-5')}><div className={cx('w-10 h-10 rounded-xl', bg)} /><div className="mt-3 font-extrabold">{t}</div><div className="text-sm text-gray-500">{s}</div></div>
        ))}
      </div>
    </div>
  )
}

const REG_HEAD: Record<Persona, [string, string, string]> = {
  shipper: ['Every load', 'moves India', 'forward.'],
  driver: ['More trips.', 'Steady income.', 'A stronger tomorrow.'],
  fleet: ['More trips.', 'Steady income.', 'A stronger tomorrow.'],
}

function AuthFrame({ c, children, head }: { c: Ctx; children: ReactNode; head: [string, string, string] }) {
  return (
    <div className="h-full grid grid-cols-[1fr_1fr] bg-gray-50">
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: 'url(/images/highway-portrait.webp)' }} />
        <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-black/30 to-black/70" />
        <div className="relative p-10 text-white flex flex-col h-full">
          <div className="flex items-center gap-2"><BrandMark className="w-8 h-8" /><span className="text-xl font-extrabold">Bharat<span className="text-[#fbb314]">Truck</span></span></div>
          <div className="mt-auto">
            <div className="text-[2.6rem] leading-[1.05] font-extrabold tracking-tight">{head[0]}<br />{c.persona === 'shipper' ? head[1] : <span className="text-[#fbb314]">{head[1]}</span>}<br />
              {c.persona === 'shipper' ? <span className="text-[#fbb314]">{head[2]}</span> : head[2]}</div>
            <div className="mt-6 grid grid-cols-3 gap-3 text-sm">
              {[['1 login', 'For every role'], ['3 roles', 'Shipper, driver, fleet'], ['Paperless', 'LR, invoice, e-way bill']].map(([a, b]) => (
                <div key={a} className="rounded-xl bg-white/10 backdrop-blur px-3 py-2"><div className="font-extrabold">{a}</div><div className="text-white/80 text-xs">{b}</div></div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="grid place-items-center px-10">
        <div className="w-full max-w-[30rem] rounded-2xl border border-gray-200 bg-white p-8 shadow-[0_18px_50px_rgba(20,24,31,0.10)]">{children}</div>
      </div>
    </div>
  )
}

const PERSONA_ROWS: { p: Persona; label: string; hint: string; icon: ReactNode }[] = [
  { p: 'shipper', label: 'I ship goods', hint: 'Post loads, track deliveries', icon: <Package className="w-5 h-5" /> },
  { p: 'driver', label: 'I drive a truck', hint: 'Just your DL to start — no truck needed', icon: <Navigation className="w-5 h-5" /> },
  { p: 'fleet', label: 'I run a fleet', hint: 'Trucks, drivers, bids', icon: <Truck className="w-5 h-5" /> },
]

function Register({ c }: { c: Ctx }) {
  const chosen: Persona = (['shipper', 'driver', 'fleet'] as Persona[]).find((p) => c.state.on[`persona-${p}`]) ?? 'shipper'
  const pw = c.v('password')
  const strength = pw.length === 0 ? 0 : pw.length < 8 ? 1 : pw.length < 11 ? 3 : 4
  return (
    <AuthFrame c={c} head={REG_HEAD[c.persona]}>
      <div className="text-sm font-semibold text-blue-600 flex items-center gap-1"><ArrowLeft className="w-4 h-4" />Back to sign in</div>
      <h2 className="mt-3 text-2xl font-extrabold tracking-tight">Create your account</h2>
      <p className="text-sm text-gray-500">One account for shippers, drivers and fleet owners on BharatTruck.</p>
      <div className="mt-4 text-sm font-semibold text-gray-700">I am a…</div>
      <div className="mt-2 space-y-2">
        {PERSONA_ROWS.map((r) => (
          <div key={r.p} {...c.g(`persona-${r.p}`)} className={cx('flex items-center gap-3 rounded-xl border px-3 py-2.5',
            chosen === r.p ? 'border-blue-600 bg-blue-50' : 'border-gray-200 bg-white')}>
            <span className={cx('w-9 h-9 rounded-lg grid place-items-center', chosen === r.p ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600')}>{r.icon}</span>
            <span className="flex-1"><span className="block text-sm font-bold">{r.label}</span><span className="block text-xs text-gray-500">{r.hint}</span></span>
            {chosen === r.p && <CheckCircle2 className="w-5 h-5 text-blue-600" />}
          </div>
        ))}
      </div>
      <div className="mt-4 space-y-3">
        <Field c={c} k="name" label="Full name" placeholder="Rajesh Kumar" guide="full-name" />
        <Field c={c} k="email" label="Email" placeholder="you@company.in" guide="email" icon={<Mail />} />
        <Field c={c} k="password" label="Password" placeholder="Create a password" guide="password" icon={<Lock />} password />
        <div className="flex items-center gap-2">
          {[1, 2, 3, 4].map((i) => <span key={i} className={cx('h-1.5 flex-1 rounded-full', i <= strength ? (strength >= 4 ? 'bg-emerald-500' : 'bg-amber-400') : 'bg-gray-200')} />)}
          <span className="text-xs text-gray-500 w-28 text-right">{['At least 8 characters', 'Too short', 'Fair password', 'Good password', 'Strong password'][strength]}</span>
        </div>
      </div>
      <button type="button" {...c.g('create')} className={cx(BTN_PRIMARY, 'mt-5 h-12 w-full text-base shadow-[0_6px_16px_rgba(242,165,22,0.3)]')}>Create account</button>
    </AuthFrame>
  )
}

function Verify({ c }: { c: Ctx }) {
  const code = c.v('code')
  return (
    <AuthFrame c={c} head={['Every load', 'moves India', 'forward.']}>
      <div className="w-14 h-14 rounded-full bg-brand-100 text-brand-700 grid place-items-center"><Mail className="w-6 h-6" /></div>
      <h2 className="mt-4 text-2xl font-extrabold tracking-tight">Verify your email</h2>
      <p className="text-sm text-gray-500">Enter the 6-digit code we sent to <b className="text-gray-900">{DEMO[c.persona].email}</b></p>
      <div {...c.g('code')} className="mt-5 flex gap-2">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={cx('h-14 flex-1 rounded-xl border grid place-items-center text-2xl font-bold', MONO,
            code.length === i && c.typing?.key === 'code' ? 'border-blue-600 ring-2 ring-blue-100' : 'border-gray-200')}>{code[i] ?? ''}</span>
        ))}
      </div>
      <button type="button" {...c.g('verify')} className={cx(BTN_PRIMARY, 'mt-5 h-12 w-full text-base', code.length < 6 && 'opacity-50')}>Verify &amp; continue</button>
      <p className="mt-4 text-sm text-gray-500 text-center">Didn&apos;t get it? <span className="text-blue-600 font-semibold">Resend code</span></p>
    </AuthFrame>
  )
}

// ── app screens ─────────────────────────────────────────────────────────────

function HomeScreen({ c }: { c: Ctx }) {
  const first = PERSONA_META[c.persona].who.split(' ')[0]
  const showInvite = c.persona === 'driver' && (c.step.id === 'invite' || c.state.on.joined)
  return (
    <AppShell c={c}>
      <div {...c.g('greeting')}><Hero tall title={<>Good morning, <span className="text-brand-500">{first}</span></>} sub="Here's what needs you right now." /></div>
      <div className="px-8 pb-8 -mt-4 grid grid-cols-[1fr_18rem] gap-6">
        <div className="space-y-4">
          {showInvite && (
            <div className={cx(SURFACE, 'p-5 flex items-center gap-4')}>
              <span className="w-11 h-11 rounded-xl bg-emerald-50 text-emerald-600 grid place-items-center"><Users className="w-5 h-5" /></span>
              <div className="flex-1"><div className="font-bold">Sharma Roadlines invited you to drive for them</div><div className="text-sm text-gray-500">Nagpur · ₹28,000 / month</div></div>
              {c.state.on.joined ? <Pill tone="green">Joined</Pill> : <>
                <span className={BTN_SECONDARY}><X className="w-4 h-4" />Decline</span>
                <button type="button" {...c.g('accept-invite')} className={BTN_PRIMARY}><Check className="w-4 h-4" />Accept</button>
              </>}
            </div>
          )}
          {c.persona === 'fleet' && !c.state.on.fleet && (
            <div className="rounded-2xl border border-brand-200 bg-gradient-to-r from-brand-50 to-white p-5 flex items-center gap-4">
              <span className="w-11 h-11 rounded-xl bg-brand-100 text-brand-700 grid place-items-center"><Truck className="w-5 h-5" /></span>
              <div className="flex-1"><div className="font-bold">Set up your fleet</div><div className="text-sm text-gray-600">Create your fleet profile to add trucks, invite drivers, and bid on loads.</div></div>
              <button type="button" {...c.g('setup-fleet')} className={BTN_PRIMARY}>Set up fleet management <ArrowRight className="w-4 h-4" /></button>
            </div>
          )}
          <div className={cx(SURFACE, 'p-8 text-center')}>
            <div className="mx-auto h-24 w-48 rounded-xl bg-cover bg-center opacity-80" style={{ backgroundImage: 'url(/images/empty-road.webp)' }} />
            <div className="mt-3 font-bold text-gray-900">{c.state.on.posted ? 'Your load is live — bids will appear here' : 'Nothing needs you right now'}</div>
            <div className="text-sm text-gray-500">Bids, trips, deliveries and fleet updates land here as they happen.</div>
          </div>
        </div>
        <div className={cx(SURFACE, 'p-4 h-fit')}>
          <div className="font-extrabold mb-3">Quick actions</div>
          <div className="space-y-2">
            {c.persona !== 'driver' && <span className={cx(BTN_PRIMARY, 'w-full justify-start')}><PlusCircle className="w-4 h-4" />Post a Load</span>}
            {c.persona === 'driver' && <span className={cx(BTN_PRIMARY, 'w-full justify-start')}><PlusCircle className="w-4 h-4" />Post a Load</span>}
            {c.persona === 'fleet' && <span className={cx(BTN_SECONDARY, 'w-full justify-start')}><Search className="w-4 h-4" />Find Work</span>}
            {c.persona === 'fleet' && <span className={cx(BTN_SECONDARY, 'w-full justify-start')}><Truck className="w-4 h-4" />Add truck</span>}
          </div>
        </div>
      </div>
    </AppShell>
  )
}

function SettingsScreen({ c }: { c: Ctx }) {
  const on = c.state.on
  return (
    <AppShell c={c}>
      <Hero title="Settings" sub="Your tax identity, company profile, and monthly overhead." />
      <div className="px-8 pb-10 grid grid-cols-2 gap-5 items-start">
        <div className="space-y-5">
          <Card title="PAN (required)" sub="Needed before you can post a load or bid on one. Checked against the PAN record; the number is not stored.">
            {on.pan
              ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm font-semibold text-emerald-800 flex items-center gap-2"><ShieldCheck className="w-4 h-4" />PAN verified.</div>
              : <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">No PAN verified yet — posting loads and bidding are locked until it is.</div>}
            <ScanBox c={c} id="scan-pan" label="Scan PAN card" text="Photograph the card and the fields fill in — or type them below." />
            <Field c={c} k="pan" label="PAN" placeholder="ABCPD1234E" mono />
            <div className="grid grid-cols-2 gap-3">
              <Field c={c} k="panName" label="Name as on card" placeholder={PERSONA_META[c.persona].who} />
              <Field c={c} k="panDob" label="Date of birth / incorporation" placeholder="dd-mm-yyyy" />
            </div>
            <button type="button" {...c.g('verify-pan')} className={BTN_PRIMARY}>Verify PAN</button>
          </Card>
          {c.persona === 'fleet' && (
            <Card title="Company profile" sub="What shippers, invoices and your GST filings see.">
              <Field c={c} k="company" label="Company name" placeholder="Sharma Transport Company" guide="company-name" />
              <div className="grid grid-cols-2 gap-3">
                <Field c={c} k="cPhone" label="Contact phone" placeholder="+91 98765 43210" />
                <Field c={c} k="cCity" label="City" placeholder="Bengaluru" />
              </div>
              <Field c={c} k="cAddress" label="Billing address" placeholder="Plot 14, Transport Nagar, near NH-48" />
              <button type="button" {...c.g('save-profile')} className={BTN_PRIMARY}>Save profile</button>
            </Card>
          )}
        </div>
        <div className="space-y-5">
          <Card title="Your GSTIN" sub="Required before you can post a load or add a truck.">
            <ScanBox c={c} id="scan-gst" label="Scan GST certificate" text="Photograph the GST registration certificate (REG-06); the number is filled in and checked against your PAN." />
            <Field c={c} k="gstin" label="GSTIN" placeholder="29ABCDE1234F1Z5" mono hint="15 characters. Same format as GST filings." />
            {c.v('gstin') && <div className="rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-emerald-600" />Registered and active · Verify it&apos;s yours by OTP</div>}
            {on.gst
              ? <div className="text-sm text-emerald-700 font-semibold">On file: <span className={MONO}>{c.state.f.gstin}</span></div>
              : <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">No GSTIN on file — Post a Load and Add truck will refuse until you save one.</div>}
            <button type="button" {...c.g('save-gstin')} className={BTN_PRIMARY}>Save GSTIN</button>
          </Card>
          {c.persona !== 'fleet' && (
            <Card title="Billing address" sub="Printed on your invoices and e-way bills.">
              <Field c={c} k="address" label="Address" placeholder="Shop / building, street, area" guide="address" />
              <div className="grid grid-cols-3 gap-3">
                <Field c={c} k="city" label="City" placeholder="City" />
                <Field c={c} k="state" label="State" placeholder="State" />
                <Field c={c} k="pin" label="PIN code" placeholder="560001" />
              </div>
              <button type="button" {...c.g('save-address')} className={BTN_PRIMARY}>Save address</button>
            </Card>
          )}
        </div>
      </div>
    </AppShell>
  )
}

function Section({ n, title, sub, children }: { n: number; title: string; sub: string; children: ReactNode }) {
  return (
    <section className={cx(SURFACE, 'p-5')}>
      <div className="flex items-center gap-3 mb-4">
        <span className="w-7 h-7 rounded-full bg-brand-100 text-brand-800 grid place-items-center text-sm font-extrabold">{n}</span>
        <div><div className="font-extrabold">{title}</div><div className="text-sm text-gray-500">{sub}</div></div>
      </div>
      {children}
    </section>
  )
}

function PostScreen({ c }: { c: Ctx }) {
  const on = c.state.on
  const w = Number(c.v('weight') || 0)
  const cls = w > 7000 ? 'HCV' : 'LCV'
  return (
    <AppShell c={c}>
      <Hero title={<>Post a <span className="text-brand-500">Load</span></>} sub="Create a booking and take it to the marketplace or your own fleet." />
      <div className="px-8 pb-10 grid grid-cols-[1fr_19rem] gap-5 items-start">
        <div className="space-y-4">
          <Section n={1} title="Route" sub="Add pickup and drop locations. Drag the pins to the exact gate.">
            <div className="grid grid-cols-2 gap-3">
              <Field c={c} k="pickup" label="Pickup *" placeholder="Start typing an address…" guide="pickup" />
              <Field c={c} k="drop" label="Drop *" placeholder="Start typing an address…" guide="drop" />
            </div>
          </Section>
          <Section n={2} title="Consignee" sub="Receiver details for delivery and POD.">
            <div className="grid grid-cols-2 gap-3">
              <Field c={c} k="consignee" label="Name *" placeholder="Anita Traders" guide="consignee" />
              <Field c={c} k="consigneePhone" label="Mobile *" placeholder="+91 98765 43210" />
            </div>
          </Section>
          <Section n={3} title="Cargo & vehicle" sub="Describe what you are shipping.">
            <div className="grid grid-cols-2 gap-3 items-end">
              <Field c={c} k="weight" label="Weight * (kg)" placeholder="5000" guide="weight" />
              <div><div className={LABEL}>Vehicle type *</div>
                <div className={SEG_WRAP}>{['Mini truck', 'LCV', 'HCV', 'Trailer'].map((t) => <span key={t} className={cx(t === cls ? SEG_ON : SEG_OFF, 'px-3 whitespace-nowrap')}>{t}</span>)}</div></div>
            </div>
          </Section>
          <Section n={4} title="Schedule" sub="When should the truck pick up the load?">
            <Field c={c} k="date" label="Pickup date *" placeholder="dd-mm-yyyy" guide="pickup-date" className="max-w-xs" />
          </Section>
          <Section n={5} title="How to fill it" sub="Choose how you want to move this load.">
            <div className="grid grid-cols-2 gap-3">
              <div {...c.g('auction')} className={cx('rounded-xl border p-3', on.auction ? 'border-blue-600 bg-blue-50' : 'border-gray-200')}>
                <div className="font-bold flex items-center gap-2"><Gavel className="w-4 h-4" />Auction</div><div className="text-sm text-gray-500">Open to all carriers — they bid, you pick.</div></div>
              <div className="rounded-xl border border-gray-200 p-3"><div className="font-bold flex items-center gap-2"><Navigation className="w-4 h-4" />Direct</div><div className="text-sm text-gray-500">Sent to one specific driver.</div></div>
            </div>
          </Section>
        </div>
        <div className={cx(SURFACE, 'p-5 sticky top-4')}>
          <div className="font-extrabold text-lg">Price estimate</div>
          <div className="text-sm text-gray-500">Get an estimate before posting.</div>
          {on.quote
            ? <div className="mt-4"><div className="text-3xl font-extrabold tabular-nums">₹55,718</div><div className="mt-1"><Pill tone="blue">Reference, not binding</Pill></div>
                <div className="mt-3 text-xs text-gray-500 space-y-1"><div className="flex justify-between"><span>Operating cost</span><span>₹44,970</span></div>
                  <div className="flex justify-between"><span>Fleet operator margin (18%)</span><span>₹8,095</span></div><div className="flex justify-between"><span>Market correction (×1.05)</span><span>₹2,653</span></div></div></div>
            : <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50/60 px-3 py-2.5 text-sm text-gray-600 flex gap-2"><Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />Fill route, vehicle and weight to price this load.</div>}
          <button type="button" {...c.g('get-quote')} className={cx(BTN_SECONDARY, 'mt-4 w-full')}>{on.quote ? 'Refresh quote' : 'Get quote'}</button>
          <button type="button" {...c.g('post-load')} className={cx(BTN_PRIMARY, 'mt-2 w-full', !on.quote && 'opacity-50')}>{on.quote ? 'Post load' : 'Get a quote to continue'}</button>
        </div>
      </div>
    </AppShell>
  )
}

function DriverProfile({ c }: { c: Ctx }) {
  const on = c.state.on
  const checks: [string, boolean][] = [['Personal details', !!on.details], ['Driving licence submitted', !!on.licence], ['Driving licence verified', false], ['Bank account linked', !!on.bank]]
  return (
    <AppShell c={c}>
      <Hero title="Driver profile" sub="Your details, driving licence and payout account. No truck needed." />
      {!on.driver ? (
        <div className="px-8"><div className={cx(SURFACE, 'p-6 max-w-xl')}>
          <div className="text-lg font-extrabold">Drive for BharatTruck?</div>
          <p className="text-sm text-gray-600 mt-1">Register as a driver with just your driving licence and details. You do not need a truck.</p>
          <button type="button" {...c.g('register-driver')} className={cx(BTN_PRIMARY, 'mt-4')}>Register as a driver</button>
        </div></div>
      ) : (
        <div className="px-8 pb-10 grid grid-cols-[1fr_17rem] gap-5 items-start">
          <div className="space-y-5">
            <Card title="Personal details" sub="What a fleet owner or shipper sees about you.">
              <ScanBox c={c} id="scan-aadhaar" label="Scan Aadhaar card" text={on.aadhaarRead ? `Read from your Aadhaar ending ${DEMO.driver.aadhaarLast4}. Check the details, then save.` : 'Take a photo of your Aadhaar card to fill in your name and home city. The Aadhaar number is not kept.'} />
              <div className="grid grid-cols-2 gap-3">
                <Field c={c} k="dName" label="Full name" placeholder="Ramesh Yadav" />
                <Field c={c} k="dCity" label="Home base city" placeholder="Nagpur" />
              </div>
              <Field c={c} k="languages" label="Languages" placeholder="Hindi, Marathi" guide="languages" />
              <div className="flex items-center justify-end gap-3"><span className="text-xs text-gray-500">{on.details ? 'Saved' : 'Unsaved changes'}</span>
                <button type="button" {...c.g('save-details')} className={BTN_PRIMARY}>Save details</button></div>
            </Card>
            <Card title="Driving licence" sub="Proof you may legally drive the vehicle class. Verified by our ops team.">
              <div className="rounded-xl border border-emerald-100 bg-emerald-50/60 px-3.5 py-3 flex items-center gap-3">
                <span className={cx(BTN_PRIMARY, 'h-9')}><ShieldCheck className="w-4 h-4" />Verify with DigiLocker</span>
                <p className="text-xs text-gray-600">Fastest: pull your licence from the transport department&apos;s record. Verified on the spot.</p>
              </div>
              <ScanBox c={c} id="scan-licence" label="Scan your licence" text="Take a photo of the front of your licence and we fill this in for you." />
              <div className="grid grid-cols-3 gap-3">
                <Field c={c} k="dl" label="DL number" placeholder="MH1220110012345" mono />
                <Field c={c} k="dlValid" label="Valid till" placeholder="dd-mm-yyyy" />
                <Field c={c} k="dlClasses" label="Vehicle classes" placeholder="LMV, HGMV…" />
              </div>
              <div className="flex justify-end"><button type="button" {...c.g('submit-licence')} className={BTN_PRIMARY}>{on.licence ? 'Update licence' : 'Submit licence'}</button></div>
            </Card>
            <Card title="Bank account" sub="Where your trip payouts are settled. The number is stored encrypted.">
              <ScanBox c={c} id="scan-cheque" label="Scan cheque or passbook" text="Take a photo of a cancelled cheque or the first page of your passbook." />
              <div className="grid grid-cols-2 gap-3">
                <Field c={c} k="acct" label="Account number" placeholder="8–18 digits" mono />
                <Field c={c} k="ifsc" label="IFSC" placeholder="HDFC0001234" mono />
                <Field c={c} k="holder" label="Account holder name" placeholder="As on the passbook" />
                <Field c={c} k="bank" label="Bank (optional)" placeholder="HDFC Bank" />
              </div>
              <div className="flex justify-end"><button type="button" {...c.g('link-account')} className={BTN_PRIMARY}>Link account</button></div>
            </Card>
          </div>
          <section {...c.g('checklist')} className={cx(SURFACE, 'p-5')}>
            <div className="flex items-center justify-between"><div className="font-extrabold">Verification</div><Pill tone="amber">pending</Pill></div>
            <p className="text-xs text-gray-500 mt-1">Your badge is earned on your own details — a truck is not required.</p>
            <ul className="mt-3 space-y-2.5">
              {checks.map(([t, done]) => (
                <li key={t} className="flex items-center gap-2 text-sm">
                  <span className={cx('w-5 h-5 rounded-full grid place-items-center', done ? 'bg-emerald-500 text-white' : 'border-2 border-gray-300')}>{done && <Check className="w-3 h-3" />}</span>{t}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </AppShell>
  )
}

function Dialog({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <div className="absolute inset-0 z-10 bg-black/40 grid place-items-center">
      <div className="w-[32rem] rounded-2xl bg-white p-6 shadow-2xl">
        <div className="text-lg font-extrabold">{title}</div><div className="text-sm text-gray-500 mb-4">{sub}</div>
        {children}
      </div>
    </div>
  )
}

function VehiclesScreen({ c }: { c: Ctx }) {
  const on = c.state.on
  return (
    <AppShell c={c}>
      <div className="relative min-h-full">
        <Hero title="Trucks" sub="Every asset you own, and whether it clears its own EMI." actions={<>
          <span className={cx(BTN_SECONDARY, !on.gst && 'opacity-50')}><Upload className="w-4 h-4" />Bulk upload</span>
          <button type="button" {...c.g('add-truck')} className={cx(BTN_PRIMARY, !on.gst && 'opacity-50')}><PlusCircle className="w-4 h-4" />Add truck</button>
        </>} />
        <div className="px-8 pb-10 space-y-4">
          {!on.gst && (
            <div {...c.g('gst-gate')} className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <b>GST registration needed before adding trucks.</b> Save your GSTIN in Settings (company profile or your account) and come back. Trucks you already run are unaffected.
            </div>
          )}
          {on.truck ? (
            <div className={cx(SURFACE, 'p-4 flex items-center gap-4')}>
              <span className="w-11 h-11 rounded-xl bg-brand-50 text-brand-600 grid place-items-center"><Truck className="w-5 h-5" /></span>
              <div className="flex-1"><div className={cx('font-bold', MONO)}>{DEMO.fleet.rc}</div><div className="text-sm text-gray-500">Tata Signa 4825.TK · HCV Cargo 42-48T · BS6 · 2023</div></div>
              <Pill tone="green">Active</Pill>
            </div>
          ) : (
            <div className={cx(SURFACE, 'p-10 text-center')}><Truck className="w-8 h-8 mx-auto text-gray-400" /><div className="mt-2 font-bold">No trucks yet</div>
              <div className="text-sm text-gray-500">{on.gst ? 'Add your first truck, or bulk upload the register you already keep.' : 'Save your GSTIN in Settings first — then add your first truck here.'}</div></div>
          )}
        </div>
        {c.step.dialog === 'add-truck' && (
          <Dialog title="Add truck" sub="Category and year are required.">
            <div className="space-y-3">
              <div className="text-xs font-bold uppercase tracking-wide text-gray-400">1. Identity</div>
              <div className="grid grid-cols-2 gap-3">
                <Field c={c} k="rc" label="RC number *" placeholder="MH31CQ4512" guide="rc-number" mono />
                <Field c={c} k="make" label="Make / model" placeholder="Tata Signa 4825.TK" />
              </div>
              <div className="text-xs font-bold uppercase tracking-wide text-gray-400">2. Cost model</div>
              <div {...c.g('cost-model')} className="grid grid-cols-3 gap-3 rounded-xl">
                <Field c={c} k="category" label="Model category *" placeholder="Select a category" />
                <Field c={c} k="emission" label="Emission norm" placeholder="BS6" />
                <Field c={c} k="year" label="Year *" placeholder="2023" />
              </div>
              <div className="flex justify-end gap-2 pt-2"><span className={BTN_SECONDARY}>Cancel</span>
                <button type="button" {...c.g('submit-truck')} className={BTN_PRIMARY}>Add truck</button></div>
            </div>
          </Dialog>
        )}
      </div>
    </AppShell>
  )
}

function DriversScreen({ c }: { c: Ctx }) {
  const on = c.state.on
  return (
    <AppShell c={c}>
      <div className="relative min-h-full">
        <Hero title="Drivers" sub={on.invited ? '0 active · 1 invited · 0 former' : '0 active · 0 invited · 0 former'}
          actions={<button type="button" {...c.g('invite-driver')} className={BTN_PRIMARY}><UserPlus className="w-4 h-4" />Invite driver</button>} />
        <div className="px-8 pb-10">
          {on.invited ? (
            <div className={cx(SURFACE, 'p-4 flex items-center gap-4')}>
              <span className="w-11 h-11 rounded-full bg-blue-50 text-blue-700 grid place-items-center font-bold">RY</span>
              <div className="flex-1"><div className="font-bold">{DEMO.driver.name}</div><div className={cx('text-sm text-gray-500', MONO)}>+91 {DEMO.fleet.driverPhone}</div></div>
              <Pill tone="amber">Invited</Pill>
            </div>
          ) : (
            <div className={cx(SURFACE, 'p-10 text-center')}><Users className="w-8 h-8 mx-auto text-gray-400" /><div className="mt-2 font-bold">No drivers on the roster yet</div>
              <div className="text-sm text-gray-500">Invite a driver by their BharatTruck phone number.</div></div>
          )}
        </div>
        {c.step.dialog === 'invite' && (
          <Dialog title="Invite a driver" sub="Send an invitation to join your fleet.">
            <div className={SEG_WRAP}><span className={SEG_ON}>Phone</span><span className={SEG_OFF}>Email</span></div>
            <div className="mt-3"><div className={LABEL}>Driver mobile number</div>
              <div className="flex gap-2"><span className="h-[42px] px-3 grid place-items-center rounded-[10px] border border-gray-200 bg-gray-50 text-sm">+91</span>
                <Field c={c} k="invitePhone" placeholder="9876543210" guide="invite-phone" mono className="flex-1" /></div></div>
            <div className="flex justify-end gap-2 pt-5"><span className={BTN_SECONDARY}>Cancel</span>
              <button type="button" {...c.g('send-invite')} className={BTN_PRIMARY}>Send invitation</button></div>
          </Dialog>
        )}
      </div>
    </AppShell>
  )
}

function Done({ c }: { c: Ctx }) {
  const items: Record<Persona, string[]> = {
    shipper: ['Account created and email verified', 'PAN verified', 'GSTIN saved', 'Billing address saved', 'First load posted'],
    driver: ['Account created and email verified', 'Driver profile with Aadhaar details', 'Driving licence submitted', 'Bank account linked', 'Joined a fleet'],
    fleet: ['Account created and email verified', 'Fleet management set up', 'GSTIN and PAN on file', 'First truck added', 'First driver invited'],
  }
  return (
    <div {...c.g('done')} className="h-full grid place-items-center bg-[#fffaf0]">
      <div className={cx(SURFACE, 'p-10 w-[34rem] text-center')}>
        <div className="mx-auto w-16 h-16 rounded-full bg-emerald-500 text-white grid place-items-center"><Check className="w-8 h-8" /></div>
        <h2 className="mt-4 text-3xl font-extrabold tracking-tight">You&apos;re on BharatTruck</h2>
        <ul className="mt-5 space-y-2 text-left">
          {items[c.persona].map((t) => <li key={t} className="flex items-center gap-2"><CheckCircle2 className="w-5 h-5 text-emerald-600" />{t}</li>)}
        </ul>
      </div>
    </div>
  )
}

const PATH: Record<string, string> = {
  landing: '/', register: '/login?mode=register', verify: '/login?mode=verify', home: '/home', settings: '/settings',
  post: '/post', 'driver-profile': '/driver-profile', vehicles: '/vehicles', drivers: '/drivers', done: '/home',
}

export function AppScreen(props: ScreenProps) {
  const v = (k: string) => (props.typing?.key === k ? props.typing.text : props.state.f[k] ?? '')
  const g = (id: string) => ({ 'data-guide': id, onClick: () => props.hit(id) })
  const c: Ctx = { ...props, v, g }
  const S = props.step.screen
  return (
    <div className="flex flex-col h-full">
      <div className="h-10 shrink-0 bg-gray-100 border-b border-gray-200 flex items-center gap-3 px-3">
        <span className="flex gap-1.5">{['#ff5f57', '#febc2e', '#28c840'].map((x) => <span key={x} className="w-3 h-3 rounded-full" style={{ background: x }} />)}</span>
        <span className="flex-1 max-w-lg mx-auto rounded-md bg-white border border-gray-200 px-3 py-1 text-xs text-gray-600 font-mono flex items-center gap-1.5">
          <Lock className="w-3 h-3 text-gray-400" />www.bharattruck.net{PATH[S]}
        </span>
      </div>
      <div className="relative flex-1 min-h-0">
        {S === 'landing' && <Landing c={c} />}
        {S === 'register' && <Register c={c} />}
        {S === 'verify' && <Verify c={c} />}
        {S === 'home' && <HomeScreen c={c} />}
        {S === 'settings' && <SettingsScreen c={c} />}
        {S === 'post' && <PostScreen c={c} />}
        {S === 'driver-profile' && <DriverProfile c={c} />}
        {S === 'vehicles' && <VehiclesScreen c={c} />}
        {S === 'drivers' && <DriversScreen c={c} />}
        {S === 'done' && <Done c={c} />}
      </div>
    </div>
  )
}
