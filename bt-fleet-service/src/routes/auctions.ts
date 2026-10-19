import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireFleetAccess } from '../lib/fleet-access.js'
import { listOpenAuctions, listFleetBids, resolveSoloCarrier, type BoardBidder } from '../lib/auctions.js'
import { FleetError, parseOrThrow } from '../lib/types.js'
import type { AuthenticatedUser } from '../plugins/auth.js'

// -----------------------------------------------------------
// auctionRoutes — the fleet's read side of bidding (mounted at /fleet).
//
// Two endpoints, and between them they close the gap the console has carried since
// the fleet persona shipped:
//
//   GET /fleet/auctions — open loads this fleet may bid on. There was no such list.
//   GET /fleet/bids     — every bid this fleet has out. There was no such list either.
//
// `/fleet/bookings` could only ever answer "auctions already won", because
// `bookings.fleet_owner_id` is written at AWARD time. Live bids, countered bids and
// lost bids were simply unreachable from this console.
//
// Both go through requireFleetAccess(..., 'bid'), so the tenant is resolved from the JWT (the
// owner, or a delegate holding the bid grant) and never taken from a query parameter.
// -----------------------------------------------------------

const OpenAuctionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  /**
   * Expired auctions are hidden by default: bidding on one 409s at
   * bt-booking-service, so surfacing them would be a board of dead buttons. The
   * flag exists so the UI can still show what was missed.
   */
  include_expired: z.coerce.boolean().default(false),
})

const BidsQuery = z.object({
  status: z.enum(['submitted', 'countered', 'accepted', 'rejected', 'withdrawn']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
})

// Who the board is for. A fleet (owned, or delegated with the 'bid' grant) when the caller has
// one — the same precedence bt-booking-service's bidderFromSnapshot gives a bid. Otherwise a SOLO
// owner-driver: someone with their own truck and no fleet can place a bid at booking-service, so
// they must be able to see the board and their bids here. Before this, they got the fleet gate's
// 404 and a "not found" page behind a "Load available" notification.
async function resolveBoardViewer(
  user: AuthenticatedUser,
): Promise<{ bidder: BoardBidder; fleetOwnerId: string | null; userId: string }> {
  try {
    const owner = await requireFleetAccess(user, 'bid')
    return { bidder: { kind: 'fleet', fleetOwnerId: owner.id }, fleetOwnerId: owner.id, userId: owner.user_id }
  } catch (err) {
    // Only "no fleet at all" falls through. A fleet the caller may not bid for (403), an
    // ambiguous grant (400) or a deactivated fleet stays the refusal it was.
    if (!(err instanceof FleetError && err.code === 'NOT_FOUND')) throw err
    const solo = await resolveSoloCarrier(user.userId)
    if (!solo) {
      throw new FleetError('Add a truck to see and bid on loads — you have no fleet and no truck of your own yet', 'NOT_FOUND', 404)
    }
    return { bidder: { kind: 'driver', driverId: solo.driverId }, fleetOwnerId: null, userId: user.userId }
  }
}

export async function auctionRoutes(app: FastifyInstance) {
  // GET /fleet/auctions — the open load board.
  app.get('/auctions', async (req, reply) => {
    const viewer = await resolveBoardViewer(req.user)
    const q = parseOrThrow(OpenAuctionsQuery, req.query)

    // Two DIFFERENT ids, and swapping them silently breaks the board: the bidder id
    // (fleet_owners.id or drivers.id) scopes which bid is "mine", while the caller's
    // users.id is what bookings.shipper_id holds and is therefore the only thing that can
    // identify the caller's own loads for exclusion.
    const auctions = await listOpenAuctions(viewer.bidder, {
      limit: q.limit,
      offset: q.offset,
      includeExpired: q.include_expired,
      excludeShipperUserId: viewer.userId,
    })

    return reply.send({
      success: true,
      data: {
        fleet_owner_id: viewer.fleetOwnerId,
        count: auctions.length,
        auctions,
      },
    })
  })

  // GET /fleet/bids — every bid this fleet (or solo owner-driver) has placed, with its load attached.
  app.get('/bids', async (req, reply) => {
    const viewer = await resolveBoardViewer(req.user)
    const q = parseOrThrow(BidsQuery, req.query)

    const bids = await listFleetBids(viewer.bidder, {
      status: q.status,
      limit: q.limit,
      offset: q.offset,
    })

    return reply.send({
      success: true,
      data: {
        fleet_owner_id: viewer.fleetOwnerId,
        count: bids.length,
        bids,
      },
    })
  })
}
