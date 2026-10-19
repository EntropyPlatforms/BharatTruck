/**
 * Regression guard for the payout WIRE SHAPE (the columns actually sent to PostgREST).
 *
 * Why this exists separately from payment.e2e.mts: that suite drives a Map-backed fake
 * PaymentStore, which happily accepts any key. It therefore cannot catch a payload that
 * names a column the real `payouts` table does not have — and PostgREST rejects the
 * ENTIRE write in that case (PGRST204 / 42703), it does not ignore the extra key.
 *
 * `payee_type` and `fleet_owner_id` arrive in migration 0016. A solo-driver settlement
 * must not depend on 0016, because that is 100% of settlements today. So a driver payout
 * has to go over the wire with exactly the pre-fleet column set.
 *
 * Run: npx tsx test/payout-wire-shape.mts
 */
import assert from 'node:assert/strict'
import { wirePayout } from '../src/lib/payment-store.js'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  PASS  ${name}`)
}

console.log('\n── payout wire shape ──')

const driverRow = {
  booking_id: 'b-1',
  payee_type: 'driver' as const,
  driver_id: 'd-1',
  fleet_owner_id: null,
  amount: 6000,
  mode: 'cash' as const,
  status: 'recorded' as const,
  recorded_by: 'u-1',
}

check('driver payout omits payee_type (absent pre-0016)', () => {
  assert.ok(!('payee_type' in wirePayout(driverRow)))
})

check('driver payout omits fleet_owner_id (absent pre-0016)', () => {
  assert.ok(!('fleet_owner_id' in wirePayout(driverRow)))
})

check('driver payout is exactly the pre-fleet column set', () => {
  assert.deepEqual(Object.keys(wirePayout(driverRow)).sort(), [
    'amount', 'booking_id', 'driver_id', 'mode', 'recorded_by', 'status',
  ])
})

check('driver payout preserves the payee and the money', () => {
  const w = wirePayout(driverRow)
  assert.equal(w.driver_id, 'd-1')
  assert.equal(w.amount, 6000)
})

const fleetRow = {
  booking_id: 'b-2',
  payee_type: 'fleet_owner' as const,
  driver_id: null,
  fleet_owner_id: 'f-1',
  amount: 9000,
  mode: 'cash' as const,
  status: 'recorded' as const,
  recorded_by: 'u-1',
}

check('fleet payout DOES send both fleet columns', () => {
  const w = wirePayout(fleetRow)
  assert.equal(w.payee_type, 'fleet_owner')
  assert.equal(w.fleet_owner_id, 'f-1')
})

check('fleet payout satisfies the 0016 payee CHECK (fleet_owner_id not null)', () => {
  const w = wirePayout(fleetRow)
  assert.equal(w.payee_type, 'fleet_owner')
  assert.notEqual(w.fleet_owner_id, null)
})

check('fleet payout leaves driver_id null — the fleet is the payee', () => {
  assert.equal(wirePayout(fleetRow).driver_id, null)
})

console.log(`\nRESULT: PASS — ${passed} checks passed, 0 failed`)
