// ============================================================
// src/lib/notifications/recipients.ts
//
// Responsibility: turn the ids a domain event carries into an email address
// plus the users.id behind it (so the dispatcher can honour preferences).
//
// The identity hop here is the one documented in CLAUDE.md and it is the single
// easiest thing to get wrong in this codebase: bookings.driver_id and
// quotes.driver_id are `drivers.id`, NOT `users.id`, and the email lives on
// `users`. Every carrier-side lookup below is therefore two hops
// (drivers -> users), and the fleet side is fleet_owners -> users. Getting this
// wrong does not error — it silently resolves nobody and the mail is never sent,
// which is exactly the failure mode this whole change exists to eliminate.
//
// Explicit joins rather than PostgREST embedding, matching bt-fleet-service's
// hydrateDriverIdentities: the roster must not depend on FK-name inference.
// ============================================================

import { supabase } from '../supabase.js'

export type Recipient = {
  email: string
  userId: string | null
  name: string | null
}

/** users.id -> address. The base case every other resolver funnels into. */
export async function recipientByUserId(userId: string | null | undefined): Promise<Recipient | null> {
  if (!userId) return null
  const { data, error } = await supabase
    .from('users')
    .select('id, email, full_name')
    .eq('id', userId)
    .maybeSingle()
  if (error) throw new Error(`users select failed: ${error.message}`)

  const u = data as { id: string; email: string | null; full_name: string | null } | null
  if (!u?.email) return null
  return { email: u.email, userId: u.id, name: u.full_name }
}

/**
 * drivers.id -> address (two hops).
 *
 * Returns null — not an error — when the driver row or the user behind it is
 * missing. A notification has no business failing a lookup that the domain
 * operation itself already succeeded without.
 */
export async function recipientByDriverId(driverId: string | null | undefined): Promise<Recipient | null> {
  if (!driverId) return null
  const { data, error } = await supabase
    .from('drivers')
    .select('user_id')
    .eq('id', driverId)
    .maybeSingle()
  if (error) throw new Error(`drivers select failed: ${error.message}`)

  const d = data as { user_id: string } | null
  return recipientByUserId(d?.user_id)
}

/** fleet_owners.id -> the owner's address, plus the company name for the copy. */
export async function recipientByFleetOwnerId(
  fleetOwnerId: string | null | undefined,
): Promise<(Recipient & { companyName: string | null }) | null> {
  if (!fleetOwnerId) return null
  const { data, error } = await supabase
    .from('fleet_owners')
    .select('user_id, company_name')
    .eq('id', fleetOwnerId)
    .maybeSingle()
  if (error) throw new Error(`fleet_owners select failed: ${error.message}`)

  const o = data as { user_id: string; company_name: string | null } | null
  if (!o) return null
  const base = await recipientByUserId(o.user_id)
  return base ? { ...base, companyName: o.company_name } : null
}

/**
 * The carrier side of a booking or quote, whoever that is.
 *
 * A fleet-won trip pays and answers to the FLEET OWNER, not the driver at the
 * wheel (founder Q15, same rule bt-payment-service settles on) — so when
 * fleet_owner_id is set it wins. Commercial mail (won/lost, payout) goes to the
 * commercial party; operational mail is addressed separately via
 * recipientByDriverId where the person driving is the right audience.
 */
export async function carrierRecipient(source: {
  driver_id?: string | null
  fleet_owner_id?: string | null
}): Promise<Recipient | null> {
  if (source.fleet_owner_id) {
    return recipientByFleetOwnerId(source.fleet_owner_id)
  }
  return recipientByDriverId(source.driver_id)
}

/**
 * How the carrier side of a bid should be NAMED in an email.
 *
 * A fleet bid is signed by the company ("Sharma Logistics"), a solo bid by the
 * person. Kept next to `carrierRecipient` so the two always agree on who the
 * carrier is; a mismatch would address a fleet owner by their driver's name.
 * Best-effort — a null degrades to a neutral fallback in the template.
 */
export async function carrierDisplayName(source: {
  driver_id?: string | null
  fleet_owner_id?: string | null
}): Promise<string | null> {
  if (source.fleet_owner_id) {
    const owner = await recipientByFleetOwnerId(source.fleet_owner_id)
    return owner?.companyName ?? owner?.name ?? null
  }
  const { name } = await driverDisplay(source.driver_id)
  return name
}

/**
 * Driver display name + truck, for templates that name who is carrying the load.
 *
 * Best-effort: a null name renders as a neutral fallback ("Assigned") rather than
 * blocking the email. Two bounded queries, no embedding.
 */
export async function driverDisplay(
  driverId: string | null | undefined,
): Promise<{ name: string | null; truckNumber: string | null }> {
  if (!driverId) return { name: null, truckNumber: null }

  const { data: driver, error: dErr } = await supabase
    .from('drivers')
    .select('user_id, truck_number')
    .eq('id', driverId)
    .maybeSingle()
  if (dErr) throw new Error(`drivers select failed: ${dErr.message}`)

  const d = driver as { user_id: string; truck_number: string | null } | null
  if (!d) return { name: null, truckNumber: null }

  const { data: user, error: uErr } = await supabase
    .from('users')
    .select('full_name')
    .eq('id', d.user_id)
    .maybeSingle()
  if (uErr) throw new Error(`users select failed: ${uErr.message}`)

  return {
    name: (user as { full_name: string | null } | null)?.full_name ?? null,
    truckNumber: d.truck_number,
  }
}
