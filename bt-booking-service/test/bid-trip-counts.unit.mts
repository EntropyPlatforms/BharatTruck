/**
 * Bid cards show a driver's finished trips COUNTED from bookings (18 Oct audit): the stored
 * drivers.total_trips is written only by a database function nothing calls, so it read 0.
 * Run: npx tsx test/bid-trip-counts.unit.mts
 */
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}
type Row = Record<string, any>
const B = '11111111-1111-4111-8111-111111111111'
const db: Record<string, Row[]> = {
  quotes: [
    { id: 'Q1', booking_id: B, driver_id: 'D1', fleet_owner_id: null, submitted_at: '2026-10-20T10:00:00Z', driver: { id: 'D1', truck_number: 'MH12AB1234', average_rating: '0.00', total_trips: '0', user: { full_name: 'Ravi' } }, fleet_owner: null },
    { id: 'Q2', booking_id: B, driver_id: null, fleet_owner_id: 'F1', submitted_at: '2026-10-20T09:00:00Z', driver: null, fleet_owner: { id: 'F1', company_name: 'Patil Roadways' } },
  ],
  bookings: [
    { driver_id: 'D1', status: 'completed' }, { driver_id: 'D1', status: 'paid' }, { driver_id: 'D1', status: 'paid' }, { driver_id: 'D1', status: 'accepted' },
  ],
}
class Q {
  private f: Array<(r: Row) => boolean> = []
  constructor(private t: string) {}
  select() { return this } order() { return this }
  eq(c: string, v: any) { this.f.push((r) => r[c] === v); return this }
  in(c: string, vs: any[]) { this.f.push((r) => vs.includes(r[c])); return this }
  then(res: (v: any) => void) { return Promise.resolve({ data: (db[this.t] ?? []).filter((r) => this.f.every((fn) => fn(r))), error: null }).then(res) }
}

async function main() {
  const { __setSupabaseClientForTests } = await import('../src/lib/supabase.js')
  __setSupabaseClientForTests({ from: (t: string) => new Q(t) } as any)
  const { listQuotesForBooking } = await import('../src/lib/quote-repository.js')
  const quotes = await listQuotesForBooking(B, { seeAllQuotes: true })
  const solo = quotes.find((q) => q.carrier?.kind === 'driver')
  const fleet = quotes.find((q) => q.carrier?.kind === 'fleet')
  check('a solo driver\'s bid shows 3 finished trips (counted), not the stored 0', solo?.carrier?.total_trips === 3, JSON.stringify(solo?.carrier))
  check('a fleet bid still carries no per-driver trip count', fleet?.carrier?.total_trips === null, JSON.stringify(fleet?.carrier))
  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) process.exit(1)
}
main().catch((e) => { console.error(e); process.exit(1) })
