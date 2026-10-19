// -----------------------------------------------------------
// Trip expenses — the driver logs what a trip actually cost (fuel, toll, tyre, …).
//
// WHY THIS EXISTS: trip_economics' fuel-variance / pilferage signal diffs modelled diesel
// against what the driver actually filled, but until now NOTHING in the repo ever wrote a
// trip_expenses row — the "actuals" the fleet dashboard promised had no source, and the one
// column that fed the signal (category) was free text nobody validated. This is the write
// path: the assigned driver records an expense against their booking, choosing a category
// from a CONTROLLED set (category_code), so the pilferage signal stops depending on how a
// driver spells "fuel". The fleet roll-up (bt-fleet-service classifyExpense) keys off that
// code.
//
// The category vocabulary now lives in @bharattruck/shared/expenses — the ONE backend source,
// shared with the fleet roll-up's classifier. It must still match the CHECK constraint on
// trip_expenses.category_code (migration 0034 — authoritative). bt-app keeps its own dropdown
// copy until it too is onboarded onto @bharattruck/shared; keep that copy in step with 0034.
// -----------------------------------------------------------

import { z } from 'zod'
import { canFleetAccessBooking, resolveFleetOwnerByUserId } from '@bharattruck/shared/fleet'
import { EXPENSE_CATEGORY_CODES, EXPENSE_CATEGORY_LABELS } from '@bharattruck/shared/expenses'
import { supabase } from './supabase.js'
import * as repo from './repository.js'
import { BookingError, type AuthenticatedUser, type BookingStatus } from './types.js'

// A trip must actually be underway (or just delivered) to have costs — logging on a pending
// or cancelled booking is meaningless, and the roll-up runs at 'paid', so we take entries up
// to and including 'completed'.
const EXPENSE_LOGGABLE_STATUSES: BookingStatus[] = ['accepted', 'in_transit', 'delivery_asserted', 'completed']

// The driver types this at a dhaba / fuel pump, often one-handed — trimmed, strict, and the
// server sets driver/booking/vehicle, never the client.
export const LogExpenseSchema = z.object({
  category_code: z.enum(EXPENSE_CATEGORY_CODES),
  amount: z.number().positive('amount must be greater than zero'),
  description: z.string().trim().max(500).optional(),
  // Fuel-specific, optional: lets a fuel entry carry litres/rate so a future check can catch
  // a rate that does not match the state diesel price.
  litres: z.number().positive().optional(),
  rate_per_litre: z.number().positive().optional(),
  odometer_km: z.number().int().nonnegative().optional(),
  expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expense_date must be YYYY-MM-DD').optional(),
}).strict()

export type LogExpenseBody = z.infer<typeof LogExpenseSchema>

export type TripExpenseRow = {
  id: string
  booking_id: string | null
  driver_id: string
  vehicle_id: string | null
  category: string
  category_code: string | null
  amount: number
  description: string | null
  litres: number | null
  rate_per_litre: number | null
  odometer_km: number | null
  expense_date: string
  created_at: string
}

const EXPENSE_COLUMNS =
  'id, booking_id, driver_id, vehicle_id, category, category_code, amount, description, ' +
  'litres, rate_per_litre, odometer_km, expense_date, created_at'

// logTripExpense — the assigned driver records one expense against their booking.
export async function logTripExpense(
  bookingId: string,
  user: AuthenticatedUser,
  body: LogExpenseBody,
): Promise<TripExpenseRow> {
  const driver = await repo.getDriverByUserId(user.userId)
  if (!driver) throw new BookingError('Driver profile not found', 'NOT_FOUND', 404)

  const booking = await repo.getBookingById(bookingId)
  if (!booking) throw new BookingError(`Booking ${bookingId} not found`, 'NOT_FOUND', 404)

  // bookings.driver_id references drivers.id, and getDriverByUserId returns drivers.id —
  // so this is the assigned-driver check, not a users.id mix-up (CLAUDE.md identity gotcha).
  if (booking.driver_id !== driver.id) {
    throw new BookingError('You are not assigned to this booking', 'FORBIDDEN', 403)
  }
  if (!EXPENSE_LOGGABLE_STATUSES.includes(booking.status)) {
    throw new BookingError(
      `Expenses can only be logged on an active trip (${EXPENSE_LOGGABLE_STATUSES.join(', ')}), not '${booking.status}'`,
      'INVALID_TRANSITION',
      409,
    )
  }

  const insert = {
    booking_id: bookingId,
    driver_id: driver.id,
    // vehicle_id ties the expense to the truck for the per-vehicle P&L; null on a solo
    // driver booking with no vehicle of record, exactly as the roll-up already tolerates.
    vehicle_id: booking.vehicle_id ?? null,
    category_code: body.category_code,
    // The legacy free-text column stays populated with the label, so any older display that
    // reads `category` still shows something sensible; the code is what the classifier uses.
    category: EXPENSE_CATEGORY_LABELS[body.category_code],
    amount: body.amount,
    description: body.description ?? null,
    litres: body.litres ?? null,
    rate_per_litre: body.rate_per_litre ?? null,
    odometer_km: body.odometer_km ?? null,
    ...(body.expense_date ? { expense_date: body.expense_date } : {}),
  }

  const { data, error } = await supabase
    .from('trip_expenses')
    .insert(insert)
    .select(EXPENSE_COLUMNS)
    .single()
  if (error) throw new Error(`trip_expenses insert failed: ${error.message}`)
  return data as unknown as TripExpenseRow
}

// listTripExpenses — the expenses on a booking, for the assigned driver, the fleet that can
// reach the booking, or ops. Deliberately NOT the shipper: a truck's running costs are the
// carrier's book, not the customer's.
export async function listTripExpenses(
  bookingId: string,
  user: AuthenticatedUser,
): Promise<TripExpenseRow[]> {
  const booking = await repo.getBookingById(bookingId)
  if (!booking) throw new BookingError(`Booking ${bookingId} not found`, 'NOT_FOUND', 404)

  const driver = await repo.getDriverByUserId(user.userId)
  let allowed = user.role === 'admin' || (driver != null && booking.driver_id === driver.id)
  if (!allowed) {
    const fleetOwner = await resolveFleetOwnerByUserId(supabase, user.userId)
    if (fleetOwner) allowed = await canFleetAccessBooking(supabase, fleetOwner.id, booking)
  }
  if (!allowed) {
    throw new BookingError('You cannot view expenses for this booking', 'FORBIDDEN', 403)
  }

  const { data, error } = await supabase
    .from('trip_expenses')
    .select(EXPENSE_COLUMNS)
    .eq('booking_id', bookingId)
    .order('created_at', { ascending: false })
  if (error) throw new Error(`trip_expenses select failed: ${error.message}`)
  return (data ?? []) as unknown as TripExpenseRow[]
}
