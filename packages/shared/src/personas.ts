/**
 * Emergent personas — THE single implementation of "what may this human do?".
 *
 * WHY THIS REPLACES `role`: `users.role` is one enum value per human, and every service
 * authorizes on it. That cannot describe the businesses we actually have. A distributor ships
 * goods AND owns the trucks that move them. A driver who buys a second truck is running a fleet.
 * A driver whose own truck is attached to a fleet is that fleet's employee on some trips and an
 * independent operator on others. One role per human puts each of them in a costume that is wrong
 * most of the time.
 *
 * THE MODEL: a persona is not a flag, it is a VIEW over what you own and who you are connected to.
 *
 *     what you OWN   (trucks)            -> carrier capability
 *     who you HOLD   (drivers / fleets)  -> fleet capability
 *     what you DO    (post a load)       -> shipper capability
 *
 * Nothing is stored. Nobody "becomes" a fleet owner — they buy a second truck and the fleet
 * surfaces become relevant. Computing rather than storing is what makes that true: a stored flag
 * would need a migration, a backfill and a settings screen, and would go stale the moment someone
 * sold a truck.
 *
 * IDENTITY CONTRACT (see ./auth.ts — violating it silently authorizes the wrong party):
 *   • JWT `userId` is `public.users.id`.
 *   • `drivers.user_id` -> users.id;  `drivers.id` is a DIFFERENT row.
 *   • `fleet_owners.user_id` -> users.id;  `fleet_owners.id` is the fleet tenant key.
 *   • `vehicles.driver_id` -> drivers.id;  `vehicles.fleet_owner_id` -> fleet_owners.id.
 *
 * Schema source: supabase/migrations/0022_unified_identity.sql.
 * Locked model: docs/ARCHITECTURE_UNIFIED_IDENTITY.md.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { UserRole } from './auth.js'

/**
 * What a human may do. Deliberately verbs, not job titles: "fleet_owner" is a costume,
 * "may operate a fleet" is a fact about their assets.
 */
export type Capability =
  /** May post loads. Ungated — posting IS the act that emerges the shipper persona. */
  | 'ship'
  /** May be assigned trips. Has a `drivers` row. */
  | 'drive'
  /** May bid and self-select work from the marketplace. Owns at least one truck. */
  | 'carry'
  /** Fleet surfaces: assignment, P&L, driver management. Owns 2+ trucks OR holds a driver. */
  | 'operate'

export interface PersonaSnapshot {
  /** users.id */
  user_id: string
  /**
   * Default surface, and the destination for emailed links. A multi-persona human still needs
   * ONE correct address for a password-reset mail — "all three personas" is not a destination.
   * This is `users.role` under an honest name, NOT an authorization axis.
   */
  primary_persona: UserRole
  capabilities: Capability[]

  /** drivers.id, or null when this human has no driver profile. */
  driver_id: string | null
  /** fleet_owners.id, or null when this human owns no fleet. */
  fleet_owner_id: string | null

  /** Trucks owned outright by this human, as a driver or as a fleet. */
  owned_vehicle_count: number
  /** Drivers held under this human's fleet with a live seat ('pending' | 'active'). */
  held_driver_count: number
  /** Fleets this human DRIVES FOR (they are the employee). Multi-fleet is allowed. */
  affiliated_fleet_owner_ids: string[]

  /**
   * Whether this human is a stakeholder in trip economics anywhere.
   *
   * THE RULE (docs/ARCHITECTURE_UNIFIED_IDENTITY.md §1.1): commercial visibility follows ASSET
   * OWNERSHIP, not affiliation. Own a truck -> you carry its cost and risk -> you see the money.
   * Own nothing and drive for a fleet -> you are an employee -> you do not.
   *
   * This is a *baseline* for UI affordances. Per-booking masking is still decided per booking
   * (you do not see a stranger's freight just because you own a truck) — see
   * seesCommercialsOnBooking().
   */
  sees_commercials: boolean
}

/** Ownership + relationship facts, before they are turned into capabilities. Exported for tests. */
export interface PersonaFacts {
  driver_id: string | null
  fleet_owner_id: string | null
  owned_vehicle_count: number
  held_driver_count: number
  affiliated_fleet_owner_ids: string[]
}

/**
 * The rules, isolated from I/O so they are testable without a database and readable in one screen.
 *
 * `ship` is unconditional at MVP by founder decision D-5: KYC does not gate use, and posting a
 * load is itself the act that emerges the shipper persona. When KYC gating returns, this is the
 * one line that changes.
 */
export function capabilitiesFrom(facts: PersonaFacts): Capability[] {
  const caps: Capability[] = ['ship']

  if (facts.driver_id) caps.push('drive')

  // Ownership, not affiliation, is what grants marketplace access. An owner-driver attached to a
  // fleet KEEPS it: affiliation ADDS a source of work, it does not replace self-selection.
  // An assetless fleet driver has no 'carry' and correctly never sees a load board.
  if (facts.owned_vehicle_count >= 1) caps.push('carry')

  // Two ways to be running a fleet, and they are genuinely different businesses:
  //   - 2+ trucks: you are managing assets even with nobody hired yet
  //   - 1+ driver: you are managing people even if the truck is theirs (the attached-vehicle model)
  if (facts.owned_vehicle_count >= 2 || facts.held_driver_count >= 1) caps.push('operate')

  return caps
}

/**
 * Resolve everything about a human in one pass.
 *
 * Six small indexed lookups rather than one join: they are individually cacheable, each maps to
 * exactly one fact in the model above, and a join would have to be re-derived every time the
 * ownership rules move. This sits behind /auth/me and is not on a per-request hot path.
 */
export async function resolvePersonas(
  supabase: SupabaseClient,
  userId: string,
  primaryPersona: UserRole,
): Promise<PersonaSnapshot> {
  const [driverRes, fleetRes] = await Promise.all([
    supabase.from('drivers').select('id').eq('user_id', userId).maybeSingle(),
    supabase.from('fleet_owners').select('id').eq('user_id', userId).maybeSingle(),
  ])
  if (driverRes.error) throw new Error(`drivers lookup failed: ${driverRes.error.message}`)
  if (fleetRes.error) throw new Error(`fleet_owners lookup failed: ${fleetRes.error.message}`)

  const driverId: string | null = driverRes.data?.id ?? null
  const fleetOwnerId: string | null = fleetRes.data?.id ?? null

  // Vehicles owned as a driver and as a fleet are counted together: migration 0022 guarantees a
  // truck has exactly one owner, so these sets cannot overlap and a sum cannot double-count.
  const [ownedAsDriver, ownedAsFleet, heldDrivers, affiliations] = await Promise.all([
    driverId
      ? supabase.from('vehicles').select('id', { count: 'exact', head: true }).eq('driver_id', driverId)
      : Promise.resolve({ count: 0, error: null } as const),
    fleetOwnerId
      ? supabase.from('vehicles').select('id', { count: 'exact', head: true }).eq('fleet_owner_id', fleetOwnerId)
      : Promise.resolve({ count: 0, error: null } as const),
    fleetOwnerId
      ? supabase
          .from('fleet_drivers')
          .select('id', { count: 'exact', head: true })
          .eq('fleet_owner_id', fleetOwnerId)
          .in('status', ['pending', 'active'])
      : Promise.resolve({ count: 0, error: null } as const),
    // Fleets this human DRIVES FOR. 'pending' counts: the seat is taken and the invite is live.
    driverId
      ? supabase
          .from('fleet_drivers')
          .select('fleet_owner_id')
          .eq('driver_id', driverId)
          .in('status', ['pending', 'active'])
      : Promise.resolve({ data: [] as Array<{ fleet_owner_id: string }>, error: null } as const),
  ])

  for (const [label, res] of [
    ['vehicles(driver)', ownedAsDriver],
    ['vehicles(fleet)', ownedAsFleet],
    ['fleet_drivers(held)', heldDrivers],
    ['fleet_drivers(affiliations)', affiliations],
  ] as const) {
    if (res.error) throw new Error(`${label} lookup failed: ${res.error.message}`)
  }

  const facts: PersonaFacts = {
    driver_id: driverId,
    fleet_owner_id: fleetOwnerId,
    owned_vehicle_count: (ownedAsDriver.count ?? 0) + (ownedAsFleet.count ?? 0),
    held_driver_count: heldDrivers.count ?? 0,
    affiliated_fleet_owner_ids: ((affiliations as { data?: Array<{ fleet_owner_id: string }> }).data ?? [])
      .map((r) => r.fleet_owner_id),
  }

  const capabilities = capabilitiesFrom(facts)

  return {
    user_id: userId,
    primary_persona: primaryPersona,
    capabilities,
    ...facts,
    // Owning an asset or running a fleet makes you a stakeholder in trip economics.
    sees_commercials: capabilities.includes('carry') || capabilities.includes('operate'),
  }
}

/** Convenience predicate so callers read as intent, not as array plumbing. */
export function can(snapshot: PersonaSnapshot, capability: Capability): boolean {
  return snapshot.capabilities.includes(capability)
}

/**
 * How a viewer relates to ONE booking. This is what makes "one app, no mode switch" work: the
 * object supplies the context, so the same screen renders the shipper view to the person who
 * posted the load and the carrier view to the person who won it — and the inbound-shipment view to
 * the consignee waiting on it.
 */
export type BookingRelation = 'shipper' | 'carrier' | 'driver' | 'consignee' | 'observer'

export interface ViewerBooking {
  shipper_id: string
  fleet_owner_id?: string | null
  driver_id?: string | null
  vehicle_id?: string | null
  /**
   * users.id of the consignee, when that party has CLAIMED an account — null otherwise.
   *
   * The consignee (the receiver) is a first-class freight party, the same kind of entity as a
   * shipper, and most of them are UNCLAIMED: a record with a name and a phone, no login. An
   * unclaimed consignee therefore has NO viewer relation, because there is no session to resolve —
   * their access path is the POD OTP (D-13), not a logged-in read. Resolving by users.id is what
   * makes that fall out for free: the relation simply does not match until the party claims an
   * account, at which point their inbound shipment appears with no backfill.
   */
  consignee_user_id?: string | null
}

/**
 * Every relation the viewer holds to a booking, strongest claim first.
 *
 * One human can hold TWO relations to ONE booking, and that is not an edge case: under direct-attach
 * (D-10) a distributor posts a load AND wins it with their own fleet, so they are shipper AND
 * carrier. A single value has to drop one of those, which is right for "which screen do I render"
 * and wrong for "may this human do X" — hence both functions.
 *
 * Order is significant and is not alphabetical:
 *   shipper first  — you posted it. Whoever is paying sees the paying side; that is the relation
 *                    with the stronger claim on the screen.
 *   carrier next   — the winning party, fleet or solo.
 *   driver next    — assigned to run it, which on a fleet booking is an employee relation.
 *   consignee last — the receiving end. The weakest claim: they are downstream of the trip, not a
 *                    party to its commercials.
 *
 * An EMPTY array means observer-only. 'observer' is deliberately not an element — it is the absence
 * of a relation, and putting it in the set would make `.includes('observer')` read as a permission.
 */
export function relationsToBooking(booking: ViewerBooking, snapshot: PersonaSnapshot): BookingRelation[] {
  const relations: BookingRelation[] = []

  if (booking.shipper_id === snapshot.user_id) relations.push('shipper')

  const viewerIsBookingFleet = Boolean(booking.fleet_owner_id) && booking.fleet_owner_id === snapshot.fleet_owner_id
  const viewerIsAssignedDriver = Boolean(booking.driver_id) && booking.driver_id === snapshot.driver_id

  // A solo driver IS the carrier — they bid, they won, they carry the economics. A driver on a
  // fleet-owned booking is staff instead, and `stripCommercialFields` will mask the money for them
  // unless they own the truck (see seesCommercialsOnBooking). The two are mutually exclusive for
  // the same person only because the fleet flag decides which one the assignment means.
  if (viewerIsBookingFleet || (viewerIsAssignedDriver && !booking.fleet_owner_id)) relations.push('carrier')
  if (viewerIsAssignedDriver && booking.fleet_owner_id) relations.push('driver')

  if (booking.consignee_user_id && booking.consignee_user_id === snapshot.user_id) relations.push('consignee')

  return relations
}

/**
 * The viewer's single strongest relation to a booking — the one that decides which view renders.
 *
 * This is `relationsToBooking()[0]`, and it must stay that way: the ordering above is exactly the
 * precedence this function has always applied, so the set is the primitive and this is the picker.
 */
export function relationToBooking(booking: ViewerBooking, snapshot: PersonaSnapshot): BookingRelation {
  return relationsToBooking(booking, snapshot)[0] ?? 'observer'
}

/**
 * Whether this viewer may see freight/price on THIS booking.
 *
 * The asset-ownership rule, applied per booking. An assetless fleet driver is staff and stays
 * masked — that behaviour is unchanged. What changes is the owner-driver: a driver running their
 * OWN truck under a fleet's booking carries that truck's cost and risk, so they are a stakeholder
 * and the money stops being hidden from them.
 *
 * `viewerOwnsBookingVehicle` is passed in rather than looked up: the caller already has the
 * booking's vehicle in hand, and a lookup here would put a query on every row of a list response.
 */
export function seesCommercialsOnBooking(
  booking: ViewerBooking,
  snapshot: PersonaSnapshot,
  viewerOwnsBookingVehicle: boolean,
): boolean {
  // The strongest relation decides, and it is safe to look at only that one: every relation that
  // can GRANT sorts ahead of every relation that cannot, so a viewer who is both shipper and
  // consignee is answered by 'shipper' and never masked by the weaker claim.
  const relation = relationToBooking(booking, snapshot)
  if (relation === 'shipper' || relation === 'carrier') return true
  if (relation === 'driver') return viewerOwnsBookingVehicle
  // A consignee is a stakeholder in the SHIPMENT, not in the carriage economics: they never see the
  // carrier's margin or the fleet↔driver revenue split. What they legitimately see is what THEY owe
  // — the freight on a "To Pay" consignment — and that is a per-document disclosure the documents
  // layer makes on the LR/invoice they are handed, not a booking-wide unmask. Stated explicitly
  // rather than left to fall through, so that widening this predicate cannot widen it by accident.
  if (relation === 'consignee') return false
  return false
}
