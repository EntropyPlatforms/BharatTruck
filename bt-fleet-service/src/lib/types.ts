import { z } from 'zod'

// -----------------------------------------------------------
// Shared error + row shapes for bt-fleet-service.
//
// Row types mirror the LIVE database (migrations 0015-0018 for the fleet tables,
// introspected columns for the pre-existing ones). Column names here are the
// contract with PostgREST — a typo becomes a runtime 400, never a compile error,
// so they are written out in full rather than inferred.
// -----------------------------------------------------------

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'GSTIN_REQUIRED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_TRANSITION'
  // A truck cannot be dispatched under a load heavier than it can carry. Its own code
  // (not CONFLICT) so the app can point the dispatcher at a bigger truck or splitting the
  // load, rather than showing a generic clash they would reasonably retry unchanged.
  | 'CAPACITY_EXCEEDED'
  | 'NOT_IMPLEMENTED'
  | 'MISCONFIGURED'
  | 'INTERNAL_ERROR'

export class FleetError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
    readonly httpStatus: number,
  ) {
    super(message)
    this.name = 'FleetError'
  }
}

// parseOrThrow — single Zod entry point so every body/param rejection produces the
// same {success:false,error,code} envelope with the first field message. Generic
// over the schema (not its output) so `.default()` and `.coerce` resolve to the
// parsed type rather than the input type.
export function parseOrThrow<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new FleetError(result.error.errors[0].message, 'VALIDATION_ERROR', 400)
  }
  return result.data
}

// -----------------------------------------------------------
// PostgREST row casts. Without generated database types, supabase-js cannot
// resolve an explicit column list and widens the result to GenericStringError.
// These three helpers are the ONE place that acknowledges the live DB — not the
// TypeScript compiler — is the schema authority, instead of scattering
// `as unknown as X` through every query.
// -----------------------------------------------------------

export function asRow<T>(data: unknown): T {
  return data as T
}

export function asRowOrNull<T>(data: unknown): T | null {
  return (data ?? null) as T | null
}

export function asRows<T>(data: unknown): T[] {
  return (data ?? []) as T[]
}

// PostgREST surfaces the raw Postgres SQLSTATE; 23505 is unique_violation, which is
// how the partial-unique indexes in migration 0016 report a lost concurrency race.
export const UNIQUE_VIOLATION = '23505'

export type EmissionNorm = 'BS4' | 'BS6' | 'BS6_PH2'

export type FleetOwnerRow = {
  id: string
  user_id: string
  company_name: string
  gstin: string | null
  pan: string | null
  contact_phone: string | null
  billing_address: string | null
  city: string | null
  state: string | null
  monthly_overhead_inr: number
  is_active: boolean
  created_at: string
  updated_at: string
}

export type FleetDriverStatus = 'pending' | 'active' | 'rejected' | 'suspended' | 'left'

export type FleetDriverRow = {
  id: string
  fleet_owner_id: string
  driver_id: string
  status: FleetDriverStatus
  monthly_salary_inr: number | null
  invited_by: string | null
  invited_at: string
  responded_at: string | null
  left_at: string | null
  created_at: string
  updated_at: string
}

export type VehicleRow = {
  id: string
  driver_id: string | null
  fleet_owner_id: string | null
  rc_number: string
  capacity_tons: number | null
  body_type: string | null
  axle_config: string | null
  maker_model: string | null
  fuel_type: string | null
  rc_expiry: string | null
  model_category: string | null
  emission_norm: EmissionNorm | null
  manufacture_year: number | null
  volume_cuft: number | null
  current_odometer_km: number | null
  created_at: string
}

export type VehicleAssignmentRow = {
  id: string
  fleet_owner_id: string
  booking_id: string
  vehicle_id: string
  driver_id: string
  assigned_by: string
  assigned_at: string
  released_at: string | null
  created_at: string
}

export type VehicleFinanceRow = {
  id: string
  vehicle_id: string
  lender: string | null
  loan_account_no: string | null
  principal_inr: number | null
  emi_amount_inr: number
  emi_day_of_month: number | null
  tenure_months: number | null
  interest_rate_pct: number | null
  start_date: string | null
  end_date: string | null
  outstanding_inr: number | null
  insurance_annual_inr: number
  permit_annual_inr: number
  fitness_annual_inr: number
}

export type TripEconomicsRow = {
  booking_id: string
  fleet_owner_id: string | null
  vehicle_id: string | null
  driver_id: string | null
  revenue_inr: number
  fuel_cost_est_inr: number
  def_cost_est_inr: number
  engine_oil_cost_inr: number
  gear_oil_cost_inr: number
  service_cost_inr: number
  tyre_cost_inr: number
  driver_wage_alloc_inr: number
  fuel_cost_actual_inr: number | null
  toll_cost_inr: number
  other_cost_inr: number
  running_cost_inr: number
  net_profit_inr: number
  distance_km_quoted: number | null
  distance_km_actual: number | null
  distance_km_planned: number | null
  distance_basis: 'measured' | 'routed' | 'estimated' | null
  laden_weight_kg: number | null
  capacity_kg: number | null
  volume_used_cuft: number | null
  capacity_cuft: number | null
  started_at: string | null
  completed_at: string | null
  model_version: string
  computed_at: string
}

// Bookings columns this service reads. bookings.driver_id stays THE driver of
// record for the trip (tracking/POD/ingestion are unchanged by fleet ownership).
export type BookingRow = {
  id: string
  shipper_id: string
  driver_id: string | null
  fleet_owner_id: string | null
  vehicle_id: string | null
  source_address: string
  source_lat: number
  source_lng: number
  destination_address: string
  dest_lat: number
  dest_lng: number
  // Geocoded origin state (migration 0035) — the per-state diesel resolver prefers it over the
  // fleet owner's base state. Absent/null on legacy hand-typed bookings.
  source_state_code?: string | null
  load_type: string
  weight_kg: number
  quoted_price: number
  final_price: number | null
  pickup_date: string
  status: string
  booking_type: string
  dimensions_json: Record<string, unknown> | null
  created_at: string
  updated_at: string
}
