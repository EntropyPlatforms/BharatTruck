import { getRedis } from './redis.js'
import { FleetError } from './types.js'

// -----------------------------------------------------------
// market-offer — a fleet hiring an OUTSIDER (an independent driver on their own truck) for one
// load it has won. Own crew = the fleet's member driver on the fleet's truck; outsider = a
// market truck. (Aditya, 2026-11-13: "Market truck".)
//
// CONSENT FIRST. The fleet cannot put someone else's truck on a trip by itself: it sends an
// OFFER, and only the driver accepting it creates the assignment (lib/assignment.ts, through
// the market-hire branch of mayExecuteFor). Until then nothing is bound.
//
// NO MIGRATION. An offer is short-lived state, so it lives in Redis with a 24 h TTL:
//   market_offer:{bookingId}             JSON MarketOffer — one open offer per booking; a new
//                                        offer for the same booking replaces the old one.
//   market_offers:driver:{driverId}      SET of bookingIds offered to that driver (the inbox).
// The set can hold ids whose offer has expired or been replaced; readers drop those lazily.
// Once accepted, the vehicle_assignments row (fleet_owner_id = the hiring fleet, vehicle and
// driver = the outsider's) is the durable record — that table has no ownership constraint, so
// an outsider row fits as-is.
// -----------------------------------------------------------

export const MARKET_OFFER_TTL_SECONDS = 24 * 60 * 60

export type MarketOffer = {
  booking_id: string
  fleet_owner_id: string
  driver_id: string
  vehicle_id: string
  /** users.id of whoever sent it (owner or a dispatcher). Becomes assigned_by on accept. */
  by: string
  at: string
  expires_at: string
}

export const marketOfferKey = (bookingId: string) => `market_offer:${bookingId}`
export const driverOffersKey = (driverId: string) => `market_offers:driver:${driverId}`

/**
 * checkMarketCrew — may this fleet offer this load to this driver and truck? Pure, so every
 * refusal is unit-tested without Redis or a database.
 *   vehicle        the truck as read by getDriverOwnedVehicle (null = not this driver's own truck)
 *   driverUserId   the driver's users.id; ownerUserId the hiring fleet owner's users.id
 *   isMember       the driver is an ACTIVE member of this fleet
 */
export function checkMarketCrew(input: {
  vehicle: { id: string; driver_id: string | null; fleet_owner_id: string | null } | null
  driverId: string
  driverUserId: string | null
  ownerUserId: string
  isMember: boolean
}): FleetError | null {
  if (input.driverUserId && input.driverUserId === input.ownerUserId) {
    return new FleetError('You cannot hire yourself as a market truck — assign your own truck instead', 'OWN_FLEET', 409)
  }
  if (input.isMember) {
    return new FleetError(
      'This driver is already in your fleet — assign them directly instead of hiring them as a market truck',
      'IN_YOUR_FLEET',
      409,
    )
  }
  const v = input.vehicle
  if (!v || v.driver_id !== input.driverId || v.fleet_owner_id !== null) {
    return new FleetError('That truck is not registered to this driver', 'NOT_FOUND', 404)
  }
  return null
}

/** The offer is for this driver, and has not lapsed. Anything else reads as "no such offer". */
export function offerIsFor(offer: MarketOffer | null, driverId: string, now = new Date()): offer is MarketOffer {
  return !!offer && offer.driver_id === driverId && new Date(offer.expires_at).getTime() > now.getTime()
}

export function buildOffer(input: Omit<MarketOffer, 'at' | 'expires_at'>, now = new Date()): MarketOffer {
  return {
    ...input,
    at: now.toISOString(),
    expires_at: new Date(now.getTime() + MARKET_OFFER_TTL_SECONDS * 1000).toISOString(),
  }
}

function parse(raw: string | null): MarketOffer | null {
  if (!raw) return null
  try { return JSON.parse(raw) as MarketOffer } catch { return null }
}

export async function getMarketOffer(bookingId: string): Promise<MarketOffer | null> {
  return parse(await getRedis().get(marketOfferKey(bookingId)))
}

/** Save an offer, replacing any earlier one for the same booking (and taking it out of that driver's inbox). */
export async function saveMarketOffer(offer: MarketOffer): Promise<void> {
  const redis = getRedis()
  const previous = await getMarketOffer(offer.booking_id)
  const tx = redis.multi()
  if (previous && previous.driver_id !== offer.driver_id) tx.srem(driverOffersKey(previous.driver_id), offer.booking_id)
  tx.set(marketOfferKey(offer.booking_id), JSON.stringify(offer), 'EX', MARKET_OFFER_TTL_SECONDS)
  tx.sadd(driverOffersKey(offer.driver_id), offer.booking_id)
  tx.expire(driverOffersKey(offer.driver_id), MARKET_OFFER_TTL_SECONDS)
  await tx.exec()
}

export async function deleteMarketOffer(offer: Pick<MarketOffer, 'booking_id' | 'driver_id'>): Promise<void> {
  await getRedis().multi()
    .del(marketOfferKey(offer.booking_id))
    .srem(driverOffersKey(offer.driver_id), offer.booking_id)
    .exec()
}

/** The driver's open offers. Expired or replaced ids are pruned from the inbox on the way. */
export async function listMarketOffersForDriver(driverId: string): Promise<MarketOffer[]> {
  const redis = getRedis()
  const ids = await redis.smembers(driverOffersKey(driverId))
  if (ids.length === 0) return []
  const raws = await redis.mget(ids.map(marketOfferKey))
  const open: MarketOffer[] = []
  const stale: string[] = []
  ids.forEach((id, i) => {
    const offer = parse(raws[i])
    if (offerIsFor(offer, driverId)) open.push(offer)
    else stale.push(id)
  })
  if (stale.length > 0) await redis.srem(driverOffersKey(driverId), ...stale)
  return open.sort((a, b) => b.at.localeCompare(a.at))
}
