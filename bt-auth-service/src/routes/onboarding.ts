import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { resolvePersonas, can, type UserRole } from '@bharattruck/shared'
import type { JwtPayload } from '../lib/authenticate.js'
import { authenticate } from '../lib/authenticate.js'
import { encrypt } from '../lib/encryption.js'

const UpdateProfileBody = z.object({
  full_name:      z.string().min(2).max(100).optional(),
  photo_url:      z.string().url().optional(),
  languages:      z.array(z.string().min(1).max(30)).max(10).optional(),
  home_base_city: z.string().min(1).max(100).optional(),
  home_base_lat:  z.number().min(-90).max(90).optional(),
  home_base_lng:  z.number().min(-180).max(180).optional(),
})

const CreateVehicleBody = z.object({
  rc_number:       z.string().min(4).max(20),
  rc_storage_path: z.string().optional(),
  vehicle_photos:  z.array(z.string()).max(10).optional(),
  capacity_tons:   z.number().positive().max(100).optional(),
  body_type:       z.enum(['open', 'closed', 'container', 'flatbed', 'tanker', 'refrigerated']).optional(),
  axle_config:     z.enum(['4x2', '6x2', '6x4', '8x4', '10x2']).optional(),
  maker_model:     z.string().max(100).optional(),
  fuel_type:       z.string().max(20).optional(),
  rc_expiry:       z.string().date().optional(),
})

const UpdateVehicleBody = CreateVehicleBody.partial()

const UuidParam = z.object({ id: z.string().uuid() })

const SubmitLicenseBody = z.object({
  dl_number:       z.string().min(5).max(30),
  dl_storage_path: z.string().optional(),
  vehicle_classes: z.array(z.string().max(10)).max(10).optional(),
  expiry_date:     z.string().date().optional(),
})

const UpdateLicenseBody = SubmitLicenseBody.partial()

const SubmitInsuranceBody = z.object({
  policy_number: z.string().min(1).max(50),
  provider:      z.string().max(100).optional(),
  storage_path:  z.string().optional(),
  expiry_date:   z.string().date().optional(),
})

const LinkBankAccountBody = z.object({
  account_number:      z.string().min(8).max(18),
  ifsc:                z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC code'),
  bank_name:           z.string().max(100).optional(),
  account_holder_name: z.string().min(2).max(100),
  is_primary:          z.boolean().optional(),
})

// A truck is physically free again only once its trip has ended.
//
// This list is a HAND-KEPT COPY of TERMINAL_BOOKING_STATUSES in
// bt-fleet-service/src/lib/assignment.ts (the list that releases a vehicle_assignments
// row). Nothing enforces the copy: that one is a TS array in another service, this one
// is a PostgREST filter string, and there is no shared import between them. If the
// booking_status enum gains a terminal state, BOTH have to be edited by hand — and the
// failure mode here is the safe one (an unknown status reads as "still running").
const FINISHED_BOOKING_STATUSES = '(completed,paid,cancelled)'

// PostgREST evaluates `status not in (...)` to NULL when status itself is NULL, and a
// NULL predicate drops the row — so a booking whose status is NULL would slip straight
// past a bare negative filter and the guard would wave a live truck through. The
// explicit `status.is.null` arm keeps the check fail-closed: unknown means "not
// finished" until a real terminal status says otherwise.
const UNFINISHED_BOOKING_FILTER = `status.is.null,status.not.in.${FINISHED_BOOKING_STATUSES}`

// Every route below reads/writes `drivers`-keyed rows, so the gate is the 'drive'
// CAPABILITY — the caller HAS a `drivers` row — not the JWT `role` string (D-27, the role
// string is being removed as an authorization axis). The two agreed for every seeded user,
// whose one role matches their assets; they DIVERGE for the multi-persona case this fixes:
// a distributor whose account role is 'shipper' but who drives their own truck has a drivers
// row, so they may finish driver onboarding (insurance/bank) — the old `role === 'driver'`
// check wrongly refused them. A user with no drivers row (a pure shipper, or a fleet_owner
// whose trucks and licences live in bt-fleet-service) is refused exactly as before.
//
// Capability is COMPUTED per request from owned assets (resolvePersonas), never read off the
// token — six small indexed lookups, fine at pilot scale. The `primary_persona` arg only
// labels the snapshot; it does not feed the capability, so a token without a `role` (optional
// now, see lib/authenticate.ts) resolves the same way.
async function requireDrive(app: FastifyInstance, user: JwtPayload): Promise<string | null> {
  const snapshot = await resolvePersonas(app.supabase, user.userId, (user.role ?? 'shipper') as UserRole)
  return can(snapshot, 'drive') ? null : 'Only drivers can access onboarding'
}

type VerificationBadge = 'pending' | 'verified' | 'premium'

interface BadgeInput {
  driver: Record<string, unknown> | null
  license: { status: string } | null
  vehicleCount: number
  verifiedVehicleCount: number
  bankLinked: boolean
  insuranceCount: number
  kycStatus: string
}

// A driver is verified on THEIR OWN evidence — profile, licence, bank. A truck is
// deliberately NOT part of it (2026-09-30): drivers join with just their DL and
// details and may never own a truck (an employed fleet driver), so tying the badge
// to verifiedVehicleCount would leave every such driver 'pending' forever. Trucks
// carry their own rc_status; the checklist below still reports it separately.
function computeBadge(input: BadgeInput): VerificationBadge {
  const { driver, license, bankLinked, insuranceCount, kycStatus } = input
  if (!driver) return 'pending'

  const profileComplete = !!(
    driver.photo_url &&
    (driver.languages as string[] | undefined)?.length &&
    driver.home_base_city
  )
  const isVerified = profileComplete && license?.status === 'verified' && bankLinked
  if (!isVerified) return 'pending'

  const isPremium = insuranceCount > 0 && (kycStatus === 'verified' || kycStatus === 'approved')
  return isPremium ? 'premium' : 'verified'
}

export async function onboardingRoutes(app: FastifyInstance) {

  // PUT /onboarding/profile
  app.put('/profile', { preHandler: authenticate }, async (req, reply) => {
    const err = await requireDrive(app, req.user)
    if (err) return reply.status(403).send({ success: false, error: err })

    const body = UpdateProfileBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ success: false, error: body.error.errors[0].message })

    const { full_name, ...driverFields } = body.data

    if (full_name) {
      const { error: userErr } = await app.supabase
        .from('users').update({ full_name }).eq('id', req.user.userId)
      if (userErr) return reply.status(500).send({ success: false, error: 'Failed to update user name' })
    }

    if (Object.keys(driverFields).length > 0) {
      const { error: driverErr } = await app.supabase
        .from('drivers').update(driverFields).eq('user_id', req.user.userId)
      if (driverErr) return reply.status(500).send({ success: false, error: 'Failed to update driver profile' })
    }

    const { data: driver } = await app.supabase
      .from('drivers').select('*').eq('user_id', req.user.userId).single()

    return reply.send({ success: true, data: { driver } })
  })

  // GET /onboarding/profile
  app.get('/profile', { preHandler: authenticate }, async (req, reply) => {
    const err = await requireDrive(app, req.user)
    if (err) return reply.status(403).send({ success: false, error: err })

    const { data: user } = await app.supabase
      .from('users')
      .select('id, full_name, phone_number, email, avatar_url, city, state, kyc_status')
      .eq('id', req.user.userId)
      .single()
    if (!user) return reply.status(404).send({ success: false, error: 'User not found' })

    const { data: driver } = await app.supabase
      .from('drivers').select('*').eq('user_id', req.user.userId).single()
    // Same guard every other route here has. Without it a driver-role user with no
    // drivers row leaves driver?.id undefined, the filters below go out as literally
    // `driver_id=eq.undefined`, PostgREST rejects that as an invalid uuid, and the
    // error is thrown away because only `data` is destructured — so the reply degrades
    // to an empty licence/vehicle list and hides the real problem.
    if (!driver) return reply.status(404).send({ success: false, error: 'Driver profile not found' })

    const { data: license } = await app.supabase
      .from('driver_licenses').select('*').eq('driver_id', driver.id).maybeSingle()

    // Removed trucks stay in the table for trip history, but the profile is the
    // driver's own view of their garage — a retired truck listed here reads as a
    // failed removal.
    const { data: vehicles } = await app.supabase
      .from('vehicles').select('*, driver_insurance(*)').eq('driver_id', driver.id).eq('is_active', true)

    const { data: bankAccounts } = await app.supabase
      .from('bank_accounts')
      .select('id, account_number_last4, ifsc, bank_name, account_holder_name, is_primary, verification_status')
      .eq('user_id', req.user.userId)

    return reply.send({
      success: true,
      data: { user, driver, license, vehicles: vehicles ?? [], bank_accounts: bankAccounts ?? [] },
    })
  })

  // POST /onboarding/vehicle
  app.post('/vehicle', { preHandler: authenticate }, async (req, reply) => {
    const err = await requireDrive(app, req.user)
    if (err) return reply.status(403).send({ success: false, error: err })

    const body = CreateVehicleBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ success: false, error: body.error.errors[0].message })

    const { data: driver } = await app.supabase
      .from('drivers').select('id').eq('user_id', req.user.userId).single()
    if (!driver) return reply.status(404).send({ success: false, error: 'Driver profile not found. Complete registration first.' })

    // Adding a truck needs the business's GSTIN on file (2026-09-30 rule; the fleet-side
    // twin is bt-fleet-service/src/lib/vehicle-gate.ts). A driver completes their OWN
    // profile — DL, details, bank — with no truck at all; putting a truck on the platform
    // is what gets invoiced, so it waits for GST. Only the INSERT/revive path is gated:
    // editing or retiring a truck the driver already runs is not.
    const { data: gstRow, error: gstErr } = await app.supabase
      .from('users').select('gstin').eq('id', req.user.userId).maybeSingle()
    if (gstErr) return reply.status(500).send({ success: false, error: 'Failed to check GST registration' })
    if (!gstRow?.gstin || String(gstRow.gstin).trim() === '') {
      return reply.status(403).send({
        success: false,
        error: 'Add your GST registration (GSTIN) in Settings before adding a truck. Your driver profile does not need one.',
        code: 'GSTIN_REQUIRED',
      })
    }

    // This lookup stays UNFILTERED on is_active on purpose: vehicles_rc_number_key is an
    // unconditional UNIQUE(rc_number), so a retired row still occupies its RC and an
    // insert would hit the constraint no matter what we filtered here. Read the row and
    // decide, rather than pretending it isn't there.
    const { data: existing } = await app.supabase
      .from('vehicles').select('id, driver_id, is_active').eq('rc_number', body.data.rc_number).maybeSingle()

    // Duplicate = an ACTIVE truck, or ANY truck that belongs to somebody else. The
    // second half is the one that matters: re-adding an RC must never be a way to take
    // over another driver's (or a fleet's, driver_id NULL) truck, retired or not.
    if (existing && (existing.is_active !== false || existing.driver_id !== driver.id)) {
      return reply.status(409).send({ success: false, error: 'Vehicle with this RC number already registered' })
    }

    // The driver's own retired truck coming back. Removal is soft precisely so this is
    // possible; without it the UNIQUE constraint would make Remove a one-way door and
    // the driver could never re-add a truck they took off the road for a month.
    // Answers exactly like a fresh create (201 + { vehicle }) — from the app's side it
    // IS a create.
    //
    // rc_status is reset to 'pending' for the same reason PUT /license resets its
    // status: this body may re-declare capacity_tons / body_type / axle_config /
    // maker_model, so the specs on the row are no longer the ones anybody verified.
    // Carrying an old 'verified' over re-declared specs would let a driver launder new
    // claims through a retired truck — and rc_status feeds verifiedVehicleCount in
    // GET /status, which is PERSISTED to drivers.verification_badge. A fresh insert
    // starts at the column default 'pending'; a revive must land in the same place.
    if (existing) {
      const { data: revived, error: reviveErr } = await app.supabase
        .from('vehicles').update({ ...body.data, is_active: true, rc_status: 'pending' })
        .eq('id', existing.id).eq('driver_id', driver.id)
        .select().single()
      if (reviveErr) return reply.status(500).send({ success: false, error: 'Failed to register vehicle' })

      return reply.status(201).send({ success: true, data: { vehicle: revived } })
    }

    const { data: vehicle, error } = await app.supabase
      .from('vehicles').insert({ driver_id: driver.id, ...body.data }).select().single()
    if (error) {
      // Two requests racing on the same RC: the read above saw nothing, the constraint
      // did. Same answer as the read-side duplicate, not a 500.
      if (error.code === '23505') return reply.status(409).send({ success: false, error: 'Vehicle with this RC number already registered' })
      return reply.status(500).send({ success: false, error: 'Failed to register vehicle' })
    }

    return reply.status(201).send({ success: true, data: { vehicle } })
  })

  // PUT /onboarding/vehicle/:id
  app.put<{ Params: { id: string } }>('/vehicle/:id', { preHandler: authenticate }, async (req, reply) => {
    const err = await requireDrive(app, req.user)
    if (err) return reply.status(403).send({ success: false, error: err })

    const params = UuidParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ success: false, error: 'Invalid vehicle id' })

    const body = UpdateVehicleBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ success: false, error: body.error.errors[0].message })
    if (Object.keys(body.data).length === 0) return reply.status(400).send({ success: false, error: 'No fields to update' })

    const { data: driver } = await app.supabase
      .from('drivers').select('id').eq('user_id', req.user.userId).single()
    if (!driver) return reply.status(404).send({ success: false, error: 'Driver profile not found' })

    // is_active in the WHERE clause, not just driver_id: a removed truck is gone as far
    // as this API is concerned, so editing one must 404 rather than quietly mutate a row
    // the driver can no longer see.
    const { data: vehicle } = await app.supabase
      .from('vehicles').select('id').eq('id', params.data.id).eq('driver_id', driver.id).eq('is_active', true).maybeSingle()
    if (!vehicle) return reply.status(404).send({ success: false, error: 'Vehicle not found' })

    if (body.data.rc_number) {
      // Active-scoped to match POST: the driver's own retired truck must not read as
      // "taken" by the same generic message an in-service truck would produce.
      const { data: dup } = await app.supabase
        .from('vehicles').select('id')
        .eq('rc_number', body.data.rc_number).neq('id', params.data.id).eq('is_active', true).maybeSingle()
      if (dup) return reply.status(409).send({ success: false, error: 'Another vehicle with this RC number already exists' })

      // An active-scoped miss is NOT proof the RC is free: vehicles_rc_number_key is an
      // unconditional UNIQUE(rc_number), so a retired row still occupies its RC and the
      // update below would fail on the constraint. Left at the generic message that
      // would be a dead end — retired trucks are hidden from GET /vehicles and
      // GET /profile, so the driver is told they collide with something that appears
      // nowhere in the app and has no in-app way out. Name the real situation instead.
      const { data: hiddenDup } = await app.supabase
        .from('vehicles').select('id, driver_id, is_active')
        .eq('rc_number', body.data.rc_number).neq('id', params.data.id).maybeSingle()

      // Only the driver's OWN retired truck earns the specific message. Anyone else's
      // row — retired or not, including a fleet truck (driver_id NULL) — stays the
      // opaque generic 409: this route must never confirm what another owner holds.
      if (hiddenDup && hiddenDup.is_active === false && hiddenDup.driver_id === driver.id) {
        return reply.status(409).send({
          success: false,
          error: 'That RC number belongs to a truck you removed. Add that truck back instead of renaming this one — the removed truck keeps its own trip history.',
          code: 'RC_HELD_BY_REMOVED_VEHICLE',
        })
      }
      if (hiddenDup) return reply.status(409).send({ success: false, error: 'Another vehicle with this RC number already exists' })
    }

    // rc_status resets for the same reason the revive branch resets it, and the same
    // reason PUT /license resets its own status: this body can re-declare capacity,
    // body type, axle config and the RC number itself, so whatever an earlier check
    // verified is no longer what the row claims. Without this a driver can edit the
    // specs of a verified truck and keep the verified mark — which feeds
    // verifiedVehicleCount and is then PERSISTED to drivers.verification_badge.
    //
    // driver_id and is_active are repeated on the write so it is scoped exactly like
    // the read above; a concurrent DELETE landing between the two must not leave this
    // update mutating a truck that is by then retired.
    const { data: updated, error } = await app.supabase
      .from('vehicles').update({ ...body.data, rc_status: 'pending' })
      .eq('id', params.data.id).eq('driver_id', driver.id).eq('is_active', true)
      .select().single()
    if (error) {
      if (error.code === '23505') return reply.status(409).send({ success: false, error: 'Another vehicle with this RC number already exists' })
      return reply.status(500).send({ success: false, error: 'Failed to update vehicle' })
    }

    return reply.send({ success: true, data: { vehicle: updated } })
  })

  // GET /onboarding/vehicles
  app.get('/vehicles', { preHandler: authenticate }, async (req, reply) => {
    const err = await requireDrive(app, req.user)
    if (err) return reply.status(403).send({ success: false, error: err })

    const { data: driver } = await app.supabase
      .from('drivers').select('id').eq('user_id', req.user.userId).single()
    if (!driver) return reply.status(404).send({ success: false, error: 'Driver profile not found' })

    // Retired trucks stay in the table for history but must not come back as pickable
    // options — a removed truck reappearing in the driver's garage reads as a bug.
    const { data: vehicles } = await app.supabase
      .from('vehicles').select('*, driver_insurance(*)').eq('driver_id', driver.id).eq('is_active', true)
      .order('created_at', { ascending: false })

    return reply.send({ success: true, data: { vehicles: vehicles ?? [] } })
  })

  // DELETE /onboarding/vehicle/:id
  //
  // SOFT, always. A vehicles row is the spine of that truck's whole record:
  // vehicle_finance, vehicle_permits and vehicle_lanes cascade off it (migration 0017),
  // and bookings.vehicle_id (migration 0016) / trip_expenses.vehicle_id (0017) null
  // out — as do trips.vehicle_id and location_history.vehicle_id (0016). A hard
  // delete would burn the asset's permit and cost history and quietly detach it from
  // trips it really ran — the rows the driver's own earnings are reconstructed from.
  // Retiring a truck means "stop offering it", not "it never existed", so the row
  // stays and only is_active flips.
  app.delete<{ Params: { id: string } }>('/vehicle/:id', { preHandler: authenticate }, async (req, reply) => {
    const err = await requireDrive(app, req.user)
    if (err) return reply.status(403).send({ success: false, error: err })

    const params = UuidParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ success: false, error: 'Invalid vehicle id' })

    const { data: driver } = await app.supabase
      .from('drivers').select('id').eq('user_id', req.user.userId).single()
    if (!driver) return reply.status(404).send({ success: false, error: 'Driver profile not found' })

    // Ownership lives in the WHERE clause, not in a check after the read: another
    // driver's truck is indistinguishable from a missing one, so the 404 can never be
    // used to confirm that some id exists.
    const { data: vehicle } = await app.supabase
      .from('vehicles').select('id, is_active')
      .eq('id', params.data.id).eq('driver_id', driver.id).maybeSingle()
    if (!vehicle) return reply.status(404).send({ success: false, error: 'Vehicle not found' })

    // Already retired — answer the same way as the first time. A driver whose
    // connection dropped mid-request will tap again, and that retry must not surface
    // as a different failure than the one they already succeeded at.
    if (vehicle.is_active === false) {
      return reply.send({ success: true, data: { message: 'Vehicle removed' } })
    }

    // Retiring a truck mid-trip would strand the load: tracking, POD and the trip's
    // per-asset economics all key off the truck the booking is running on. Asked as
    // "not finished" rather than as a list of live states, so a status added to the
    // enum later refuses by default instead of silently freeing a truck still moving.
    //
    // TWO arms, because there are two ways a truck can be on a trip and only one of
    // them is written down:
    //
    //  (a) bookings.vehicle_id — explicit attribution. Correct, but today the ONLY
    //      writer of that column is bt-fleet-service's assignment path, and a fleet
    //      truck has driver_id NULL (vehicles_exactly_one_owner), so no row this
    //      driver-scoped route can reach ever carries it. Kept because it becomes the
    //      real check the moment solo trips start recording their vehicle.
    //
    //  (b) the solo case that actually happens now: the driver's trips name the DRIVER,
    //      never the truck. If this is their LAST active truck and they are on a live
    //      trip, that trip is necessarily running on this truck — there is nothing else
    //      it could be on. That inference is only sound while one truck remains, which
    //      is why we deliberately do NOT block on driver_id alone: a driver with two
    //      trucks removing truck B while driving truck A is doing something legitimate,
    //      and blocking it would be a bug, not a safeguard.
    const { data: attachedBooking, error: attachedErr } = await app.supabase
      .from('bookings').select('id')
      .eq('vehicle_id', params.data.id)
      .or(UNFINISHED_BOOKING_FILTER)
      .limit(1).maybeSingle()
    if (attachedErr) return reply.status(500).send({ success: false, error: 'Failed to check whether the vehicle is in use' })

    let inUse = !!attachedBooking

    if (!inUse) {
      // "Any OTHER active truck left?" — not a count of all of them, because this row
      // is still active at this point in the request.
      const { count: otherActive, error: otherErr } = await app.supabase
        .from('vehicles').select('id', { count: 'exact', head: true })
        .eq('driver_id', driver.id).eq('is_active', true).neq('id', params.data.id)
      if (otherErr) return reply.status(500).send({ success: false, error: 'Failed to check whether the vehicle is in use' })

      // A missing count is treated as "none left", which routes into the stricter
      // branch. Erring toward refusing a removal is recoverable; releasing a truck
      // out from under a running load is not.
      if ((otherActive ?? 0) === 0) {
        const { data: driverBooking, error: driverErr } = await app.supabase
          .from('bookings').select('id')
          .eq('driver_id', driver.id)
          .or(UNFINISHED_BOOKING_FILTER)
          .limit(1).maybeSingle()
        if (driverErr) return reply.status(500).send({ success: false, error: 'Failed to check whether the vehicle is in use' })
        inUse = !!driverBooking
      }
    }

    if (inUse) {
      return reply.status(409).send({
        success: false,
        error: 'This vehicle is on a trip that has not finished yet. It can be removed once that trip completes.',
        code: 'VEHICLE_IN_USE',
      })
    }

    // driver_id repeated on the write so the update is scoped exactly like the read
    // above — the ownership check and the mutation can never disagree.
    const { error } = await app.supabase
      .from('vehicles').update({ is_active: false })
      .eq('id', params.data.id).eq('driver_id', driver.id)
    if (error) return reply.status(500).send({ success: false, error: 'Failed to remove vehicle' })

    return reply.send({ success: true, data: { message: 'Vehicle removed' } })
  })

  // POST /onboarding/license
  app.post('/license', { preHandler: authenticate }, async (req, reply) => {
    const err = await requireDrive(app, req.user)
    if (err) return reply.status(403).send({ success: false, error: err })

    const body = SubmitLicenseBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ success: false, error: body.error.errors[0].message })

    const { data: driver } = await app.supabase
      .from('drivers').select('id').eq('user_id', req.user.userId).single()
    if (!driver) return reply.status(404).send({ success: false, error: 'Driver profile not found' })

    const { data: existing } = await app.supabase
      .from('driver_licenses').select('id').eq('driver_id', driver.id).maybeSingle()
    if (existing) return reply.status(409).send({ success: false, error: 'License already submitted. Use PUT to update.' })

    const { data: dupDl } = await app.supabase
      .from('driver_licenses').select('id').eq('dl_number', body.data.dl_number).maybeSingle()
    if (dupDl) return reply.status(409).send({ success: false, error: 'This DL number is already registered by another driver' })

    const { data: license, error } = await app.supabase
      .from('driver_licenses').insert({ driver_id: driver.id, ...body.data }).select().single()
    if (error) return reply.status(500).send({ success: false, error: 'Failed to submit license' })

    return reply.status(201).send({ success: true, data: { license } })
  })

  // PUT /onboarding/license
  app.put('/license', { preHandler: authenticate }, async (req, reply) => {
    const err = await requireDrive(app, req.user)
    if (err) return reply.status(403).send({ success: false, error: err })

    const body = UpdateLicenseBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ success: false, error: body.error.errors[0].message })
    if (Object.keys(body.data).length === 0) return reply.status(400).send({ success: false, error: 'No fields to update' })

    const { data: driver } = await app.supabase
      .from('drivers').select('id').eq('user_id', req.user.userId).single()
    if (!driver) return reply.status(404).send({ success: false, error: 'Driver profile not found' })

    if (body.data.dl_number) {
      const { data: dup } = await app.supabase
        .from('driver_licenses').select('id').eq('dl_number', body.data.dl_number).neq('driver_id', driver.id).maybeSingle()
      if (dup) return reply.status(409).send({ success: false, error: 'This DL number is already registered by another driver' })
    }

    const { data: license, error } = await app.supabase
      .from('driver_licenses').update({ ...body.data, status: 'pending' }).eq('driver_id', driver.id).select().single()
    if (error) return reply.status(404).send({ success: false, error: 'No license found to update. Submit one first.' })

    return reply.send({ success: true, data: { license } })
  })

  // POST /onboarding/vehicle/:id/insurance
  app.post<{ Params: { id: string } }>('/vehicle/:id/insurance', { preHandler: authenticate }, async (req, reply) => {
    const err = await requireDrive(app, req.user)
    if (err) return reply.status(403).send({ success: false, error: err })

    const params = UuidParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ success: false, error: 'Invalid vehicle id' })

    const body = SubmitInsuranceBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ success: false, error: body.error.errors[0].message })

    const { data: driver } = await app.supabase
      .from('drivers').select('id').eq('user_id', req.user.userId).single()
    if (!driver) return reply.status(404).send({ success: false, error: 'Driver profile not found' })

    // Same is_active scoping as the edit path: a removed truck is not a thing you can
    // file fresh insurance against.
    const { data: vehicle } = await app.supabase
      .from('vehicles').select('id').eq('id', params.data.id).eq('driver_id', driver.id).eq('is_active', true).maybeSingle()
    if (!vehicle) return reply.status(404).send({ success: false, error: 'Vehicle not found' })

    const { data: insurance, error } = await app.supabase
      .from('driver_insurance')
      .insert({ driver_id: driver.id, vehicle_id: params.data.id, ...body.data })
      .select().single()
    if (error) {
      if (error.code === '23505') return reply.status(409).send({ success: false, error: 'Insurance with this policy number already exists for this vehicle' })
      return reply.status(500).send({ success: false, error: 'Failed to submit insurance' })
    }

    return reply.status(201).send({ success: true, data: { insurance } })
  })

  // POST /onboarding/bank-account
  app.post('/bank-account', { preHandler: authenticate }, async (req, reply) => {
    const body = LinkBankAccountBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ success: false, error: body.error.errors[0].message })

    const { account_number, ifsc, bank_name, account_holder_name, is_primary } = body.data
    const last4 = account_number.slice(-4)

    let encrypted: string
    try {
      encrypted = encrypt(account_number)
    } catch (e) {
      app.log.error(e, 'Encryption failed')
      return reply.status(500).send({ success: false, error: 'Failed to secure account details' })
    }

    if (is_primary !== false) {
      await app.supabase
        .from('bank_accounts').update({ is_primary: false })
        .eq('user_id', req.user.userId).eq('is_primary', true)
    }

    const { data: account, error } = await app.supabase
      .from('bank_accounts')
      .insert({
        user_id: req.user.userId,
        account_number_enc: encrypted,
        account_number_last4: last4,
        ifsc,
        bank_name: bank_name ?? null,
        account_holder_name,
        is_primary: is_primary !== false,
      })
      .select('id, account_number_last4, ifsc, bank_name, account_holder_name, is_primary, verification_status, created_at')
      .single()
    if (error) return reply.status(500).send({ success: false, error: 'Failed to link bank account' })

    return reply.status(201).send({ success: true, data: { bank_account: account } })
  })

  // GET /onboarding/bank-accounts
  app.get('/bank-accounts', { preHandler: authenticate }, async (req, reply) => {
    const { data: accounts } = await app.supabase
      .from('bank_accounts')
      .select('id, account_number_last4, ifsc, bank_name, account_holder_name, is_primary, verification_status, created_at')
      .eq('user_id', req.user.userId)
      .order('is_primary', { ascending: false })
      .order('created_at', { ascending: false })

    return reply.send({ success: true, data: { bank_accounts: accounts ?? [] } })
  })

  // DELETE /onboarding/bank-account/:id
  app.delete<{ Params: { id: string } }>('/bank-account/:id', { preHandler: authenticate }, async (req, reply) => {
    const params = UuidParam.safeParse(req.params)
    if (!params.success) return reply.status(400).send({ success: false, error: 'Invalid account id' })

    const { data: account } = await app.supabase
      .from('bank_accounts').select('id, is_primary')
      .eq('id', params.data.id).eq('user_id', req.user.userId).maybeSingle()
    if (!account) return reply.status(404).send({ success: false, error: 'Bank account not found' })

    const { error } = await app.supabase
      .from('bank_accounts').delete().eq('id', params.data.id)
    if (error) return reply.status(500).send({ success: false, error: 'Failed to remove bank account' })

    if (account.is_primary) {
      const { data: next } = await app.supabase
        .from('bank_accounts').select('id')
        .eq('user_id', req.user.userId).order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (next) {
        await app.supabase.from('bank_accounts').update({ is_primary: true }).eq('id', next.id)
      }
    }

    return reply.send({ success: true, data: { message: 'Bank account removed' } })
  })

  // GET /onboarding/status
  app.get('/status', { preHandler: authenticate }, async (req, reply) => {
    const err = await requireDrive(app, req.user)
    if (err) return reply.status(403).send({ success: false, error: err })

    const { data: user } = await app.supabase
      .from('users').select('kyc_status').eq('id', req.user.userId).single()

    const { data: driver } = await app.supabase
      .from('drivers').select('id, photo_url, languages, home_base_city, verification_badge')
      .eq('user_id', req.user.userId).single()

    if (!driver) {
      return reply.send({
        success: true,
        data: {
          verification_badge: 'pending' as VerificationBadge,
          checklist: {
            profile_complete: false,
            license_submitted: false,
            license_verified: false,
            vehicle_registered: false,
            vehicle_verified: false,
            insurance_uploaded: false,
            bank_linked: false,
          },
        },
      })
    }

    const { data: license } = await app.supabase
      .from('driver_licenses').select('status').eq('driver_id', driver.id).maybeSingle()

    // Counting removed trucks here is the expensive mistake: this feeds computeBadge AND
    // the result is written back to drivers.verification_badge below, so a driver who
    // removed their only verified truck would keep a 'verified'/'premium' badge and have
    // it PERSISTED — a stale badge in the DB that outlives the request that caused it.
    const { data: vehicles } = await app.supabase
      .from('vehicles').select('id, rc_status').eq('driver_id', driver.id).eq('is_active', true)

    const { count: insuranceCount } = await app.supabase
      .from('driver_insurance').select('id', { count: 'exact', head: true }).eq('driver_id', driver.id)

    const { count: bankCount } = await app.supabase
      .from('bank_accounts').select('id', { count: 'exact', head: true }).eq('user_id', req.user.userId)

    const vehicleList = vehicles ?? []
    const verifiedVehicles = vehicleList.filter(v => v.rc_status === 'verified').length
    const bankLinked = (bankCount ?? 0) > 0

    const badge = computeBadge({
      driver,
      license,
      vehicleCount: vehicleList.length,
      verifiedVehicleCount: verifiedVehicles,
      bankLinked,
      insuranceCount: insuranceCount ?? 0,
      kycStatus: user?.kyc_status ?? 'pending',
    })

    if (badge !== (driver as Record<string, unknown>).verification_badge) {
      await app.supabase.from('drivers').update({ verification_badge: badge }).eq('id', driver.id)
    }

    const profileComplete = !!(driver.photo_url && driver.languages?.length && driver.home_base_city)

    return reply.send({
      success: true,
      data: {
        verification_badge: badge,
        checklist: {
          profile_complete: profileComplete,
          license_submitted: !!license,
          license_verified: license?.status === 'verified',
          vehicle_registered: vehicleList.length > 0,
          vehicle_verified: verifiedVehicles > 0,
          insurance_uploaded: (insuranceCount ?? 0) > 0,
          bank_linked: bankLinked,
        },
      },
    })
  })
}
