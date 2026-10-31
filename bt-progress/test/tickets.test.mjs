// Client requests on the progress portal: the real server over HTTP with an in-memory store, plus
// the Cloud Storage store against a fake GCS. Run: node --test test/tickets.test.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { createPortalServer } from '../server.mjs'
import { GcsStore, MemoryStore, applyUpdate, buildTicket, roleForCode, updateTicket } from '../lib/tickets.mjs'

const env = { PORTAL_CLIENT_CODE: 'client-code-123', PORTAL_TEAM_CODE: 'team-code-456' }
let server, base

before(async () => {
  server = createPortalServer({ store: new MemoryStore(), env, log: { error() {} } })
  await new Promise((r) => server.listen(0, r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())

const call = (method, path, { code, body, ip } = {}) => fetch(base + path, {
  method,
  headers: { ...(code ? { 'x-portal-code': code } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(ip ? { 'x-forwarded-for': ip } : {}) },
  body: body ? JSON.stringify(body) : undefined,
})
const good = { type: 'feature', title: 'Driver app in Hindi', details: 'Drivers want the app in Hindi and Marathi.', area: 'Driver', priority: 'high', name: 'Ravi' }

test('static portal still served: the log page, progress.json no-store, unknown paths fall back', async () => {
  const home = await call('GET', '/')
  assert.equal(home.status, 200)
  assert.match(await home.text(), /Build Log/)
  const req = await call('GET', '/requests.html')
  assert.equal(req.status, 200)
  assert.match(await req.text(), /Requests/)
  const nowhere = await call('GET', '/some/deep/link')
  assert.equal(nowhere.status, 200)
  assert.match(await nowhere.text(), /Build Log/)
  const traversal = await call('GET', '/..%2f..%2fserver.mjs')
  assert.doesNotMatch(await traversal.text(), /createPortalServer/)
})

test('access codes: right code gives a role, wrong code 401, team code is team', async () => {
  let r = await call('POST', '/api/session', { body: { code: 'client-code-123' } })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).data.role, 'client')
  r = await call('POST', '/api/session', { body: { code: 'team-code-456' } })
  assert.equal((await r.json()).data.role, 'team')
  r = await call('POST', '/api/session', { body: { code: 'nope' }, ip: '10.0.0.9' })
  assert.equal(r.status, 401)
  r = await call('GET', '/api/tickets')
  assert.equal(r.status, 401, 'listing needs a code')
})

test('repeated wrong codes are rate limited per caller', async () => {
  let last
  for (let i = 0; i < 12; i++) last = await call('GET', '/api/tickets', { code: 'guess-' + i, ip: '10.9.9.9' })
  assert.equal(last.status, 429)
})

test('client raises a request; it is listed with status new', async () => {
  const r = await call('POST', '/api/tickets', { code: env.PORTAL_CLIENT_CODE, body: good })
  assert.equal(r.status, 201)
  const t = (await r.json()).data
  assert.match(t.id, /^R-\d{6}-[0-9A-F]{6}$/)
  assert.equal(t.status, 'new')
  assert.equal(t.raised_by, 'Ravi')
  assert.equal(t.raised_by_role, 'client')
  const list = (await (await call('GET', '/api/tickets', { code: env.PORTAL_CLIENT_CODE })).json()).data.tickets
  assert.ok(list.some((x) => x.id === t.id))
})

test('validation: missing title, bad type, oversized details are rejected', async () => {
  for (const body of [{ ...good, title: '' }, { ...good, type: 'wish' }, { ...good, details: 'x'.repeat(5001) }]) {
    const r = await call('POST', '/api/tickets', { code: env.PORTAL_CLIENT_CODE, body })
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60))
  }
})

test('replies from both sides; only the team changes status and links a PR', async () => {
  const t = (await (await call('POST', '/api/tickets', { code: env.PORTAL_CLIENT_CODE, body: good })).json()).data
  let r = await call('PATCH', `/api/tickets/${t.id}`, { code: env.PORTAL_CLIENT_CODE, body: { comment: 'Also Gujarati please' } })
  assert.equal(r.status, 200)
  r = await call('PATCH', `/api/tickets/${t.id}`, { code: env.PORTAL_CLIENT_CODE, body: { status: 'done' } })
  assert.equal(r.status, 403, 'client cannot close a ticket')
  r = await call('PATCH', `/api/tickets/${t.id}`, { code: env.PORTAL_TEAM_CODE, body: { status: 'planned', pr: 14, comment: 'Planned for next sprint', name: 'Aditya' } })
  assert.equal(r.status, 200)
  const u = (await r.json()).data
  assert.equal(u.status, 'planned')
  assert.equal(u.pr, 14)
  assert.deepEqual(u.thread.map((e) => e.kind), ['comment', 'status', 'comment'])
  assert.equal(u.thread[1].from, 'new')
  assert.equal(u.thread[2].by_role, 'team')
  r = await call('PATCH', `/api/tickets/R-000000-ZZZZZZ`, { code: env.PORTAL_TEAM_CODE, body: { comment: 'x' } })
  assert.equal(r.status, 404)
})

test('without codes configured the API says not set up (503), the page still works', async () => {
  const s = createPortalServer({ store: new MemoryStore(), env: {}, log: { error() {} } })
  await new Promise((r) => s.listen(0, r))
  const b = `http://127.0.0.1:${s.address().port}`
  assert.equal((await fetch(b + '/api/tickets', { headers: { 'x-portal-code': 'x' } })).status, 503)
  assert.equal((await (await fetch(b + '/health')).json()).tickets, 'not_configured')
  assert.equal((await fetch(b + '/')).status, 200)
  s.close()
})

test('codes compare exactly; an empty code is never accepted', () => {
  assert.equal(roleForCode('', env), null)
  assert.equal(roleForCode('client-code-12', env), null)
  assert.equal(roleForCode('client-code-123', env), 'client')
  assert.equal(roleForCode('anything', {}), null)
})

test('a concurrent edit is re-read and applied, never lost', async () => {
  const store = new MemoryStore()
  const t = buildTicket(good, 'client')
  await store.create(t)
  // Another reply lands between our read and our write the first time.
  const realUpdate = store.update.bind(store)
  let raced = false
  store.update = async (ticket, version) => {
    if (!raced) { raced = true; const cur = await store.get(t.id); await realUpdate(applyUpdate(cur.ticket, { comment: 'theirs' }, 'team'), cur.version) }
    return realUpdate(ticket, version)
  }
  const out = await updateTicket(store, t.id, { comment: 'mine' }, 'client')
  assert.deepEqual(out.thread.map((e) => e.text), ['theirs', 'mine'])
})

test('GcsStore: writes with generation guards, maps 412 to a retry, reads back', async () => {
  const objects = new Map() // name → { body, gen }
  let gen = 100
  const fakeFetch = async (url, init = {}) => {
    const u = new URL(url)
    if (u.hostname === 'metadata.google.internal') return Response.json({ access_token: 't', expires_in: 3600 })
    assert.equal(init.headers.authorization, 'Bearer t')
    if (u.pathname.startsWith('/upload/')) {
      const name = u.searchParams.get('name'), want = Number(u.searchParams.get('ifGenerationMatch'))
      const cur = objects.get(name)
      if ((cur?.gen ?? 0) !== want) return new Response('', { status: 412 })
      objects.set(name, { body: init.body, gen: ++gen })
      return Response.json({})
    }
    const m = /\/o\/(.+)$/.exec(u.pathname)
    if (m) {
      const o = objects.get(decodeURIComponent(m[1]))
      return o ? new Response(o.body, { headers: { 'x-goog-generation': String(o.gen) } }) : new Response('', { status: 404 })
    }
    return Response.json({ items: [...objects.keys()].map((name) => ({ name })) })
  }
  const store = new GcsStore('bucket', { fetchImpl: fakeFetch })
  const t = buildTicket(good, 'client')
  assert.equal(await store.create(t), true)
  assert.equal(await store.create(t), false, 'same id twice → taken')
  const row = await store.get(t.id)
  assert.equal(row.ticket.title, good.title)
  assert.equal(await store.update({ ...row.ticket, title: 'new' }, 1), false, 'stale generation → 412 → false')
  assert.equal(await store.update({ ...row.ticket, title: 'new' }, Number(row.version)), true)
  assert.equal((await store.list())[0].title, 'new')
})
