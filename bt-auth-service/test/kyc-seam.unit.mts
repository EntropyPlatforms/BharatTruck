/**
 * bt-auth-service — the PURE decisions behind the KYC provider seam (migration 0038): which provider
 * a config resolves to, whether two names match, and the level a set of verifications derives to.
 * The DB-touching parts (repository upserts, fraud dedup queries) are integration-tested; these are
 * the pieces that decide pass/fail and vendor wiring, so they are unit-tested without a database.
 *
 * Run: npx tsx test/kyc-seam.unit.mts
 */
let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

async function main() {
  const { resolveKycProvider } = await import('../src/modules/kyc/provider.js')
  const { fuzzyNameMatch } = await import('../src/modules/kyc/fraud.js')
  const { deriveLevel } = await import('../src/modules/kyc/repository.js')
  const { KYCStatus, KYCLevel } = await import('../src/modules/kyc/types.js')

  console.log('\n── resolveKycProvider: env switch, all-or-nothing fallback to console ──')
  check('unset -> console, with a reason', (() => { const r = resolveKycProvider({}); return r.provider.name === 'console' && r.unwiredReason !== null })())
  check('KYC_PROVIDER=console -> console', resolveKycProvider({ KYC_PROVIDER: 'console' }).provider.name === 'console')
  check('surepass WITHOUT a key -> falls back to console + reason', (() => {
    const r = resolveKycProvider({ KYC_PROVIDER: 'surepass' })
    return r.provider.name === 'console' && (r.unwiredReason ?? '').includes('SUREPASS_API_KEY')
  })())
  check('surepass WITH a key -> surepass, no reason', (() => {
    const r = resolveKycProvider({ KYC_PROVIDER: 'surepass', SUREPASS_API_KEY: 'sk_live_xyz' })
    return r.provider.name === 'surepass' && r.unwiredReason === null
  })())
  check('sandbox WITHOUT keys -> falls back to console + reason', (() => {
    const r = resolveKycProvider({ KYC_PROVIDER: 'sandbox' })
    return r.provider.name === 'console' && (r.unwiredReason ?? '').includes('SANDBOX_API_KEY')
  })())
  check('sandbox WITH key but NO secret -> still console (all-or-nothing)', (() => {
    const r = resolveKycProvider({ KYC_PROVIDER: 'sandbox', SANDBOX_API_KEY: 'key_live_x' })
    return r.provider.name === 'console'
  })())
  check('sandbox WITH key + secret -> sandbox, no reason', (() => {
    const r = resolveKycProvider({ KYC_PROVIDER: 'sandbox', SANDBOX_API_KEY: 'key_live_x', SANDBOX_API_SECRET: 'secret_live_y' })
    return r.provider.name === 'sandbox' && r.unwiredReason === null
  })())
  check('an unknown provider -> console + reason', resolveKycProvider({ KYC_PROVIDER: 'signzy' }).provider.name === 'console')

  console.log('\n── console provider never auto-passes in production ──')
  const consoleProd = resolveKycProvider({ KYC_PROVIDER: 'console', NODE_ENV: 'production' }).provider
  const panOut = await consoleProd.verifyPan({ pan: 'ABCDE1234F' })
  check('console verifyPan is UNAVAILABLE (→ manual review), not verified', panOut.unavailable === true && panOut.verified === false)
  const consoleDev = resolveKycProvider({ KYC_PROVIDER: 'console', NODE_ENV: 'development', KYC_DEV_MODE: 'true' }).provider
  check('console dev-mode auto-passes (for testing only)', (await consoleDev.verifyPan({ pan: 'ABCDE1234F' })).verified === true)

  console.log('\n── fuzzyNameMatch: same person tolerant, different person rejected ──')
  check('identical', fuzzyNameMatch('Ravi Kumar', 'Ravi Kumar'))
  check('salutation stripped', fuzzyNameMatch('Mr Ravi Kumar', 'Ravi Kumar'))
  check('case + spacing', fuzzyNameMatch('RAVI  KUMAR', 'ravi kumar'))
  check('a small typo is within 40%', fuzzyNameMatch('Ravi Kumar', 'Ravi Kumaar'))
  check('a clearly different name is rejected', !fuzzyNameMatch('Ravi Kumar', 'Sunita Sharma'))
  check('empty vs a name is NOT a match', !fuzzyNameMatch('', 'Ravi Kumar'))
  check('both empty is NOT a match', !fuzzyNameMatch('', ''))

  console.log('\n── deriveLevel: cumulative ladder, a gap stops the climb ──')
  const S = { status: KYCStatus.Success }
  check('nothing -> L0', deriveLevel({}) === KYCLevel.L0)
  check('phone+email -> L1', deriveLevel({ phone: S, email: S }) === KYCLevel.L1)
  check('+aadhaar+pan -> L2', deriveLevel({ phone: S, email: S, aadhaar: S, pan: S }) === KYCLevel.L2)
  check('+dl+face+bank -> L3', deriveLevel({ phone: S, email: S, aadhaar: S, pan: S, dl: S, face_match: S, bank: S }) === KYCLevel.L3)
  check('rc satisfies the L3 (dl|rc|gst) branch', deriveLevel({ phone: S, email: S, aadhaar: S, pan: S, rc: S, face_match: S, bank: S }) === KYCLevel.L3)
  check('aadhaar+pan but NO email -> L0 (the ladder is cumulative)', deriveLevel({ aadhaar: S, pan: S }) === KYCLevel.L0)
  check('a failed verification does not count', deriveLevel({ phone: S, email: { status: KYCStatus.Failed } }) === KYCLevel.L0)

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    for (const f of failures) console.error('  x ' + f)
    process.exit(1)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
