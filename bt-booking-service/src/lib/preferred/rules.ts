// ============================================================
// src/lib/preferred/rules.ts
//
// Who counts as a shipper's PREFERRED carrier, decided without a database so every rule
// is pinned by a unit test (test/preferred-carriers.unit.mts).
//
// "Preferred" has two sources and a carrier may have both:
//   * trips   — they have FINISHED a trip for this shipper (booking status completed or
//               paid). Derived from bookings on every read, never stored, so it cannot
//               drift from the trips themselves.
//   * starred — the shipper marked them by hand (migration 0044). The only source that
//               needs storage, because that intent exists nowhere else.
//
// delivery_asserted is deliberately NOT a finished trip: the driver says it arrived but the
// shipper has not confirmed the POD yet, and a carrier should not become "preferred" on a
// trip whose delivery is still in question. The same pair (completed, paid) is what the bid
// cards' trip count uses (quote-repository completedTripCounts), so the two numbers a
// shipper sees about one carrier always agree.
// ============================================================

/** Matches the CHECK on shipper_preferred_carriers.carrier_kind. */
export type CarrierKind = 'driver' | 'fleet_owner'
export const CARRIER_KINDS: readonly CarrierKind[] = ['driver', 'fleet_owner']

/** Finished trips — see the header for why delivery_asserted is not one. */
export const FINISHED_TRIP_STATUSES = ['completed', 'paid'] as const

export type PreferredReason = 'trips' | 'starred'

/** The carrier card every endpoint here returns. Never carries a full phone number. */
export interface CarrierCard {
  kind: CarrierKind
  /** drivers.id or fleet_owners.id — the same ids quotes and bookings carry. */
  id: string
  name: string | null
  /** Last four digits only (maskPhone). */
  phone_masked: string | null
  city: string | null
  /** Driver only; a fleet runs many trucks. */
  truck_number: string | null
  /** Finished trips for THIS shipper (not platform-wide). */
  trips_with_you: number
  last_trip_at: string | null
  starred: boolean
  preferred: boolean
  reasons: PreferredReason[]
  /**
   * Can a DIRECT load be aimed at this carrier? Today the booking API targets a driver
   * (bookings.target_driver_id) who must then accept or quote it themselves, so only a
   * driver who self-selects work qualifies: a solo driver or an owner-driver. A
   * fleet-EMPLOYED driver cannot accept or bid (their owner does), and a fleet has no
   * direct-target column — see routes/preferred-carriers.ts for how the app handles both.
   */
  direct_targetable: boolean
}

// -----------------------------------------------------------
// Tallying finished trips per carrier
// -----------------------------------------------------------

export interface FinishedTripRow {
  driver_id: string | null
  fleet_owner_id: string | null
  updated_at: string | null
}

export interface TripTally {
  kind: CarrierKind
  id: string
  trips: number
  last_trip_at: string | null
}

/**
 * One tally per carrier the shipper contracted. A fleet trip is credited to the FLEET,
 * not to the employee who drove it: the shipper hired the fleet, the fleet chose the
 * driver, and the next load goes to the fleet too. A trip with neither id (should not
 * happen once finished) credits nobody.
 *
 * last_trip_at is the booking's updated_at — the last write, which for a finished trip is
 * the completion or the payment. bookings has no completed_at column; the status history
 * (0041) is exact but not every environment has it, and "most recent" only orders the
 * list, so the approximation is safe.
 */
export function tallyFinishedTrips(rows: FinishedTripRow[]): TripTally[] {
  const byKey = new Map<string, TripTally>()
  for (const r of rows) {
    const ref: { kind: CarrierKind; id: string } | null = r.fleet_owner_id
      ? { kind: 'fleet_owner', id: r.fleet_owner_id }
      : r.driver_id
        ? { kind: 'driver', id: r.driver_id }
        : null
    if (!ref) continue
    const key = carrierKey(ref.kind, ref.id)
    const t = byKey.get(key) ?? { ...ref, trips: 0, last_trip_at: null }
    t.trips += 1
    if (r.updated_at && (!t.last_trip_at || r.updated_at > t.last_trip_at)) t.last_trip_at = r.updated_at
    byKey.set(key, t)
  }
  return [...byKey.values()]
}

export function carrierKey(kind: CarrierKind, id: string): string {
  return `${kind}:${id}`
}

// -----------------------------------------------------------
// Ordering
// -----------------------------------------------------------

/**
 * The order the picker shows Preferred carriers in, as the shipper asked for it: most
 * finished trips first, then most recent. A starred carrier with no trips yet sorts after
 * every carrier with history (they are a promise, the others are a record), newest star
 * first; name breaks any remaining tie so the list never reshuffles between reloads.
 */
export function rankPreferred<T extends Pick<CarrierCard, 'trips_with_you' | 'last_trip_at' | 'name'> & { starred_at?: string | null }>(
  list: T[],
): T[] {
  return [...list].sort((a, b) =>
    (b.trips_with_you - a.trips_with_you)
    || cmpDesc(a.last_trip_at, b.last_trip_at)
    || cmpDesc(a.starred_at ?? null, b.starred_at ?? null)
    || (a.name ?? '').localeCompare(b.name ?? ''),
  )
}

function cmpDesc(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (!a) return 1
  if (!b) return -1
  return a < b ? 1 : -1
}

export function reasonsFor(trips: number, starred: boolean): PreferredReason[] {
  const out: PreferredReason[] = []
  if (trips > 0) out.push('trips')
  if (starred) out.push('starred')
  return out
}

// -----------------------------------------------------------
// Phone masking + search parsing
// -----------------------------------------------------------

/**
 * "••••••3210". A shipper gets a carrier's full number once that carrier is on THEIR trip
 * (the booking payload carries it then); before that, a directory that hands out every
 * driver's mobile to any account would be a scraping target. Four digits are enough to
 * tell two "Ramesh Kumar"s apart, which is all the picker needs.
 */
export function maskPhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '')
  if (digits.length < 4) return null
  return `••••••${digits.slice(-4)}`
}

export type CarrierSearch =
  | { by: 'phone'; phone: string }
  | { by: 'name'; pattern: string }

/**
 * A search box takes a name OR a full mobile number.
 *
 * A number must be a WHOLE Indian mobile (10 digits, optionally +91/0-prefixed) and is
 * matched exactly: a shipper who has the number can find the carrier, but nobody can walk
 * the directory by typing "98" and paging. Anything else is a name of at least two
 * characters, matched case-insensitively anywhere in the name — with the LIKE wildcards
 * escaped, so a typed "%" cannot turn the box into "list everyone".
 *
 * Returns null for a query too short or too vague to run.
 */
export function parseCarrierSearch(raw: string | null | undefined): CarrierSearch | null {
  const q = (raw ?? '').trim()
  if (!q) return null
  const digits = q.replace(/[\s()-]/g, '')
  if (/^\+?\d+$/.test(digits)) {
    const m = /^(?:\+?91|0)?([6-9]\d{9})$/.exec(digits)
    return m ? { by: 'phone', phone: m[1] } : null
  }
  if (q.length < 2) return null
  const escaped = q.slice(0, 60).replace(/[\\%_]/g, (c) => `\\${c}`)
  return { by: 'name', pattern: `%${escaped}%` }
}
