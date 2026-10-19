import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  findDriverByPhone,
  findDriverByEmail,
  getAffiliationForDriver,
  countVehiclesOwnedByDriver,
  getFleetDriverById,
  getInviteForDriver,
  hydrateDriverIdentities,
  inviteDriver,
  listFleetDrivers,
  listPendingInvitesForDriver,
  requireDriver,
  updateFleetDriver,
} from '../lib/fleet-repo.js'
import { requireFleetAccess } from '../lib/fleet-access.js'
import { hasLiveAssignmentForDriver } from '../lib/assignment.js'
import { addDriverToFleetSet, removeDriverFromFleetSet } from '../lib/redis.js'
import { FleetError, parseOrThrow, type FleetDriverStatus } from '../lib/types.js'
import { emitNotification } from '../lib/notify-emit.js'

// -----------------------------------------------------------
// driverRoutes — the fleet roster (mounted at /fleet/drivers).
//
// TWO PERSONAS, ONE PREFIX. The roster routes are fleet-scoped (requireFleetAccess — the
// owner, or a delegate with the right grant: manage_drivers to invite/edit/remove, 'any' to
// read the roster); the two /invites routes are driver-only (requireDriver). A fleet_owner
// token can never satisfy requireDriver — owners hold no drivers row by design — so the invite
// inbox is closed to them, and a driver with no fleet access gets a 404 on the roster.
// -----------------------------------------------------------

// An owner invites by EITHER channel they choose — phone or email — so exactly one is
// required. Both optional at the field level; the refine enforces "at least one".
const InviteBody = z.object({
  driver_phone: z.string().trim().min(8).max(20).optional(),
  driver_email: z.string().trim().email('driver_email must be a valid email').optional(),
}).refine((b) => Boolean(b.driver_phone) || Boolean(b.driver_email), {
  message: 'driver_phone or driver_email is required',
})

const UpdateDriverBody = z.object({
  monthly_salary_inr: z.number().min(0, 'monthly_salary_inr cannot be negative').max(10_000_000).optional(),
  // Reinstatement is included deliberately: fleet_drivers_one_live_per_driver
  // treats 'suspended' as NOT live, so a suspended driver may have been picked up
  // by another fleet — the unique index rejects the reactivation in that case
  // rather than silently double-employing them.
  status: z.enum(['suspended', 'active']).optional(),
}).refine(body => Object.keys(body).length > 0, 'No fields to update')

const RespondBody = z.object({
  action: z.enum(['accept', 'reject'], { errorMap: () => ({ message: "action must be 'accept' or 'reject'" }) }),
})

const IdParam = z.object({ id: z.string().uuid('id must be a valid UUID') })

const ListQuery = z.object({
  status: z.enum(['pending', 'active', 'rejected', 'suspended', 'left']).optional(),
})

export async function driverRoutes(app: FastifyInstance) {
  // POST /fleet/drivers/invite — affiliate an EXISTING driver account. We never
  // create driver identities on the owner's behalf (locked model), so an unknown
  // phone number is a 404, not an implicit signup.
  app.post('/invite', async (req, reply) => {
    const owner = await requireFleetAccess(req.user, 'manage_drivers')
    const body = parseOrThrow(InviteBody, req.body)

    const driver = body.driver_email
      ? await findDriverByEmail(body.driver_email)
      : await findDriverByPhone(body.driver_phone!)
    const affiliation = await inviteDriver(owner.id, driver.driver_id, req.user.userId)

    // The invite is only actionable if the driver hears about it — until now it was
    // visible ONLY to a driver who happened to open the in-app inbox.
    emitNotification({
      event: 'fleet_invite',
      invite_id: affiliation.id,
      driver_id: driver.driver_id,
      fleet_owner_id: owner.id,
    }, req.log)

    return reply.status(201).send({
      success: true,
      data: { ...affiliation, driver: { ...driver } },
    })
  })

  // GET /fleet/drivers — roster + status.
  app.get('/', async (req, reply) => {
    const owner = await requireFleetAccess(req.user, 'any')
    const query = parseOrThrow(ListQuery, req.query)

    const rows = await listFleetDrivers(owner.id, query.status ? [query.status] : undefined)
    const identities = await hydrateDriverIdentities(rows.map(r => r.driver_id))

    return reply.send({
      success: true,
      data: rows.map(r => ({ ...r, driver: identities.get(r.driver_id) ?? null })),
    })
  })

  // GET /fleet/drivers/invites/mine — driver-side inbox (role=driver).
  app.get('/invites/mine', async (req, reply) => {
    const driver = await requireDriver(req.user)
    const invites = await listPendingInvitesForDriver(driver.id)
    return reply.send({ success: true, data: invites })
  })

  // GET /fleet/drivers/me/affiliation — driver-side "who am I, commercially?"
  //
  // The capability signal the driver app renders from. Nothing else tells it
  // which product to show: /invites/mine returns 'pending' rows only, so an
  // ACCEPTED affiliation is invisible there.
  //
  // `is_employed` — NOT `is_fleet_affiliated` — is the field clients must branch
  // on. Affiliation alone was the wrong signal: it also caught the owner-driver
  // whose own truck is attached to a fleet, hiding the money from the person
  // paying that truck's EMI and taking away the load board they need to fill an
  // empty return leg. Employment is affiliation AND owning no truck
  // (docs/ARCHITECTURE_UNIFIED_IDENTITY.md §1.1), and it is what
  // isEmployedDriver() in bt-booking-service enforces server-side. The two MUST
  // agree or the app renders one product while the API allows another.
  //
  // is_fleet_affiliated and owns_vehicles are both still returned: the first for
  // backward compatibility with clients not yet updated (they keep today's
  // behaviour), the second because the app has a legitimate use for it beyond
  // this rule — an owner-driver needs their bank account for payouts, whereas a
  // salaried employee is paid by their fleet and does not.
  app.get('/me/affiliation', async (req, reply) => {
    const driver = await requireDriver(req.user)
    const [affiliation, ownedVehicles] = await Promise.all([
      getAffiliationForDriver(driver.id),
      countVehiclesOwnedByDriver(driver.id),
    ])
    const ownsVehicles = ownedVehicles > 0

    return reply.send({
      success: true,
      data: affiliation
        ? {
            is_fleet_affiliated: true,
            is_employed:    !ownsVehicles,
            owns_vehicles:  ownsVehicles,
            owned_vehicle_count: ownedVehicles,
            fleet_owner_id: affiliation.fleet_owner_id,
            company_name:   affiliation.company_name,
            fleet_city:     affiliation.fleet_city,
            since:          affiliation.responded_at ?? affiliation.invited_at,
          }
        : {
            is_fleet_affiliated: false,
            // Unaffiliated is never employed, whether or not they own a truck.
            is_employed:    false,
            owns_vehicles:  ownsVehicles,
            owned_vehicle_count: ownedVehicles,
            fleet_owner_id: null,
            company_name:   null,
            fleet_city:     null,
            since:          null,
          },
    })
  })

  // POST /fleet/drivers/invites/:id/respond — driver accepts or rejects (role=driver).
  app.post('/invites/:id/respond', async (req, reply) => {
    const driver = await requireDriver(req.user)
    const params = parseOrThrow(IdParam, req.params)
    const body = parseOrThrow(RespondBody, req.body)

    const invite = await getInviteForDriver(driver.id, params.id)
    if (!invite) throw new FleetError('Invitation not found', 'NOT_FOUND', 404)
    if (invite.status !== 'pending') {
      throw new FleetError(`This invitation is already '${invite.status}'`, 'INVALID_TRANSITION', 409)
    }

    const status: FleetDriverStatus = body.action === 'accept' ? 'active' : 'rejected'
    const updated = await updateFleetDriver(invite.id, { status, responded_at: new Date().toISOString() })

    if (status === 'active') {
      await syncFleetSet(app, 'add', updated.fleet_owner_id, updated.driver_id)
    }

    // The owner is waiting on this answer to plan capacity.
    emitNotification({
      event: 'fleet_invite_answered',
      invite_id: updated.id,
      driver_id: updated.driver_id,
      fleet_owner_id: updated.fleet_owner_id,
      response: status === 'active' ? 'accepted' : 'declined',
    }, req.log)

    return reply.send({ success: true, data: updated })
  })

  // PATCH /fleet/drivers/:id — salary and suspend/reinstate. :id is the
  // fleet_drivers row, always re-read scoped to this fleet first.
  app.patch('/:id', async (req, reply) => {
    const owner = await requireFleetAccess(req.user, 'manage_drivers')
    const params = parseOrThrow(IdParam, req.params)
    const body = parseOrThrow(UpdateDriverBody, req.body)

    const affiliation = await getFleetDriverById(owner.id, params.id)
    if (!affiliation) throw new FleetError('Driver not found in this fleet', 'NOT_FOUND', 404)
    if (affiliation.status === 'left' || affiliation.status === 'rejected') {
      throw new FleetError(`This affiliation is '${affiliation.status}' and can no longer be edited`, 'INVALID_TRANSITION', 409)
    }
    // CONSENT GATE: only the DRIVER may move an invitation out of 'pending', via
    // POST /fleet/drivers/invites/:id/respond. Without this, an owner could PATCH
    // status='active' on an invitation the driver never accepted — silently
    // conscripting a solo driver, which strips their load board and their right to
    // bid. The owner may still set the salary on a pending row; only the status is
    // frozen.
    if (body.status && affiliation.status === 'pending') {
      throw new FleetError(
        'This invitation has not been accepted by the driver yet',
        'INVALID_TRANSITION',
        409,
      )
    }
    // Suspending mid-trip would strand the load: the driver stays bound to the
    // booking but is no longer dispatchable.
    if (body.status === 'suspended' && await hasLiveAssignmentForDriver(owner.id, affiliation.driver_id)) {
      throw new FleetError('Driver has a live assignment — release it before suspending them', 'INVALID_TRANSITION', 409)
    }

    const updated = await updateFleetDriver(affiliation.id, body)
    if (body.status === 'suspended') {
      await syncFleetSet(app, 'remove', updated.fleet_owner_id, updated.driver_id)
    } else if (body.status === 'active') {
      await syncFleetSet(app, 'add', updated.fleet_owner_id, updated.driver_id)
    }
    return reply.send({ success: true, data: updated })
  })

  // DELETE /fleet/drivers/:id — the driver leaves the fleet (Q7). Soft: the row
  // becomes 'left' so their trip history and wage allocation survive.
  app.delete('/:id', async (req, reply) => {
    const owner = await requireFleetAccess(req.user, 'manage_drivers')
    const params = parseOrThrow(IdParam, req.params)

    const affiliation = await getFleetDriverById(owner.id, params.id)
    if (!affiliation) throw new FleetError('Driver not found in this fleet', 'NOT_FOUND', 404)
    if (affiliation.status === 'left') {
      return reply.send({ success: true, data: affiliation })
    }
    if (await hasLiveAssignmentForDriver(owner.id, affiliation.driver_id)) {
      throw new FleetError('Driver has a live assignment — it must finish before they can leave', 'INVALID_TRANSITION', 409)
    }

    const now = new Date().toISOString()
    const updated = await updateFleetDriver(affiliation.id, { status: 'left', left_at: now, responded_at: affiliation.responded_at ?? now })
    await syncFleetSet(app, 'remove', updated.fleet_owner_id, updated.driver_id)
    return reply.send({ success: true, data: updated })
  })
}

// syncFleetSet — keep fleet:{id}:drivers in step with the table. Best-effort: the
// Postgres write has already committed and is authoritative, and GET /fleet/live
// rebuilds the set from the table when it finds it empty, so a Redis blip must not
// turn into a failed roster change.
async function syncFleetSet(
  app: FastifyInstance,
  op: 'add' | 'remove',
  fleetOwnerId: string,
  driverId: string,
): Promise<void> {
  try {
    if (op === 'add') await addDriverToFleetSet(fleetOwnerId, driverId)
    else await removeDriverFromFleetSet(fleetOwnerId, driverId)
  } catch (err) {
    app.log.warn({ err, fleet_owner_id: fleetOwnerId, driver_id: driverId, op }, 'Fleet driver set sync failed; will self-heal on next /fleet/live')
  }
}
