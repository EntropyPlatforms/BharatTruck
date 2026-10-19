// verifyJwt token-purpose tests.
//
// The hole these pin: a password-reset and a consignee-claim token are signed with the SAME
// JWT_SECRET as an access token and both carry a `userId`, so without a purpose check they would
// authenticate as a full session on every service (a leaked 14-day claim link = a 14-day login).
// verifyJwt must accept only access tokens — tagged `type:'access'`, or untagged (legacy sessions
// minted before tagging, which must keep working so no live user is signed out on deploy) — and
// reject any other typed token.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import { verifyJwt, JwtError, extractBearer } from '../src/auth.ts'

const SECRET = 'test-secret'
const sign = (claims: Record<string, unknown>) => jwt.sign(claims, SECRET)

test('accepts an access-typed token', () => {
  const user = verifyJwt(sign({ userId: 'u1', role: 'shipper', type: 'access' }), SECRET)
  assert.equal(user.userId, 'u1')
  assert.equal(user.role, 'shipper')
})

test('accepts a legacy untyped token (no session is signed out on deploy)', () => {
  const user = verifyJwt(sign({ userId: 'u2', role: 'driver' }), SECRET)
  assert.equal(user.userId, 'u2')
})

test('rejects a password-reset token used as a session', () => {
  assert.throws(() => verifyJwt(sign({ userId: 'u3', type: 'pwreset' }), SECRET), JwtError)
})

test('rejects a consignee-claim token used as a session', () => {
  assert.throws(() => verifyJwt(sign({ userId: 'u4', type: 'consignee_claim' }), SECRET), JwtError)
})

test('rejects any unknown token type', () => {
  assert.throws(() => verifyJwt(sign({ userId: 'u5', type: 'anything-else' }), SECRET), JwtError)
})

test('still rejects a token signed with a different secret', () => {
  assert.throws(() => verifyJwt(sign({ userId: 'u6', type: 'access' }), 'other-secret'), JwtError)
})

test('still rejects a token missing userId', () => {
  assert.throws(() => verifyJwt(sign({ type: 'access' }), SECRET), JwtError)
})

test('extractBearer unchanged', () => {
  assert.equal(extractBearer('Bearer abc'), 'abc')
  assert.equal(extractBearer('abc'), null)
  assert.equal(extractBearer(undefined), null)
})
