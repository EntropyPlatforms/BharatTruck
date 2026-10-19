import { Redis } from 'ioredis'

// -----------------------------------------------------------
// Redis access for the live fleet map.
//
// This service is a READER of the live-position keys; bt-booking-service's
// /location/update is their only writer, so `driverLocationKey` MUST stay
// byte-identical to bt-booking-service/src/lib/redis.ts.
//
// The one key this service owns is `fleet:{fleet_owner_id}:drivers` — the set of
// drivers.id currently affiliated to a fleet. It exists so GET /fleet/live is a
// single SMEMBERS + single MGET instead of a per-driver fan-out: at 1000 trucks on
// a 10s poll the fan-out version is 100 req/s against Redis and the DB.
// -----------------------------------------------------------

let client: Redis | null = null

// Lazy so /health and every non-map route stay up (and unit tests stay importable)
// without a Redis connection.
export function getRedis(): Redis {
  if (!client) {
    const url = process.env.REDIS_URL
    if (!url) throw new Error('REDIS_URL must be set')
    client = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false })
  }
  return client
}

export const fleetDriversKey = (fleetOwnerId: string) => `fleet:${fleetOwnerId}:drivers`

// Written by bt-booking-service ingestion (30s TTL). Do not change independently.
export const driverLocationKey = (driverId: string) => `loc:driver:${driverId}`

// Live position payload as bt-booking-service serialises it.
export type LivePosition = {
  driver_id: string
  lat: number
  lng: number
  heading: number | null
  speed_kmh: number | null
  accuracy_m: number | null
  booking_id: string | null
  updated_at: string
}

// addDriverToFleetSet / removeDriverFromFleetSet — called from every place a
// fleet_drivers row changes status, so the set never drifts from the table.
// Best-effort: a Redis hiccup must not fail an invite/accept/suspend write that
// already committed to Postgres. getFleetDriverIds self-heals from the DB.
export async function addDriverToFleetSet(fleetOwnerId: string, driverId: string): Promise<void> {
  await getRedis().sadd(fleetDriversKey(fleetOwnerId), driverId)
}

export async function removeDriverFromFleetSet(fleetOwnerId: string, driverId: string): Promise<void> {
  await getRedis().srem(fleetDriversKey(fleetOwnerId), driverId)
}
