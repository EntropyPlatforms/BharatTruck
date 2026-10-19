/**
 * GST portal OTP verification (modules/kyc/gst-otp.ts) against a fake Sandbox client: the two
 * calls, what "verified" means (a taxpayer session came back), and the portal's refusals in the
 * taxpayer's words. Run: npx tsx test/gst-otp.unit.mts
 */
let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

async function main() {
  const { sendGstOtp, verifyGstOtp, readVerify, otpFailureReason, GstOtpError } = await import('../src/modules/kyc/gst-otp.js')
  const calls: Array<{ endpoint: string; payload: any }> = []
  let verifyAnswer: any = { code: 200, data: { access_token: 'tp-session-token-abcdef', session_expiry: 1760700000000 } }
  let otpAnswer: any = { code: 200, data: { status_cd: '1' } }
  const fake = { configured: true, async post(endpoint: string, payload: any) { calls.push({ endpoint, payload }); return endpoint.includes('/otp/verify') ? verifyAnswer : otpAnswer }, async get() { throw new Error('no') } } as any

  console.log('\n── send OTP ──')
  await sendGstOtp({ gstin: '27AAPFU0939F1ZV', username: 'firm_user' }, fake)
  check('calls the taxpayer OTP endpoint with username + gstin', calls[0].endpoint === '/gst/compliance/tax-payer/otp' && calls[0].payload.username === 'firm_user' && calls[0].payload.gstin === '27AAPFU0939F1ZV', JSON.stringify(calls[0]))
  const bad = await sendGstOtp({ gstin: 'nope', username: 'x' }, fake).then(() => null, (e) => e)
  check('a malformed GSTIN is refused before any call', bad instanceof GstOtpError && bad.httpStatus === 400, String(bad))
  otpAnswer = { code: 200, data: { status_cd: '0', error: { message: 'API access not enabled for taxpayer (AUTH4033)' } } }
  const notEnabled = await sendGstOtp({ gstin: '27AAPFU0939F1ZV', username: 'firm_user' }, fake).then(() => null, (e) => e)
  check('portal "API access not enabled" → the gst.gov.in steps', notEnabled instanceof GstOtpError && /Manage API Access/.test(notEnabled.message), String(notEnabled?.message))

  console.log('\n── verify OTP ──')
  const ok = await verifyGstOtp({ gstin: '27AAPFU0939F1ZV', username: 'firm_user', otp: '575757' }, fake)
  check('OTP goes as a query parameter, body repeats username + gstin', /\/otp\/verify\?otp=575757$/.test(calls.at(-1)!.endpoint) && calls.at(-1)!.payload.gstin === '27AAPFU0939F1ZV', calls.at(-1)!.endpoint)
  check('a session token means verified, with its expiry', ok.verified && ok.expires_at === '2025-10-17T11:20:00.000Z', JSON.stringify(ok))
  verifyAnswer = { code: 200, data: { status_cd: '0', error: { message: 'Invalid OTP (AUTH4035)' } } }
  const wrong = await verifyGstOtp({ gstin: '27AAPFU0939F1ZV', username: 'firm_user', otp: '000000' }, fake).then(() => null, (e) => e)
  check('a wrong OTP is refused in plain words', wrong instanceof GstOtpError && wrong.code === 'GST_OTP_REFUSED' && /wrong or has expired/.test(wrong.message), String(wrong?.message))
  const noToken = (() => { try { readVerify({ code: 200, data: {} } as any); return null } catch (e) { return e as any } })()
  check('no token = not verified, never a silent pass', noToken instanceof GstOtpError, '')
  const notDigits = await verifyGstOtp({ gstin: '27AAPFU0939F1ZV', username: 'u', otp: 'abc' }, fake).then(() => null, (e) => e)
  check('OTP must be digits', notDigits instanceof GstOtpError && notDigits.httpStatus === 400, '')
  check('unknown portal message is passed through, capped', otpFailureReason({ code: 200, data: { message: 'x'.repeat(300) } } as any, 'f').length === 200, '')

  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch((e) => { console.error(e); process.exit(1) })
