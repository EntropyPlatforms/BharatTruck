/**
 * Phone-OTP SMS provider seam (D-14).
 *
 * Pins the two things that keep an un-registered DLT account from becoming an
 * outage: the console provider is what you get unless SMS is FULLY configured,
 * and the route sends exactly one message per OTP — no more, and none at all for
 * a request the per-phone throttle refused.
 *
 * The MSG91 path is exercised against a stubbed global fetch. No real SMS is sent
 * and no credentials exist: the provider is unreachable without env vars.
 *
 * Run: npx tsx test/sms-provider.e2e.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-hs256'
process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret-hs256'
process.env.EMAIL_DEV_MODE = 'true' // never touch a real SMTP host
// Pin the ambient config the route-level cases run under: nothing configured, and
// not the [DEV] branch either, so we assert the exact line production prints today.
delete process.env.SMS_PROVIDER
delete process.env.OTP_DEV_MODE
delete process.env.NODE_ENV

import Fastify from 'fastify'
import { resolveSmsProvider, Msg91SmsProvider, TwilioSmsProvider, SmsSendError } from '../src/lib/sms.js'

const PHONE = '9876543210'

// ── Fake Redis: only what /auth/send-otp touches. Values are strings, as in the
// real client, so a bug that assumes numbers surfaces here rather than in prod.
class FakeRedis {
  private store = new Map<string, string>()
  private expiries = new Map<string, number>()
  async incr(k: string) { const n = Number(this.store.get(k) ?? 0) + 1; this.store.set(k, String(n)); return n }
  async expire(k: string, s: number) { this.expiries.set(k, s); return 1 }
  async ttl(k: string) { return this.expiries.get(k) ?? -1 }
  async get(k: string) { return this.store.get(k) ?? null }
  async set(k: string, v: string, ..._rest: unknown[]) { this.store.set(k, v); return 'OK' }
  async del(k: string) { this.expiries.delete(k); return this.store.delete(k) ? 1 : 0 }
  peek(k: string) { return this.store.get(k) ?? null }
}

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

/** Collect everything the code under test writes to stdout via console.log. */
function captureConsoleLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
  return { lines, restore: () => { console.log = original } }
}

async function main() {
  console.log('\n── provider selection ──')

  const bare = resolveSmsProvider({})
  check('nothing configured → console', bare.provider.name === 'console', `(got ${bare.provider.name})`)
  check('nothing configured reports why SMS is unwired', /SMS_PROVIDER is unset/.test(bare.unwiredReason ?? ''), `(got ${bare.unwiredReason})`)

  // The failure this prevents: an ops deploy that sets the auth key and forgets the
  // DLT-issued pair. Throwing here would take phone login down for every user; a
  // send would be rejected by the operator and count against the sender header.
  const partial = resolveSmsProvider({ SMS_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'k' })
  check('partially configured msg91 → console, no throw', partial.provider.name === 'console', `(got ${partial.provider.name})`)
  check('partial config names the missing vars', /MSG91_SENDER_ID/.test(partial.unwiredReason ?? '') && /MSG91_TEMPLATE_ID/.test(partial.unwiredReason ?? ''), `(got ${partial.unwiredReason})`)

  // Cloud Run env vars are frequently present-but-empty; blank must count as unset.
  const blank = resolveSmsProvider({ SMS_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'k', MSG91_SENDER_ID: '  ', MSG91_TEMPLATE_ID: '' })
  check('empty-string credentials count as missing', blank.provider.name === 'console', `(got ${blank.provider.name})`)

  const unknown = resolveSmsProvider({ SMS_PROVIDER: 'gupshup' })
  check('unknown provider name → console, no throw', unknown.provider.name === 'console', `(got ${unknown.provider.name})`)

  const full = { SMS_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'test-key', MSG91_SENDER_ID: 'BHTRUK', MSG91_TEMPLATE_ID: 'tmpl-1' }
  const wired = resolveSmsProvider(full)
  check('fully configured msg91 → msg91', wired.provider.name === 'msg91', `(got ${wired.provider.name})`)
  check('wired config reports nothing unwired', wired.unwiredReason === null, `(got ${wired.unwiredReason})`)

  const twilioFull = { SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC-test', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+15551234567' }
  const twilioWired = resolveSmsProvider(twilioFull)
  check('fully configured twilio → twilio', twilioWired.provider.name === 'twilio', `(got ${twilioWired.provider.name})`)
  check('wired twilio reports nothing unwired', twilioWired.unwiredReason === null, `(got ${twilioWired.unwiredReason})`)

  // Credentials present but no sender at all: Twilio rejects every such request, so
  // it is a config error, not a per-send failure — it must not reach the network.
  const twilioNoSender = resolveSmsProvider({ SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC-test', TWILIO_AUTH_TOKEN: 'tok' })
  check('twilio with no sender → console, no throw', twilioNoSender.provider.name === 'console', `(got ${twilioNoSender.provider.name})`)
  check('missing sender is named in the reason', /TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM/.test(twilioNoSender.unwiredReason ?? ''), `(got ${twilioNoSender.unwiredReason})`)

  const twilioNoToken = resolveSmsProvider({ SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC-test', TWILIO_FROM: '+15551234567' })
  check('twilio missing the auth token → console', twilioNoToken.provider.name === 'console', `(got ${twilioNoToken.provider.name})`)
  check('missing token is named in the reason', /TWILIO_AUTH_TOKEN/.test(twilioNoToken.unwiredReason ?? ''), `(got ${twilioNoToken.unwiredReason})`)

  // Same present-but-empty trap Cloud Run sets for MSG91.
  const twilioBlank = resolveSmsProvider({ SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC-test', TWILIO_AUTH_TOKEN: '  ', TWILIO_FROM: '+15551234567' })
  check('empty-string twilio credentials count as missing', twilioBlank.provider.name === 'console', `(got ${twilioBlank.provider.name})`)

  console.log('\n── msg91 send shape (stubbed fetch — no real SMS) ──')

  const realFetch = globalThis.fetch
  let lastUrl = ''
  let lastInit: any = null
  let fetchCalls = 0
  const stubFetch = (body: string, status = 200) => {
    globalThis.fetch = (async (url: any, init: any) => {
      fetchCalls++
      lastUrl = String(url)
      lastInit = init
      return { ok: status >= 200 && status < 300, status, text: async () => body } as any
    }) as typeof fetch
  }

  try {
    // Resolution alone must never talk to the network — building the provider at
    // boot cannot be allowed to cost a request or hang startup.
    stubFetch('{"type":"success"}')
    resolveSmsProvider(full)
    check('constructing the provider performs no HTTP', fetchCalls === 0, `(got ${fetchCalls} calls)`)

    const provider = resolveSmsProvider({ ...full, MSG91_BASE_URL: 'https://msg91.invalid' }).provider
    await provider.sendOtp(PHONE, '123456')
    const sent = JSON.parse(String(lastInit.body))
    check('posts to the v5 flow endpoint on the configured host', lastUrl === 'https://msg91.invalid/api/v5/flow', `(got ${lastUrl})`)
    check('auth key travels in the authkey header', lastInit.headers.authkey === 'test-key', `(got ${lastInit.headers.authkey})`)
    check('DLT template id and registered sender are sent', sent.template_id === 'tmpl-1' && sent.sender === 'BHTRUK', `(got ${sent.template_id}/${sent.sender})`)
    check('number is 91-prefixed and carries OUR code', sent.recipients[0].mobiles === `91${PHONE}` && sent.recipients[0].otp === '123456', `(got ${JSON.stringify(sent.recipients[0])})`)

    // MSG91 answers 200 for a rejected send and hides the failure in the body —
    // res.ok alone would report a delivery that never happened.
    stubFetch('{"type":"error","message":"template not approved"}')
    let threw: unknown = null
    try { await provider.sendOtp(PHONE, '123456') } catch (e) { threw = e }
    check('200 with type:error is a failure, not a delivery', threw instanceof SmsSendError, `(got ${threw})`)

    // The error body can echo the request payload, which carries the live code.
    stubFetch('{"message":"unauthorized","otp":"123456"}', 401)
    let httpErr: any = null
    try { await provider.sendOtp(PHONE, '123456') } catch (e) { httpErr = e }
    check('HTTP failure throws', httpErr instanceof SmsSendError, `(got ${httpErr})`)
    check('the thrown message never carries the OTP', !String(httpErr?.message).includes('123456'), `(got ${httpErr?.message})`)

    console.log('\n── twilio send shape (stubbed fetch — no real SMS) ──')

    stubFetch('{"sid":"SM1","status":"queued"}', 201)
    const twilio = resolveSmsProvider({ ...twilioFull, TWILIO_BASE_URL: 'https://twilio.invalid' }).provider
    check('resolved provider is the twilio one', twilio instanceof TwilioSmsProvider, `(got ${twilio.name})`)
    await twilio.sendOtp(PHONE, '123456')
    check('posts to the account Messages resource', lastUrl === 'https://twilio.invalid/2010-04-01/Accounts/AC-test/Messages.json', `(got ${lastUrl})`)
    check('authenticates with HTTP Basic sid:token', lastInit.headers.authorization === `Basic ${Buffer.from('AC-test:tok').toString('base64')}`, `(got ${lastInit.headers.authorization})`)

    // The single most common way this integration is got wrong: Twilio's REST API is
    // form-encoded, and a JSON body comes back as a missing-parameter error that
    // reads like a credential problem.
    check('body is form-encoded, not JSON', lastInit.headers['content-type'] === 'application/x-www-form-urlencoded' && !String(lastInit.body).startsWith('{'), `(got ${lastInit.headers['content-type']})`)
    const form = new URLSearchParams(String(lastInit.body))
    // The route validates a BARE 10-digit number; Twilio needs E.164, and that gap
    // is closed at the provider boundary rather than by widening the route's schema.
    check('To is E.164 with the India prefix', form.get('To') === `+91${PHONE}`, `(got ${form.get('To')})`)
    check('body carries our code', String(form.get('Body')).includes('123456'), `(got ${form.get('Body')})`)
    check('From is sent when no messaging service is set', form.get('From') === '+15551234567' && form.get('MessagingServiceSid') === null, `(got ${form.get('From')}/${form.get('MessagingServiceSid')})`)

    // Both set: the Messaging Service carries the sender pool and compliance config,
    // and Twilio rejects a request that carries both — so From must not be sent.
    const bothSenders = resolveSmsProvider({
      ...twilioFull, TWILIO_BASE_URL: 'https://twilio.invalid', TWILIO_MESSAGING_SERVICE_SID: 'MG-test',
    }).provider
    await bothSenders.sendOtp(PHONE, '123456')
    const bothForm = new URLSearchParams(String(lastInit.body))
    check('messaging service wins over From', bothForm.get('MessagingServiceSid') === 'MG-test' && bothForm.get('From') === null, `(got ${bothForm.get('MessagingServiceSid')}/${bothForm.get('From')})`)

    // Twilio signals a rejection with a non-2xx AND {code,message} — unlike MSG91 it
    // never hides one behind a 200. The code is what an operator acts on (21608 is a
    // trial-account unverified number; a DLT-unregistered sender fails the same way),
    // so it has to survive into the thrown error.
    stubFetch('{"code":21608,"message":"The number is unverified","status":400}', 400)
    let twilioErr: any = null
    try { await twilio.sendOtp(PHONE, '123456') } catch (e) { twilioErr = e }
    check('twilio error response throws', twilioErr instanceof SmsSendError, `(got ${twilioErr})`)
    check('twilio error code and message are surfaced', /21608/.test(String(twilioErr?.message)) && /unverified/.test(String(twilioErr?.message)), `(got ${twilioErr?.message})`)

    // A body we cannot parse must still fail loudly rather than read as a delivery.
    stubFetch('<html>502 Bad Gateway</html>', 502)
    let twilioHtml: any = null
    try { await twilio.sendOtp(PHONE, '123456') } catch (e) { twilioHtml = e }
    check('unparseable twilio failure still throws with the status', twilioHtml instanceof SmsSendError && /502/.test(String(twilioHtml.message)), `(got ${twilioHtml?.message})`)
  } finally {
    globalThis.fetch = realFetch
  }

  console.log('\n── route wiring: one send per OTP, throttle unchanged ──')

  const redis = new FakeRedis()
  const app = Fastify({ logger: false })
  app.decorate('redis', redis as any)
  app.decorate('supabase', { from: () => ({}) } as any)
  const { authRoutes } = await import('../src/routes/auth.js')
  await app.register(authRoutes, { prefix: '/auth' })

  const sendOtp = (phone: string) => app.inject({ method: 'POST', url: '/auth/send-otp', payload: { phone } })

  // Every send runs under the capture and every assertion runs after it is torn
  // down — check() writes to console.log too, and asserting against a buffer it is
  // still appending to would count its own output as delivered messages.
  const cap = captureConsoleLog()
  let first: any, sixth: any
  let firstOtp: string | null = null
  let afterOne = 0, afterFive = 0, afterSix = 0
  const otpLines = () => cap.lines.filter(l => l.includes(`OTP for ${PHONE}`))
  try {
    first = await sendOtp(PHONE)
    firstOtp = redis.peek(`phone_otp:${PHONE}`)
    afterOne = otpLines().length
    for (let i = 0; i < 4; i++) await sendOtp(PHONE)
    afterFive = otpLines().length
    sixth = await sendOtp(PHONE)
    afterSix = otpLines().length
  } finally {
    cap.restore()
  }

  check('send-otp still 200', first.statusCode === 200, `(got ${first.statusCode})`)
  check('exactly one message per OTP', afterOne === 1, `(got ${afterOne})`)
  check('console provider prints the unwired line verbatim', cap.lines.includes(`[WARN] No SMS provider configured — OTP for ${PHONE}: ${firstOtp}`), `(got ${JSON.stringify(cap.lines.slice(0, 2))})`)
  check('5 sends produce 5 messages', afterFive === 5, `(got ${afterFive})`)
  check('6th request in the hour still 429', sixth.statusCode === 429, `(got ${sixth.statusCode})`)
  check('a throttled request sends nothing', afterSix === 5, `(got ${afterSix})`)

  await app.close()
  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch(err => { console.error(err); process.exit(1) })
