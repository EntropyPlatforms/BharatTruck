'use client'

/**
 * Preferred carriers — the shipper's "people I already trust", labelled wherever the shipper
 * meets a carrier: the Post-a-Load picker, the bid list, and the load's assigned carrier.
 *
 * "Preferred" has two sources (bt-booking-service lib/preferred, migration 0044):
 *   - trips   — a driver or fleet that has FINISHED a trip for this shipper (completed / paid);
 *   - starred — the shipper marked them by hand, e.g. a transporter they use off-platform.
 * The label always says which ("3 trips with you", "Starred"), because "Preferred" alone
 * does not tell the shipper why the app thinks so.
 *
 * Stars degrade: until 0044 is applied the server answers `stars_enabled: false`, the star
 * buttons are not drawn, and the automatic list keeps working.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Building2, Check, Search, Star, UserRound, X } from 'lucide-react'

import { ApiError, listPreferredCarriers, searchCarriers, starCarrier, unstarCarrier } from '@/lib/api'
import type { CarrierCard, CarrierKind } from '@/lib/types'
import { HINT, INPUT, MONO, cx, pill } from '@/lib/ui'

// ── Data ──────────────────────────────────────────────────────────────────────

/** A quote's carrier says 'fleet'; the preferred API says 'fleet_owner'. One key for both. */
export function carrierKeyOf(kind: CarrierKind | 'fleet', id: string): string {
  return `${kind === 'fleet' ? 'fleet_owner' : kind}:${id}`
}

export type PreferredState = {
  carriers: CarrierCard[]
  starsEnabled: boolean
  loading: boolean
  error: string | null
  /** The shipper's preference facts for one carrier, or undefined when not preferred. */
  lookup: (kind: CarrierKind | 'fleet', id: string | null | undefined) => CarrierCard | undefined
  reload: () => void
  /** Star / un-star, then refresh. Resolves to the new starred state, or null on failure. */
  toggleStar: (card: Pick<CarrierCard, 'kind' | 'id' | 'starred'>) => Promise<boolean | null>
}

/**
 * The signed-in shipper's Preferred list. `enabled` lets a page call the hook before it
 * knows whether the viewer is the shipper (hooks cannot sit after an early return); while
 * false nothing is fetched and every lookup is empty. A failed fetch only costs the
 * labels — it never blocks the page that asked.
 */
export function usePreferredCarriers(enabled = true): PreferredState {
  const [carriers, setCarriers] = useState<CarrierCard[]>([])
  const [starsEnabled, setStarsEnabled] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  // Which fetch has answered. "Loading" is derived from it rather than set inside the
  // effect, so a reload keeps the old list on screen until the new one lands.
  const [settled, setSettled] = useState(-1)
  const loading = enabled && settled < 0

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    listPreferredCarriers()
      .then((d) => {
        if (cancelled) return
        setCarriers(d.carriers)
        setStarsEnabled(d.stars_enabled)
        setError(null)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load your preferred carriers.')
      })
      .finally(() => { if (!cancelled) setSettled(nonce) })
    return () => { cancelled = true }
  }, [enabled, nonce])

  const byKey = useMemo(() => new Map(carriers.map((c) => [carrierKeyOf(c.kind, c.id), c])), [carriers])
  const lookup = useCallback(
    (kind: CarrierKind | 'fleet', id: string | null | undefined) => (id ? byKey.get(carrierKeyOf(kind, id)) : undefined),
    [byKey],
  )
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  const toggleStar = useCallback(async (card: Pick<CarrierCard, 'kind' | 'id' | 'starred'>) => {
    try {
      if (card.starred) await unstarCarrier(card.kind, card.id)
      else await starCarrier(card.kind, card.id)
      setNonce((n) => n + 1)
      return !card.starred
    } catch (err: unknown) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update your preferred carriers.')
      return null
    }
  }, [])

  return { carriers, starsEnabled, loading, error, lookup, reload, toggleStar }
}

// ── Label ─────────────────────────────────────────────────────────────────────

/** Why the app calls this carrier Preferred, in the shipper's words. */
export function preferredReasonText(card: Pick<CarrierCard, 'trips_with_you' | 'starred'>): string {
  const parts: string[] = []
  if (card.trips_with_you > 0) parts.push(`${card.trips_with_you} ${card.trips_with_you === 1 ? 'trip' : 'trips'} with you`)
  if (card.starred) parts.push('Starred')
  return parts.join(' · ')
}

/**
 * The "Preferred" label. Rendered IN FRONT of the carrier's name everywhere, so a shipper
 * scanning a list of bids sees it before anything else. The reason rides along as a
 * tooltip and for screen readers; pass `showReason` to print it beside the pill too.
 */
export function PreferredBadge({
  card, showReason = false, className,
}: { card: Pick<CarrierCard, 'trips_with_you' | 'starred'>; showReason?: boolean; className?: string }) {
  const reason = preferredReasonText(card)
  return (
    <span className={cx('inline-flex items-center gap-1.5', className)}>
      <span className={pill('brand')} title={reason || undefined}>
        <Star className="w-3 h-3 fill-current" aria-hidden />
        Preferred
        {reason && <span className="sr-only"> — {reason}</span>}
      </span>
      {showReason && reason && <span className="text-xs text-gray-500 whitespace-nowrap">{reason}</span>}
    </span>
  )
}

// ── Picker (Post a Load → Direct) ─────────────────────────────────────────────

const ROW_BTN =
  'inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-lg text-xs font-semibold transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 disabled:opacity-50 disabled:pointer-events-none'

/**
 * Choose who a direct load goes to: Preferred carriers first (with their label and why),
 * then a search over every other driver and fleet by name or full mobile number.
 *
 * What "choose" does depends on who is chosen — `direct_targetable` from the server:
 *   - a solo / owner driver → the load is aimed at them (target_driver_id);
 *   - a fleet → the booking API has no fleet target, so the load is posted OPEN; the fleet
 *     sees it on their board and quotes, and that quote is labelled Preferred on the load.
 *     It is NOT exclusive — other carriers see an open load too — and the picker says so;
 *   - a fleet-employed driver → not choosable: they can neither accept nor bid (their
 *     owner does), so aiming the load at them would strand it. The row says so.
 */
export function CarrierPicker({
  value, onChange,
}: { value: CarrierCard | null; onChange: (next: CarrierCard | null) => void }) {
  const pref = usePreferredCarriers(true)
  const [query, setQuery] = useState('')
  // The answer for ONE query string. Everything shown is derived by comparing it with the
  // current query, so a stale answer can never be painted under a newer query.
  const [answer, setAnswer] = useState<{ q: string; data: CarrierCard[] | null; error: string | null } | null>(null)
  const seq = useRef(0)

  // A whole mobile or 2+ letters; anything shorter shows nothing (the server would 400 it,
  // and saying so on every keystroke is noise).
  const q = query.trim()
  const digits = q.replace(/[\s()+-]/g, '')
  const runnable = /^\d+$/.test(digits) ? digits.length >= 10 : q.length >= 2
  const current = runnable && answer?.q === q ? answer : null
  const searching = runnable && !current
  const results = current?.data ?? null
  const searchError = current?.error ?? null

  // Debounced search.
  useEffect(() => {
    if (!runnable) return
    const mine = ++seq.current
    const t = setTimeout(() => {
      searchCarriers(q)
        .then((r) => { if (seq.current === mine) setAnswer({ q, data: r, error: null }) })
        .catch((err: unknown) => {
          if (seq.current === mine) setAnswer({ q, data: null, error: err instanceof ApiError ? err.message : 'Search failed — try again.' })
        })
    }, 300)
    return () => clearTimeout(t)
  }, [q, runnable])

  // A star toggled from a search row must show on that row immediately, and the row must
  // pick up (or drop) the Preferred label; the preferred list itself refreshes in the hook.
  async function toggle(card: CarrierCard) {
    const next = await pref.toggleStar(card)
    if (next === null) return
    const patch = (c: CarrierCard): CarrierCard => {
      if (c.kind !== card.kind || c.id !== card.id) return c
      const reasons = [...(c.trips_with_you > 0 ? ['trips' as const] : []), ...(next ? ['starred' as const] : [])]
      return { ...c, starred: next, reasons, preferred: reasons.length > 0 }
    }
    setAnswer((a) => (a?.data ? { ...a, data: a.data.map(patch) } : a))
    if (value && value.kind === card.kind && value.id === card.id) onChange(patch(value))
  }

  const preferredKeys = new Set(pref.carriers.map((c) => carrierKeyOf(c.kind, c.id)))
  const others = (results ?? []).filter((c) => !preferredKeys.has(carrierKeyOf(c.kind, c.id)))
  const preferredHits = (results ?? []).filter((c) => preferredKeys.has(carrierKeyOf(c.kind, c.id)))

  const row = (c: CarrierCard) => (
    <CarrierRow
      key={carrierKeyOf(c.kind, c.id)}
      card={pref.lookup(c.kind, c.id) ?? c}
      selected={!!value && value.kind === c.kind && value.id === c.id}
      starsEnabled={pref.starsEnabled}
      onSelect={() => onChange(pref.lookup(c.kind, c.id) ?? c)}
      onToggleStar={() => toggle(pref.lookup(c.kind, c.id) ?? c)}
    />
  )

  return (
    <div className="space-y-4">
      {value && <SelectedCarrier card={value} onClear={() => onChange(null)} />}

      <div>
        <p className="text-sm font-semibold text-gray-900">Your preferred carriers</p>
        <p className={cx(HINT, 'mt-0.5 mb-2')}>
          Carriers who finished a trip for you{pref.starsEnabled ? ', and any you starred' : ''}. Most trips first.
        </p>
        {pref.loading ? (
          <p className="text-sm text-gray-500 py-2">Loading your preferred carriers…</p>
        ) : pref.error ? (
          <p className="text-sm text-red-600 py-1">{pref.error}</p>
        ) : pref.carriers.length === 0 ? (
          <p className="text-sm text-gray-500 rounded-xl border border-dashed border-gray-200 px-3.5 py-3">
            No preferred carriers yet. A driver or fleet appears here after they finish a trip for you
            {pref.starsEnabled ? ' — or search below and tap the star' : ''}.
          </p>
        ) : (
          <ul className="space-y-2">{pref.carriers.map((c) => <li key={carrierKeyOf(c.kind, c.id)}>{row(c)}</li>)}</ul>
        )}
      </div>

      <div>
        <label htmlFor="carrier_search" className="text-sm font-semibold text-gray-900">Find another driver or fleet</label>
        <div className="relative mt-1.5">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" aria-hidden />
          <input
            id="carrier_search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, or full 10-digit mobile"
            autoComplete="off"
            className={cx(INPUT, 'pl-9')}
          />
        </div>
        <p className={HINT}>Phone numbers are matched in full only and shown as the last four digits.</p>
        <div aria-live="polite" className="mt-2">
          {searching && <p className="text-sm text-gray-500">Searching…</p>}
          {!searching && searchError && <p className="text-sm text-red-600">{searchError}</p>}
          {!searching && results && results.length === 0 && <p className="text-sm text-gray-500">No drivers or fleets match “{query.trim()}”.</p>}
          {!searching && results && results.length > 0 && (
            <ul className="space-y-2">
              {[...preferredHits, ...others].map((c) => <li key={carrierKeyOf(c.kind, c.id)}>{row(c)}</li>)}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function KindIcon({ kind }: { kind: CarrierKind }) {
  return (
    <span className="w-9 h-9 rounded-lg bg-gray-50 border border-gray-100 text-gray-500 inline-flex items-center justify-center shrink-0">
      {kind === 'driver' ? <UserRound className="w-4 h-4" /> : <Building2 className="w-4 h-4" />}
    </span>
  )
}

function kindLabel(kind: CarrierKind): string {
  return kind === 'driver' ? 'Driver' : 'Fleet operator'
}

function CarrierRow({
  card, selected, starsEnabled, onSelect, onToggleStar,
}: {
  card: CarrierCard
  selected: boolean
  starsEnabled: boolean
  onSelect: () => void
  onToggleStar: () => void
}) {
  const [busy, setBusy] = useState(false)
  const choosable = card.kind === 'fleet_owner' || card.direct_targetable
  const detail = [card.truck_number, card.city, card.phone_masked].filter(Boolean) as string[]
  const name = card.name ?? (card.kind === 'driver' ? 'Unnamed driver' : 'Unnamed fleet')

  return (
    <div className={cx(
      'rounded-xl border bg-white p-3 flex items-center gap-3 transition-colors',
      selected ? 'border-blue-300 ring-1 ring-blue-100' : 'border-gray-200',
    )}>
      <KindIcon kind={card.kind} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {card.preferred && <PreferredBadge card={card} />}
          <span className={cx('text-sm text-gray-900', card.name ? 'font-bold' : 'italic')}>{name}</span>
          <span className="inline-flex items-center whitespace-nowrap rounded-md bg-gray-100 px-1.5 py-0.5 text-[0.6875rem] font-medium text-gray-600">
            {kindLabel(card.kind)}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-gray-500 flex flex-wrap gap-x-1.5">
          {card.preferred && <span className="font-medium text-gray-700">{preferredReasonText(card)}</span>}
          {detail.map((d, i) => (
            <span key={i} className="inline-flex items-center gap-1.5">
              {(i > 0 || card.preferred) && <span className="text-gray-300" aria-hidden>·</span>}
              <span className={d === card.truck_number ? MONO : undefined}>{d}</span>
            </span>
          ))}
        </p>
        {!choosable && (
          <p className="mt-1 text-xs text-amber-700">Drives for a fleet — book their fleet operator instead.</p>
        )}
      </div>
      {starsEnabled && (
        <button
          type="button"
          onClick={async () => { setBusy(true); try { await onToggleStar() } finally { setBusy(false) } }}
          disabled={busy}
          aria-pressed={card.starred}
          aria-label={card.starred ? `Remove the star from ${name}` : `Star ${name} as preferred`}
          title={card.starred ? 'Starred — tap to remove' : 'Star as preferred'}
          className={cx(
            'p-2 rounded-lg shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 disabled:opacity-50',
            card.starred ? 'text-brand-600 hover:bg-brand-50' : 'text-gray-400 hover:text-gray-700 hover:bg-gray-50',
          )}
        >
          <Star className={cx('w-4.5 h-4.5', card.starred && 'fill-current')} />
        </button>
      )}
      <button
        type="button"
        onClick={onSelect}
        disabled={!choosable}
        aria-pressed={selected}
        className={cx(
          ROW_BTN, 'shrink-0',
          selected ? 'bg-blue-600 text-[#fff] hover:bg-blue-700' : 'bg-white border border-blue-200 text-blue-700 hover:bg-blue-50',
        )}
      >
        {selected ? <><Check className="w-3.5 h-3.5" /> Chosen</> : 'Choose'}
      </button>
    </div>
  )
}

function SelectedCarrier({ card, onClear }: { card: CarrierCard; onClear: () => void }) {
  const name = card.name ?? (card.kind === 'driver' ? 'this driver' : 'this fleet')
  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50 px-3.5 py-3 flex items-start gap-3">
      <Check className="w-4.5 h-4.5 mt-0.5 shrink-0 text-blue-600" />
      <div className="min-w-0 flex-1 text-sm text-blue-900">
        <p className="flex flex-wrap items-center gap-2 font-semibold">
          {card.preferred && <PreferredBadge card={card} />}
          {card.kind === 'driver' ? `Sending to ${name}` : `Open to quotes — ${name} will see it`}
        </p>
        <p className="mt-0.5 text-blue-800/90">
          {card.kind === 'driver'
            ? 'Only this driver can accept or quote on the load.'
            : 'A fleet takes a load by quoting, so this load is posted open: it appears on their board (and other carriers’), and their quote is marked Preferred on the load page for you to accept.'}
        </p>
      </div>
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear the chosen carrier"
        className="p-1 -m-1 rounded-md text-blue-700 hover:bg-blue-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  )
}
