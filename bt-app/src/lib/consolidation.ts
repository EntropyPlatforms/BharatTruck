/**
 * Load consolidation — READ-ONLY suggestion slice (v1).
 *
 * The founder wants a fleet operator to aggregate lane-compatible loads into one truck by
 * payload capacity. The full feature reverses the one-load-one-truck invariant (dispatch,
 * tracking, POD, e-way, the 0016 unique indexes all assume booking↔vehicle is 1:1), so v1
 * ships ONLY the non-breaking half: surface which of the fleet's own not-yet-crewed loads
 * share a lane and would fit one free truck. It changes NOTHING about how loads dispatch —
 * they still go out as separate trips today. It is a hint, not an action.
 *
 * Deliberately self-contained (no app/DB types) so the rule is pure and unit-testable.
 * When real consolidated dispatch lands (a manifest entity grouping N bookings on one
 * vehicle), this grouping logic is the seed for it.
 */

export interface ConsolidatableLoad {
  id: string
  source_lat: number
  source_lng: number
  dest_lat: number
  dest_lng: number
  destination_address: string
  weight_kg: number
}

export interface ConsolidatableTruck {
  id: string
  rc_number: string
  capacity_tons: number | null
  /** Not currently on a live trip — only free trucks can be suggested. */
  free: boolean
}

export interface ConsolidationSuggestion {
  /** Opaque lane bucket key (rounded source→dest), useful as a React key. */
  lane: string
  destination_address: string
  loadIds: string[]
  totalWeightKg: number
  /** The tightest-fitting free truck for the combined load, or null if none fits. */
  fittingTruck: { id: string; rc_number: string; capacity_tons: number } | null
}

/**
 * Lane bucket: source and destination rounded to ~0.1° (≈11 km) so near-identical
 * origins and destinations group together without demanding exact coordinates. A coarse
 * bucket is right for a v1 hint — the operator confirms the actual pairing by eye.
 */
export function laneKey(load: Pick<ConsolidatableLoad, 'source_lat' | 'source_lng' | 'dest_lat' | 'dest_lng'>): string {
  const r = (n: number) => (Math.round(n * 10) / 10).toFixed(1)
  return `${r(load.source_lat)},${r(load.source_lng)}>${r(load.dest_lat)},${r(load.dest_lng)}`
}

/**
 * Group not-yet-crewed loads by lane and, for each lane carrying 2+ loads, report the
 * combined weight and the tightest free truck that could carry all of them at once.
 *
 * Pure. Callers pass ONLY loads that still need a truck (a load already on a trip is not a
 * consolidation candidate). Suggestions are ordered by opportunity size — most loads first,
 * then heaviest — so the biggest win is on top.
 */
export function consolidationSuggestions(
  loads: ConsolidatableLoad[],
  trucks: ConsolidatableTruck[],
): ConsolidationSuggestion[] {
  const byLane = new Map<string, ConsolidatableLoad[]>()
  for (const load of loads) {
    const key = laneKey(load)
    const group = byLane.get(key)
    if (group) group.push(load)
    else byLane.set(key, [load])
  }

  // Free trucks with a known capacity, smallest first — so the fit search returns the
  // tightest sufficient truck (best utilization), not merely the first big one.
  const freeTrucks = trucks
    .filter(t => t.free && t.capacity_tons != null)
    .sort((a, b) => (a.capacity_tons as number) - (b.capacity_tons as number))

  const suggestions: ConsolidationSuggestion[] = []
  for (const [lane, group] of byLane) {
    if (group.length < 2) continue
    const totalWeightKg = group.reduce((s, l) => s + l.weight_kg, 0)
    const fit = freeTrucks.find(t => (t.capacity_tons as number) * 1000 >= totalWeightKg) ?? null
    suggestions.push({
      lane,
      destination_address: group[0].destination_address,
      loadIds: group.map(l => l.id),
      totalWeightKg,
      fittingTruck: fit ? { id: fit.id, rc_number: fit.rc_number, capacity_tons: fit.capacity_tons as number } : null,
    })
  }

  return suggestions.sort((a, b) =>
    b.loadIds.length - a.loadIds.length || b.totalWeightKg - a.totalWeightKg,
  )
}
