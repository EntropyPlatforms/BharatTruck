'use client'

// The onboarding guide: pick who you are, then walk the real sign-up on re-drawn screens.
// A spotlight and a bouncing arrow show exactly where to click, type or upload; "Do it for me"
// types the demo data and drops the sample document in; Auto-play runs the whole journey.
// The step lives in the URL (?p=driver&s=7), so any step can be linked or captured directly.

import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Download, Languages, Pause, Play, RotateCcw, Sparkles, Wand2 } from 'lucide-react'
import Link from 'next/link'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { BrandMark, Wordmark } from '@/components/brand'
import { BTN_PRIMARY, BTN_SECONDARY, SURFACE, cx } from '@/lib/ui'
import { DOC_LABEL, SampleDoc } from './docs'
import { AppScreen } from './screens'
import { PERSONA_META, VERB_LABEL, stateAfter, stepsFor, type GuideStart, type Lang, type Persona } from './steps'

const CANVAS_W = 1280
const CANVAS_H = 800
type Rect = { x: number; y: number; w: number; h: number }

const UI = {
  title: { en: 'Onboarding guide', hi: 'ऑनबोर्डिंग गाइड' },
  who: { en: 'Who are you?', hi: 'आप कौन हैं?' },
  whoSub: { en: 'Pick one and we’ll walk you through signing up on BharatTruck, screen by screen — with demo data, so nothing real is used.', hi: 'एक चुनें — हम BharatTruck पर साइन अप का हर स्क्रीन दिखाएँगे। सब डेमो डेटा से, कुछ भी असली नहीं।' },
  step: { en: 'Step', hi: 'स्टेप' },
  of: { en: 'of', hi: 'में से' },
  doIt: { en: 'Do it for me', hi: 'मेरे लिए करें' },
  next: { en: 'Next', hi: 'आगे' },
  back: { en: 'Back', hi: 'पीछे' },
  auto: { en: 'Auto-play', hi: 'ऑटो-प्ले' },
  pause: { en: 'Pause', hi: 'रोकें' },
  restart: { en: 'Start again', hi: 'फिर से शुरू' },
  change: { en: 'Change role', hi: 'भूमिका बदलें' },
  sample: { en: 'Sample document used', hi: 'इस्तेमाल हुआ नमूना दस्तावेज़' },
  sampleNote: { en: 'Demo only — use your real document in the app.', hi: 'सिर्फ़ डेमो — ऐप में अपना असली दस्तावेज़ लगाएँ।' },
  open: { en: 'Open BharatTruck', hi: 'BharatTruck खोलें' },
  tryReal: { en: 'Create your real account', hi: 'अपना असली अकाउंट बनाएँ' },
  pdf: { en: 'Download PDF', hi: 'PDF डाउनलोड करें' },
  pdfLong: { en: 'Prefer paper? Download the whole guide as a PDF (all roles, every screen).', hi: 'काग़ज़ पर चाहिए? पूरी गाइड PDF में डाउनलोड करें (सभी भूमिकाएँ, हर स्क्रीन)।' },
}

const PDF_URL = '/onboarding/BharatTruck-Onboarding-Guide.pdf'

export default function GuideApp({ start }: { start: GuideStart }) {
  const [persona, setPersona] = useState<Persona | null>(start.p)
  const [idx, setIdx] = useState(start.s)
  const [lang, setLang] = useState<Lang>(start.lang)
  const shot = start.shot

  // Keep the URL in step with the guide, so a step can be shared or reloaded.
  useEffect(() => {
    const q = new URLSearchParams()
    if (persona) { q.set('p', persona); q.set('s', String(idx)) }
    if (lang === 'hi') q.set('lang', 'hi')
    if (shot) q.set('shot', '1')
    const next = `${window.location.pathname}${q.toString() ? `?${q}` : ''}`
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, '', next)
  }, [persona, idx, lang, shot])

  return (
    <div className={cx('min-h-dvh bg-[#fffaf0]', shot && 'guide-shot')}>
      {!shot && (
        <header className="sticky top-0 z-30 bg-white/90 backdrop-blur border-b border-gray-200">
          <div className="max-w-[96rem] mx-auto flex items-center gap-3 px-4 sm:px-6 h-14">
            <Link href="/" className="flex items-center gap-2"><BrandMark className="w-7 h-7" /><Wordmark className="text-lg" /></Link>
            <span className="hidden sm:inline text-sm font-semibold text-gray-500 border-l border-gray-200 pl-3">{UI.title[lang]}</span>
            <div className="ml-auto flex items-center gap-2">
              <a href={PDF_URL} download className={cx(BTN_SECONDARY, 'h-9 px-3')}><Download className="w-4 h-4" /><span className="hidden sm:inline">{UI.pdf[lang]}</span></a>
              <button type="button" onClick={() => setLang(lang === 'en' ? 'hi' : 'en')} className={cx(BTN_SECONDARY, 'h-9 px-3')} aria-label="Switch language">
                <Languages className="w-4 h-4" />{lang === 'en' ? 'हिन्दी' : 'English'}
              </button>
              <Link href="/login?mode=register" className={cx(BTN_PRIMARY, 'h-9 px-3 hidden sm:inline-flex')}>{UI.tryReal[lang]}</Link>
            </div>
          </div>
        </header>
      )}
      {persona
        ? <Tour key={persona} persona={persona} idx={idx} setIdx={setIdx} lang={lang} shot={shot} onChange={() => { setPersona(null); setIdx(0) }} />
        : <Picker lang={lang} onPick={(p) => { setPersona(p); setIdx(0) }} />}
    </div>
  )
}

function Picker({ lang, onPick }: { lang: Lang; onPick: (p: Persona) => void }) {
  const tone: Record<Persona, string> = { shipper: 'bg-brand-50 text-brand-700', driver: 'bg-blue-50 text-blue-700', fleet: 'bg-emerald-50 text-emerald-700' }
  return (
    <main className="max-w-5xl mx-auto px-4 sm:px-6 py-10 sm:py-16">
      <div className="inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-white px-3 py-1 text-xs font-semibold text-brand-800"><Sparkles className="w-3.5 h-3.5" />{UI.title[lang]}</div>
      <h1 className="mt-4 text-[2.25rem] sm:text-[3rem] leading-[1.05] font-extrabold tracking-[-0.03em] text-gray-900">{UI.who[lang]}</h1>
      <p className="mt-3 text-gray-600 max-w-2xl">{UI.whoSub[lang]}</p>
      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        {(['shipper', 'driver', 'fleet'] as Persona[]).map((p) => (
          <button key={p} type="button" onClick={() => onPick(p)} data-pick={p}
            className={cx(SURFACE, 'text-left p-6 hover:border-brand-300 hover:shadow-lg transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600')}>
            <span className={cx('inline-flex rounded-lg px-2.5 py-1 text-xs font-bold', tone[p])}>{PERSONA_META[p].role}</span>
            <span className="mt-3 block text-xl font-extrabold text-gray-900">{PERSONA_META[p].label[lang]}</span>
            <span className="mt-1 block text-sm text-gray-600">{PERSONA_META[p].blurb[lang]}</span>
            <span className="mt-4 inline-flex items-center gap-1 text-sm font-bold text-blue-600">{lang === 'en' ? 'Show me' : 'दिखाइए'} <ArrowRight className="w-4 h-4" /></span>
          </button>
        ))}
      </div>
      <a href={PDF_URL} download className="mt-8 inline-flex items-center gap-2 text-sm font-semibold text-blue-600 hover:text-blue-700">
        <Download className="w-4 h-4" />{UI.pdfLong[lang]}
      </a>
    </main>
  )
}

function Tour({ persona, idx, setIdx, lang, shot, onChange }: {
  persona: Persona; idx: number; setIdx: (n: number) => void; lang: Lang; shot: boolean; onChange: () => void
}) {
  const steps = useMemo(() => stepsFor(persona), [persona])
  const i = Math.min(idx, steps.length - 1)
  const step = steps[i]
  const state = useMemo(() => stateAfter(steps, i), [steps, i])
  const last = i === steps.length - 1

  const [typing, setTyping] = useState<{ key: string; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [autoOn, setAuto] = useState(false)
  const auto = autoOn && !last // auto-play stops by itself at the last step
  const [toast, setToast] = useState<string | null>(null)
  const [flying, setFlying] = useState<null | { from: boolean }>(null)

  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [rect, setRect] = useState<Rect | null>(null)
  const timers = useRef<number[]>([])
  const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)) }
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  // Fit the fixed-size canvas to the available width.
  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const fit = () => setScale(Math.min(1, el.clientWidth / CANVAS_W))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const settled = typing === null // re-measure once a typed field stops changing size

  // Bring the target into view inside its scrolling page, then measure it (canvas pixels).
  const measure = useCallback(() => {
    const canvas = canvasRef.current
    const t = canvas?.querySelector<HTMLElement>(`[data-guide="${step.target}"]`)
    if (!canvas || !t) { setRect(null); return }
    const c = canvas.getBoundingClientRect(), r = t.getBoundingClientRect()
    setRect({ x: (r.left - c.left) / scale, y: (r.top - c.top) / scale, w: r.width / scale, h: r.height / scale })
  }, [step.target, scale])

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const t = canvas?.querySelector<HTMLElement>(`[data-guide="${step.target}"]`)
    const scroller = t?.closest<HTMLElement>('[data-guide-scroll]')
    if (t && scroller) {
      scroller.style.scrollBehavior = 'auto' // jump, so the measurement below is final
      const sr = scroller.getBoundingClientRect(), tr = t.getBoundingClientRect()
      const offset = (tr.top - sr.top) / scale + scroller.scrollTop
      scroller.scrollTop = Math.max(0, offset - (sr.height / scale) / 2 + (tr.height / scale) / 2)
    }
    measure()
    const id = window.setTimeout(measure, 60) // after fonts/images settle
    return () => clearTimeout(id)
  }, [i, step.target, measure, scale, settled])

  // The visitor can scroll the re-drawn page; keep the spotlight on the target while they do.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let frame = 0
    const onScroll = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure) }
    canvas.addEventListener('scroll', onScroll, true)
    return () => { canvas.removeEventListener('scroll', onScroll, true); cancelAnimationFrame(frame) }
  }, [measure])

  const goto = useCallback((n: number) => {
    timers.current.forEach(clearTimeout); timers.current = []
    setTyping(null); setBusy(false); setFlying(null)
    setIdx(Math.max(0, Math.min(steps.length - 1, n)))
  }, [setIdx, steps.length])

  const finish = useCallback(() => {
    setTyping(null); setFlying(null); setBusy(false)
    if (step.toast) { setToast(step.toast); later(() => setToast(null), 2600) }
    setIdx(Math.min(steps.length - 1, i + 1))
  }, [i, setIdx, step.toast, steps.length])

  /** Perform the current step: animate the typing / upload, then move on. */
  const perform = useCallback(() => {
    if (busy || last) return
    setBusy(true)
    const typeOut = (then: () => void) => {
      if (!step.type) return then()
      const [key, full] = step.type
      const per = Math.max(18, Math.min(60, 900 / full.length))
      for (let n = 1; n <= full.length; n++) later(() => setTyping({ key, text: full.slice(0, n) }), n * per)
      later(then, full.length * per + 250)
    }
    if (step.verb === 'upload' && step.doc) {
      setFlying({ from: true })
      later(() => setFlying({ from: false }), 30)
      later(() => typeOut(finish), 1000)
    } else if (step.type) {
      typeOut(finish)
    } else {
      later(finish, 350)
    }
  }, [busy, last, step, finish])

  // Auto-play: perform, pause to read, repeat.
  useEffect(() => {
    if (!auto || busy) return
    const id = window.setTimeout(perform, 1700)
    return () => clearTimeout(id)
  }, [auto, busy, perform, i])

  // Keyboard: → do it, ← back.
  useEffect(() => {
    if (shot) return
    const key = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') perform()
      if (e.key === 'ArrowLeft') goto(i - 1)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [perform, goto, i, shot])

  const hit = useCallback((id: string) => { if (id === step.target) perform() }, [step.target, perform])

  const chapters = useMemo(() => Array.from(new Set(steps.map((s) => s.chapter))), [steps])
  const pct = Math.round((i / (steps.length - 1)) * 100)

  return (
    <main className={cx('mx-auto grid gap-5 px-4 sm:px-6 py-5', shot ? 'max-w-none p-0' : 'max-w-[96rem] lg:grid-cols-[minmax(0,1fr)_22rem]')}>
      {/* Stage */}
      <div ref={stageRef} className="min-w-0">
        <div className="relative overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-[0_18px_50px_rgba(20,24,31,0.10)]"
          style={{ height: CANVAS_H * scale }}>
          <div id="guide-canvas" ref={canvasRef} className="absolute left-0 top-0 origin-top-left" style={{ width: CANVAS_W, height: CANVAS_H, transform: `scale(${scale})` }}>
            <AppScreen persona={persona} step={step} state={state} typing={typing} hit={hit} />
            {rect && step.screen !== 'done' && <Coach rect={rect} verb={VERB_LABEL[step.verb][lang]} pulse={!busy} scale={scale} />}
            {flying && step.doc && rect && (
              <div className="pointer-events-none absolute z-40 transition-all duration-[900ms] ease-in-out"
                style={flying.from
                  ? { left: CANVAS_W / 2 - 170, top: CANVAS_H / 2 - 107, width: 340, opacity: 1 }
                  : { left: rect.x + rect.w / 2 - 40, top: rect.y + rect.h / 2 - 25, width: 80, opacity: 0.2 }}>
                <SampleDoc kind={step.doc} persona={persona} />
              </div>
            )}
            {toast && (
              <div className="absolute right-5 top-14 z-40 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm font-semibold text-emerald-800 shadow-lg">{toast}</div>
            )}
            {/* Screenshot mode: the sample document sits in the picture, since there is no side panel. */}
            {shot && step.doc && (
              <div className="absolute right-5 bottom-5 z-40 w-[300px] rounded-2xl border border-gray-200 bg-white p-3 shadow-2xl">
                <div className="mb-1.5 text-xs font-bold text-gray-500">{UI.sample[lang]}: {DOC_LABEL[step.doc]}</div>
                <SampleDoc kind={step.doc} persona={persona} />
              </div>
            )}
          </div>
        </div>
        {shot && (
          // Read by the PDF builder: the step's text, and whether its target was found on the screen.
          <div id="guide-step" hidden data-found={rect || step.screen === 'done' ? '1' : '0'}
            data-json={JSON.stringify({ persona, i, total: steps.length, chapter: step.chapter, title: step.title, body: step.body, verb: step.verb, doc: step.doc ?? null, target: step.target })} />
        )}
        {!shot && <p className="mt-2 text-xs text-gray-500">{lang === 'en' ? 'Tip: click the highlighted spot, press →, or use “Do it for me”. Everything here is demo data.' : 'सुझाव: चमकती जगह पर क्लिक करें, → दबाएँ या “मेरे लिए करें” चुनें। यहाँ सब डेमो डेटा है।'}</p>}
      </div>

      {/* Panel */}
      {!shot && (
        <aside className="space-y-4 lg:sticky lg:top-20 h-fit">
          <div className={cx(SURFACE, 'p-5')}>
            <div className="flex items-center justify-between text-xs font-semibold text-gray-500">
              <span>{PERSONA_META[persona].label[lang]}</span>
              <span>{UI.step[lang]} {i + 1} {UI.of[lang]} {steps.length}</span>
            </div>
            <div className="mt-2 h-1.5 rounded-full bg-gray-100"><div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} /></div>
            <div className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-blue-50 px-2 py-0.5 text-xs font-bold text-blue-700">
              {VERB_LABEL[step.verb][lang]}
            </div>
            <h2 className="mt-2 text-xl font-extrabold tracking-tight text-gray-900">{step.title[lang]}</h2>
            <p className="mt-1.5 text-gray-700 leading-relaxed">{step.body[lang]}</p>
            {step.doc && (
              <div className="mt-4">
                <div className="text-xs font-semibold text-gray-500 mb-1.5">{UI.sample[lang]}: {DOC_LABEL[step.doc]}</div>
                <SampleDoc kind={step.doc} persona={persona} />
                <div className="mt-1 text-[11px] text-gray-400">{UI.sampleNote[lang]}</div>
              </div>
            )}
            <div className="mt-5 flex flex-wrap gap-2">
              <button type="button" onClick={() => goto(i - 1)} disabled={i === 0 || busy} className={cx(BTN_SECONDARY, 'px-3')}><ArrowLeft className="w-4 h-4" />{UI.back[lang]}</button>
              {last
                ? <Link href="/login?mode=register" className={cx(BTN_PRIMARY, 'flex-1')}>{UI.tryReal[lang]}<ArrowRight className="w-4 h-4" /></Link>
                : <button type="button" onClick={perform} disabled={busy} className={cx(BTN_PRIMARY, 'flex-1')}>
                    {step.verb === 'look' ? UI.next[lang] : UI.doIt[lang]}{step.verb === 'look' ? <ArrowRight className="w-4 h-4" /> : <Wand2 className="w-4 h-4" />}
                  </button>}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {!last && <button type="button" onClick={() => setAuto(!auto)} className={cx(BTN_SECONDARY, 'h-9 px-3 flex-1')}>
                {auto ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}{auto ? UI.pause[lang] : UI.auto[lang]}</button>}
              <button type="button" onClick={() => { setAuto(false); goto(0) }} className={cx(BTN_SECONDARY, 'h-9 px-3')}><RotateCcw className="w-4 h-4" />{UI.restart[lang]}</button>
              <button type="button" onClick={onChange} className={cx(BTN_SECONDARY, 'h-9 px-3')}>{UI.change[lang]}</button>
            </div>
          </div>
          <ol className={cx(SURFACE, 'p-4 space-y-1')}>
            {chapters.map((ch) => {
              const first = steps.findIndex((s) => s.chapter === ch)
              const lastOf = steps.length - 1 - [...steps].reverse().findIndex((s) => s.chapter === ch)
              const done = i > lastOf, current = i >= first && i <= lastOf
              return (
                <li key={ch}>
                  <button type="button" onClick={() => { setAuto(false); goto(first) }}
                    className={cx('w-full flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm', current ? 'bg-brand-50 font-bold text-gray-900' : 'text-gray-600 hover:bg-gray-50')}>
                    <span className={cx('w-5 h-5 rounded-full grid place-items-center text-[11px] font-bold', done ? 'bg-emerald-500 text-white' : current ? 'bg-brand-500 text-ink' : 'border-2 border-gray-300 text-gray-400')}>
                      {done ? '✓' : chapters.indexOf(ch) + 1}
                    </span>{ch}
                  </button>
                </li>
              )
            })}
          </ol>
        </aside>
      )}
    </main>
  )
}

/** Spotlight + bouncing arrow + label, in canvas pixels. */
function Coach({ rect, verb, pulse, scale }: { rect: Rect; verb: string; pulse: boolean; scale: number }) {
  const pad = 6
  // The canvas shrinks on small screens; the arrow and its label grow back so they stay readable.
  const grow = Math.min(2.4, Math.max(1, 0.9 / scale))
  // Padded ring, kept inside the canvas so a full-width target doesn't lose its edge.
  const x0 = Math.max(3, rect.x - pad), y0 = Math.max(3, rect.y - pad)
  const x1 = Math.min(CANVAS_W - 3, rect.x + rect.w + pad), y1 = Math.min(CANVAS_H - 3, rect.y + rect.h + pad)
  const r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  const below = r.y + r.h + 110 < CANVAS_H - 10 || r.y < 120
  const labelW = 190
  const lx = Math.max(10, Math.min(CANVAS_W - labelW - 10, r.x + r.w / 2 - labelW / 2))
  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      {/* dim everything except the target */}
      <div className="absolute rounded-xl transition-all duration-300"
        style={{ left: r.x, top: r.y, width: r.w, height: r.h, boxShadow: '0 0 0 9999px rgba(11,14,19,0.45)' }} />
      <div className={cx('absolute rounded-xl border-[3px] border-brand-400 transition-all duration-300', pulse && 'guide-pulse')}
        style={{ left: r.x, top: r.y, width: r.w, height: r.h }} />
      <div className="absolute flex flex-col items-center" style={{
        left: lx, width: labelW, top: below ? r.y + r.h + 8 : r.y - 104,
        transform: `scale(${grow})`, transformOrigin: below ? 'top center' : 'bottom center',
      }}>
        {below && <ArrowUp className="guide-bounce-up w-10 h-10 text-brand-400 drop-shadow-[0_2px_4px_rgba(0,0,0,0.35)]" strokeWidth={3} />}
        <span className="rounded-full bg-brand-500 px-4 py-2 text-base font-extrabold text-ink shadow-[0_8px_24px_rgba(0,0,0,0.3)] whitespace-nowrap">{verb}</span>
        {!below && <ArrowDown className="guide-bounce-down w-10 h-10 text-brand-400 drop-shadow-[0_2px_4px_rgba(0,0,0,0.35)]" strokeWidth={3} />}
      </div>
    </div>
  )
}
