/**
 * Licence (Sarathi) and RC (Vahan) checks through Surepass, and the per-check routing that lets
 * them run on Surepass while every other check stays on Sandbox. Stubbed fetch: no real call, no
 * real key.
 *
 * Run: npx tsx test/kyc-vahan-sarathi.unit.mts
 */
import {
  resolveKycProvider, checkRouting, RoutedKycProvider, SurepassKycProvider,
  surepassRcOutcome, surepassDlOutcome, parseRecordDate,
} from '../src/modules/kyc/provider.js'
import { SurepassClient } from '../src/lib/surepass.js'

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

const SANDBOX = { SANDBOX_API_KEY: 'k', SANDBOX_API_SECRET: 's' }
const TODAY = new Date(Date.UTC(2026, 10, 12))
const ok = (data: Record<string, unknown>) => ({ success: true, message: '', status_code: 200, data })

async function main() {
  console.log('\n── routing ──')
  const plain = resolveKycProvider({ KYC_PROVIDER: 'sandbox', ...SANDBOX })
  check('no override → plain sandbox for every check', plain.provider.name === 'sandbox' && !(plain.provider instanceof RoutedKycProvider))
  check('plain routing reports sandbox for dl and rc', checkRouting(plain.provider).rc === 'sandbox' && checkRouting(plain.provider).dl === 'sandbox')

  const rcOnly = resolveKycProvider({ KYC_PROVIDER: 'sandbox', ...SANDBOX, KYC_RC_PROVIDER: 'surepass', SUREPASS_API_KEY: 'sp' })
  check('RC override → routed provider, still named sandbox', rcOnly.provider instanceof RoutedKycProvider && rcOnly.provider.name === 'sandbox')
  check('RC goes to surepass, licence stays on sandbox', checkRouting(rcOnly.provider).rc === 'surepass' && checkRouting(rcOnly.provider).dl === 'sandbox')
  check('main provider is wired, no reason', rcOnly.unwiredReason === null && (rcOnly.overrideWarnings ?? []).length === 0)

  const both = resolveKycProvider({ KYC_PROVIDER: 'sandbox', ...SANDBOX, KYC_RC_PROVIDER: 'Surepass', KYC_DL_PROVIDER: ' surepass ', SUREPASS_API_KEY: 'sp' })
  check('both overrides → licence and RC on surepass', checkRouting(both.provider).rc === 'surepass' && checkRouting(both.provider).dl === 'surepass')

  const noKey = resolveKycProvider({ KYC_PROVIDER: 'sandbox', ...SANDBOX, KYC_RC_PROVIDER: 'surepass' })
  check('override without SUREPASS_API_KEY is ignored', !(noKey.provider instanceof RoutedKycProvider) && checkRouting(noKey.provider).rc === 'sandbox')
  check('…with a warning naming the variable and the key', (noKey.overrideWarnings ?? []).some((w) => /KYC_RC_PROVIDER/.test(w) && /SUREPASS_API_KEY/.test(w)), `(got ${noKey.overrideWarnings})`)
  check('…and the main provider is still wired', noKey.unwiredReason === null)

  const unsetMain = resolveKycProvider({ KYC_RC_PROVIDER: 'surepass', SUREPASS_API_KEY: 'sp' })
  check('RC override works even with KYC_PROVIDER unset', checkRouting(unsetMain.provider).rc === 'surepass' && unsetMain.provider.name === 'console' && unsetMain.unwiredReason !== null)

  const same = resolveKycProvider({ KYC_PROVIDER: 'surepass', SUREPASS_API_KEY: 'sp', KYC_RC_PROVIDER: 'surepass' })
  check('override equal to the main provider → no wrapper', !(same.provider instanceof RoutedKycProvider))

  console.log('\n── delegation (stubbed fetch) ──')
  const realFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (url: any, init: any) => {
    urls.push(String(url))
    const u = String(url)
    const body = u.includes('surepass') ? JSON.stringify(ok({ client_id: 'c1', rc_status: 'ACTIVE', owner_name: 'X' })) : JSON.stringify({ code: 200, data: { status: 'valid' }, transaction_id: 't' })
    if (u.endsWith('/authenticate')) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok' }), json: async () => ({ access_token: 'tok' }) } as any
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) } as any
  }) as typeof fetch
  try {
    await rcOnly.provider.verifyRc({ rc_number: 'MH31CQ4512' })
    check('verifyRc hits Surepass rc-full', urls.some((u) => u.includes('surepass') && u.endsWith('/rc/rc-full')), `(got ${urls.join(' ')})`)
    urls.length = 0
    process.env.SUREPASS_RC_ENDPOINT = '/rc/rc-v2'
    await new SurepassKycProvider(new SurepassClient('sp')).verifyRc({ rc_number: 'MH31CQ4512' })
    check('SUREPASS_RC_ENDPOINT overrides the RC tier', urls.some((u) => u.endsWith('/rc/rc-v2')), `(got ${urls.join(' ')})`)
    delete process.env.SUREPASS_RC_ENDPOINT
    urls.length = 0
    await rcOnly.provider.verifyBank({ account_number: '123456789', ifsc: 'HDFC0000001' }).catch(() => null)
    check('bank check stays on Sandbox', urls.length > 0 && urls.every((u) => !u.includes('surepass')), `(got ${urls.join(' ')})`)
    const noDob = await new SurepassKycProvider(new SurepassClient('sp')).verifyDl({ dl_number: 'MH3120200001234' })
    check('licence without a DOB → manual review, no call', noDob.unavailable === true)
  } finally {
    globalThis.fetch = realFetch
  }

  console.log('\n── Vahan (RC) mapping ──')
  const active = surepassRcOutcome(ok({ client_id: 'r1', rc_status: 'ACTIVE', owner_name: 'Ravi Kumar', maker_model: 'TATA SIGNA 4825.TK', fit_up_to: '2027-03-01', insurance_upto: '2026-10-01', chassis_number: 'MAT123', present_address: 'Nagpur' }), TODAY)
  check('ACTIVE RC → verified', active.verified === true && active.reason === null)
  check('reference id kept', active.reference_id === 'r1')
  check('fitness in date, insurance lapsed', active.details.fitness_lapsed === false && active.details.insurance_lapsed === true)
  check('no chassis or address in details', !JSON.stringify(active.details).includes('MAT123') && !JSON.stringify(active.details).includes('Nagpur'))
  check('owner name used for matching only, not in details', active.name === 'Ravi Kumar' && !JSON.stringify(active.details).includes('Ravi'))
  const susp = surepassRcOutcome(ok({ rc_status: 'SUSPENDED' }), TODAY)
  check('SUSPENDED RC → not verified, says why', susp.verified === false && /SUSPENDED/.test(susp.reason ?? ''))
  const inactive = surepassRcOutcome(ok({ rc_status: 'Inactive' }), TODAY)
  check('Inactive RC → not verified', inactive.verified === false)
  const bl = surepassRcOutcome(ok({ rc_status: 'ACTIVE', blacklist_status: 'Y' }), TODAY)
  check('blacklisted RC → not verified', bl.verified === false && /blacklisted/i.test(bl.reason ?? ''))
  const notFound = surepassRcOutcome({ success: false, message: 'Invalid RC', status_code: 422, data: {} } as any, TODAY)
  check('Surepass success:false → not verified with its message', notFound.verified === false && notFound.reason === 'Invalid RC')

  console.log('\n── Sarathi (licence) mapping ──')
  const dlOk = surepassDlOutcome(ok({ client_id: 'd1', name: 'RAVI KUMAR', doe: '2033-05-05', transport_doe: '2025-01-01', vehicle_classes: ['LMV', 'HGMV', 3] }), TODAY)
  check('valid licence → verified', dlOk.verified === true && dlOk.name === 'RAVI KUMAR')
  check('lapsed transport endorsement is flagged', dlOk.details.transport_valid === false)
  check('vehicle classes kept (strings only)', JSON.stringify(dlOk.details.vehicle_classes) === '["LMV","HGMV"]')
  const dlExp = surepassDlOutcome(ok({ name: 'A', doe: '01-01-2025' }), TODAY)
  check('expired licence (DD-MM-YYYY) → not verified, says when', dlExp.verified === false && /2025/.test(dlExp.reason ?? ''))
  const dlNoDate = surepassDlOutcome(ok({ name: 'A' }), TODAY)
  check('no expiry on record → still verified (cannot tell)', dlNoDate.verified === true && dlNoDate.details.transport_valid === null)

  console.log('\n── dates ──')
  check('YYYY-MM-DD', parseRecordDate('2027-03-01')?.toISOString().startsWith('2027-03-01') === true)
  check('DD/MM/YYYY', parseRecordDate('05/04/2030')?.toISOString().startsWith('2030-04-05') === true)
  check('garbage → null', parseRecordDate('soon') === null && parseRecordDate(null) === null)

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
