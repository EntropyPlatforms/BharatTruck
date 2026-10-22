/**
 * The WhatsApp bot's pure parts: Meta's signature check, webhook parsing, phone numbers,
 * links, what the bot says for every intent, the Cloud API payloads, and the all-or-nothing
 * config. No database, no network.
 *
 * Run: npx tsx test/whatsapp-bot.unit.mts
 */
import { createHmac } from 'node:crypto'
import { createChecker } from './support/fake-supabase.mts'
import { verifyMetaSignature, safeEqual } from '../src/lib/whatsapp/signature.js'
import { parseWebhook, type InboundMessage } from '../src/lib/whatsapp/inbound.js'
import { indianMobileFromWaId, storedPhoneCandidates, waIdFromStoredPhone } from '../src/lib/whatsapp/phone.js'
import { alertPath, appBaseUrl, appLink } from '../src/lib/whatsapp/links.js'
import { BUTTON, intentOf, respond, type Turn } from '../src/lib/whatsapp/bot.js'
import { toCloudApiPayload, templateParam } from '../src/lib/whatsapp/client.js'
import { resolveWhatsAppConfig } from '../src/lib/whatsapp/config.js'
import { memoryGuard } from '../src/lib/whatsapp/guard.js'

const { check, finish } = createChecker()

// ── Signature ────────────────────────────────────────────────────────────────
console.log('\n── Meta’s signature is checked on the raw body')
const secret = 'app-secret-for-tests'
const body = Buffer.from('{"object":"whatsapp_business_account"}')
const good = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
check('a correct signature passes', verifyMetaSignature(body, good, secret))
check('a missing header fails', !verifyMetaSignature(body, undefined, secret))
check('the wrong secret fails', !verifyMetaSignature(body, 'sha256=' + createHmac('sha256', 'other').update(body).digest('hex'), secret))
check('a changed body fails', !verifyMetaSignature(Buffer.from('{"object":"x"}'), good, secret))
check('a short or malformed header fails without throwing', !verifyMetaSignature(body, 'sha256=abcd', secret) && !verifyMetaSignature(body, 'md5=' + good.slice(7), secret))
check('safeEqual compares tokens exactly', safeEqual('tok', 'tok') && !safeEqual('tok', 'tok2') && !safeEqual('a', 'b'))

// ── Parsing ──────────────────────────────────────────────────────────────────
console.log('\n── webhook parsing')
const envelope = (messages: unknown[], extra: Record<string, unknown> = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: 'PNID' }, messages, ...extra } }] }],
})
const parsed = parseWebhook(envelope([
  { id: 'w1', from: '919876543210', type: 'text', text: { body: 'Hi' } },
  { id: 'w2', from: '919876543210', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: BUTTON.alerts, title: 'My alerts' } } },
  { id: 'w3', from: '919876543210', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: BUTTON.trips, title: 'My trips' } } },
  { id: 'w4', from: '919876543210', type: 'button', button: { payload: BUTTON.help, text: 'Help' } },
  { id: 'w5', from: '919876543210', type: 'image', image: { id: 'media' } },
  { id: 'w6', from: '919876543210', type: 'location', location: {} },
  { id: 'bad', from: 'not-a-number', type: 'text', text: { body: 'x' } },
]))
check('text, reply buttons, list rows and template buttons parse', parsed[0].kind === 'text' && parsed[0].text === 'Hi'
  && parsed[1].buttonId === BUTTON.alerts && parsed[2].buttonId === BUTTON.trips && parsed[3].buttonId === BUTTON.help, JSON.stringify(parsed.slice(0, 4)))
check('photos and files are media; a location is other', parsed[4].kind === 'media' && parsed[5].kind === 'other')
check('a sender that is not a phone number is dropped', parsed.length === 6 && parsed.every((m) => m.phoneNumberId === 'PNID'))
check('delivery receipts are ignored', parseWebhook(envelope([], { statuses: [{ id: 's', status: 'delivered' }] })).length === 0)
check('anything that is not a WhatsApp business payload is ignored', parseWebhook({ object: 'page', entry: [] }).length === 0 && parseWebhook(null).length === 0 && parseWebhook('x').length === 0)

// ── Phone numbers ────────────────────────────────────────────────────────────
console.log('\n── phone numbers')
check('an Indian wa_id becomes a 10-digit mobile', indianMobileFromWaId('919876543210') === '9876543210')
check('a foreign or malformed wa_id matches nothing', indianMobileFromWaId('14155550100') === null && indianMobileFromWaId('911234567890') === null)
check('stored formats all map to the same wa_id', ['9876543210', '+919876543210', '+91 98765 43210', '09876543210', '919876543210'].every((p) => waIdFromStoredPhone(p) === '919876543210'))
check('a landline or junk stores no wa_id', waIdFromStoredPhone('02212345678') === null && waIdFromStoredPhone(null) === null)
check('lookup candidates cover the stored formats', storedPhoneCandidates('9876543210').includes('+919876543210') && storedPhoneCandidates('9876543210').includes('9876543210'))

// ── Links ────────────────────────────────────────────────────────────────────
console.log('\n── links open the page that can fix it')
check('base URL: shipper base first, trailing slash dropped', appBaseUrl({ SHIPPER_APP_BASE_URL: 'https://www.bharattruck.net/', DRIVER_APP_BASE_URL: 'x' }) === 'https://www.bharattruck.net')
check('no base: no link, never a broken one', appBaseUrl({}) === null && appLink(null, '/loads') === null)
check('a shipper’s overdue payment opens the Payment tab', alertPath({ persona: 'shipper', kind: 'unpaid_overdue', subject_type: 'booking', subject_id: 'B' }) === '/loads/B?tab=payment')
check('a driver’s licence alert opens their profile', alertPath({ persona: 'driver', kind: 'licence_expiring', subject_type: 'driver', subject_id: 'D' }) === '/driver-profile')
check('a fleet alert opens the fleet board', alertPath({ persona: 'fleet', kind: 'gps_silent', subject_type: 'booking', subject_id: 'B' }) === '/trips')

// ── What the bot says ────────────────────────────────────────────────────────
console.log('\n── what the bot says')
const msg = (p: Partial<InboundMessage>): InboundMessage => ({ id: 'x', from: '919876543210', phoneNumberId: null, kind: 'text', text: null, buttonId: null, ...p })
check('any greeting is the menu', intentOf(msg({ text: 'Hi' })) === 'menu' && intentOf(msg({ text: 'namaste' })) === 'menu')
check('STOP / START / HELP words work in any case', intentOf(msg({ text: ' STOP ' })) === 'stop' && intentOf(msg({ text: 'Start' })) === 'start' && intentOf(msg({ text: 'help!' })) === 'help')
check('menu buttons map to their intents', intentOf(msg({ kind: 'button', buttonId: BUTTON.trips })) === 'trips' && intentOf(msg({ kind: 'button', buttonId: BUTTON.ship })) === 'ship')
check('a photo is refused, whatever its caption', intentOf(msg({ kind: 'media' })) === 'media')

const base = 'https://www.bharattruck.net'
const known: Turn = { person: { firstName: 'Anita' }, firstContact: false, base, supportEmail: 'help@bharattruck.test' }
const newcomer: Turn = { person: null, firstContact: false, base, supportEmail: null }
const [menu] = respond('menu', known)
check('a known person is greeted by name with three buttons', menu.kind === 'buttons' && menu.body.startsWith('Hi Anita!') && menu.buttons.length === 3, JSON.stringify(menu))
const [first] = respond('menu', { ...known, firstContact: true })
check('the first menu says alerts will come here, and how to stop them', /alerts/i.test(first.body) && /STOP/.test(first.body))
check('the opt-in notice is shown once, not on every menu', !/STOP/.test(menu.body))
const [welcome] = respond('menu', newcomer)
check('a newcomer gets the welcome and the three ways in', welcome.kind === 'buttons' && /Welcome to BharatTruck/.test(welcome.body) && welcome.buttons.map((b) => b.id).join() === [BUTTON.ship, BUTTON.carry, BUTTON.newHelp].join())
check('a newcomer asking for alerts or trips gets the welcome, not someone else’s data', respond('alerts', newcomer)[0].body === welcome.body && respond('trips', newcomer)[0].body === welcome.body)
check('ship links to Post a load', respond('ship', newcomer)[0].body.includes(`${base}/post`))
check('help shows the support email when set, the app otherwise', respond('help', known)[0].body.includes('help@bharattruck.test') && respond('help', newcomer)[0].body.includes(base))
check('a photo gets a refusal and the app link', /don’t send documents/.test(respond('media', known)[0].body) && respond('media', known)[0].body.includes(base))
check('STOP and START confirm', /START/.test(respond('stop', known)[0].body) && /back on/.test(respond('start', known)[0].body))

const alerts = Array.from({ length: 7 }, (_, i) => ({ severity: i === 0 ? 'critical' as const : 'warning' as const, title: `Alert ${i}`, subtitle: `detail ${i}`, url: `${base}/trips` }))
const [alertMsg] = respond('alerts', { ...known, alerts })
check('alerts list at most five, then point to the app', (alertMsg.body.match(/Alert \d/g) ?? []).length === 5 && /\+2 more in the app/.test(alertMsg.body), alertMsg.body)
check('a critical alert is marked red', alertMsg.body.includes('🔴 Alert 0'))
check('no alerts says so plainly', /No open alerts/.test(respond('alerts', { ...known, alerts: [] })[0].body))
const [tripMsg] = respond('trips', { ...known, trips: [{ lane: 'Mumbai → Nagpur', status: 'On the way', url: `${base}/my-trips/B1` }] })
check('trips show lane, status and link', tripMsg.body.includes('Mumbai → Nagpur') && tripMsg.body.includes('On the way') && tripMsg.body.includes('/my-trips/B1'))

// No reply the bot can produce on its own carries a price.
const everything = (['menu', 'alerts', 'trips', 'help', 'stop', 'start', 'media', 'ship', 'carry'] as const)
  .flatMap((i) => [...respond(i, { ...known, trips: [], alerts: [] }), ...respond(i, newcomer)])
check('no fixed reply mentions money', everything.every((r) => !/₹|rs\.?\s?\d/i.test(r.body)))
check('every button title fits WhatsApp’s 20-character limit', everything.every((r) => r.kind !== 'buttons' || r.buttons.every((b) => b.title.length <= 20)))

// ── Cloud API payloads ───────────────────────────────────────────────────────
console.log('\n── Cloud API payloads')
const t = toCloudApiPayload({ type: 'text', to: '919876543210', body: 'hello' }) as any
check('text', t.messaging_product === 'whatsapp' && t.type === 'text' && t.text.body === 'hello' && t.to === '919876543210')
const b = toCloudApiPayload({ type: 'buttons', to: '91', body: 'pick', buttons: [1, 2, 3, 4].map((i) => ({ id: `b${i}`, title: `A very long button title ${i}` })) }) as any
check('buttons: at most three, titles clipped to 20', b.interactive.action.buttons.length === 3 && b.interactive.action.buttons.every((x: any) => x.reply.title.length <= 20))
const tp = toCloudApiPayload({ type: 'template', to: '91', name: 'bt_alert', language: 'en', params: ['Line one\nline two', ''] }) as any
check('template: name, language and body parameters', tp.template.name === 'bt_alert' && tp.template.language.code === 'en' && tp.template.components[0].parameters.length === 2)
check('template parameters lose newlines and are never empty', !tp.template.components[0].parameters[0].text.includes('\n') && templateParam('') === '-')

// ── Config ───────────────────────────────────────────────────────────────────
console.log('\n── config is all-or-nothing')
const full = { WHATSAPP_ACCESS_TOKEN: 'a', WHATSAPP_PHONE_NUMBER_ID: 'b', WHATSAPP_APP_SECRET: 'c', WHATSAPP_VERIFY_TOKEN: 'd' }
check('all four set: on, with defaults', resolveWhatsAppConfig(full).config?.graphVersion === 'v23.0' && resolveWhatsAppConfig(full).config?.alertTemplate === null)
const partial = resolveWhatsAppConfig({ ...full, WHATSAPP_APP_SECRET: ' ' })
check('one missing (or blank): off, and it says which', partial.config === null && partial.missing.join() === 'WHATSAPP_APP_SECRET')

// ── Guard ────────────────────────────────────────────────────────────────────
console.log('\n── handle once, and rate-limit')
let clock = 0
const g = memoryGuard(() => clock)
check('a message id is handled once', (await g.once('m1', 60)) && !(await g.once('m1', 60)))
check('...and again after its window', (clock = 61_000, await g.once('m1', 60)))
const hits = [] as boolean[]
for (let i = 0; i < 4; i++) hits.push(await g.allow('n1', 3, 60))
check('the fourth message in a 3-per-minute window is refused', hits.join() === 'true,true,true,false')

finish()
