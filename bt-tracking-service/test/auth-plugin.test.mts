/**
 * The tracking service's bearer-token check must accept every valid session the other services
 * accept. It used to also demand a `role` claim, so a session whose access token was refreshed
 * from an older role-less refresh token worked everywhere except Live Fleet and live tracking —
 * and the app read that 401 as "session expired" and signed the user out.
 *
 * Run: npx tsx test/auth-plugin.test.mts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import jwt from 'jsonwebtoken'

process.env.JWT_SECRET = 'test-secret-tracking'

const { default: authPlugin } = await import('../src/plugins/auth.ts')

async function build() {
  const app = Fastify()
  await app.register(authPlugin)
  app.get('/whoami', async (req) => ({ user: (req as unknown as { user: unknown }).user }))
  await app.ready()
  return app
}

const sign = (payload: object, secret = process.env.JWT_SECRET!) => jwt.sign(payload, secret, { expiresIn: 60 })

test('a token WITH a role is accepted and the role is kept', async () => {
  const app = await build()
  const r = await app.inject({ url: '/whoami', headers: { authorization: `Bearer ${sign({ userId: 'u1', role: 'fleet_owner', type: 'access' })}` } })
  assert.equal(r.statusCode, 200)
  assert.deepEqual(r.json().user, { userId: 'u1', role: 'fleet_owner' })
})

test('a valid token WITHOUT a role is accepted (the Live Fleet sign-out bug)', async () => {
  const app = await build()
  const r = await app.inject({ url: '/whoami', headers: { authorization: `Bearer ${sign({ userId: 'u2', type: 'access' })}` } })
  assert.equal(r.statusCode, 200)
  assert.equal(r.json().user.userId, 'u2')
})

test('a token without a userId is still refused', async () => {
  const app = await build()
  const r = await app.inject({ url: '/whoami', headers: { authorization: `Bearer ${sign({ role: 'shipper' })}` } })
  assert.equal(r.statusCode, 401)
})

test('a token signed with the wrong secret is still refused', async () => {
  const app = await build()
  const r = await app.inject({ url: '/whoami', headers: { authorization: `Bearer ${sign({ userId: 'u3', role: 'shipper' }, 'other-secret')}` } })
  assert.equal(r.statusCode, 401)
})

test('no bearer token is refused', async () => {
  const app = await build()
  const r = await app.inject({ url: '/whoami' })
  assert.equal(r.statusCode, 401)
})
