'use client'

/**
 * Public landing page for visitors with no session (2026-10 light redesign).
 *
 * Every claim on this page is a feature the product ships today. No testimonials, no
 * "trusted by" badges, no user counts — the strip under the hero states product facts
 * (see marketing-bits). The hero product card is a SAMPLE load (labelled so) with three
 * switchable views; its tracking view is a still picture and loads no map.
 */

import Image from 'next/image'
import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import {
  ArrowRight, Building2, Car, Check, ChevronRight, ClipboardCheck, Factory, FileText,
  IndianRupee, Lock, MapPin, Package, PackagePlus, ReceiptText, ShieldCheck, ShoppingBasket,
  ShoppingCart, Sprout, Truck,
} from 'lucide-react'
import { Logo } from '@/components/brand'
import { BTN_BLUE_SOLID, BTN_PRIMARY, BTN_SECONDARY, BTN_SUCCESS, LINK, TINT, cx, type Tint } from '@/lib/ui'
import { SteeringWheel } from './auth-ui'
import { FOCUS, FactStrip, FeatureTile, SiteNav } from './marketing-bits'

const SIGN_IN = '/login'
const REGISTER = '/login?mode=register'

type Persona = {
  id: string; icon: ReactNode; tint: Tint; check: string; title: string; sub: string; points: string[]
  /** Header wash, the faded backdrop icon colour, and the call-to-action button. */
  wash: string; ghost: string; cta: string
}

const PERSONAS: Persona[] = [
  {
    id: 'shippers', icon: <Package />, tint: 'brand', check: 'text-brand-500',
    title: 'For Shippers', sub: 'Move goods with confidence',
    points: [
      'Post loads and get competitive bids',
      'Track live and get proof of delivery',
      'Digital LR and e-way bill records',
      'Share a delivery code with your receiver',
    ],
    wash: 'from-brand-100/80 via-brand-50/60', ghost: 'text-brand-300/35', cta: BTN_PRIMARY,
  },
  {
    id: 'drivers', icon: <SteeringWheel />, tint: 'blue', check: 'text-blue-600',
    title: 'For Drivers', sub: 'Get trips. Get paid. Keep moving.',
    points: [
      'Join with just your driving licence',
      'See your assigned trips and navigate',
      'Delivery code and photo proof',
      'Payouts directly to your bank',
    ],
    wash: 'from-blue-100/80 via-blue-50/60', ghost: 'text-blue-300/35', cta: BTN_BLUE_SOLID,
  },
  {
    id: 'fleet-owners', icon: <Truck />, tint: 'green', check: 'text-emerald-600',
    title: 'For Fleet Owners', sub: 'Higher utilisation. Lower headaches.',
    points: [
      'Assign trucks and drivers',
      'Track live and manage per-truck costs',
      'See fuel variance and tyre costs',
      'Add and manage staff with roles',
    ],
    wash: 'from-emerald-100/80 via-emerald-50/60', ghost: 'text-emerald-300/35', cta: BTN_SUCCESS,
  },
]

const HERO_FEATURES: { icon: ReactNode; tint: Tint; label: string }[] = [
  { icon: <ReceiptText />, tint: 'brand', label: 'GST-ready invoices' },
  { icon: <MapPin />, tint: 'blue', label: 'Live trip tracking' },
  { icon: <ClipboardCheck />, tint: 'brand', label: 'Proof of delivery (POD)' },
  { icon: <ShieldCheck />, tint: 'green', label: 'Encrypted bank details' },
]

const STEPS: { icon: ReactNode; title: string; text: string }[] = [
  { icon: <PackagePlus />, title: 'Post a load', text: 'Add pickup, delivery and goods details.' },
  { icon: <IndianRupee />, title: 'Compare bids', text: 'Rates, truck types and carriers side by side.' },
  { icon: <Truck />, title: 'Assign truck and driver', text: 'Pick the best bid and confirm the trip.' },
  { icon: <MapPin />, title: 'Track live', text: 'Follow the truck from pickup to drop.' },
  { icon: <ClipboardCheck />, title: 'Deliver and pay', text: 'Delivery code, POD photos, then payment.' },
]

const FEATURES: { icon: ReactNode; tint: Tint; title: string; text: string }[] = [
  { icon: <ReceiptText />, tint: 'blue', title: 'GST-ready invoices', text: 'Scan the e-invoice QR to capture GST details' },
  { icon: <FileText />, tint: 'violet', title: 'E-way bill records', text: 'Keep every e-way bill with its load' },
  { icon: <MapPin />, tint: 'brand', title: 'Geotagged proof of delivery', text: 'Photo, location and time at the drop' },
  { icon: <Lock />, tint: 'green', title: 'Encrypted bank details', text: 'Account numbers stored encrypted' },
]

const INDUSTRIES: { icon: ReactNode; tint: Tint; label: string }[] = [
  { icon: <Factory />, tint: 'brand', label: 'Manufacturing' },
  { icon: <ShoppingBasket />, tint: 'amber', label: 'FMCG' },
  { icon: <Sprout />, tint: 'green', label: 'Agriculture' },
  { icon: <Building2 />, tint: 'red', label: 'Construction' },
  { icon: <ShoppingCart />, tint: 'violet', label: 'E-commerce' },
  { icon: <Car />, tint: 'blue', label: 'Automotive' },
]

const PHOTO = '/images/highway-sunset-wide.webp'

export function Landing() {
  return (
    <div className="min-h-full bg-gray-50 text-gray-900">
      <SiteNav
        actions={
          <>
            <Link href={SIGN_IN} className={cx(BTN_SECONDARY, 'h-9 whitespace-nowrap border-gray-300 px-3 sm:px-4')}>Sign in</Link>
            <Link href={REGISTER} className={cx(BTN_PRIMARY, 'h-9 whitespace-nowrap px-3 sm:px-4')}>Create account</Link>
          </>
        }
      />

      <main>
        {/* ── HERO ── */}
        <section className="relative isolate overflow-hidden bg-[var(--warm)]">
          <HeroBackdrop />
          <HeroBackdropMobile />
          <div className="mx-auto grid max-w-[100rem] items-start gap-8 px-4 pt-8 sm:pt-10 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] lg:gap-8 lg:px-8">
            <div className="lg:pb-4 lg:pt-2">
              <span className="inline-flex items-center gap-2 rounded-full border border-white/80 bg-white/90 px-3 py-1.5 text-xs font-semibold text-gray-700 shadow-[0_1px_4px_rgba(20,24,31,0.06)]">
                <IndiaFlag />
                <span className="sm:hidden">India&apos;s freight platform</span>
                <span className="hidden sm:inline">India&apos;s freight marketplace and fleet management platform</span>
              </span>
              <h1 className="mt-5 text-[2.625rem] font-extrabold leading-[1.02] tracking-[-0.03em] sm:text-[3.25rem] xl:text-[3.625rem] 2xl:text-[4.25rem]">
                <span className="block xl:whitespace-nowrap">Every load, every truck,</span>
                <span className="block text-brand-500">one login.</span>
              </h1>
              <p className="mt-5 max-w-xl text-base font-medium leading-relaxed text-gray-700 sm:text-lg">
                Post a load and get bids, run your trips with live tracking and proof of delivery,
                and see which truck actually pays its EMI.
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                <Link href={REGISTER} className={cx(BTN_PRIMARY, 'h-12 px-6 text-base shadow-[0_6px_16px_rgba(242,165,22,0.35)]')}>
                  Post a load <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
                <Link href={REGISTER} className={cx(BTN_SECONDARY, 'h-12 border-gray-900/80 px-6 text-base')}>
                  Run my fleet <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              </div>
              <ul className="mt-8 flex flex-wrap gap-x-5 gap-y-4">
                {HERO_FEATURES.map(f => <FeatureTile key={f.label} {...f} />)}
              </ul>
            </div>
            <HeroIllustration />
          </div>

          {/* facts + supply-chain tile, sitting on the photo */}
          <div className="mx-auto mt-8 grid max-w-[100rem] gap-4 px-4 pb-8 lg:mt-10 lg:grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)] lg:px-8 lg:pb-10">
            <FactStrip />
            <div className="relative isolate flex min-h-[92px] items-center overflow-hidden rounded-2xl px-6 py-4 text-[#fff] shadow-[0_8px_30px_rgba(20,24,31,0.12)]">
              <Image src="/images/highway-sunset.webp" alt="" fill sizes="(min-width: 1024px) 30vw, 100vw" className="-z-20 object-cover object-[50%_70%]" />
              <div className="absolute inset-0 -z-10 bg-gradient-to-r from-[#0b0e13]/85 via-[#0b0e13]/60 to-[#0b0e13]/20" aria-hidden />
              <div>
                <p className="text-lg font-extrabold leading-tight tracking-tight">Powering India&apos;s supply chain</p>
                <p className="mt-1 text-xs text-[#fff]/85">From a single truck to a full fleet.</p>
                <span className="mt-2 flex h-1 w-9 overflow-hidden rounded-full" aria-hidden>
                  <span className="flex-1 bg-[#ff9933]" /><span className="flex-1 bg-[#fff]" /><span className="flex-1 bg-[#138808]" />
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* ── PERSONAS ── */}
        <section className="mx-auto max-w-[100rem] px-4 pt-2 lg:px-8" aria-label="Who it is for">
          <div className="grid gap-3 md:grid-cols-3 md:gap-5">
            {PERSONAS.map(p => (
              <div key={p.id} id={p.id} className="scroll-mt-24">
                {/* Phones: a compact row, as in the mobile reference. */}
                <Link href={REGISTER} className={cx('flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-3.5 md:hidden', FOCUS)}>
                  <Tile icon={p.icon} tint={p.tint} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[0.9375rem] font-bold">{p.title}</span>
                    <span className="block text-xs text-gray-500">{p.sub}</span>
                  </span>
                  <ChevronRight className="h-5 w-5 text-gray-400" aria-hidden />
                </Link>
                {/* Tablet and up: the full card with a tinted header. */}
                <div className="hidden h-full flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-[0_2px_10px_rgba(20,24,31,0.04)] transition-shadow hover:shadow-[0_10px_30px_rgba(20,24,31,0.09)] md:flex">
                  <div className={cx('relative overflow-hidden bg-gradient-to-r to-white px-6 pb-5 pt-6', p.wash)}>
                    <span className={cx('pointer-events-none absolute -right-5 -top-6 [&_svg]:h-36 [&_svg]:w-36 [&_svg]:stroke-[1.2]', p.ghost)} aria-hidden>{p.icon}</span>
                    <div className="relative flex items-center gap-4">
                      <span className={cx('inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-white bg-white shadow-[0_2px_8px_rgba(20,24,31,0.08)] [&_svg]:h-7 [&_svg]:w-7', TINT[p.tint].split(' ')[1])} aria-hidden>
                        {p.icon}
                      </span>
                      <div>
                        <h2 className="text-xl font-extrabold leading-tight tracking-tight">{p.title}</h2>
                        <p className="mt-0.5 text-sm text-gray-600">{p.sub}</p>
                      </div>
                    </div>
                  </div>
                  <ul className="space-y-2.5 px-6 pt-5 text-sm text-gray-700">
                    {p.points.map(pt => (
                      <li key={pt} className="flex items-start gap-2.5">
                        <Check className={cx('mt-0.5 h-4 w-4 shrink-0', p.check)} strokeWidth={3} aria-hidden /> {pt}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-auto px-6 pb-6 pt-5">
                    <Link href={REGISTER} className={cx(p.cta, 'h-10 px-4')}>
                      Get started <ArrowRight className="h-4 w-4" aria-hidden />
                    </Link>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── HOW A LOAD MOVES ── */}
        <section id="how-it-works" className="mx-auto max-w-[100rem] scroll-mt-20 px-4 pt-5 lg:px-8">
          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-[0_2px_10px_rgba(20,24,31,0.04)] sm:p-6">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-xl font-extrabold tracking-tight sm:text-2xl">How a load moves on BharatTruck</h2>
              <Link href={REGISTER} className={cx(LINK, 'hidden items-center gap-1.5 rounded text-sm sm:inline-flex', FOCUS)}>
                Start with a load <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            </div>
            <ol className="mt-4 rounded-xl border border-gray-100 bg-gray-50/60 p-3 sm:p-4 lg:grid lg:grid-cols-5 lg:gap-2">
              {STEPS.map((s, i) => (
                <li key={s.title} className="relative flex items-center gap-3 py-2 lg:py-1 lg:pr-5">
                  <span className="relative shrink-0">
                    <span className={cx('inline-flex h-11 w-11 items-center justify-center rounded-full [&_svg]:h-5 [&_svg]:w-5', TINT.blue)} aria-hidden>{s.icon}</span>
                    <span className="absolute -left-1.5 -top-1 inline-flex h-5 w-5 items-center justify-center rounded-full border border-gray-200 bg-white text-[0.6875rem] font-bold text-gray-700">{i + 1}</span>
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-bold leading-tight">{s.title}</span>
                    <span className="mt-0.5 block text-xs leading-snug text-gray-500">{s.text}</span>
                  </span>
                  {i < STEPS.length - 1 && (
                    <ArrowRight className="absolute right-0 top-1/2 hidden h-4 w-4 -translate-y-1/2 text-gray-300 lg:block" aria-hidden />
                  )}
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ── INDUSTRIES + DRIVER BANNER ── */}
        <section id="industries" className="mx-auto grid max-w-[100rem] scroll-mt-20 gap-5 px-4 pt-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:px-8">
          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-[0_2px_10px_rgba(20,24,31,0.04)] sm:p-6">
            <h2 className="text-xl font-extrabold tracking-tight sm:text-2xl">Built for every type of business</h2>
            <p className="mt-1 text-sm text-gray-600">Whether you ship once a month or every day, the same account works.</p>
            <ul className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-6">
              {INDUSTRIES.map(n => (
                <li key={n.label} className={cx('flex flex-col items-center gap-2 rounded-xl px-2 py-4 text-center [&_svg]:h-7 [&_svg]:w-7', TINT[n.tint])}>
                  <span aria-hidden>{n.icon}</span>
                  <span className="text-[0.8125rem] font-semibold text-gray-800">{n.label}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="relative isolate flex min-h-[180px] items-center overflow-hidden rounded-2xl px-6 py-6 text-[#fff] shadow-[0_8px_30px_rgba(20,24,31,0.12)] sm:px-8">
            <Image src={PHOTO} alt="" fill sizes="(min-width: 1024px) 40vw, 100vw" className="-z-20 object-cover object-[78%_60%]" />
            <div className="absolute inset-0 -z-10 bg-gradient-to-r from-[#0b0e13]/90 via-[#0b0e13]/65 to-[#0b0e13]/10" aria-hidden />
            <div className="max-w-[270px]">
              <p className="text-2xl font-extrabold leading-tight tracking-tight">More trips.<br />Steady income.</p>
              <p className="mt-2 text-sm text-[#fff]/85">Join with just your driving licence. No truck needed to start.</p>
              <Link href={REGISTER} className={cx(BTN_PRIMARY, 'mt-4 h-10 px-4')}>
                Join as a driver <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            </div>
          </div>
        </section>

        {/* ── BUILT FOR INDIA ── */}
        <section className="mx-auto max-w-[100rem] px-4 pt-5 lg:px-8">
          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-[0_2px_10px_rgba(20,24,31,0.04)] sm:p-6">
            <h2 className="text-xl font-extrabold tracking-tight sm:text-2xl">Built for how India moves</h2>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {FEATURES.map(f => (
                <li key={f.title} className="flex items-center gap-3 rounded-xl border border-gray-100 bg-gray-50/60 p-4">
                  <Tile icon={f.icon} tint={f.tint} />
                  <span className="min-w-0">
                    <span className="block text-sm font-bold">{f.title}</span>
                    <span className="mt-0.5 block text-xs text-gray-500">{f.text}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      {/* ── FOOTER ── */}
      <footer className="mt-10 border-t border-gray-200 bg-white">
        <div className="mx-auto flex max-w-[100rem] flex-col gap-6 px-4 py-8 sm:flex-row sm:items-center sm:justify-between lg:px-8">
          <div>
            <Logo size="md" />
            <p className="mt-2 text-sm text-gray-500">Made for Indian road freight.</p>
          </div>
          <div className="flex items-center gap-5 text-sm font-semibold">
            <Link href={SIGN_IN} className={cx('rounded text-gray-700 hover:text-gray-900', FOCUS)}>Sign in</Link>
            <Link href={REGISTER} className={cx(LINK, 'rounded', FOCUS)}>Create account</Link>
          </div>
        </div>
        <div className="border-t border-gray-100">
          <div className="mx-auto flex max-w-[100rem] flex-col gap-1 px-4 py-4 text-xs text-gray-500 sm:flex-row sm:justify-between lg:px-8">
            <span>© {new Date().getFullYear()} BharatTruck. All rights reserved.</span>
            <span>India&apos;s trucks. A stronger tomorrow.</span>
          </div>
        </div>
      </footer>
    </div>
  )
}

/**
 * The highway photograph behind the hero (desktop only), anchored bottom-left so the trucks
 * sit between the headline and the map card. Its top and right edges dissolve into the
 * hero's own colour, a light wash on the left keeps the copy readable, and the bottom
 * fades into the page.
 */
function HeroBackdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 -z-10 hidden lg:block" aria-hidden>
      <div className="absolute bottom-0 left-0 aspect-[1672/941] w-[72%]">
        <Image src={PHOTO} alt="" fill priority sizes="72vw" className="object-cover dark:hidden" />
        <Image src="/images/highway-india-map-night.webp" alt="" fill loading="lazy" sizes="72vw" className="hidden origin-bottom-left scale-[1.5] object-cover dark:block" />
        <div className="absolute inset-x-0 top-0 h-[42%] dark:hidden bg-gradient-to-b from-[var(--warm)] via-[var(--warm)]/70 to-transparent" />
        <div className="absolute inset-y-0 right-0 w-[26%] dark:hidden bg-gradient-to-l from-[var(--warm)] via-[var(--warm)]/60 to-transparent" />
      </div>
      <div className="absolute inset-0 hero-wash-x" />
      <div className="absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-gray-50 to-transparent" />
    </div>
  )
}

/**
 * Phones and tablets: the portrait highway artwork (its night version in the dark theme)
 * behind the whole hero, washed heavily at the top where the headline sits and lightly at
 * the bottom where the trucks are.
 */
function HeroBackdropMobile() {
  return (
    <div className="pointer-events-none absolute inset-0 -z-10 lg:hidden" aria-hidden>
      <Image src="/images/highway-portrait.webp" alt="" fill priority sizes="100vw" className="object-cover object-bottom dark:hidden" />
      <Image src="/images/highway-portrait-night.webp" alt="" fill loading="lazy" sizes="100vw" className="hidden object-cover object-bottom dark:block" />
      <div className="absolute inset-0 bg-[linear-gradient(to_bottom,color-mix(in_srgb,var(--warm)_88%,transparent)_0%,color-mix(in_srgb,var(--warm)_62%,transparent)_38%,color-mix(in_srgb,var(--warm)_12%,transparent)_100%)]" />
      <div className="absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-gray-50 to-transparent" />
    </div>
  )
}

function IndiaFlag() {
  return (
    <span className="flex h-3 w-[18px] flex-col overflow-hidden rounded-[2px] ring-1 ring-black/5" aria-hidden>
      <span className="flex-1 bg-[#ff9933]" /><span className="flex-1 bg-[#fff]" /><span className="flex-1 bg-[#138808]" />
    </span>
  )
}

function Tile({ icon, tint }: { icon: ReactNode; tint: Tint }) {
  return (
    <span className={cx('inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl [&_svg]:h-[22px] [&_svg]:w-[22px]', TINT[tint])} aria-hidden>
      {icon}
    </span>
  )
}

type HeroTab = 'tracking' | 'bids' | 'documents'

const HERO_BIDS: { carrier: string; truck: string; price: string; note?: string; best?: boolean }[] = [
  { carrier: 'Sharma Transport Co.', truck: 'HCV · 16 t', price: '₹46,200', note: 'Lowest bid', best: true },
  { carrier: 'Vidarbha Roadlines', truck: 'HCV · 18 t', price: '₹47,500' },
  { carrier: 'Deccan Carriers', truck: 'MCV · 16 t', price: '₹48,500' },
  { carrier: 'Western Freight', truck: 'HCV · 20 t', price: '₹49,900' },
]

const HERO_DOCS: { icon: ReactNode; name: string; text: string; status: string; done: boolean }[] = [
  { icon: <FileText />, name: 'Consignment note (LR)', text: 'Raised by the carrier', status: 'Issued', done: true },
  { icon: <ReceiptText />, name: 'Tax invoice', text: 'GST details from the e-invoice QR', status: 'Issued', done: true },
  { icon: <ClipboardCheck />, name: 'E-way bill', text: 'Kept with the load', status: 'On file', done: true },
  { icon: <MapPin />, name: 'Proof of delivery', text: 'Photo, location and time at the drop', status: 'After delivery', done: false },
]

/**
 * The hero "product card": a sample Nagpur → Pune load with three views the visitor can
 * switch between — tracking (a STILL PICTURE, not a live map: it shows no real data, so
 * loading Google Maps for it on every visit was cost with no function), the bids on it, and
 * its documents. Everything in it is sample data and labelled so.
 */
function HeroIllustration() {
  const [tab, setTab] = useState<HeroTab>('tracking')
  const tabs: { key: HeroTab; label: string }[] = [
    { key: 'tracking', label: 'Live tracking' },
    { key: 'bids', label: 'Bids' },
    { key: 'documents', label: 'Documents' },
  ]
  return (
    <div className="overflow-hidden rounded-2xl border border-white/80 bg-white shadow-[0_18px_50px_rgba(20,24,31,0.16)]">
      <div className="flex items-center gap-6 border-b border-gray-100 px-5 text-[0.8125rem] font-semibold" role="tablist" aria-label="Sample load">
        {tabs.map(t => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`hero-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls="hero-panel"
            onClick={() => setTab(t.key)}
            className={cx(
              '-mb-px border-b-2 py-3 transition-colors focus-visible:outline-none focus-visible:text-blue-600',
              tab === t.key ? 'border-brand-500 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-800',
            )}
          >
            {t.label}
          </button>
        ))}
        {/* A glowing, pulsing dot: a ping ring behind a dot with a soft halo. */}
        <span className="ml-auto inline-flex items-center gap-2 text-xs font-semibold text-emerald-700">
          <span className="relative flex h-2.5 w-2.5" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-[0_0_10px_3px_rgba(16,185,129,0.55)]" />
          </span>
          Live
        </span>
      </div>
      <div id="hero-panel" role="tabpanel" aria-labelledby={`hero-tab-${tab}`} className="relative aspect-[1160/967] w-full bg-gray-100">
        {tab === 'tracking' && (
          <>
            {/* One picture per theme; the other is not downloaded (display: none + lazy). */}
            <Image src="/images/hero-route.webp" alt="Sample trip from Nagpur to Pune shown on a map, in transit" fill priority sizes="(min-width: 1024px) 40vw, 100vw" className="object-cover object-center dark:hidden" />
            <Image src="/images/hero-route-dark.webp" alt="" aria-hidden fill loading="lazy" sizes="(min-width: 1024px) 40vw, 100vw" className="hidden object-cover object-center dark:block" />
            <HeroTruck />
          </>
        )}
        {tab === 'bids' && (
          <div className="absolute inset-0 overflow-y-auto bg-white p-4 sm:p-5">
            <HeroLoadLine sub="4 bids received" />
            <ul className="mt-3 space-y-2.5">
              {HERO_BIDS.map(b => (
                <li key={b.carrier} className={cx('flex items-center gap-3 rounded-xl border p-3', b.best ? 'border-emerald-200 bg-emerald-50/60' : 'border-gray-200 bg-white')}>
                  <span className={cx('inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl [&_svg]:h-5 [&_svg]:w-5', b.best ? TINT.green : TINT.slate)} aria-hidden><Truck /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold text-gray-900">{b.carrier}</span>
                    <span className="block text-xs text-gray-500">{b.truck}{b.note ? ` · ${b.note}` : ''}</span>
                  </span>
                  <span className={cx('text-base font-extrabold tabular-nums', b.best ? 'text-emerald-600' : 'text-gray-900')}>{b.price}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-gray-500">Compare rates and truck types, then accept the bid you want.</p>
          </div>
        )}
        {tab === 'documents' && (
          <div className="absolute inset-0 overflow-y-auto bg-white p-4 sm:p-5">
            <HeroLoadLine sub="All paperwork stays with the load" />
            <ul className="mt-3 space-y-2.5">
              {HERO_DOCS.map(d => (
                <li key={d.name} className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-3">
                  <span className={cx('inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl [&_svg]:h-5 [&_svg]:w-5', d.done ? TINT.blue : TINT.slate)} aria-hidden>{d.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold text-gray-900">{d.name}</span>
                    <span className="block text-xs text-gray-500">{d.text}</span>
                  </span>
                  <span className={cx('shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold', d.done ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-gray-200 bg-gray-50 text-gray-600')}>{d.status}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <p className="border-t border-gray-100 px-5 py-2 text-center text-[0.6875rem] font-medium text-gray-400">Sample load, for illustration</p>
    </div>
  )
}

/**
 * The route drawn in both hero pictures, from Nagpur down to Pune, in the picture's own
 * 1160 × 967 pixel space: a smooth curve fitted through points traced from the artwork, so
 * the truck's heading changes gradually.
 */
const HERO_ROUTE_PATH =
  'M995 333 C989 336 968 339 958 348 C948 358 943 376 933 390 C923 404 914 419 900 430 C886 441 867 446 849 454 C831 462 810 469 790 478 C770 487 749 495 729 507 C709 519 690 538 670 549 C650 560 630 566 610 572 C590 579 570 581 550 588 C530 595 509 610 489 614 C469 618 450 610 430 614 C410 618 389 632 369 640 C349 648 329 654 309 662 C289 670 268 683 250 689 C232 695 214 694 200 700 C186 706 173 722 165 727 C157 732 153 730 150 730'

/**
 * Truck size on the 1160-wide picture, and — measured from the artwork — the point midway
 * between its two wheels' contact with the ground (as fractions of the image) and how far
 * the drawing is tilted nose-up. That point rides the route line, and the tilt is undone,
 * so the wheels sit on the road instead of the truck floating above it.
 */
const TRUCK = { w: 78, h: 52, wheelX: 0.558, wheelY: 0.791, tiltDeg: 7.6 }

/**
 * A truck driving the sample route, over the picture. The SVG shares the picture's aspect
 * ratio, so the path stays on the drawn line at every size. `rotate="auto"` turns the truck
 * to follow the road; the trip runs Nagpur → Pune, i.e. right to left, so the artwork is
 * flipped top-to-bottom first (a half-turn would otherwise leave it upside down). The
 * drawing is anchored at its wheels and levelled (see TRUCK), so the wheels sit on the line. It
 * fades in at the start and out at the end instead of jumping back. Parked for people who
 * ask for reduced motion.
 */
function HeroTruck() {
  const art = (
    <image
      href="/images/hero-truck.webp"
      width={TRUCK.w}
      height={TRUCK.h}
      x={-TRUCK.w * TRUCK.wheelX}
      y={-TRUCK.h * TRUCK.wheelY}
      // Read right to left: level the drawing about the wheel point, then flip it.
      transform={`scale(1 -1) rotate(${TRUCK.tiltDeg})`}
    />
  )
  return (
    <svg viewBox="0 0 1160 967" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
      <g className="motion-reduce:hidden" opacity="0">
        {art}
        <animateMotion dur="36s" repeatCount="indefinite" path={HERO_ROUTE_PATH} rotate="auto" calcMode="linear" />
        <animate attributeName="opacity" dur="36s" repeatCount="indefinite" values="0;1;1;0" keyTimes="0;0.04;0.95;1" />
      </g>
      {/* Reduced motion: the truck parked part-way along the route. */}
      <g transform="translate(610 572) rotate(160)" className="hidden motion-reduce:block">{art}</g>
    </svg>
  )
}

function HeroLoadLine({ sub }: { sub: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[1.0625rem] font-extrabold tracking-tight text-gray-900">Nagpur</span>
      <ArrowRight className="h-4 w-4 text-gray-400" aria-label="to" />
      <span className="text-[1.0625rem] font-extrabold tracking-tight text-gray-900">Pune</span>
      <span className="ml-auto text-xs font-medium text-gray-500">{sub}</span>
    </div>
  )
}
