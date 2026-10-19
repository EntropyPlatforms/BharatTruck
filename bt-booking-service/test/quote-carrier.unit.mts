/**
 * Quote → carrier mapping.
 *
 * Pins the shape the shipper's quote list is rendered from. The regression this
 * exists for: a fleet-owner bid leaves quotes.driver_id NULL (migration 016),
 * and the shipper app was reading that column directly to name the bidder —
 * every fleet bid crashed the booking page on `driver_id.slice(...)`.
 *
 * Pure mapper, no Postgres: the embed shape is the contract under test.
 *
 * Run: npx tsx test/quote-carrier.unit.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'

import { toQuoteWithCarrier } from '../src/lib/quote-repository.js'
import type { DbQuote } from '../src/lib/types.js'

let passed = 0
const failures: string[] = []
function check(label: string, ok: boolean) {
  if (ok) { passed++; console.log(`  ✓ ${label}`) }
  else { failures.push(label); console.log(`  ✗ ${label}`) }
}

const BASE: DbQuote = {
  id: 'q-1',
  booking_id: 'b-1',
  driver_id: null,
  fleet_owner_id: null,
  amount: 18000,
  message: null,
  status: 'submitted',
  submitted_at: '2026-07-31T14:18:24.258519+00:00',
  expires_at: null,
  updated_at: '2026-07-31T14:18:24.258519+00:00',
}

console.log('\n── fleet-owner bid (driver_id NULL — the crashing case)')
{
  const out = toQuoteWithCarrier({
    ...BASE,
    fleet_owner_id: 'f2000000-0000-4000-8000-000000000001',
    fleet_owner: { id: 'f2000000-0000-4000-8000-000000000001', company_name: 'Shree Balaji Roadlines Pvt Ltd' },
    driver: null,
  })
  check('resolves to a fleet carrier', out.carrier?.kind === 'fleet')
  check('names the company', out.carrier?.name === 'Shree Balaji Roadlines Pvt Ltd')
  check('carrier id is the fleet owner id', out.carrier?.id === 'f2000000-0000-4000-8000-000000000001')
  check('no truck is claimed before assignment', out.carrier?.truck_number === null)
  check('driver_id stays null on the wire', out.driver_id === null)
  check('join keys are stripped from the payload', !('fleet_owner' in out) && !('driver' in out))
}

console.log('\n── solo-driver bid')
{
  const out = toQuoteWithCarrier({
    ...BASE,
    driver_id: 'd-1',
    driver: {
      id: 'd-1',
      truck_number: 'MH12AB1234',
      average_rating: '4.50',
      total_trips: '37',
      user: { full_name: 'Ramesh Kumar' },
    },
    fleet_owner: null,
  })
  check('resolves to a driver carrier', out.carrier?.kind === 'driver')
  check('names the driver', out.carrier?.name === 'Ramesh Kumar')
  check('carries the truck number', out.carrier?.truck_number === 'MH12AB1234')
  // PostgREST hands numerics back as strings; rendering "4.50" through
  // toLocaleString would print a bare string, so coercion is part of the contract.
  check('numeric rating is coerced to a number', out.carrier?.average_rating === 4.5)
  check('numeric trip count is coerced to a number', out.carrier?.total_trips === 37)
}

console.log('\n── driver with no name on file (the seeded demo drivers)')
{
  const out = toQuoteWithCarrier({
    ...BASE,
    driver_id: 'd-2',
    driver: { id: 'd-2', truck_number: null, average_rating: '0.00', total_trips: 0, user: { full_name: null } },
    fleet_owner: null,
  })
  check('still resolves the carrier', out.carrier?.kind === 'driver')
  check('name is null rather than invented', out.carrier?.name === null)
  check('zero rating survives coercion (not turned into null)', out.carrier?.average_rating === 0)
}

console.log('\n── party row missing entirely')
{
  const out = toQuoteWithCarrier({ ...BASE, driver_id: 'd-3', driver: null, fleet_owner: null })
  check('carrier is null, not a half-built object', out.carrier === null)
}

console.log('\n── malformed numerics')
{
  const out = toQuoteWithCarrier({
    ...BASE,
    driver_id: 'd-4',
    driver: { id: 'd-4', truck_number: null, average_rating: 'not-a-number', total_trips: null, user: null },
    fleet_owner: null,
  })
  check('unparseable rating degrades to null, never NaN', out.carrier?.average_rating === null)
  check('absent user does not throw', out.carrier?.name === null)
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) { failures.forEach(f => console.log(`  - ${f}`)); process.exit(1) }
