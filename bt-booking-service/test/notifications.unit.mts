/**
 * Notification layer — templates, preferences, and the outbox dispatcher.
 *
 * Exercises the REAL dispatcher against an in-memory fake Supabase (the T-BE-1
 * injection seam) and a fake EmailSender, so retry/claim/dedupe behaviour is
 * asserted without a live Postgres or a mail server.
 *
 * Run: npx tsx test/notifications.unit.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'
process.env.SHIPPER_APP_BASE_URL = 'https://shipper.test'
process.env.DRIVER_APP_BASE_URL = 'https://driver.test'
process.env.NOTIFICATIONS_PUBLIC_BASE_URL = 'https://api.test'

import type { EmailMessage, EmailSender } from '@bharattruck/shared/notifications'

const U_SHIPPER = '11111111-1111-4111-8111-111111111111'
const B1 = '22222222-2222-4222-8222-222222222222'

// ── Minimal in-memory Supabase double ───────────────────────────────────────
// Supports the exact surface the notification code uses: select/insert/update with
// eq/in/lte/neq filters, order/limit, maybeSingle, and a unique constraint on
// notification_outbox.dedupe_key (the idempotency guard this suite has to prove).
type Row = Record<string, any>
const store: Record<string, Row[]> = {
  notification_outbox: [],
  notification_preferences: [],
  users: [{ id: U_SHIPPER, email: 'shipper@example.com', full_name: 'Test Shipper' }],
}

let idSeq = 0
const nextId = () => `row-${++idSeq}`

class FakeQuery {
  private filters: Array<['eq' | 'in' | 'lte' | 'neq', string, any]> = []
  private mode: 'select' | 'update' | 'insert' = 'select'
  private payload: Row | Row[] | null = null
  private limitN: number | null = null
  constructor(private table: string) {}

  select() { return this }
  insert(p: Row | Row[]) { this.mode = 'insert'; this.payload = p; return this }
  update(p: Row) { this.mode = 'update'; this.payload = p; return this }
  eq(c: string, v: any) { this.filters.push(['eq', c, v]); return this }
  neq(c: string, v: any) { this.filters.push(['neq', c, v]); return this }
  in(c: string, v: any[]) { this.filters.push(['in', c, v]); return this }
  lte(c: string, v: any) { this.filters.push(['lte', c, v]); return this }
  order() { return this }
  limit(n: number) { this.limitN = n; return this }

  private match(r: Row) {
    return this.filters.every(([op, c, v]) => {
      if (op === 'eq') return r[c] === v
      if (op === 'neq') return r[c] !== v
      if (op === 'in') return v.includes(r[c])
      return String(r[c] ?? '') <= String(v) // lte, ISO timestamps compare lexically
    })
  }

  private run() {
    const rows = store[this.table] ?? (store[this.table] = [])

    if (this.mode === 'insert') {
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload as Row]
      const created: Row[] = []
      for (const p of incoming) {
        // The unique index from migration 019 — the whole idempotency contract.
        if (this.table === 'notification_outbox' && rows.some(r => r.dedupe_key === p.dedupe_key)) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
        }
        if (this.table === 'notification_preferences' && rows.some(r => r.user_id === p.user_id)) {
          return { data: null, error: { code: '23505', message: 'duplicate key' } }
        }
        const row: Row = {
          id: nextId(),
          status: 'pending', attempts: 0, max_attempts: 5,
          next_attempt_at: new Date().toISOString(), created_at: new Date().toISOString(),
          ...(this.table === 'notification_preferences'
            ? { email_marketplace: true, email_trip_updates: true, email_digests: true,
                unsubscribe_token: `tok-${p.user_id}` }
            : {}),
          ...p,
        }
        rows.push(row); created.push(row)
      }
      return { data: created, error: null }
    }

    const hits = rows.filter(r => this.match(r))
    if (this.mode === 'update') {
      hits.forEach(r => Object.assign(r, this.payload))
      return { data: hits, error: null }
    }
    return { data: this.limitN ? hits.slice(0, this.limitN) : hits, error: null }
  }

  maybeSingle() { const { data, error } = this.run(); return Promise.resolve({ data: data?.length ? data[0] : null, error }) }
  single() { return this.maybeSingle() }
  then(f: (v: any) => any, r?: (e: any) => any) { return Promise.resolve(this.run()).then(f, r) }
}
const fakeSupabase = { from: (t: string) => new FakeQuery(t) }

// ── Harness ─────────────────────────────────────────────────────────────────
let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

class FakeSender implements EmailSender {
  sent: EmailMessage[] = []
  failTimes = 0
  async send(msg: EmailMessage): Promise<void> {
    if (this.failTimes > 0) { this.failTimes--; throw new Error('smtp unavailable') }
    this.sent.push(msg)
  }
}

const outbox = () => store.notification_outbox
const resetOutbox = () => { store.notification_outbox.length = 0; store.notification_preferences.length = 0 }
/** Make every queued row due now, undoing the claim lease. */
const makeAllDue = () => outbox().forEach(r => { r.next_attempt_at = new Date(Date.now() - 1000).toISOString() })

async function main() {
  const { __setServiceRoleClientForTests } = await import('@bharattruck/shared/db')
  __setServiceRoleClientForTests(fakeSupabase as any)

  const { enqueueNotification } = await import('@bharattruck/shared/notifications')
  const { renderNotification, isKnownEvent } = await import('../src/lib/notifications/templates.js')
  const { dispatchOnce } = await import('../src/lib/notifications/dispatcher.js')

  const ctx = {
    shipperBaseUrl: 'https://shipper.test',
    driverBaseUrl: 'https://driver.test',
    unsubscribeUrl: 'https://api.test/notifications/unsubscribe?token=abc',
  }

  // ── Templates ─────────────────────────────────────────────────────────────
  console.log('\n── templates')

  const awarded = renderNotification('quote_awarded', {
    booking_id: B1, source_address: 'Mumbai', destination_address: 'Delhi', amount: 36483,
  }, ctx)
  check('quote_awarded renders', !!awarded)
  check('formats INR with Indian grouping', !!awarded && awarded.subject.includes('36,483'),
    awarded?.subject)
  check('subject carries a short booking ref', !!awarded && awarded.subject.includes('22222222'))
  check('html and text are both populated',
    !!awarded && awarded.html.length > 0 && awarded.text.length > 0)
  check('deep-links into the driver app',
    !!awarded && awarded.html.includes('https://driver.test/bookings/' + B1))

  // Transactional mail must never offer an unsubscribe it will not honour.
  check('transactional event has NO unsubscribe footer',
    !!awarded && !awarded.html.includes('Unsubscribe') && !awarded.headers?.['List-Unsubscribe'])

  const received = renderNotification('quote_received', {
    booking_id: B1, source_address: 'Mumbai', destination_address: 'Delhi', amount: 40000,
  }, ctx)
  check('marketplace event HAS an unsubscribe footer',
    !!received && received.html.includes('Unsubscribe'))
  check('marketplace event sets List-Unsubscribe headers',
    received?.headers?.['List-Unsubscribe'] === `<${ctx.unsubscribeUrl}>` &&
    received?.headers?.['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click')

  // User-supplied text reaches the template; unescaped it could forge markup.
  const xss = renderNotification('quote_received', {
    booking_id: B1, source_address: 'Mumbai', destination_address: 'Delhi', amount: 100,
    bidder_name: '<script>alert(1)</script>', message: '<img src=x onerror=alert(1)>',
  }, ctx)
  // The property that matters is that payload content cannot OPEN a tag. The literal
  // substring `onerror=` surviving is fine and expected — inside escaped text it is
  // inert prose, not an attribute.
  check('payload content cannot open an HTML tag',
    !!xss && !xss.html.includes('<script') && !xss.html.includes('<img'),
    xss?.html.slice(0, 200))
  check('escaped content is still present, just inert',
    !!xss && xss.html.includes('&lt;script&gt;') && xss.html.includes('&lt;img'))

  const missing = renderNotification('quote_awarded', { booking_id: B1 }, ctx)
  check('missing payload fields degrade, never print "undefined"',
    !!missing && !missing.text.includes('undefined'), missing?.text.slice(0, 120))

  // ── Presentation ──────────────────────────────────────────────────────────
  // The inbox-level and at-a-glance affordances. Without the preheader every
  // BharatTruck email previews as the wordmark; without tone a cancellation and a
  // win look identical.
  check('emits a full HTML document (needed for the dark-mode + mobile <style>)',
    !!awarded && awarded.html.startsWith('<!doctype html>'))
  check('carries a preheader distinct from the subject',
    !!awarded && awarded.html.includes('is yours at') && !awarded.html.includes('>You won load'),
    awarded?.html.slice(0, 80))
  check('preheader is hidden from the opened message',
    !!awarded && awarded.html.includes('display:none;max-height:0;overflow:hidden;opacity:0'))
  check('declares dark-mode support so clients stop force-inverting',
    !!awarded && awarded.html.includes('name="color-scheme"') &&
    awarded.html.includes('prefers-color-scheme: dark'))

  const lost = renderNotification('quote_lost', {
    booking_id: B1, source_address: 'Mumbai', destination_address: 'Delhi',
  }, ctx)
  check('tone differentiates a loss from a win',
    !!lost && !!awarded && lost.html.includes('#b45309') && awarded.html.includes('#0f766e'))

  check('money events show the amount as a hero block',
    !!awarded && awarded.html.includes('Agreed price') && awarded.html.includes('font-size:26px'))
  check('button padding is on the <td>, not the <a> (Outlook drops the latter)',
    !!awarded && /bgcolor="#0f766e"[^>]*>\s*<a /.test(awarded.html.replace(/\n\s*/g, ' ')))

  const dated = renderNotification('quote_awarded', { ...{ booking_id: B1 }, pickup_date: '2026-08-04' }, ctx)
  check('renders a human date, with no stray comma before the year',
    !!dated && dated.text.includes('Tue, 4 Aug 2026'),
    dated?.text.match(/Pickup: .*/)?.[0])
  check('an unparseable date passes through rather than being guessed at',
    renderNotification('quote_awarded', { booking_id: B1, pickup_date: 'next week' }, ctx)!
      .text.includes('next week'))

  check('unknown event renders null (does not throw)',
    renderNotification('not_a_real_event', {}, ctx) === null)
  check('isKnownEvent agrees', isKnownEvent('quote_awarded') && !isKnownEvent('nope'))

  // ── Enqueue + idempotency ────────────────────────────────────────────────
  console.log('\n── enqueue')
  resetOutbox()

  await enqueueNotification({
    event: 'quote_awarded', to: 'driver@example.com',
    payload: { booking_id: B1, amount: 100 }, dedupeKey: 'quote_awarded:q1',
  })
  check('enqueue writes an outbox row', outbox().length === 1)
  check('row starts pending with 0 attempts',
    outbox()[0].status === 'pending' && outbox()[0].attempts === 0)

  await enqueueNotification({
    event: 'quote_awarded', to: 'driver@example.com',
    payload: { booking_id: B1, amount: 100 }, dedupeKey: 'quote_awarded:q1',
  })
  check('duplicate dedupe_key does not create a second row', outbox().length === 1)

  await enqueueNotification({
    event: 'quote_awarded', to: '', payload: {}, dedupeKey: 'quote_awarded:no-address',
  })
  check('empty recipient is skipped, not queued', outbox().length === 1)

  // An enqueue must never propagate a failure into the business operation.
  const broken = { from: () => { throw new Error('db down') } }
  __setServiceRoleClientForTests(broken as any)
  let threw = false
  try {
    await enqueueNotification({ event: 'quote_awarded', to: 'x@y.z', payload: {}, dedupeKey: 'boom' })
  } catch { threw = true }
  check('enqueue swallows DB failure (never fails the caller)', !threw)
  __setServiceRoleClientForTests(fakeSupabase as any)

  // ── Dispatch ─────────────────────────────────────────────────────────────
  console.log('\n── dispatch')
  resetOutbox()

  await enqueueNotification({
    event: 'quote_awarded', to: 'driver@example.com',
    payload: { booking_id: B1, source_address: 'Mumbai', destination_address: 'Delhi', amount: 500 },
    dedupeKey: 'd:1',
  })

  const sender = new FakeSender()
  let res = await dispatchOnce(sender, 25)
  check('dispatch sends the queued row', res.sent === 1 && sender.sent.length === 1)
  check('sends to the outbox row address', sender.sent[0].to === 'driver@example.com')
  check('row flips to sent with a timestamp',
    outbox()[0].status === 'sent' && !!outbox()[0].sent_at)

  res = await dispatchOnce(sender, 25)
  check('a sent row is never re-sent', res.claimed === 0 && sender.sent.length === 1)

  // ── Retry + dead-letter ──────────────────────────────────────────────────
  console.log('\n── retry and dead-letter')
  resetOutbox()

  await enqueueNotification({
    event: 'quote_awarded', to: 'flaky@example.com',
    payload: { booking_id: B1, amount: 1 }, dedupeKey: 'r:1',
  })

  const flaky = new FakeSender()
  flaky.failTimes = 1
  res = await dispatchOnce(flaky, 25)
  check('a failed send is not counted as sent', res.sent === 0 && res.failed === 1)
  check('failed row returns to pending for retry', outbox()[0].status === 'pending')
  check('failure records the error', String(outbox()[0].last_error).includes('smtp unavailable'))
  check('retry is backed off into the future',
    new Date(outbox()[0].next_attempt_at).getTime() > Date.now())

  makeAllDue()
  res = await dispatchOnce(flaky, 25)
  check('retry after backoff succeeds', res.sent === 1 && outbox()[0].status === 'sent')
  check('attempts accumulated across both tries', outbox()[0].attempts === 2)

  resetOutbox()
  await enqueueNotification({
    event: 'quote_awarded', to: 'dead@example.com',
    payload: { booking_id: B1, amount: 1 }, dedupeKey: 'dl:1',
  })
  const alwaysFails = new FakeSender()
  alwaysFails.failTimes = 99
  for (let i = 0; i < 5; i++) { makeAllDue(); await dispatchOnce(alwaysFails, 25) }
  check('dead-letters after max_attempts', outbox()[0].status === 'failed', outbox()[0].status)
  check('does not exceed max_attempts', outbox()[0].attempts === 5, String(outbox()[0].attempts))

  makeAllDue()
  res = await dispatchOnce(alwaysFails, 25)
  check('a dead-lettered row is not retried', res.claimed === 0)

  // ── Unknown event ────────────────────────────────────────────────────────
  console.log('\n── unknown event')
  resetOutbox()
  await enqueueNotification({
    event: 'some_future_event' as any, to: 'x@example.com', payload: {}, dedupeKey: 'u:1',
  })
  const s2 = new FakeSender()
  res = await dispatchOnce(s2, 25)
  check('unknown event does not crash the drain', res.failed === 1 && s2.sent.length === 0)
  check('unknown event stays retryable (producer may deploy first)',
    outbox()[0].status === 'pending')
  check('unknown event records a useful reason',
    String(outbox()[0].last_error).includes('no template registered'))

  // One bad row must not stop the rest of the batch.
  resetOutbox()
  await enqueueNotification({ event: 'nope' as any, to: 'a@b.c', payload: {}, dedupeKey: 'mix:1' })
  await enqueueNotification({
    event: 'quote_awarded', to: 'good@example.com',
    payload: { booking_id: B1, amount: 9 }, dedupeKey: 'mix:2',
  })
  const s3 = new FakeSender()
  res = await dispatchOnce(s3, 25)
  check('a bad row does not block the rest of the batch',
    res.sent === 1 && s3.sent[0].to === 'good@example.com')

  // ── Preferences ──────────────────────────────────────────────────────────
  console.log('\n── preferences')
  resetOutbox()

  store.notification_preferences.push({
    user_id: U_SHIPPER, email_marketplace: false, email_trip_updates: true,
    email_digests: true, unsubscribe_token: 'tok-1',
  })

  await enqueueNotification({
    event: 'quote_received', to: 'shipper@example.com', userId: U_SHIPPER,
    payload: { booking_id: B1, amount: 1 }, dedupeKey: 'p:muted',
  })
  await enqueueNotification({
    event: 'payment_settled', to: 'shipper@example.com', userId: U_SHIPPER,
    payload: { booking_id: B1, amount: 1 }, dedupeKey: 'p:transactional',
  })

  const s4 = new FakeSender()
  res = await dispatchOnce(s4, 25)
  check('muted marketplace mail is skipped', res.skipped === 1)
  check('transactional mail ignores the opt-out', res.sent === 1)
  check('the one that sent is the receipt',
    s4.sent.length === 1 && s4.sent[0].subject.includes('Payment receipt'), s4.sent[0]?.subject)
  check('skipped row is recorded as skipped, not failed',
    outbox().find(r => r.dedupe_key === 'p:muted')?.status === 'skipped')

  // A recipient with no account (a consignee) has no preferences to honour.
  resetOutbox()
  await enqueueNotification({
    event: 'quote_received', to: 'consignee@example.com',
    payload: { booking_id: B1, amount: 1 }, dedupeKey: 'p:noaccount',
  })
  const s5 = new FakeSender()
  res = await dispatchOnce(s5, 25)
  check('accountless recipient still receives optional mail', res.sent === 1)

  // ── Production SMTP guard ────────────────────────────────────────────────
  // The queue must never be drained into the console sender in production: every
  // row would be claimed, "sent" to stdout and marked sent, silently destroying
  // notifications nobody received.
  console.log('\n── production SMTP guard')
  const { dispatchBlockedReason } = await import('../src/lib/notifications/dispatcher.js')

  const restoreEnv = { NODE_ENV: process.env.NODE_ENV, SMTP_USER: process.env.SMTP_USER, EMAIL_DEV_MODE: process.env.EMAIL_DEV_MODE }

  process.env.NODE_ENV = 'development'; delete process.env.SMTP_USER
  check('dev without SMTP is allowed to drain (console logging is the point)',
    dispatchBlockedReason() === null)

  process.env.NODE_ENV = 'production'; delete process.env.SMTP_USER
  check('production without SMTP is BLOCKED', dispatchBlockedReason() !== null)
  check('the block explains itself',
    (dispatchBlockedReason() ?? '').includes('SMTP is not configured'))

  process.env.SMTP_USER = 'ops@example.com'; delete process.env.EMAIL_DEV_MODE
  check('production with SMTP drains normally', dispatchBlockedReason() === null)

  process.env.EMAIL_DEV_MODE = 'true'
  check('EMAIL_DEV_MODE=true in production is also blocked', dispatchBlockedReason() !== null)

  Object.assign(process.env, restoreEnv)
  if (restoreEnv.SMTP_USER === undefined) delete process.env.SMTP_USER
  if (restoreEnv.EMAIL_DEV_MODE === undefined) delete process.env.EMAIL_DEV_MODE

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log(`  - ${f}`)); process.exit(1) }
}

main().catch(err => { console.error(err); process.exit(1) })
