import { Redis } from 'ioredis'

const url = process.env.REDIS_URL
if (!url) throw new Error('REDIS_URL must be set')

export const redis = new Redis(url, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
})

export const LOCATION_TTL_SECONDS = 30

// Durable breadcrumb throttle window (D-007: ~1 point / 10–15s).
// The first /location/update in each window per booking wins the
// location_history insert via an atomic SET NX EX gate; the rest
// stay Redis-only.
export const BREADCRUMB_THROTTLE_SECONDS = 12

export const driverLocationKey  = (driverId: string)  => `loc:driver:${driverId}`
export const driverBookingKey   = (driverId: string)  => `loc:driver-booking:${driverId}`
export const bookingDriverKey   = (bookingId: string) => `loc:booking-driver:${bookingId}`
export const breadcrumbGateKey  = (bookingId: string) => `loc:bc-gate:${bookingId}`
