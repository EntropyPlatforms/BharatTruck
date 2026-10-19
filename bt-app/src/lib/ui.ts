/**
 * Shared class strings for the 2026-10 light redesign.
 *
 * Pages are written in plain Tailwind; these constants keep the handful of things
 * that must look identical everywhere (buttons, inputs, labels, segmented controls,
 * tinted icon tiles) in one place. Import what you need; extend with `cx()` for
 * per-use sizing. Primary buttons are Marigold with ink text — never white text.
 */
import { twMerge } from 'tailwind-merge'

/** Join classes; later classes win over earlier ones that set the same property
 *  (tailwind-merge), so `cx(BTN_PRIMARY, 'h-14')` really is 56px tall. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return twMerge(parts.filter(Boolean).join(' '))
}

const BTN_BASE =
  'inline-flex items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 ' +
  'disabled:opacity-50 disabled:pointer-events-none active:scale-[0.99]'

/** Marigold, ink text. The one main action on a screen or dialog. */
export const BTN_PRIMARY = `${BTN_BASE} h-10 px-4 bg-brand-500 hover:bg-brand-400 text-ink`
/** White with a border. Cancel, secondary actions, filters. */
export const BTN_SECONDARY = `${BTN_BASE} h-10 px-4 bg-white border border-gray-200 hover:bg-gray-50 text-gray-800`
/** Signal Blue outline. In-row actions like Review, Assign, Re-bid, Track. */
export const BTN_BLUE = `${BTN_BASE} h-9 px-3.5 bg-white border border-blue-200 text-blue-700 hover:bg-blue-50`
/** Signal Blue solid. Used sparingly for a second strong action in a row (Counter, Review). */
export const BTN_BLUE_SOLID = `${BTN_BASE} h-9 px-3.5 bg-blue-600 hover:bg-blue-700 text-[#fff]`
/** Red outline. Reject, Remove, Cancel load. */
export const BTN_DANGER = `${BTN_BASE} h-10 px-4 bg-white border border-red-200 text-red-600 hover:bg-red-50`
/** Green solid. Approve, Accept bid. */
export const BTN_SUCCESS = `${BTN_BASE} h-10 px-4 bg-emerald-600 hover:bg-emerald-700 text-[#fff]`
/** Text link in Signal Blue. */
export const LINK = 'text-blue-600 hover:text-blue-700 font-semibold'
/** 56px thumb-sized variant for driver screens: combine with a BTN_* colour. */
export const BTN_THUMB = 'h-14 text-base rounded-xl w-full'

/** Form field. 42px tall, 10px radius, blue focus ring. */
export const INPUT =
  'w-full h-[42px] rounded-[10px] border border-gray-200 bg-white px-3 text-sm text-gray-900 ' +
  'placeholder:text-gray-400 outline-none transition-colors ' +
  'focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-gray-50 disabled:text-gray-400'
export const INPUT_ERROR =
  'w-full h-[42px] rounded-[10px] border border-red-300 bg-white px-3 text-sm text-gray-900 ' +
  'placeholder:text-gray-400 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100'
export const TEXTAREA =
  'w-full rounded-[10px] border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 ' +
  'placeholder:text-gray-400 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 resize-y'
export const SELECT = `${INPUT} pr-8 appearance-none bg-[url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%235b6676' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")] bg-no-repeat bg-[right_10px_center]`
/** Field label: sentence case, dark, medium weight (the references use readable labels, not tiny caps). */
export const LABEL = 'block text-sm font-medium text-gray-700 mb-1.5'
export const HINT = 'mt-1 text-xs text-gray-500'
export const MONO = 'font-mono tracking-wide'

/** Segmented control (period switches, Paid by, Phone|Email). */
export const SEG_WRAP = 'inline-flex rounded-xl border border-gray-200 bg-white p-1 gap-1'
export const SEG_ON = 'rounded-lg px-3.5 py-1.5 text-sm font-bold bg-brand-500 text-ink'
export const SEG_OFF = 'rounded-lg px-3.5 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50'

/** Underlined tabs (load detail, truck detail, auctions). */
export const TAB_ON = 'relative px-1 pb-3 text-sm font-semibold text-gray-900 after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-blue-600'
export const TAB_OFF = 'px-1 pb-3 text-sm font-medium text-gray-500 hover:text-gray-800'

/** Tinted icon tiles, the rounded squares that sit beside KPI labels and card titles. */
export type Tint = 'blue' | 'green' | 'amber' | 'red' | 'violet' | 'slate' | 'brand' | 'teal'
export const TINT: Record<Tint, string> = {
  blue:   'bg-blue-50 text-blue-600',
  green:  'bg-emerald-50 text-emerald-600',
  amber:  'bg-amber-50 text-amber-600',
  red:    'bg-red-50 text-red-600',
  violet: 'bg-violet-50 text-violet-600',
  slate:  'bg-gray-100 text-gray-600',
  brand:  'bg-brand-50 text-brand-600',
  teal:   'bg-teal-50 text-teal-600',
}

/** A soft corner wash in the tile's own tint — the KPI cards' background. */
export const WASH: Record<Tint, string> = {
  blue:   'from-blue-50/90',
  green:  'from-emerald-50/90',
  amber:  'from-amber-50/90',
  red:    'from-red-50/90',
  violet: 'from-violet-50/90',
  slate:  'from-gray-100/80',
  brand:  'from-brand-50',
  teal:   'from-teal-50/90',
}

/**
 * Page container: fills the screen beside the rail instead of stopping at 1280px, so wide
 * monitors are not left with empty margins. Capped in rem so it grows with the root size.
 */
export const PAGE_WIDE = 'p-4 lg:px-8 lg:pb-8 lg:pt-6 max-w-[112rem] mx-auto'

/** The card surface: white, 16px radius, hairline border and a soft lift. */
export const SURFACE = 'bg-white rounded-2xl border border-gray-200/80 shadow-[0_2px_10px_rgba(20,24,31,0.04)]'

/** Soft pill with a matching border, the pill style of the references. */
export type PillTone = 'amber' | 'blue' | 'indigo' | 'violet' | 'green' | 'teal' | 'slate' | 'red' | 'orange' | 'brand'
export const PILL: Record<PillTone, string> = {
  amber:  'bg-amber-50 text-amber-700 border-amber-200',
  blue:   'bg-blue-50 text-blue-700 border-blue-200',
  indigo: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  violet: 'bg-violet-50 text-violet-700 border-violet-200',
  green:  'bg-emerald-50 text-emerald-700 border-emerald-200',
  teal:   'bg-teal-50 text-teal-700 border-teal-200',
  slate:  'bg-gray-100 text-gray-600 border-gray-200',
  red:    'bg-red-50 text-red-700 border-red-200',
  orange: 'bg-orange-50 text-orange-700 border-orange-200',
  brand:  'bg-brand-50 text-brand-800 border-brand-200',
}
export const PILL_BASE = 'inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-semibold'
export function pill(tone: PillTone): string {
  return `${PILL_BASE} ${PILL[tone]}`
}
