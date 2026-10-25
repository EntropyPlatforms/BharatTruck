import { getSupabase } from './supabase.js'
import {
  asRow,
  asRowOrNull,
  asRows,
  FleetError,
  UNIQUE_VIOLATION,
  type VehicleFinanceRow,
  type VehicleRow,
} from './types.js'

// -----------------------------------------------------------
// vehicles-repo — fleet-owned trucks and their per-asset records (finance,
// permits, lanes).
//
// `vehicles` is SHARED with the solo-driver persona: migration 0015 pivots it to
// "owned by EITHER a driver OR a fleet" (num_nonnulls(driver_id, fleet_owner_id)=1).
// Every read and write here therefore filters on fleet_owner_id — a solo driver's
// truck must be invisible and untouchable from this service.
// -----------------------------------------------------------

const VEHICLE_COLUMNS =
  'id, driver_id, fleet_owner_id, rc_number, capacity_tons, body_type, axle_config, maker_model, ' +
  'fuel_type, rc_expiry, model_category, emission_norm, manufacture_year, volume_cuft, ' +
  // is_active: VehicleRow declared it but it was never selected, so every truck read as active.
  'current_odometer_km, is_active, created_at'

export type CreateVehicleInput = {
  rc_number: string
  model_category: string
  manufacture_year: number
  emission_norm?: 'BS4' | 'BS6' | 'BS6_PH2' | null
  capacity_tons?: number | null
  volume_cuft?: number | null
  current_odometer_km?: number | null
  body_type?: string | null
  axle_config?: string | null
  maker_model?: string | null
  fuel_type?: string | null
  rc_expiry?: string | null
}

export async function createVehicle(fleetOwnerId: string, input: CreateVehicleInput): Promise<VehicleRow> {
  const { data, error } = await getSupabase()
    .from('vehicles')
    // driver_id stays NULL: the exactly-one-owner CHECK is what makes this a
    // fleet asset rather than a driver's own truck.
    .insert({ ...input, fleet_owner_id: fleetOwnerId, driver_id: null })
    .select(VEHICLE_COLUMNS)
    .single()
  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      throw new FleetError(`A vehicle with RC number ${input.rc_number} is already registered`, 'CONFLICT', 409)
    }
    throw new Error(`vehicles insert failed: ${error.message}`)
  }
  return asRow<VehicleRow>(data)
}

export async function listFleetVehicles(fleetOwnerId: string): Promise<VehicleRow[]> {
  const { data, error } = await getSupabase()
    .from('vehicles')
    .select(VEHICLE_COLUMNS)
    .eq('fleet_owner_id', fleetOwnerId)
    .order('created_at', { ascending: false })
  if (error) throw new Error(`vehicles select failed: ${error.message}`)
  return asRows<VehicleRow>(data)
}

// getFleetVehicle — tenancy-scoped by construction: an id belonging to another
// fleet (or to a solo driver) reads as "not found", never as someone else's truck.
export async function getFleetVehicle(fleetOwnerId: string, vehicleId: string): Promise<VehicleRow | null> {
  const { data, error } = await getSupabase()
    .from('vehicles')
    .select(VEHICLE_COLUMNS)
    .eq('id', vehicleId)
    .eq('fleet_owner_id', fleetOwnerId)
    .maybeSingle()
  if (error) throw new Error(`vehicles select failed: ${error.message}`)
  return asRowOrNull<VehicleRow>(data)
}

export async function requireFleetVehicle(fleetOwnerId: string, vehicleId: string): Promise<VehicleRow> {
  const vehicle = await getFleetVehicle(fleetOwnerId, vehicleId)
  if (!vehicle) throw new FleetError('Vehicle not found in this fleet', 'NOT_FOUND', 404)
  return vehicle
}

export async function updateVehicle(
  fleetOwnerId: string,
  vehicleId: string,
  patch: Partial<CreateVehicleInput>,
): Promise<VehicleRow> {
  const { data, error } = await getSupabase()
    .from('vehicles')
    .update(patch)
    .eq('id', vehicleId)
    .eq('fleet_owner_id', fleetOwnerId)
    .select(VEHICLE_COLUMNS)
    .maybeSingle()
  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      throw new FleetError('Another vehicle with that RC number already exists', 'CONFLICT', 409)
    }
    throw new Error(`vehicles update failed: ${error.message}`)
  }
  if (!data) throw new FleetError('Vehicle not found in this fleet', 'NOT_FOUND', 404)
  return asRow<VehicleRow>(data)
}

// -----------------------------------------------------------
// vehicle_finance — EMI + the fixed annual carrying costs the owner keys in once.
// -----------------------------------------------------------

const FINANCE_COLUMNS =
  'id, vehicle_id, lender, loan_account_no, principal_inr, emi_amount_inr, emi_day_of_month, ' +
  'tenure_months, interest_rate_pct, start_date, end_date, outstanding_inr, ' +
  'insurance_annual_inr, permit_annual_inr, fitness_annual_inr'

export type FinanceInput = Omit<VehicleFinanceRow, 'id' | 'vehicle_id'>

export async function upsertVehicleFinance(vehicleId: string, input: FinanceInput): Promise<VehicleFinanceRow> {
  const { data, error } = await getSupabase()
    .from('vehicle_finance')
    // vehicle_id is UNIQUE, so PUT is a genuine upsert rather than a read-modify-write.
    .upsert({ ...input, vehicle_id: vehicleId, updated_at: new Date().toISOString() }, { onConflict: 'vehicle_id' })
    .select(FINANCE_COLUMNS)
    .single()
  if (error) throw new Error(`vehicle_finance upsert failed: ${error.message}`)
  return asRow<VehicleFinanceRow>(data)
}

export async function getVehicleFinance(vehicleId: string): Promise<VehicleFinanceRow | null> {
  const { data, error } = await getSupabase()
    .from('vehicle_finance')
    .select(FINANCE_COLUMNS)
    .eq('vehicle_id', vehicleId)
    .maybeSingle()
  if (error) throw new Error(`vehicle_finance select failed: ${error.message}`)
  return asRowOrNull<VehicleFinanceRow>(data)
}

export async function listVehicleFinance(vehicleIds: string[]): Promise<Map<string, VehicleFinanceRow>> {
  if (vehicleIds.length === 0) return new Map()
  const { data, error } = await getSupabase()
    .from('vehicle_finance')
    .select(FINANCE_COLUMNS)
    .in('vehicle_id', vehicleIds)
  if (error) throw new Error(`vehicle_finance select failed: ${error.message}`)
  return new Map((asRows<VehicleFinanceRow>(data)).map(f => [f.vehicle_id, f]))
}

// -----------------------------------------------------------
// vehicle_permits / vehicle_lanes — PUT replaces the whole set for one truck,
// which is what the owner's edit screen actually does (add/remove rows at once).
// -----------------------------------------------------------

export type PermitInput = {
  permit_type: 'national' | 'state' | 'contract_carriage' | 'goods'
  allowed_states: string[]
  permit_number?: string | null
  issued_on?: string | null
  expiry_date?: string | null
  is_active?: boolean
}

export async function replaceVehiclePermits(vehicleId: string, permits: PermitInput[]) {
  const supabase = getSupabase()
  const { error: delErr } = await supabase.from('vehicle_permits').delete().eq('vehicle_id', vehicleId)
  if (delErr) throw new Error(`vehicle_permits delete failed: ${delErr.message}`)
  if (permits.length === 0) return []

  const { data, error } = await supabase
    .from('vehicle_permits')
    .insert(permits.map(p => ({ ...p, vehicle_id: vehicleId })))
    .select('*')
  if (error) throw new Error(`vehicle_permits insert failed: ${error.message}`)
  return data ?? []
}

export async function listVehiclePermits(vehicleId: string) {
  const { data, error } = await getSupabase()
    .from('vehicle_permits')
    .select('*')
    .eq('vehicle_id', vehicleId)
    .order('created_at', { ascending: false })
  if (error) throw new Error(`vehicle_permits select failed: ${error.message}`)
  return data ?? []
}

export type LaneInput = {
  origin_city: string
  destination_city: string
  origin_lat?: number | null
  origin_lng?: number | null
  dest_lat?: number | null
  dest_lng?: number | null
  typical_distance_km?: number | null
  is_primary?: boolean
}

export async function replaceVehicleLanes(vehicleId: string, lanes: LaneInput[]) {
  const supabase = getSupabase()
  const { error: delErr } = await supabase.from('vehicle_lanes').delete().eq('vehicle_id', vehicleId)
  if (delErr) throw new Error(`vehicle_lanes delete failed: ${delErr.message}`)
  if (lanes.length === 0) return []

  const { data, error } = await supabase
    .from('vehicle_lanes')
    .insert(lanes.map(l => ({ ...l, vehicle_id: vehicleId })))
    .select('*')
  if (error) {
    // vehicle_lanes_one_primary — at most one primary corridor per truck.
    if (error.code === UNIQUE_VIOLATION) {
      throw new FleetError('Only one lane may be marked primary for a vehicle', 'CONFLICT', 409)
    }
    throw new Error(`vehicle_lanes insert failed: ${error.message}`)
  }
  return withObservedTrips(vehicleId, (data ?? []) as LaneRow[])
}

export async function listVehicleLanes(vehicleId: string) {
  const { data, error } = await getSupabase()
    .from('vehicle_lanes')
    .select('*')
    .eq('vehicle_id', vehicleId)
    .order('is_primary', { ascending: false })
  if (error) throw new Error(`vehicle_lanes select failed: ${error.message}`)
  return withObservedTrips(vehicleId, (data ?? []) as LaneRow[])
}

// ── trips observed on a lane ────────────────────────────────────────────────
// vehicle_lanes.trips_observed was never written (and every lane edit deletes and re-inserts the
// rows), so the screen showed 0 next to "observed from completed trips, not hardcoded". It is now
// COUNTED from this truck's finished bookings: a trip belongs to a lane when its pickup and drop
// match the lane's cities by name, or lie within LANE_MATCH_KM of the lane's end points.

type LaneRow = {
  id: string; origin_city: string; destination_city: string
  origin_lat: number | string | null; origin_lng: number | string | null
  dest_lat: number | string | null; dest_lng: number | string | null
  trips_observed?: number
  [k: string]: unknown
}
type TripRow = {
  source_address: string | null; destination_address: string | null
  source_lat: number | string | null; source_lng: number | string | null
  dest_lat: number | string | null; dest_lng: number | string | null
}

export const LANE_MATCH_KM = 25

function kmBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = (d: number) => (d * Math.PI) / 180
  const dLat = r(bLat - aLat), dLng = r(bLng - aLng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}
const n = (v: number | string | null | undefined) => (v === null || v === undefined || v === '' ? null : Number(v))
function endMatches(city: string, lat: number | null, lng: number | null, address: string | null, tLat: number | null, tLng: number | null): boolean {
  if (city && address && address.toLowerCase().includes(city.trim().toLowerCase())) return true
  if (lat !== null && lng !== null && tLat !== null && tLng !== null && Number.isFinite(lat + lng + tLat + tLng)) return kmBetween(lat, lng, tLat, tLng) <= LANE_MATCH_KM
  return false
}

/** Pure: how many of these trips ran this lane. Exported for the unit suite. */
export function countLaneTrips(lane: LaneRow, trips: TripRow[]): number {
  return trips.filter((t) =>
    endMatches(lane.origin_city, n(lane.origin_lat), n(lane.origin_lng), t.source_address, n(t.source_lat), n(t.source_lng)) &&
    endMatches(lane.destination_city, n(lane.dest_lat), n(lane.dest_lng), t.destination_address, n(t.dest_lat), n(t.dest_lng)),
  ).length
}

async function withObservedTrips(vehicleId: string, lanes: LaneRow[]): Promise<LaneRow[]> {
  if (lanes.length === 0) return lanes
  const supabase = getSupabase()
  const cols = 'source_address, destination_address, source_lat, source_lng, dest_lat, dest_lng'
  // Fleet trips name the truck; a solo trip's truck is its driver's own (vehicles.driver_id).
  const { data: v } = await supabase.from('vehicles').select('driver_id, fleet_owner_id').eq('id', vehicleId).maybeSingle()
  const veh = v as { driver_id: string | null; fleet_owner_id: string | null } | null
  const [{ data: byTruck, error: e1 }, solo] = await Promise.all([
    supabase.from('bookings').select(cols).eq('vehicle_id', vehicleId).in('status', ['completed', 'paid']),
    veh?.driver_id && !veh.fleet_owner_id
      ? supabase.from('bookings').select(cols).eq('driver_id', veh.driver_id).is('fleet_owner_id', null).in('status', ['completed', 'paid'])
      : Promise.resolve({ data: [] as TripRow[], error: null }),
  ])
  if (e1 || solo.error) return lanes // keep the stored value rather than fail the page
  const trips = [...((byTruck ?? []) as TripRow[]), ...((solo.data ?? []) as TripRow[])]
  return lanes.map((l) => ({ ...l, trips_observed: countLaneTrips(l, trips) }))
}
