/**
 * Records that used to misreport (18 Oct data-placeholders audit):
 *   - a driver's trip count is COUNTED from finished bookings (drivers.total_trips is never written);
 *   - "Trips observed" on a truck's lane is counted from its finished trips (was always 0);
 *   - a closed loan's EMI is no longer charged; inactive trucks carry no office overhead.
 *
 * Run: npx tsx test/records-truth.unit.mts
 */
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}

type Row = Record<string, any>
const db: Record<string, Row[]> = { bookings: [], vehicles: [], vehicle_lanes: [] }
let failTable: string | null = null
class Q {
  private f: Array<(r: Row) => boolean> = []
  constructor(private t: string) {}
  select() { return this } order() { return this } limit() { return this }
  eq(c: string, v: any) { this.f.push((r) => r[c] === v); return this }
  is(c: string, v: any) { this.f.push((r) => (r[c] ?? null) === v); return this }
  in(c: string, vs: any[]) { this.f.push((r) => vs.includes(r[c])); return this }
  private rows() { return (db[this.t] ?? []).filter((r) => this.f.every((fn) => fn(r))) }
  maybeSingle() { return Promise.resolve({ data: this.rows()[0] ?? null, error: null }) }
  then(res: (v: any) => void) { return Promise.resolve(failTable === this.t ? { data: null, error: { message: 'boom' } } : { data: this.rows(), error: null }).then(res) }
}

async function main() {
  const { __setFleetSupabaseForTests } = await import('../src/lib/supabase.js')
  __setFleetSupabaseForTests({ from: (t: string) => new Q(t) } as any)
  const { completedTripCounts } = await import('../src/lib/fleet-repo.js')
  const { countLaneTrips, listVehicleLanes, LANE_MATCH_KM } = await import('../src/lib/vehicles-repo.js')
  const { loanActive, monthlyFixedForVehicle, overheadSharePerActive } = await import('../src/lib/analytics.js')

  console.log('\n── driver trip counts ──')
  db.bookings = [
    { driver_id: 'D1', status: 'completed' }, { driver_id: 'D1', status: 'paid' }, { driver_id: 'D1', status: 'in_transit' },
    { driver_id: 'D1', status: 'cancelled' }, { driver_id: 'D2', status: 'paid' },
  ]
  const c = await completedTripCounts(['D1', 'D2', 'D3'])
  check('counts completed + paid trips only (D1: 2)', c?.get('D1') === 2, JSON.stringify([...(c ?? [])]))
  check('D2: 1; a driver with none: 0 (not missing)', c?.get('D2') === 1 && c?.get('D3') === 0)
  failTable = 'bookings'
  check('a failed count returns null — callers keep the stored value instead of a wrong 0', (await completedTripCounts(['D1'])) === null)
  failTable = null

  console.log('\n── lane trips observed ──')
  const lane = { id: 'L1', origin_city: 'Pune', destination_city: 'Mumbai', origin_lat: 18.52, origin_lng: 73.86, dest_lat: 19.07, dest_lng: 72.88 }
  const trips = [
    { source_address: 'Hinjewadi, Pune, MH', destination_address: 'Andheri, Mumbai, MH', source_lat: null, source_lng: null, dest_lat: null, dest_lng: null },
    { source_address: 'Chakan MIDC', destination_address: 'Bhiwandi', source_lat: 18.6, source_lng: 73.85, dest_lat: 19.2, dest_lng: 73.0 }, // by coordinates
    { source_address: 'Nashik', destination_address: 'Mumbai', source_lat: 20.0, source_lng: 73.79, dest_lat: 19.07, dest_lng: 72.88 },     // wrong origin
    { source_address: 'Mumbai', destination_address: 'Pune', source_lat: 19.07, source_lng: 72.88, dest_lat: 18.52, dest_lng: 73.86 },      // reverse direction
  ]
  check(`matches by city name or within ${LANE_MATCH_KM} km; wrong origin and reverse trips do not count (2)`, countLaneTrips(lane as any, trips as any) === 2, String(countLaneTrips(lane as any, trips as any)))
  db.vehicle_lanes = [{ ...lane, vehicle_id: 'V1', is_primary: true, trips_observed: 0 }]
  db.vehicles = [{ id: 'V1', driver_id: null, fleet_owner_id: 'F1' }]
  db.bookings = trips.map((t, i) => ({ ...t, vehicle_id: 'V1', status: i === 0 ? 'in_transit' : 'completed' }))
  const listed = await listVehicleLanes('V1') as any[]
  check('the lane list shows the COUNT (only finished trips: 1), not the stored 0', listed[0].trips_observed === 1, JSON.stringify(listed[0]))
  db.vehicles = [{ id: 'V2', driver_id: 'DS', fleet_owner_id: null }]
  db.vehicle_lanes = [{ ...lane, id: 'L2', vehicle_id: 'V2', is_primary: true, trips_observed: 0 }]
  db.bookings = [{ ...trips[0], driver_id: 'DS', fleet_owner_id: null, vehicle_id: null, status: 'paid' }]
  check("a solo truck's lane counts its driver's own trips", ((await listVehicleLanes('V2')) as any[])[0].trips_observed === 1)

  console.log('\n── loans and overhead ──')
  const asOf = new Date('2026-10-25T00:00:00Z')
  const base = { emi_amount_inr: 30000, insurance_annual_inr: 12000, permit_annual_inr: 0, fitness_annual_inr: 0 }
  check('a running loan is charged', loanActive({ ...base, end_date: '2028-01-01' }, asOf) && monthlyFixedForVehicle({ ...base, end_date: '2028-01-01' }, 0, asOf).emi === 30000)
  check('past its end date → no EMI', monthlyFixedForVehicle({ ...base, end_date: '2026-03-31' }, 0, asOf).emi === 0)
  check('nothing outstanding → no EMI', monthlyFixedForVehicle({ ...base, outstanding_inr: 0 }, 0, asOf).emi === 0)
  check('start + tenure behind us → no EMI', monthlyFixedForVehicle({ ...base, start_date: '2021-01-01', tenure_months: 48 }, 0, asOf).emi === 0)
  check('no loan paperwork at all → still charged (a live loan must not be missed)', monthlyFixedForVehicle(base, 0, asOf).emi === 30000)
  const closed = monthlyFixedForVehicle({ ...base, end_date: '2026-03-31' }, 500, asOf)
  check('insurance and overhead still count on a paid-off truck', closed.total === 12000 / 12 + 500, String(closed.total))
  check('overhead split across ACTIVE trucks only (₹30,000 / 2 active)', overheadSharePerActive(30000, [{ is_active: true }, { is_active: true }, { is_active: false }]) === 15000)
  check('a truck with no is_active value counts as active (old rows)', overheadSharePerActive(30000, [{}, { is_active: true }]) === 15000)
  check('no active trucks → no share (no divide by zero)', overheadSharePerActive(30000, [{ is_active: false }]) === 0)

  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
}
main().catch((e) => { console.error(e); process.exit(1) })
