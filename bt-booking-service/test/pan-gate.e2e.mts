/**
 * PAN is mandatory (2026-10-15): a load cannot be posted and a bid cannot be placed until the
 * caller's PAN is verified in user_kyc. Pins the gate itself — refused with PAN_REQUIRED before
 * anything else is read, allowed once verified, and off entirely under PAN_GATE=off (how every
 * other test and the scenario simulation run).
 *
 * Run: npx tsx test/pan-gate.e2e.mts
 */
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'
process.env.PAN_GATE = 'on'

type Row = Record<string, any>
const U_OK = 'aaaaaaaa-0000-4000-8000-00000000000a'
const U_NO = 'aaaaaaaa-0000-4000-8000-00000000000b'
const U_PENDING = 'aaaaaaaa-0000-4000-8000-00000000000c'
const db: Record<string, Row[]> = {
  user_kyc: [
    { user_id: U_OK, verifications: { pan: { status: 'success', provider_ref: 't1' } } },
    { user_id: U_PENDING, verifications: { pan: { status: 'manual_review' } } },
  ],
}
class FakeQuery {
  private eqs: Array<[string, any]> = []
  constructor(private table: string) {}
  select() { return this }
  eq(c: string, v: any) { this.eqs.push([c, v]); return this }
  maybeSingle() { const rows = (db[this.table] ?? []).filter(r => this.eqs.every(([c, v]) => r[c] === v)); return Promise.resolve({ data: rows[0] ?? null, error: null }) }
}

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

async function main() {
  const { __setSupabaseClientForTests } = await import('../src/lib/supabase.js')
  __setSupabaseClientForTests({ from: (t: string) => new FakeQuery(t) } as any)
  const { assertPanVerified, panGateEnabled } = await import('../src/lib/kyc-gate.js')
  const { BookingError } = await import('../src/lib/types.js')

  const refusal = async (u: string) => { try { await assertPanVerified(u, 'post a load'); return null } catch (e) { return e instanceof BookingError ? e : 'other' } }

  console.log('\n── the gate ──')
  check('gate is on by default', panGateEnabled(), '')
  check('a verified PAN passes', (await refusal(U_OK)) === null, '')
  const no = await refusal(U_NO)
  check('no verification → 403 PAN_REQUIRED', no !== null && no !== 'other' && no.code === 'PAN_REQUIRED' && no.httpStatus === 403, JSON.stringify(no))
  check('…the message points at Settings → PAN', typeof no === 'object' && no !== null && /Settings → PAN/.test(no.message), String((no as any)?.message))
  const pend = await refusal(U_PENDING)
  check('a PAN awaiting review does not pass', pend !== null && pend !== 'other' && pend.code === 'PAN_REQUIRED', JSON.stringify(pend))
  const bid = await (async () => { try { await assertPanVerified(U_NO, 'bid on a load'); return null } catch (e) { return (e as Error).message } })()
  check('the bid wording names the action', /bid on a load/.test(bid ?? ''), String(bid))

  console.log('\n── switched off ──')
  process.env.PAN_GATE = 'off'
  check('PAN_GATE=off lets everyone through (tests, simulations)', (await refusal(U_NO)) === null && !panGateEnabled(), '')

  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch((e) => { console.error(e); process.exit(1) })
