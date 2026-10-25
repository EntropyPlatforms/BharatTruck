/**
 * E-way bill form defaults (18 Oct audit: "GST rate defaults to 5%; distance is typed by hand").
 * Pins: the GST rate is read from the shipper's own tax invoice (null when it is not a standard
 * rate — the form then makes them choose); the distance comes from the trip's routed km, else the
 * quote's, else null.
 * Run: npx tsx test/ewb-defaults.unit.mts
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
const db: Record<string, Row[]> = { trip_routes: [], price_quotes: [] }
class Q {
  private f: Array<[string, any]> = []
  constructor(private t: string) {}
  select() { return this } limit() { return this }
  eq(c: string, v: any) { this.f.push([c, v]); return this }
  maybeSingle() { return Promise.resolve({ data: (db[this.t] ?? []).find((r) => this.f.every(([c, v]) => r[c] === v)) ?? null, error: null }) }
}

async function main() {
  const { __setSupabaseClientForTests } = await import('../src/lib/supabase.js')
  __setSupabaseClientForTests({ from: (t: string) => new Q(t) } as any)
  const { invoiceGstRate, tripDistanceKm } = await import('../src/lib/ewb/service.js')

  console.log('\n── GST rate from the invoice ──')
  check('intra-state 5% (CGST 2.5 + SGST 2.5) → 5', invoiceGstRate({ taxable_value_inr: '10000.00', cgst_inr: '250.00', sgst_inr: '250.00', igst_inr: '0' }) === 5)
  check('inter-state 18% (IGST) → 18', invoiceGstRate({ taxable_value_inr: 50000, igst_inr: 9000 }) === 18)
  check('a paisa of rounding still lands on the rate (89.99 + 90.00 on 1000 → 18)', invoiceGstRate({ taxable_value_inr: '1000.00', cgst_inr: '89.99', sgst_inr: '90.00' }) === 18)
  check('exempt goods (no tax) → 0', invoiceGstRate({ taxable_value_inr: 10000 }) === 0)
  check('a non-standard rate → null (the shipper must choose)', invoiceGstRate({ taxable_value_inr: 1000, igst_inr: 70 }) === null)
  check('no invoice → null', invoiceGstRate(null) === null)

  console.log('\n── distance ──')
  check('no route and no quote → null (type it)', (await tripDistanceKm('B1')) === null)
  db.price_quotes = [{ consumed_by_booking_id: 'B1', distance_km: '148.6' }]
  check('falls back to the quote\'s distance (149 km)', (await tripDistanceKm('B1')) === 149)
  db.trip_routes = [{ booking_id: 'B1', distance_m: 152_400 }]
  check('the routed distance wins (152 km)', (await tripDistanceKm('B1')) === 152)
  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) process.exit(1)
}
main().catch((e) => { console.error(e); process.exit(1) })
