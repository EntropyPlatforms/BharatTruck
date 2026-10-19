// gstStateCode — the ONE state -> GST 2-digit code mapping, now shared by the fleet economics
// roll-up (free-text fleet_owners.state) and tracking place-details (full state name). These pin
// the three accepted input shapes and the union of aliases the two callers each need, so the
// copies cannot silently drift apart again.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gstStateCode } from '../src/india-states.ts'

test('passes through an already-canonical 2-digit code', () => {
  assert.equal(gstStateCode('27'), '27')
  assert.equal(gstStateCode('07'), '07')
})

test('resolves a two-letter code, case-insensitively (fleet free-text path)', () => {
  assert.equal(gstStateCode('MH'), '27')
  assert.equal(gstStateCode('mh'), '27')
  assert.equal(gstStateCode('TS'), '36') // Telangana alt
  assert.equal(gstStateCode('OD'), '21') // Odisha alt
})

test('resolves a full state name, case-insensitively (tracking Places path)', () => {
  assert.equal(gstStateCode('Maharashtra'), '27')
  assert.equal(gstStateCode('maharashtra'), '27')
  assert.equal(gstStateCode('  Karnataka  '), '29')
})

test('accepts the union of aliases both callers need', () => {
  assert.equal(gstStateCode('Orissa'), '21')
  assert.equal(gstStateCode('Delhi'), '07')
  assert.equal(gstStateCode('National Capital Territory of Delhi'), '07') // tracking alias
  assert.equal(gstStateCode('J&K'), '01') // fleet alias
  assert.equal(gstStateCode('Tamilnadu'), '33')
})

test('returns null for the unresolvable — never fabricates a code', () => {
  assert.equal(gstStateCode('Atlantis'), null)
  assert.equal(gstStateCode(''), null)
  assert.equal(gstStateCode('   '), null)
  assert.equal(gstStateCode(null), null)
  assert.equal(gstStateCode(undefined), null)
})
