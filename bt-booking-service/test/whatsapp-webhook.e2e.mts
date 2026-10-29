/**
 * The WhatsApp bot end to end: the real webhook route (signed Meta payloads), the real
 * service and repository against an in-memory Supabase, a recording sender, and the alert
 * path from the sweep through the outbox to the Cloud API. Pins:
 *
 *   1. Only Meta gets in: the verify handshake, the signature check, 503 when unconfigured.
 *   2. Anyone can start: a number on no account gets the welcome; so does an unclaimed
 *      receiver record. A matched number gets its own menu, alerts and trips — never
 *      anyone else's, and trips never carry money.
 *   3. Opt-in is recorded on the first menu; STOP / START work; photos are refused.
 *   4. Each message is answered once; a flood is rate-limited; a missing table or a failed
 *      lookup degrades to a reply, never a 500.
 *   5. Alerts: queued only for opted-in numbers, once per episode; sent as text inside the
 *      24-hour window, as the approved template outside it, skipped without one; retried
 *      on a temporary failure; never after STOP. The alert sweep feeds this path.
 *
 * Run: npx tsx test/whatsapp-webhook.e2e.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'
process.env.INTERNAL_SERVICE_SECRET = 'internal-secret-for-tests'
const WA_ENV = {
  WHATSAPP_ACCESS_TOKEN: 'test-access-token',
  WHATSAPP_PHONE_NUMBER_ID: 'PNID',
  WHATSAPP_APP_SECRET: 'wa-app-secret-for-tests',
  WHATSAPP_VERIFY_TOKEN: 'verify-me',
}
Object.assign(process.env, WA_ENV)
process.env.SHIPPER_APP_BASE_URL = 'https://www.bharattruck.net'
process.env.SUPPORT_EMAIL = 'help@bharattruck.test'

import Fastify from 'fastify'
import { createHmac } from 'node:crypto'
import { createChecker, createFakeSupabase } from './support/fake-supabase.mts'

const { check, finish } = createChecker()
const fake = createFakeSupabase()

const U_SHIP = '30000000-0000-4000-8000-000000000003'
const U_DRIVER = '20000000-0000-4000-8000-000000000002'
const U_OWNER = '10000000-0000-4000-8000-000000000001'
const U_RECV = '50000000-0000-4000-8000-000000000005'
const U_NOPHONE = '60000000-0000-4000-8000-000000000006'
const D_HIRED = 'd0000000-0000-4000-8000-000000000002'
const FO = 'f0000000-0000-4000-8000-000000000001'
const B_MOVING = 'b0000000-0000-4000-8000-000000000001'
const B_NEXT = 'b0000000-0000-4000-8000-000000000002'
const B_DONE = 'b0000000-0000-4000-8000-000000000003'

const WA_SHIP = '919876543210'
const WA_DRIVER = '919876500001'
const WA_RECV = '919876500002'
const WA_OWNER = '919876500003'
const WA_NEW = '919999900000'

const DAY = 86_400_000
let clock = new Date('2026-10-22T06:00:00Z')
const ago = (ms: number) => new Date(clock.getTime() - ms).toISOString()

function seed() {
  fake.reset()
  const s = fake.store
  s.users = [
    { id: U_SHIP, full_name: 'Anita Exports', email: 'anita@ex.in', role: 'shipper', phone_number: '9876543210', claimed_at: ago(90 * DAY) },
    { id: U_DRIVER, full_name: 'Ravi Kumar', email: 'ravi@ex.in', role: 'driver', phone_number: '+91 98765 00001', claimed_at: ago(90 * DAY) },
    { id: U_OWNER, full_name: 'Sharma Roadlines', email: 'owner@ex.in', role: 'fleet_owner', phone_number: '9876500003', claimed_at: ago(90 * DAY) },
    { id: U_RECV, full_name: 'Receiver At Nagpur', email: null, role: 'shipper', phone_number: '9876500002', claimed_at: null },
    { id: U_NOPHONE, full_name: 'No Phone', email: 'nophone@ex.in', role: 'shipper', phone_number: null, claimed_at: ago(DAY) },
  ]
  s.drivers = [{ id: D_HIRED, user_id: U_DRIVER, user: { full_name: 'Ravi Kumar' } }]
  s.fleet_owners = [{ id: FO, user_id: U_OWNER, company_name: 'Sharma Roadlines', is_active: true }]
  s.fleet_drivers = [{ id: 'fd-1', fleet_owner_id: FO, driver_id: D_HIRED, status: 'active', responded_at: ago(30 * DAY), updated_at: ago(30 * DAY) }]
  s.vehicles = [{ id: 'v-1', fleet_owner_id: FO, driver_id: null }, { id: 'v-2', fleet_owner_id: FO, driver_id: null }]
  const base = { shipper_id: U_SHIP, fleet_owner_id: FO, driver_id: D_HIRED, quoted_price: 48000, final_price: 52000, receiver_email: 'r@acme.in', created_at: ago(20 * DAY) }
  s.bookings = [
    { ...base, id: B_MOVING, status: 'in_transit', source_address: 'Andheri East, Mumbai, Maharashtra 400069, India', destination_address: 'Nagpur', pickup_date: '2026-10-21', updated_at: ago(3600_000) },
    { ...base, id: B_NEXT, status: 'accepted', source_address: 'Pune', destination_address: 'Ahmedabad', pickup_date: '2026-10-24', updated_at: ago(DAY) },
    { ...base, id: B_DONE, status: 'completed', source_address: 'Mumbai', destination_address: 'Nagpur', pickup_date: '2026-10-10', updated_at: ago(8 * DAY) },
  ]
  s.alerts = [
    { id: 'a-1', audience_user_id: U_SHIP, persona: 'shipper', kind: 'unpaid_overdue', severity: 'critical', subject_type: 'booking', subject_id: B_DONE,
      title: 'Payment due: ₹52,000 for Mumbai → Nagpur', detail: { subtitle: 'Delivered 8 days ago — record the payment to close the trip.' },
      dedupe_key: `unpaid_overdue:${B_DONE}:${U_SHIP}`, opened_at: ago(DAY), last_seen_at: ago(0), acknowledged_at: null, resolved_at: null },
    { id: 'a-2', audience_user_id: U_DRIVER, persona: 'driver', kind: 'gps_silent', severity: 'warning', subject_type: 'booking', subject_id: B_MOVING,
      title: 'No GPS from your trip for 30 min', detail: { subtitle: 'Mumbai → Nagpur · open the trip so your location updates.' },
      dedupe_key: `gps_silent:${B_MOVING}:${U_DRIVER}`, opened_at: ago(1800_000), last_seen_at: ago(0), acknowledged_at: null, resolved_at: null },
    { id: 'a-3', audience_user_id: U_SHIP, persona: 'shipper', kind: 'trip_not_started', severity: 'warning', subject_type: 'booking', subject_id: B_NEXT,
      title: 'An old, resolved alert', detail: { subtitle: '' }, dedupe_key: 'old', opened_at: ago(5 * DAY), last_seen_at: ago(4 * DAY), acknowledged_at: null, resolved_at: ago(4 * DAY) },
  ]
  s.whatsapp_contacts = []
  s.whatsapp_outbox = []
  s.notification_outbox = []
}

type Sent = { type: string; to: string; body?: string; buttons?: Array<{ id: string; title: string }>; name?: string; params?: string[] }

async function main() {
  const { __setSupabaseClientForTests } = await import('../src/lib/supabase.js')
  __setSupabaseClientForTests(fake.client as any)
  const { whatsappRoutes } = await import('../src/routes/whatsapp.js')
  const { memoryGuard } = await import('../src/lib/whatsapp/guard.js')
  const { BUTTON } = await import('../src/lib/whatsapp/bot.js')
  const { WhatsAppSendError } = await import('../src/lib/whatsapp/client.js')
  const { queueAlertMessage, dispatchWhatsAppOnce } = await import('../src/lib/whatsapp/service.js')
  const { resolveWhatsAppConfig } = await import('../src/lib/whatsapp/config.js')
  const internalAuthPlugin = (await import('../src/plugins/internal-auth.js')).default
  const { internalRoutes } = await import('../src/routes/internal.js')

  const sent: Sent[] = []
  let failNext: null | 'temporary' | 'permanent' = null
  const sender = {
    async send(m: Sent) {
      if (failNext) {
        const kind = failNext
        failNext = null
        throw new WhatsAppSendError(kind === 'temporary' ? 'WhatsApp send refused: rate limited' : 'WhatsApp send refused: template missing', kind === 'temporary' ? 429 : 400, kind === 'temporary')
      }
      sent.push(m)
      return { id: `wamid.out.${sent.length}` }
    },
  }
  let guard = memoryGuard(() => clock.getTime())
  const guardProxy = { once: (k: string, t: number) => guard.once(k, t), allow: (k: string, m: number, w: number) => guard.allow(k, m, w) }

  const app = Fastify({ logger: false })
  await app.register(whatsappRoutes, { prefix: '/whatsapp', sender: sender as any, guard: guardProxy, now: () => clock })
  await app.register(async (a) => { await a.register(internalAuthPlugin); await a.register(internalRoutes, { prefix: '/internal' }) })
  await app.ready()

  let seq = 0
  const envelope = (from: string, message: Record<string, unknown>, id?: string) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { phone_number_id: 'PNID' },
      contacts: [{ wa_id: from, profile: { name: 'Someone' } }],
      messages: [{ id: id ?? `wamid.in.${++seq}`, from, timestamp: '1', ...message }],
    } }] }],
  })
  const sign = (raw: string, secret = WA_ENV.WHATSAPP_APP_SECRET) => 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')
  const post = (payload: unknown, opts: { signed?: boolean; secret?: string } = {}) => {
    const raw = JSON.stringify(payload)
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (opts.signed !== false) headers['x-hub-signature-256'] = sign(raw, opts.secret)
    return app.inject({ method: 'POST', url: '/whatsapp/webhook', headers, payload: raw })
  }
  const say = (from: string, text: string, id?: string) => post(envelope(from, { type: 'text', text: { body: text } }, id))
  const tap = (from: string, buttonId: string) => post(envelope(from, { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: buttonId, title: 'x' } } }))
  const last = (to: string) => sent.filter((m) => m.to === to).at(-1)
  const contact = (wa: string) => fake.store.whatsapp_contacts.find((c) => c.wa_id === wa)

  // ── 1. Only Meta gets in ──────────────────────────────────────────────────
  console.log('\n── only Meta gets in')
  seed()
  const verify = await app.inject({ method: 'GET', url: '/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345' })
  check('the verify handshake echoes the challenge', verify.statusCode === 200 && verify.body === '12345', verify.body)
  check('a wrong verify token is refused', (await app.inject({ method: 'GET', url: '/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1' })).statusCode === 403)
  check('an unsigned message is refused', (await post(envelope(WA_NEW, { type: 'text', text: { body: 'hi' } }), { signed: false })).statusCode === 401)
  check('a message signed with another secret is refused', (await post(envelope(WA_NEW, { type: 'text', text: { body: 'hi' } }), { secret: 'not-ours' })).statusCode === 401)
  check('...and neither was answered', sent.length === 0)
  const badJson = '{"object":'
  check('broken JSON with a valid signature is a 400', (await app.inject({ method: 'POST', url: '/whatsapp/webhook', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(badJson) }, payload: badJson })).statusCode === 400)
  delete process.env.WHATSAPP_APP_SECRET
  check('unconfigured: the webhook answers 503 to both calls', (await say(WA_NEW, 'hi')).statusCode === 503
    && (await app.inject({ method: 'GET', url: '/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1' })).statusCode === 503)
  process.env.WHATSAPP_APP_SECRET = WA_ENV.WHATSAPP_APP_SECRET

  // ── 2. Anyone can start ───────────────────────────────────────────────────
  console.log('\n── anyone can start')
  seed()
  const r = await say(WA_NEW, 'hi')
  check('the webhook answers 200 and counts the reply', r.statusCode === 200 && JSON.parse(r.body).data.answered === 1, r.body)
  const welcome = last(WA_NEW)
  check('a number on no account gets the welcome and three ways in', welcome?.type === 'buttons' && /Welcome to BharatTruck/.test(welcome.body!) && welcome.buttons!.length === 3)
  check('...its contact is noted, with no account and no alert opt-in', contact(WA_NEW)?.user_id === null && !contact(WA_NEW)?.alerts_opt_in_at)
  await say(WA_RECV, 'hello')
  check('an unclaimed receiver record is not an account to act as: welcome, not a greeting by name', /Welcome to BharatTruck/.test(last(WA_RECV)!.body!) && !/Receiver/.test(last(WA_RECV)!.body!))
  await say(WA_NEW, 'alerts')
  check('a newcomer asking for alerts gets the welcome, not data', /Welcome to BharatTruck/.test(last(WA_NEW)!.body!))
  await tap(WA_NEW, BUTTON.ship)
  check('“Ship a load” links to Post a load', last(WA_NEW)!.body!.includes('https://www.bharattruck.net/post'))

  // ── 3. A matched person: menu, opt-in, alerts, trips ──────────────────────
  console.log('\n── a matched person gets their own menu, alerts and trips')
  await say(WA_SHIP, 'Hello')
  const firstMenu = last(WA_SHIP)!
  check('greeted by name, with the alerts notice on the first menu', firstMenu.type === 'buttons' && firstMenu.body!.startsWith('Hi Anita!') && /STOP/.test(firstMenu.body!), firstMenu.body)
  check('...and the opt-in is recorded', !!contact(WA_SHIP)?.alerts_opt_in_at && contact(WA_SHIP)?.user_id === U_SHIP)
  await say(WA_SHIP, 'hi')
  check('the notice is not repeated', !/STOP/.test(last(WA_SHIP)!.body!))
  await tap(WA_SHIP, BUTTON.alerts)
  const shipAlerts = last(WA_SHIP)!.body!
  check('“My alerts” lists the person’s open alerts, most urgent first', shipAlerts.startsWith('Your open alerts') && shipAlerts.includes('🔴 Payment due'), shipAlerts)
  check('...links the payment alert to the load’s Payment tab', shipAlerts.includes(`/loads/${B_DONE}?tab=payment`))
  check('...and leaves resolved alerts and other people’s alerts out', !shipAlerts.includes('old, resolved') && !shipAlerts.includes('No GPS'))
  await tap(WA_SHIP, BUTTON.trips)
  const shipTrips = last(WA_SHIP)!.body!
  check('“My trips” shows the live trips, moving first', shipTrips.indexOf('On the way') < shipTrips.indexOf('Truck assigned') && shipTrips.includes('pickup 2026-10-24'), shipTrips)
  check('...each linking to the load', shipTrips.includes(`/loads/${B_MOVING}`) && shipTrips.includes(`/loads/${B_NEXT}`))
  check('...with no prices at all, and no finished trips', !/₹|48000|52000|48,000|52,000/.test(shipTrips) && !shipTrips.includes(B_DONE))

  await say(WA_DRIVER, 'hi')
  check('a number stored as “+91 98765 00001” still matches its driver', last(WA_DRIVER)!.body!.startsWith('Hi Ravi!'))
  await tap(WA_DRIVER, BUTTON.trips)
  const driverTrips = last(WA_DRIVER)!.body!
  check('a hired driver’s trips link to their trip page and carry no money', driverTrips.includes(`/my-trips/${B_MOVING}`) && !/₹|52,000|48,000/.test(driverTrips), driverTrips)
  await tap(WA_DRIVER, BUTTON.alerts)
  const driverAlerts = last(WA_DRIVER)!.body!
  check('a hired driver sees their own alert, without money', driverAlerts.includes('No GPS from your trip') && !/₹/.test(driverAlerts) && !driverAlerts.includes('Payment due'))
  await say(WA_OWNER, 'hi')
  await tap(WA_OWNER, BUTTON.trips)
  check('a fleet owner’s trips link to the fleet board', last(WA_OWNER)!.body!.includes('https://www.bharattruck.net/trips'))

  await post(envelope(WA_SHIP, { type: 'document', document: { id: 'pan-card-scan' } }))
  check('a document sent to the bot is refused, with the app link', /don’t send documents/.test(last(WA_SHIP)!.body!) && last(WA_SHIP)!.body!.includes('bharattruck.net'))
  await tap(WA_SHIP, BUTTON.help)
  check('Help shows the support email', last(WA_SHIP)!.body!.includes('help@bharattruck.test'))

  // ── 4. STOP / START ───────────────────────────────────────────────────────
  console.log('\n── STOP and START')
  await say(WA_SHIP, 'STOP')
  check('STOP is confirmed and recorded', /START/.test(last(WA_SHIP)!.body!) && !!contact(WA_SHIP)?.opted_out_at)
  check('...and no alert is queued while stopped', (await queueAlertMessage(fake.store.alerts[0] as any, 'ep-stop', undefined, { now: clock })) === 'opted_out')
  await say(WA_SHIP, 'start')
  check('START turns alerts back on', /back on/.test(last(WA_SHIP)!.body!) && !contact(WA_SHIP)?.opted_out_at && !!contact(WA_SHIP)?.alerts_opt_in_at)

  // ── 5. Robustness ─────────────────────────────────────────────────────────
  console.log('\n── answered once; floods, missing tables and failures degrade')
  const before = sent.length
  const d1 = await say(WA_NEW, 'hi', 'wamid.same')
  const d2 = await say(WA_NEW, 'hi', 'wamid.same')
  check('Meta resending a message gets one answer', sent.length === before + 1 && JSON.parse(d2.body).data.duplicates === 1, `${d1.body} ${d2.body}`)
  guard = memoryGuard(() => clock.getTime())
  const flood = []
  for (let i = 0; i < 21; i++) flood.push(JSON.parse((await say(WA_NEW, `msg ${i}`)).body).data)
  check('the 21st message in a minute from one number is not answered', flood.slice(0, 20).every((x) => x.answered === 1) && flood[20].rate_limited === 1)
  guard = memoryGuard(() => clock.getTime())

  fake.missing.add('whatsapp_contacts')
  const noTable = await say(WA_SHIP, 'hi')
  check('before migration 0043 the bot still answers', noTable.statusCode === 200 && last(WA_SHIP)!.body!.startsWith('Hi Anita!'))
  fake.missing.delete('whatsapp_contacts')
  fake.failing.add('users')
  await say(WA_SHIP, 'hi')
  check('a failed account lookup gets an apology, not silence or a 500', /couldn’t look that up/.test(last(WA_SHIP)!.body!))
  fake.failing.clear()

  // ── 6. Alerts: queue ──────────────────────────────────────────────────────
  console.log('\n── alerts are queued only for opted-in numbers')
  seed()
  const alert = fake.store.alerts[0] as any
  check('unconfigured: nothing is queued', (await queueAlertMessage(alert, 'ep1', undefined, { env: {} })) === 'not_configured')
  check('an account with no phone: nothing is queued', (await queueAlertMessage({ ...alert, audience_user_id: U_NOPHONE }, 'ep1', undefined, { now: clock })) === 'no_phone')
  check('a number that never messaged the bot: nothing is queued', (await queueAlertMessage({ ...alert, audience_user_id: U_OWNER }, 'ep1', undefined, { now: clock })) === 'not_opted_in')
  await say(WA_SHIP, 'hi')
  check('an opted-in number: queued', (await queueAlertMessage(alert, 'ep1', undefined, { now: clock })) === 'queued')
  check('...once per episode', (await queueAlertMessage(alert, 'ep1', undefined, { now: clock })) === 'duplicate' && fake.store.whatsapp_outbox.length === 1)
  const row = fake.store.whatsapp_outbox[0]
  check('the message names the alert and links to where to act', row.body_text.includes('Payment due') && row.body_text.includes(`/loads/${B_DONE}?tab=payment`) && /STOP/.test(row.body_text))
  check('...and carries the three template variables', row.template_params.length === 3 && row.template_params[2].includes('/loads/'))

  // ── 7. Alerts: send ───────────────────────────────────────────────────────
  console.log('\n── alerts go out as text inside the 24-hour window, as the template outside it')
  const cfg = resolveWhatsAppConfig().config!
  sent.length = 0
  let res = await dispatchWhatsAppOnce({ config: cfg, sender: sender as any, now: () => clock })
  check('inside the window: sent as plain text', res.sent === 1 && sent[0].type === 'text' && sent[0].to === WA_SHIP && sent[0].body!.includes('Payment due'), JSON.stringify(res))
  check('...and marked sent with Meta’s id', fake.store.whatsapp_outbox[0].status === 'sent' && fake.store.whatsapp_outbox[0].provider_message_id === 'wamid.out.1')
  check('a second drain sends nothing', (await dispatchWhatsAppOnce({ config: cfg, sender: sender as any, now: () => clock })).claimed === 0)

  clock = new Date(clock.getTime() + 25 * 3600_000)
  await queueAlertMessage(alert, 'ep2', undefined, { now: clock })
  res = await dispatchWhatsAppOnce({ config: cfg, sender: sender as any, now: () => clock })
  check('outside the window with no template: skipped, and it says why', res.skipped === 1 && /no alert template/.test(fake.store.whatsapp_outbox[1].last_error))
  await queueAlertMessage(alert, 'ep3', undefined, { now: clock })
  res = await dispatchWhatsAppOnce({ config: { ...cfg, alertTemplate: 'bt_alert' }, sender: sender as any, now: () => clock })
  const tmpl = sent.at(-1)!
  check('outside the window with a template: sent as the template', res.sent === 1 && tmpl.type === 'template' && tmpl.name === 'bt_alert' && tmpl.params!.length === 3)

  await queueAlertMessage(alert, 'ep4', undefined, { now: clock })
  failNext = 'temporary'
  res = await dispatchWhatsAppOnce({ config: { ...cfg, alertTemplate: 'bt_alert' }, sender: sender as any, now: () => clock })
  const retryRow = fake.store.whatsapp_outbox.find((x) => x.dedupe_key.endsWith(':ep4'))!
  check('a temporary failure is retried later', res.failed === 1 && retryRow.status === 'pending' && retryRow.attempts === 1 && retryRow.next_attempt_at > clock.toISOString())
  await queueAlertMessage(alert, 'ep5', undefined, { now: clock })
  failNext = 'permanent'
  await dispatchWhatsAppOnce({ config: { ...cfg, alertTemplate: 'bt_alert' }, sender: sender as any, now: () => clock })
  check('a permanent refusal is not retried', fake.store.whatsapp_outbox.find((x) => x.dedupe_key.endsWith(':ep5'))!.status === 'failed')

  await queueAlertMessage(alert, 'ep6', undefined, { now: clock })
  fake.store.whatsapp_contacts.find((c) => c.wa_id === WA_SHIP)!.opted_out_at = clock.toISOString()
  clock = new Date(clock.getTime() + 2 * 3600_000)
  await dispatchWhatsAppOnce({ config: { ...cfg, alertTemplate: 'bt_alert' }, sender: sender as any, now: () => clock })
  check('STOP after an alert was queued: it is skipped', fake.store.whatsapp_outbox.find((x) => x.dedupe_key.endsWith(':ep6'))!.status === 'skipped')

  // ── 8. The sweep feeds it; the internal route is gated ────────────────────
  console.log('\n── the alert sweep queues WhatsApp; the dispatch route is internal-only')
  seed()
  fake.store.alerts = []
  await say(WA_SHIP, 'hi')
  const sweep = await app.inject({ method: 'POST', url: '/internal/alerts/sweep?cadence=daily', headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET! } })
  const sr = JSON.parse(sweep.body).data
  check('a daily sweep with an 8-day unpaid trip queues it for the opted-in shipper', sweep.statusCode === 200 && sr.whatsapp_queued === 1
    && fake.store.whatsapp_outbox.some((x) => x.wa_id === WA_SHIP && x.body_text.includes('Payment due')), sweep.body)
  check('...and only for them (the fleet owner never messaged the bot)', fake.store.whatsapp_outbox.every((x) => x.wa_id === WA_SHIP))
  check('the dispatch route needs the internal secret', (await app.inject({ method: 'POST', url: '/internal/whatsapp/dispatch', headers: { 'x-internal-secret': 'wrong' } })).statusCode === 401)
  delete process.env.WHATSAPP_ACCESS_TOKEN
  const off = await app.inject({ method: 'POST', url: '/internal/whatsapp/dispatch', headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET! } })
  check('unconfigured, it answers 503 and names what is missing', off.statusCode === 503 && /WHATSAPP_ACCESS_TOKEN/.test(off.body))
  process.env.WHATSAPP_ACCESS_TOKEN = WA_ENV.WHATSAPP_ACCESS_TOKEN

  await app.close()
  finish()
}
main().catch((err) => { console.error(err); process.exit(1) })
