// ============================================================
// src/lib/consignee/service.ts
//
// Responsibility: decide WHO may see the consignee on a booking read, and
// attach the projection for them.
//
// The rule is relation-to-object, not role (D-27): a viewer sees the receiving
// party only if they are a party to the consignment themselves — they posted it,
// they carry it, they drive it, or they are the consignee. Anyone else is an
// observer and the block is simply absent from their payload.
//
// That distinction is not cosmetic on this platform. A solo driver's booking
// list INCLUDES the open 'pending' load board — every unclaimed load on the
// marketplace, posted by shippers who have no relationship with them. Attaching
// the consignee unconditionally would publish a phone number and a customer name
// for every load anyone posts to every driver browsing for work, which is a
// customer list, given away.
//
// The gate is @bharattruck/shared/personas — the same relationsToBooking() every
// other surface authorizes on. Duplicating "is this viewer the carrier" locally
// is how two answers to one question start to drift, and the direction this one
// drifts in is a disclosure.
// ============================================================

import { relationsToBooking, resolvePersonas, type PersonaSnapshot } from '@bharattruck/shared/personas'
import { supabase } from '../supabase.js'
import type { AuthenticatedUser } from '../types.js'
import { getConsigneeParties } from './repository.js'
import type { ConsigneeParty } from './rules.js'

/**
 * The booking fields the relation check reads. Structural rather than DbBooking
 * so a price-masked row (fleet.stripCommercialFields removes three commercial
 * fields) is still accepted — the masking and the consignee gate are
 * independent, and neither should have to know about the other.
 */
export type ConsigneeGateBooking = {
  shipper_id: string
  driver_id?: string | null
  fleet_owner_id?: string | null
  vehicle_id?: string | null
  consignee_user_id?: string | null
}

export type WithConsignee<T> = T & { consignee?: ConsigneeParty | null }

/**
 * Attach the consignee projection to every booking the viewer is a party to.
 *
 * Costs NOTHING on the path that exists today: if no booking in the payload
 * names a consignee — which is every one of the 672 legacy bookings, and every
 * booking at all on a database without migration 0026 — this returns the input
 * array untouched, with no query issued.
 *
 * When it does have work to do, the persona snapshot is resolved ONCE for the
 * request and the parties are fetched in ONE `in` query, so a 50-row list costs
 * two lookups rather than a hundred.
 */
export async function attachConsignees<T extends ConsigneeGateBooking>(
  bookings: T[],
  actor: AuthenticatedUser,
): Promise<WithConsignee<T>[]> {
  const consigneeIds = [...new Set(
    bookings.map((b) => b.consignee_user_id).filter((id): id is string => !!id),
  )]
  if (consigneeIds.length === 0) return bookings

  // Ops/admin see the consignee on any booking, the same carve-out listBookings
  // and the ops overrides already make: they unstick trips on both parties'
  // behalf, and "call the receiver" is most of what that job is. They hold no
  // relation to a booking by construction, so relationsToBooking() would answer
  // observer for them and hide the very field the console exists to surface.
  const snapshot: PersonaSnapshot | null =
    actor.role === 'admin' ? null : await resolvePersonas(supabase, actor.userId, actor.role)

  const parties = await getConsigneeParties(consigneeIds)

  return bookings.map((booking) => {
    if (!booking.consignee_user_id) return booking
    // An EMPTY relation set is observer-only ('observer' is deliberately never an
    // element of the array — see personas.ts), which is exactly the viewer this
    // gate exists to exclude.
    if (snapshot && relationsToBooking(booking, snapshot).length === 0) return booking
    return { ...booking, consignee: parties.get(booking.consignee_user_id) ?? null }
  })
}

/** Single-booking form. Same gate, same projection — see attachConsignees. */
export async function attachConsignee<T extends ConsigneeGateBooking>(
  booking: T,
  actor: AuthenticatedUser,
): Promise<WithConsignee<T>> {
  const [attached] = await attachConsignees([booking], actor)
  return attached
}
