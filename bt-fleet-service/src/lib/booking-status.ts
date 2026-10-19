// -----------------------------------------------------------
// TRIP_END_FREE_STATUSES — bookings whose trip has ended and the truck/driver
// should be free again. Physical trip end ≠ payment: 'completed' and
// 'delivery_asserted' free the truck; 'paid' and 'cancelled' do too.
//
// assignment.ts and vehicle-schedule.ts both import this list — a status that
// frees the truck in one module but not the other would make availability and
// assignment disagree about the same trip.
// -----------------------------------------------------------

export const TRIP_END_FREE_STATUSES = [
  'completed',
  'delivery_asserted',
  'paid',
  'cancelled',
] as const

export type TripEndFreeStatus = (typeof TRIP_END_FREE_STATUSES)[number]

export function bookingFreesTruck(status: string): boolean {
  return (TRIP_END_FREE_STATUSES as readonly string[]).includes(status)
}
