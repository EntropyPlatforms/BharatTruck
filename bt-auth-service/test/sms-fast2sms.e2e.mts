/**
 * Fast2SMS provider: selection (all-or-nothing, console fallback) and the send
 * shape for both routes, against a stubbed global fetch. No real SMS is sent and
 * no real key exists.
 *
 * Run: npx tsx test/sms-fast2sms.e2e.mts
 */
import { resolveSmsProvider, Fast2SmsProvider, SmsSendError } from '../src/lib/sms.js'

const PHONE = '9876543210'
const OTP = '482913'

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

async function main() {
  console.log('\n── fast2sms selection ──')

  const noKey = resolveSmsProvider({ SMS_PROVIDER: 'fast2sms' })
  check('no API key → console', noKey.provider.name === 'console', `(got ${noKey.provider.name})`)
  check('reason names FAST2SMS_API_KEY', /FAST2SMS_API_KEY/.test(noKey.unwiredReason ?? ''), `(got ${noKey.unwiredReason})`)

  const blankKey = resolveSmsProvider({ SMS_PROVIDER: 'fast2sms', FAST2SMS_API_KEY: '   ' })
  check('blank API key (Cloud Run empty var) → console', blankKey.provider.name === 'console')

  const otpRoute = resolveSmsProvider({ SMS_PROVIDER: ' Fast2SMS ', FAST2SMS_API_KEY: 'k' })
  check('key alone → fast2sms on the otp route', otpRoute.provider instanceof Fast2SmsProvider && otpRoute.unwiredReason === null, `(got ${otpRoute.provider.name}/${otpRoute.unwiredReason})`)

  const dltMissing = resolveSmsProvider({ SMS_PROVIDER: 'fast2sms', FAST2SMS_API_KEY: 'k', FAST2SMS_ROUTE: 'dlt', FAST2SMS_SENDER_ID: 'BHTRUK' })
  check('dlt route without message id → console', dltMissing.provider.name === 'console')
  check('dlt reason names FAST2SMS_MESSAGE_ID only', /FAST2SMS_MESSAGE_ID/.test(dltMissing.unwiredReason ?? '') && !/SENDER_ID/.test(dltMissing.unwiredReason ?? ''), `(got ${dltMissing.unwiredReason})`)

  const badRoute = resolveSmsProvider({ SMS_PROVIDER: 'fast2sms', FAST2SMS_API_KEY: 'k', FAST2SMS_ROUTE: 'quick' })
  check('unknown route → console with a reason', badRoute.provider.name === 'console' && /not otp or dlt/.test(badRoute.unwiredReason ?? ''), `(got ${badRoute.unwiredReason})`)

  console.log('\n── fast2sms send shape (stubbed fetch — no real SMS) ──')

  const realFetch = globalThis.fetch
  let lastUrl = ''
  let lastInit: any = null
  let calls = 0
  const stub = (body: string, status = 200) => {
    globalThis.fetch = (async (url: any, init: any) => {
      calls++; lastUrl = String(url); lastInit = init
      return { ok: status >= 200 && status < 300, status, text: async () => body } as any
    }) as typeof fetch
  }
  const failWith = async (p: { sendOtp: (a: string, b: string) => Promise<void> }) => {
    try { await p.sendOtp(PHONE, OTP); return null } catch (e) { return e as any }
  }

  try {
    stub('{"return":true,"request_id":"r1","message":["SMS sent successfully."]}')
    const base = { SMS_PROVIDER: 'fast2sms', FAST2SMS_API_KEY: 'test-key', FAST2SMS_BASE_URL: 'https://f2s.invalid/' }
    const otpP = resolveSmsProvider(base).provider
    check('building the provider performs no HTTP', calls === 0)

    await otpP.sendOtp(PHONE, OTP)
    const sent = JSON.parse(String(lastInit.body))
    check('posts to /dev/bulkV2 on the configured host', lastUrl === 'https://f2s.invalid/dev/bulkV2', `(got ${lastUrl})`)
    check('API key travels in the authorization header', lastInit.headers.authorization === 'test-key')
    check('JSON body', lastInit.headers['content-type'] === 'application/json')
    check('otp route carries OUR code and the bare 10-digit number', sent.route === 'otp' && sent.variables_values === OTP && sent.numbers === PHONE, `(got ${lastInit.body})`)
    check('otp route sends no sender/template', sent.sender_id === undefined && sent.message === undefined)

    const dltP = resolveSmsProvider({ ...base, FAST2SMS_ROUTE: 'DLT', FAST2SMS_SENDER_ID: 'BHTRUK', FAST2SMS_MESSAGE_ID: '171234' }).provider
    await dltP.sendOtp(PHONE, OTP)
    const dlt = JSON.parse(String(lastInit.body))
    check('dlt route sends header, template id and our code', dlt.route === 'dlt' && dlt.sender_id === 'BHTRUK' && dlt.message === '171234' && dlt.variables_values === OTP && dlt.numbers === PHONE, `(got ${lastInit.body})`)

    // A 200 that does not say return:true is not a delivery.
    stub('{"return":false,"status_code":416,"message":"Insufficient wallet balance"}')
    const wallet = await failWith(otpP)
    check('200 with return:false throws', wallet instanceof SmsSendError, `(got ${wallet})`)
    check('error code and message are surfaced', /416/.test(String(wallet?.message)) && /wallet/.test(String(wallet?.message)), `(got ${wallet?.message})`)

    stub('{"return":false,"status_code":412,"message":"Invalid Authentication, Check Authorization Key"}', 401)
    const auth = await failWith(otpP)
    check('401 bad key throws with code 412', auth instanceof SmsSendError && /HTTP 401 code 412/.test(String(auth.message)), `(got ${auth?.message})`)

    stub(`{"return":false,"status_code":400,"message":["bad value ${OTP}"]}`, 400)
    const echo = await failWith(otpP)
    check('the thrown message never carries the OTP', echo instanceof SmsSendError && !String(echo.message).includes(OTP), `(got ${echo?.message})`)

    stub('<html>502 Bad Gateway</html>', 502)
    const html = await failWith(otpP)
    check('unparseable failure still throws with the status', html instanceof SmsSendError && /502/.test(String(html.message)), `(got ${html?.message})`)

    stub('', 200)
    const empty = await failWith(otpP)
    check('empty 200 is a failure, not a delivery', empty instanceof SmsSendError, `(got ${empty})`)

    globalThis.fetch = (async () => { throw new Error('network down') }) as typeof fetch
    const net = await failWith(otpP)
    check('network failure throws SmsSendError', net instanceof SmsSendError && /network down/.test(String(net.message)), `(got ${net?.message})`)
  } finally {
    globalThis.fetch = realFetch
  }

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
