import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import authPlugin from '../plugins/auth.js'
import {
  getFleetOwnerById,
  inviteDriver,
  listAffiliationsOfDriver,
  requireDriver,
  updateFleetDriver,
} from '../lib/fleet-repo.js'
import { MAX_TOKEN_LENGTH, resolveInviteLink } from '../lib/invite-link.js'
import { emitNotification } from '../lib/notify-emit.js'
import { FleetError, parseOrThrow, type FleetDriverRow, type FleetOwnerRow } from '../lib/types.js'
import { syncFleetSet } from './drivers.js'

// -----------------------------------------------------------
// joinRoutes — the DRIVER's side of a fleet invite link (mounted at /fleet/join).
//
//   POST /fleet/join/preview  PUBLIC  — which fleet is this link for? (the join page, before sign-in)
//   POST /fleet/join/accept   DRIVER  — join that fleet, as ACTIVE, now
//
// The owner's side (make / show / turn off the link) is on the roster at /fleet/drivers/invite-link.
//
// The token travels in the request BODY, never the URL, so it cannot end up in a request log.
// Preview is the one unauthenticated route in this service: it answers only the fleet's public
// name and city and the link's expiry — never the owner's phone, email, GSTIN or id — and every
// refusal is one of the LINK_* codes, so it is no oracle for anything but "is this link good".
// The gateway's per-IP api_zone rate limit covers it like every other /api/fleet path.
//
// THE RULES a link join keeps are the invitation rules, unchanged: a driver is live (pending or
// active) in at most ONE fleet (fleet_drivers_one_live_per_driver), a suspension can only be
// lifted by the owner, and an owner never ends up driving for their own fleet by accident.
// -----------------------------------------------------------

const TokenBody = z.object({
  token: z.string({ required_error: 'token is required', invalid_type_error: 'token is required' })
    .trim().min(1, 'token is required').max(MAX_TOKEN_LENGTH, 'This invite link is not valid'),
})

// What anyone holding the link may learn about the fleet. Deliberately a short allow-list.
function publicFleet(owner: FleetOwnerRow) {
  return { company_name: owner.company_name, city: owner.city, state: owner.state }
}

// A link whose fleet has since been deleted or deactivated is just an invalid link: no hint
// about why, nothing to join.
async function activeFleetFor(fleetOwnerId: string): Promise<FleetOwnerRow> {
  const owner = await getFleetOwnerById(fleetOwnerId)
  if (!owner || !owner.is_active) {
    throw new FleetError('This invite link is not valid any more. Ask the fleet owner for a new one.', 'LINK_INVALID', 400)
  }
  return owner
}

export async function joinRoutes(app: FastifyInstance) {
  // POST /fleet/join/preview — public.
  app.post('/preview', async (req, reply) => {
    const { token } = parseOrThrow(TokenBody, req.body)
    const link = await resolveInviteLink(token)
    const owner = await activeFleetFor(link.fleetOwnerId)
    return reply.send({ success: true, data: { fleet: publicFleet(owner), expires_at: link.expiresAt } })
  })

  // POST /fleet/join/accept — signed-in driver. Own scope so the JWT gate covers only this route.
  await app.register(async (authed) => {
    await authed.register(authPlugin)

    authed.post('/accept', async (req, reply) => {
      const { token } = parseOrThrow(TokenBody, req.body)
      const link = await resolveInviteLink(token)
      const owner = await activeFleetFor(link.fleetOwnerId)
      const fleet = publicFleet(owner)

      if (owner.user_id === req.user.userId) {
        throw new FleetError('This is your own fleet\'s invite link — share it with your drivers.', 'OWN_FLEET', 409)
      }

      let driver: { id: string }
      try {
        driver = await requireDriver(req.user)
      } catch (err) {
        if (err instanceof FleetError && err.code === 'NOT_FOUND') {
          throw new FleetError(
            'Only drivers can join a fleet. Set up your driver profile first, then open this link again.',
            'DRIVER_PROFILE_REQUIRED',
            403,
          )
        }
        throw err
      }

      // Everything about this driver that could stand in the way, across fleets. What is read
      // about ANOTHER fleet is used only to pick the message; it is never returned.
      const rows = await listAffiliationsOfDriver(driver.id, ['pending', 'active', 'suspended'])
      const here = rows.filter(r => r.fleet_owner_id === owner.id)
      const elsewhere = rows.filter(r => r.fleet_owner_id !== owner.id)

      const activeHere = here.find(r => r.status === 'active')
      if (activeHere) {
        // Opening the link twice is harmless: already in, nothing changes, no second notification.
        return reply.send({ success: true, data: { joined: false, already_member: true, fleet, affiliation: activeHere } })
      }
      if (elsewhere.some(r => r.status === 'active')) {
        throw new FleetError(
          'You already drive for another fleet on BharatTruck. Leave that fleet first, then open this link again.',
          'ALREADY_IN_ANOTHER_FLEET',
          409,
        )
      }
      if (here.some(r => r.status === 'suspended')) {
        throw new FleetError(
          `${owner.company_name} has suspended you from their fleet. Only they can reinstate you.`,
          'SUSPENDED_IN_FLEET',
          409,
        )
      }

      let affiliation: FleetDriverRow
      const pendingHere = here.find(r => r.status === 'pending')
      if (pendingHere) {
        // They were ALSO invited the ordinary way: the link is the same answer, so accept that row
        // rather than creating a second one (exactly what POST /invites/:id/respond would do).
        affiliation = await updateFleetDriver(pendingHere.id, { status: 'active', responded_at: new Date().toISOString() })
      } else {
        if (elsewhere.some(r => r.status === 'pending')) {
          // Never decided on the driver's behalf: they answer the other fleet's invitation first.
          throw new FleetError(
            'You have an invitation from another fleet waiting for your answer. Accept or decline it on your Home page first, then open this link again.',
            'PENDING_INVITE_ELSEWHERE',
            409,
          )
        }
        try {
          // The same insert an invitation uses, born accepted. invited_by = whoever made the link.
          affiliation = await inviteDriver(owner.id, driver.id, link.record.by, { status: 'active' })
        } catch (err) {
          // Lost a race with another invitation/join for this driver (the unique index said no).
          if (err instanceof FleetError && err.code === 'CONFLICT') {
            throw new FleetError(
              'You already have a pending or active place in another fleet. Sort that out first, then open this link again.',
              'ALREADY_IN_ANOTHER_FLEET',
              409,
            )
          }
          throw err
        }
      }

      await syncFleetSet(app, 'add', affiliation.fleet_owner_id, affiliation.driver_id)
      // The owner hears that someone joined through their link — the same "invitation answered:
      // accepted" event an in-app acceptance sends.
      emitNotification({
        event: 'fleet_invite_answered',
        invite_id: affiliation.id,
        driver_id: affiliation.driver_id,
        fleet_owner_id: affiliation.fleet_owner_id,
        response: 'accepted',
      }, req.log)

      return reply.status(201).send({ success: true, data: { joined: true, already_member: false, fleet, affiliation } })
    })
  })
}
