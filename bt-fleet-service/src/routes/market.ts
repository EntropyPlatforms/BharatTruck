import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireFleetAccess } from '../lib/fleet-access.js'
import { getActiveAffiliation, getFleetOwnerById, requireDriver, toCanonicalPhone } from '../lib/fleet-repo.js'
import {
  ASSIGNABLE_STATUSES,
  assertDriverFreeAcrossBookings,
  assertVehicleWithinCapacity,
  assignDriverAndVehicle,
  getFleetBooking,
} from '../lib/assignment.js'
import {
  buildOffer,
  checkMarketCrew,
  deleteMarketOffer,
  getMarketOffer,
  listMarketOffersForDriver,
  offerIsFor,
  saveMarketOffer,
} from '../lib/market-offer.js'
import { emitNotification } from '../lib/notify-emit.js'
import { getSupabase } from '../lib/supabase.js'
import { assertVehicleAvailable } from '../lib/vehicle-schedule.js'
import { getDriverOwnedVehicle, listDriverOwnedVehicles } from '../lib/vehicles-repo.js'
import { asRows, FleetError, parseOrThrow, type BookingRow } from '../lib/types.js'

// -----------------------------------------------------------
// marketRoutes — hiring a MARKET TRUCK (an outsider: an independent driver on their own truck)
// for one load the fleet has won. Mounted at the /fleet root, beside assignmentRoutes.
//
//   Fleet (dispatch grant):
//     GET    /fleet/market-drivers?mobile=     find a driver WITH their own truck by mobile
//     POST   /fleet/bookings/:id/market-offer  offer the load to that driver + truck
//     GET    /fleet/bookings/:id/market-offer  the open offer on this load, if any ('any' grant)
//     DELETE /fleet/bookings/:id/market-offer  withdraw it
//   Driver:
//     GET    /fleet/market-offers              my open offers (the Home card)
//     POST   /fleet/market-offers/:bookingId/accept   accept: the assignment is made now
//     POST   /fleet/market-offers/:bookingId/decline  decline
//
// Consent is the point: an offer binds nothing; only the driver's accept runs the assignment,
// through the same assignDriverAndVehicle every fleet dispatch uses (capacity, truck and driver
// free, re-crew, the unique-index insert, the booking bind). See lib/market-offer.ts.
//
// The hire's money is between the fleet and the outsider and settled outside the app: the
// offer carries no price, and the outsider is never shown the shipper's price either (the
// booking service masks it for a driver running a load for a fleet they are not a member of).
// -----------------------------------------------------------

const IdParam = z.object({ id: z.string().uuid('id must be a valid UUID') })
const BookingParam = z.object({ bookingId: z.string().uuid('bookingId must be a valid UUID') })
const OfferBody = z.object({
  driver_id: z.string().uuid('driver_id must be a valid UUID'),
  vehicle_id: z.string().uuid('vehicle_id must be a valid UUID'),
})
const MobileQuery = z.object({ mobile: z.string().trim().min(1, 'Enter the driver\'s mobile number').max(20) })

const TRUCK_FIELDS = (v: { id: string; rc_number: string; model_category: string | null; body_type: string | null; capacity_tons: number | null; rc_status?: string }) => ({
  id: v.id,
  rc_number: v.rc_number,
  model_category: v.model_category,
  body_type: v.body_type,
  capacity_tons: v.capacity_tons,
  rc_status: v.rc_status ?? null,
})

async function driverByUserPhone(phone: string): Promise<{ driver_id: string; user_id: string; full_name: string | null; city: string | null } | null> {
  const supabase = getSupabase()
  const { data: user, error } = await supabase
    .from('users').select('id, full_name, city').eq('phone_number', phone).maybeSingle()
  if (error) throw new Error(`users select failed: ${error.message}`)
  if (!user) return null
  const u = user as { id: string; full_name: string | null; city: string | null }
  const { data: driver, error: dErr } = await supabase.from('drivers').select('id').eq('user_id', u.id).maybeSingle()
  if (dErr) throw new Error(`drivers select failed: ${dErr.message}`)
  if (!driver) return null
  return { driver_id: (driver as { id: string }).id, user_id: u.id, full_name: u.full_name, city: u.city }
}

async function driverUserAndName(driverId: string): Promise<{ user_id: string | null; full_name: string | null }> {
  const supabase = getSupabase()
  const { data, error } = await supabase.from('drivers').select('user_id').eq('id', driverId).maybeSingle()
  if (error) throw new Error(`drivers select failed: ${error.message}`)
  const userId = (data as { user_id: string } | null)?.user_id ?? null
  if (!userId) return { user_id: null, full_name: null }
  const { data: u } = await supabase.from('users').select('full_name').eq('id', userId).maybeSingle()
  return { user_id: userId, full_name: (u as { full_name: string | null } | null)?.full_name ?? null }
}

export async function marketRoutes(app: FastifyInstance) {
  // GET /fleet/market-drivers?mobile= — exact mobile only (no browsing other people's drivers).
  // Answers just what the owner needs to pick a truck: name, city and the driver's own trucks.
  app.get('/market-drivers', async (req, reply) => {
    const owner = await requireFleetAccess(req.user, 'dispatch')
    const { mobile } = parseOrThrow(MobileQuery, req.query)
    const phone = toCanonicalPhone(mobile)
    if (!phone) throw new FleetError('Enter a valid 10-digit Indian mobile number', 'VALIDATION_ERROR', 400)

    const driver = await driverByUserPhone(phone)
    const trucks = driver ? await listDriverOwnedVehicles(driver.driver_id) : []
    if (!driver || trucks.length === 0) {
      throw new FleetError(
        'No driver with their own truck is registered on BharatTruck with that number. Only drivers who own a truck can be hired as a market truck.',
        'NOT_FOUND',
        404,
      )
    }
    const inYourFleet = !!(await getActiveAffiliation(owner.id, driver.driver_id))
    return reply.send({
      success: true,
      data: {
        driver_id: driver.driver_id,
        full_name: driver.full_name,
        city: driver.city,
        in_your_fleet: inYourFleet,
        is_you: driver.user_id === owner.user_id,
        trucks: trucks.map(TRUCK_FIELDS),
      },
    })
  })

  // POST /fleet/bookings/:id/market-offer — { driver_id, vehicle_id }.
  app.post('/bookings/:id/market-offer', async (req, reply) => {
    const owner = await requireFleetAccess(req.user, 'dispatch')
    const { id } = parseOrThrow(IdParam, req.params)
    const body = parseOrThrow(OfferBody, req.body)

    const booking = await getFleetBooking(owner.id, id)
    if (!booking) throw new FleetError('Booking not found for this fleet', 'NOT_FOUND', 404)
    if (!ASSIGNABLE_STATUSES.includes(booking.status)) {
      throw new FleetError(
        `Booking is '${booking.status}' — a market truck can only be hired for an accepted booking that has not started`,
        'INVALID_TRANSITION',
        409,
      )
    }

    const [vehicle, driver, membership] = await Promise.all([
      getDriverOwnedVehicle(body.driver_id, body.vehicle_id),
      driverUserAndName(body.driver_id),
      getActiveAffiliation(owner.id, body.driver_id),
    ])
    const refusal = checkMarketCrew({
      vehicle,
      driverId: body.driver_id,
      driverUserId: driver.user_id,
      ownerUserId: owner.user_id,
      isMember: !!membership,
    })
    if (refusal) throw refusal
    // The same three checks the assignment will run again on accept, here so the owner hears
    // now, not after the driver says yes.
    assertVehicleWithinCapacity(booking, vehicle!)
    await assertVehicleAvailable(body.vehicle_id, { exceptBookingId: booking.id })
    await assertDriverFreeAcrossBookings(body.driver_id, booking.id)

    const offer = buildOffer({
      booking_id: booking.id,
      fleet_owner_id: owner.id,
      driver_id: body.driver_id,
      vehicle_id: body.vehicle_id,
      by: req.user.userId,
    })
    await saveMarketOffer(offer)
    emitNotification({
      event: 'market_load_offer',
      booking_id: booking.id,
      driver_id: body.driver_id,
      fleet_owner_id: owner.id,
      rc_number: vehicle!.rc_number,
      source_address: booking.source_address,
      destination_address: booking.destination_address,
      pickup_date: booking.pickup_date,
    }, req.log)
    return reply.status(201).send({
      success: true,
      data: { ...offer, driver_name: driver.full_name, rc_number: vehicle!.rc_number },
    })
  })

  // GET /fleet/bookings/:id/market-offer — the open offer on one of this fleet's loads, or null.
  app.get('/bookings/:id/market-offer', async (req, reply) => {
    const owner = await requireFleetAccess(req.user, 'any')
    const { id } = parseOrThrow(IdParam, req.params)
    const offer = await getMarketOffer(id)
    if (!offer || offer.fleet_owner_id !== owner.id || new Date(offer.expires_at) <= new Date()) {
      return reply.send({ success: true, data: null })
    }
    const [driver, vehicle] = await Promise.all([
      driverUserAndName(offer.driver_id),
      getDriverOwnedVehicle(offer.driver_id, offer.vehicle_id),
    ])
    return reply.send({
      success: true,
      data: { ...offer, driver_name: driver.full_name, rc_number: vehicle?.rc_number ?? null },
    })
  })

  // DELETE /fleet/bookings/:id/market-offer — withdraw (idempotent).
  app.delete('/bookings/:id/market-offer', async (req, reply) => {
    const owner = await requireFleetAccess(req.user, 'dispatch')
    const { id } = parseOrThrow(IdParam, req.params)
    const offer = await getMarketOffer(id)
    if (offer && offer.fleet_owner_id === owner.id) await deleteMarketOffer(offer)
    return reply.send({ success: true, data: { withdrawn: true } })
  })

  // GET /fleet/market-offers — the calling driver's open offers, with the load summary.
  app.get('/market-offers', async (req, reply) => {
    const me = await requireDriver(req.user)
    const offers = await listMarketOffersForDriver(me.id)
    if (offers.length === 0) return reply.send({ success: true, data: [] })

    const supabase = getSupabase()
    const { data, error } = await supabase
      .from('bookings')
      .select('id, fleet_owner_id, status, source_address, destination_address, pickup_date, weight_kg, load_type')
      .in('id', offers.map(o => o.booking_id))
    if (error) throw new Error(`bookings select failed: ${error.message}`)
    const bookings = new Map(asRows<Pick<BookingRow, 'id' | 'fleet_owner_id' | 'status' | 'source_address' | 'destination_address' | 'pickup_date' | 'weight_kg' | 'load_type'>>(data).map(b => [b.id, b]))

    const out = []
    for (const offer of offers) {
      const b = bookings.get(offer.booking_id)
      // A load that has moved on (cancelled, crewed by someone else) is no longer an offer.
      if (!b || b.fleet_owner_id !== offer.fleet_owner_id || !ASSIGNABLE_STATUSES.includes(b.status)) continue
      const [fleet, truck] = await Promise.all([
        getFleetOwnerById(offer.fleet_owner_id),
        getDriverOwnedVehicle(me.id, offer.vehicle_id),
      ])
      out.push({
        booking_id: offer.booking_id,
        fleet: fleet ? { company_name: fleet.company_name, city: fleet.city } : null,
        rc_number: truck?.rc_number ?? null,
        source_address: b.source_address,
        destination_address: b.destination_address,
        pickup_date: b.pickup_date,
        weight_kg: b.weight_kg,
        load_type: b.load_type,
        expires_at: offer.expires_at,
      })
    }
    return reply.send({ success: true, data: out })
  })

  // POST /fleet/market-offers/:bookingId/accept — the driver says yes: assign now.
  app.post('/market-offers/:bookingId/accept', async (req, reply) => {
    const me = await requireDriver(req.user)
    const { bookingId } = parseOrThrow(BookingParam, req.params)
    const offer = await getMarketOffer(bookingId)
    if (!offerIsFor(offer, me.id)) {
      throw new FleetError('This offer is no longer open — the fleet may have withdrawn it or it expired', 'NOT_FOUND', 404)
    }
    const result = await assignDriverAndVehicle({
      fleetOwnerId: offer.fleet_owner_id,
      bookingId: offer.booking_id,
      driverId: offer.driver_id,
      vehicleId: offer.vehicle_id,
      assignedBy: offer.by,
      marketOffer: { driverId: offer.driver_id, vehicleId: offer.vehicle_id },
    })
    await deleteMarketOffer(offer)
    return reply.status(201).send({
      success: true,
      data: { booking_id: result.booking.id, assignment_id: result.assignment.id },
    })
  })

  // POST /fleet/market-offers/:bookingId/decline — idempotent.
  app.post('/market-offers/:bookingId/decline', async (req, reply) => {
    const me = await requireDriver(req.user)
    const { bookingId } = parseOrThrow(BookingParam, req.params)
    const offer = await getMarketOffer(bookingId)
    if (offer && offer.driver_id === me.id) await deleteMarketOffer(offer)
    return reply.send({ success: true, data: { declined: true } })
  })
}
