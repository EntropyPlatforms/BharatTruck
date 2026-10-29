/**
 * Route toll parsing — Google's three tollInfo cases must map to priced / none / unknown, because
 * pricing treats them very differently (route toll, ₹0, or the class ₹/km fallback).
 *
 * Run: npx tsx test/tolls.test.mts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseRouteToll } from '../src/lib/tolls.js'

test('no tollInfo means Google expects no tolls on the route', () => {
  assert.deepEqual(parseRouteToll({}), { status: 'none' })
  assert.deepEqual(parseRouteToll({ travelAdvisory: {} }), { status: 'none' })
})

test('tollInfo without a price means tolls exist but the amount is unknown', () => {
  assert.deepEqual(parseRouteToll({ travelAdvisory: { tollInfo: {} } }), { status: 'unknown' })
  assert.deepEqual(parseRouteToll({ travelAdvisory: { tollInfo: { estimatedPrice: [] } } }), { status: 'unknown' })
})

test('an INR price is summed from units + nanos and rounded to the rupee', () => {
  const r = parseRouteToll({ travelAdvisory: { tollInfo: { estimatedPrice: [{ currencyCode: 'INR', units: '1245', nanos: 600_000_000 }] } } })
  assert.deepEqual(r, { status: 'priced', car_toll_inr: 1246 })
})

test('a price only in another currency is unknown, never mistaken for rupees', () => {
  const r = parseRouteToll({ travelAdvisory: { tollInfo: { estimatedPrice: [{ currencyCode: 'USD', units: '15' }] } } })
  assert.deepEqual(r, { status: 'unknown' })
})
