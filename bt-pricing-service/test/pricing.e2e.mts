/**
 * T-BE-5 — CTO cost-breakdown + JWT auth. Verifies the deterministic
 * breakdown math against known inputs and the auth boundary via app.inject().
 * Run: npx tsx test/pricing.e2e.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256'
delete process.env.DIESEL_PRICE_INR // ensure default 90 for the base cases

import Fastify from 'fastify'
import jwt from 'jsonwebtoken'
import { readFile } from 'node:fs/promises'

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
}
const tok = () => jwt.sign({ userId: 'u1', role: 'shipper' }, process.env.JWT_SECRET!)

async function main() {
  const { costBreakdown } = await import('../src/lib/cto-cost.js')
  const authPlugin = (await import('../src/plugins/auth.js')).default
  const { QuoteBody, computeQuote } = await import('../src/lib/pricing.js')

  console.log('\n── deterministic breakdown math (known inputs) ──')
  // HCV, 100km @ diesel 90, mileage 3.5:
  //   fuel=ceil(100/3.5*90)=2572; driver=ceil(100/400*1200)=300; opex=ceil(100*8)=800; handling=1000; total=4672
  const hcv = costBreakdown('HCV', 100)
  check('HCV/100 fuel_cost=2572', hcv.fuel_cost === 2572, `(got ${hcv.fuel_cost})`)
  check('HCV/100 driver_wage=300', hcv.driver_wage === 300, `(got ${hcv.driver_wage})`)
  check('HCV/100 per_km_operating_cost=800', hcv.per_km_operating_cost === 800, `(got ${hcv.per_km_operating_cost})`)
  check('HCV/100 handling=1000', hcv.handling === 1000, `(got ${hcv.handling})`)
  check('HCV/100 operating_cost_total=4672', hcv.operating_cost_total === 4672, `(got ${hcv.operating_cost_total})`)
  check('HCV mileage aligned to tracking D-009 (3.5)', hcv.mileage_kmpl === 3.5)

  // MCV, 200km @ diesel 90, mileage 6.0:
  //   fuel=ceil(200/6*90)=3000; driver=ceil(200/400*1200)=600; opex=ceil(200*6)=1200; handling=800; total=5600
  const mcv = costBreakdown('MCV', 200)
  check('MCV/200 fuel_cost=3000', mcv.fuel_cost === 3000, `(got ${mcv.fuel_cost})`)
  check('MCV/200 operating_cost_total=5600', mcv.operating_cost_total === 5600, `(got ${mcv.operating_cost_total})`)
  check('MCV mileage aligned to tracking D-009 (6.0)', mcv.mileage_kmpl === 6.0)

  console.log('\n── diesel price env-override ──')
  process.env.DIESEL_PRICE_INR = '100'
  const hcv100 = costBreakdown('HCV', 100) // fuel=ceil(100/3.5*100)=2858
  check('diesel override 100 → HCV/100 fuel=2858', hcv100.fuel_cost === 2858 && hcv100.diesel_price_inr === 100, `(got ${hcv100.fuel_cost}/${hcv100.diesel_price_inr})`)
  delete process.env.DIESEL_PRICE_INR

  // Build the real JWT-gated app
  const app = Fastify({ logger: false })
  await app.register(async (authed) => {
    await authed.register(authPlugin)
    authed.post('/quote', async (req, reply) => {
      const body = QuoteBody.safeParse(req.body)
      if (!body.success) return reply.status(400).send({ success: false, error: body.error.errors[0].message, code: 'VALIDATION_ERROR' })
      return reply.send({ success: true, data: computeQuote(body.data) })
    })
  })
  await app.ready()
  const quote = (body: any, token?: string) => app.inject({
    method: 'POST', url: '/quote', headers: token ? { authorization: `Bearer ${token}` } : {}, payload: body,
  })

  console.log('\n── JWT auth boundary (P1 #11) ──')
  let r = await quote({ distance_km: 100, vehicle_type: 'hcv', load_type: 'general', weight_kg: 1000 })
  check('quote without token 401', r.statusCode === 401, `(got ${r.statusCode})`)
  r = await quote({ distance_km: 100, vehicle_type: 'hcv', load_type: 'general', weight_kg: 1000 }, 'not.a.jwt')
  check('quote with bad token 401', r.statusCode === 401, `(got ${r.statusCode})`)

  console.log('\n── /quote returns breakdown + commercial split ──')
  r = await quote({ distance_km: 100, vehicle_type: 'hcv', load_type: 'general', weight_kg: 1000 }, tok())
  check('quote with token 200', r.statusCode === 200, `(got ${r.statusCode})`)
  const d = r.json().data
  // The price is the trip estimate's indicative rate (founder brief, 29 Oct 2026):
  //   trip cost → + 18% carrier return → × 1.05 market correction.
  const e = d?.trip_estimate
  check('quote carries the trip estimate', e && e.trip_cost > 0, JSON.stringify(e)?.slice(0, 200))
  check('total_price is the shipper indicative rate', d?.total_price === e?.shipper_indicative, `(${d?.total_price} vs ${e?.shipper_indicative})`)
  check('carrier estimate = trip cost + 18% of it', e?.carrier_estimate === e?.trip_cost + Math.round(e?.trip_cost * 0.18) && e?.carrier_return_pct === 18, JSON.stringify(e && [e.trip_cost, e.carrier_return, e.carrier_estimate]))
  check('shipper rate = carrier estimate × 1.05', e?.shipper_indicative === Math.round(e?.carrier_estimate * 1.05) && e?.market_correction === 1.05, JSON.stringify(e && [e.carrier_estimate, e.shipper_indicative]))
  check('trip cost is exactly operating + crew + handling + tolls', e?.trip_cost === e?.operating.total + e?.crew.total + e?.handling + e?.tolls.amount)
  check('handling_fee is the estimate\'s handling line', d?.handling_fee === e?.handling, `(${d?.handling_fee} vs ${e?.handling})`)
  check('cost_breakdown still present (vehicle_class for the lock)', d?.cost_breakdown?.vehicle_class === 'HCV', JSON.stringify(d?.cost_breakdown?.vehicle_class))

  console.log('\n── the regression guard: no class may be priced below cost ──')
  for (const vt of ['mini_truck', 'lcv', 'hcv', 'trailer'] as const) {
    for (const km of [50, 1200]) {
      const q = (await quote({ distance_km: km, vehicle_type: vt, load_type: 'general', weight_kg: 1000 }, tok())).json().data
      const cost = q.trip_estimate.trip_cost
      check(`${vt}/${km}km: carrier receives ${q.driver_receives} > trip cost ${cost}`, q.driver_receives > cost && q.driver_receives >= q.trip_estimate.carrier_estimate, '')
    }
  }

  console.log('\n── a fuel move flows through to the price ──')
  const priceAt90 = (await quote({ distance_km: 100, vehicle_type: 'hcv', load_type: 'general', weight_kg: 1000 }, tok())).json().data.total_price
  process.env.DIESEL_PRICE_INR = '120'
  const priceAt120 = (await quote({ distance_km: 100, vehicle_type: 'hcv', load_type: 'general', weight_kg: 1000 }, tok())).json().data.total_price
  delete process.env.DIESEL_PRICE_INR
  check('diesel 90 → 120 raises the HCV price', priceAt120 > priceAt90, `(${priceAt90} → ${priceAt120})`)

  console.log('\n── class mapping assumptions (Q9-flagged) ──')
  r = await quote({ distance_km: 50, vehicle_type: 'mini_truck', load_type: 'general', weight_kg: 500 }, tok())
  check('mini_truck → SCV (assumption)', r.json().data?.cost_breakdown?.vehicle_class === 'SCV', JSON.stringify(r.json().data?.cost_breakdown?.vehicle_class))
  r = await quote({ distance_km: 50, vehicle_type: 'trailer', load_type: 'general', weight_kg: 500 }, tok())
  check('trailer → HCV (assumption)', r.json().data?.cost_breakdown?.vehicle_class === 'HCV', JSON.stringify(r.json().data?.cost_breakdown?.vehicle_class))

  console.log('\n── D-11: the platform price is ADVISORY on an auction ──')
  // The platform does not have a price on an auction — the charge is the winning
  // carrier's bid. Beyond the product decision, a platform that SETS the freight
  // price drifts toward GTA characterisation under Indian GST, which is a tax and
  // cargo-liability event (INDIA_FREIGHT_COMPLIANCE.md §1.3 red line 3, §9.4).
  // Price discovery is safe; price setting is not. These checks are the guard on
  // that line, so pin the classification rather than the arithmetic.
  const base = { distance_km: 100, vehicle_type: 'hcv', load_type: 'general', weight_kg: 1000 }
  const kindOf = async (booking_type?: string) =>
    (await quote(booking_type ? { ...base, booking_type } : base, tok())).json().data

  const auction = await kindOf('auction')
  check('auction → advisory', auction.quote_kind === 'advisory', `(got ${auction.quote_kind})`)
  check('direct → binding', (await kindOf('direct')).quote_kind === 'binding')

  // 'direct' and 'auction' are the WHOLE union — bt-booking-service/src/lib/types.ts
  // is the canonical declaration, shipper/ and driver/ mirror it, and the column has
  // never held anything else. An earlier draft of this service invented a third,
  // 'instant'. Pin its absence: a value this service accepts but no booking can ever
  // BE is not harmless spare capacity, it is a second, fictional description of the
  // binding path sitting next to the real one, and it is what the surrounding
  // comments and tests then get written against.
  const invented = await quote({ ...base, booking_type: 'instant' }, tok())
  check("'instant' is not a booking_type in this system", invented.statusCode === 400, `(got ${invented.statusCode})`)

  // The compatibility default. bt-booking-service's quote-lock saga resolves the
  // charge from the locked row and sends no booking_type; if omission ever meant
  // advisory, every direct price would silently come unbound.
  const omitted = await kindOf()
  check('booking_type omitted → binding (existing callers unchanged)', omitted.quote_kind === 'binding', `(got ${omitted.quote_kind})`)

  // The failure mode a bare `=== 'auction'` invites: a typo, a capitalised value
  // or a renamed enum member falls through to binding, and an auction quote
  // quietly becomes a price the platform charges. Reject at the edge instead —
  // a 400 is loud, a silent downgrade is not.
  const typo = await quote({ ...base, booking_type: 'Auction' }, tok())
  check('unknown booking_type rejected, never silently binding', typo.statusCode === 400, `(got ${typo.statusCode})`)

  // Classification must not move the number. If advisory ever became a discount
  // or a range, it would stop being the same benchmark the cost model produced —
  // and the "shown == charged" guarantee on the binding path would be comparing
  // against a different figure than the one the rate card justifies.
  check(
    'advisory and binding price the SAME number (label, not a discount)',
    auction.total_price === omitted.total_price && auction.rate_per_km === omitted.rate_per_km,
    `(${auction.total_price}/${auction.rate_per_km} vs ${omitted.total_price}/${omitted.rate_per_km})`,
  )

  // The disclosure has to travel with the quote. A client left to compose this
  // itself eventually omits it, and an auction number shown without "this is a
  // reference" is the exact fact pattern §1.3 warns about.
  check('advisory basis names the carrier bid as the actual charge', /winning carrier/i.test(auction.basis), `(got ${auction.basis})`)
  check('binding basis states it is the price charged', /price charged/i.test(omitted.basis), `(got ${omitted.basis})`)

  await app.close()
  await advisoryRoundTripFromShipper()

  console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
}

// -----------------------------------------------------------
// D-11 round-trip: an auction quote requested THE WAY THE SHIPPER REQUESTS IT
// must come back advisory AND be stored advisory.
//
// Every check above this point talks to a stand-in /quote mounted on QuoteBody, so
// it proves computeQuote() classifies correctly and proves nothing about what the
// product does. The defect this section exists for lived exactly in that gap: the
// classifier was right, the real route was right, and the shipper's booking form
// sent no booking_type at all. Absent means binding (a deliberate compatibility
// default), production is ~94% auctions, so the effect was to write
// `breakdown_json.quote_kind = 'binding'` — a positive, machine-readable assertion
// that the platform charged that freight — onto the overwhelming majority of
// quotes, on precisely the booking type where INDIA_FREIGHT_COMPLIANCE.md §1.3 red
// line 3 says it must never be asserted. Nothing failed. Nothing 500'd. The suite
// was green. The output was manufactured evidence against us.
//
// So this drives the REAL pricingRoutes with the REAL store, over the shipper's own
// request shape (coords + cargo + booking_type, no distance_km — the shipper never
// sends a distance), and asserts on the row that would hit the DB rather than only
// on the response. Supabase is stubbed at fetch so no database is touched.
// -----------------------------------------------------------
async function advisoryRoundTripFromShipper() {
  console.log('\n── D-11 round-trip: shipper call shape → real route → persisted row ──')

  // getSupabase() is lazy, so setting these now (after the checks above) is enough.
  process.env.SUPABASE_URL = 'http://supabase.stub'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-role-key'

  // Seed the cost engine's norm caches so the route's resolveCostFloor reads them
  // instead of the stubbed supabase — keeps this test offline AND proves the REAL
  // CV-Parc floor now rides on the persisted row (not just the response).
  const { __loadCostEngineFixtures, __resetCostEngineCaches } = await import('../src/lib/cost-engine.js')
  const { CV_PARC_NORMS, CV_PARC_SERVICE_CURVE, FLEET_COST_SETTINGS_DEFAULT } = await import('./fixtures/cv-parc-norms.js')
  __resetCostEngineCaches()
  __loadCostEngineFixtures({ norms: CV_PARC_NORMS, serviceCurve: CV_PARC_SERVICE_CURVE, prices: FLEET_COST_SETTINGS_DEFAULT })

  // Capture what would have been INSERTed. The response is easy to get right and
  // the stored row is what a later reader — an auditor, a settlement job — actually
  // sees, so assert on the row.
  const inserted: any[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(typeof input === 'string' ? input : input?.url ?? '')
    if (!url.includes('/rest/v1/price_quotes')) return realFetch(input, init)
    const sent = JSON.parse(init.body)
    const row = {
      id: `stub-${inserted.length + 1}`,
      created_at: new Date().toISOString(),
      consumed_at: null,
      consumed_by_booking_id: null,
      ...(Array.isArray(sent) ? sent[0] : sent),
    }
    inserted.push(row)
    // PostgREST returns the representation; .single() reads one object.
    return new Response(JSON.stringify(row), { status: 201, headers: { 'content-type': 'application/json' } })
  }) as any

  try {
    const authPlugin = (await import('../src/plugins/auth.js')).default
    const { pricingRoutes } = await import('../src/routes/pricing.js')

    const app = Fastify({ logger: false })
    await app.register(async (authed) => {
      await authed.register(authPlugin)
      await authed.register(pricingRoutes)
    })
    await app.ready()

    // The shipper form's exact payload keys. Mumbai → Delhi so the derived distance
    // is comfortably non-degenerate. Keep this in sync with handleGetQuote() in
    // bt-app/src/app/(app)/post/page.tsx — the static guard below is what tells
    // you when it has drifted.
    const shipperQuote = (booking_type?: string) => app.inject({
      method: 'POST',
      url: '/quote',
      headers: { authorization: `Bearer ${tok()}` },
      payload: {
        source_lat: 19.076, source_lng: 72.8777,
        dest_lat: 28.6139, dest_lng: 77.209,
        vehicle_type: 'hcv',
        load_type: 'general',
        weight_kg: 1000,
        ...(booking_type ? { booking_type } : {}),
      },
    })

    const res = await shipperQuote('auction')
    check('shipper auction quote succeeds against the real route', res.statusCode === 200, `(got ${res.statusCode} ${res.body.slice(0, 160)})`)
    check('shipper auction quote responds advisory', res.json().data?.quote_kind === 'advisory', `(got ${res.json().data?.quote_kind})`)

    // The whole point: the CLASSIFICATION IS WRITTEN DOWN. A response that says
    // advisory while the row says binding leaves the durable record wrong, and the
    // durable record is the part that would be read back against us.
    const row = inserted.at(-1)
    check('shipper auction quote PERSISTS advisory in breakdown_json', row?.breakdown_json?.quote_kind === 'advisory', `(got ${row?.breakdown_json?.quote_kind})`)
    check('persisted advisory row still carries the disclosure sentence', /winning carrier/i.test(row?.breakdown_json?.basis ?? ''), `(got ${row?.breakdown_json?.basis})`)
    // quoted_price is still written on an advisory quote — the row is the record of
    // what the shipper was shown and when. It is just not an amount owed.
    check('advisory row still records the benchmark it showed', typeof row?.quoted_price === 'number' && row.quoted_price > 0, `(got ${row?.quoted_price})`)
    // The real cost floor is resolved in the route and stored alongside the quote.
    check('shipper quote persists the REAL CV-Parc cost floor', typeof row?.breakdown_json?.cost_floor?.floor === 'number' && row.breakdown_json.cost_floor.floor > 0, `(got ${JSON.stringify(row?.breakdown_json?.cost_floor?.floor)})`)

    // The direct half, same route, so "advisory" is demonstrably driven by the input
    // rather than by the real route having quietly stopped classifying at all.
    const directRes = await shipperQuote('direct')
    check('shipper direct quote PERSISTS binding', inserted.at(-1)?.breakdown_json?.quote_kind === 'binding', `(got ${inserted.at(-1)?.breakdown_json?.quote_kind})`)
    check('advisory and binding still the same number through the real route',
      directRes.json().data?.quoted_price === res.json().data?.quoted_price,
      `(${res.json().data?.quoted_price} vs ${directRes.json().data?.quoted_price})`)

    // P1 — the road distance comes from bt-tracking-service when it answers, and falls back to the
    // self-contained haversine estimate when it does not. (Everything above ran with no route
    // client injected, i.e. the fallback path, unchanged from before P1.)
    const { __setRouteDistanceClientForTests } = await import('../src/lib/tracking-client.js')

    __setRouteDistanceClientForTests({ routeDistanceKm: async () => 500 })
    const routed = await shipperQuote('direct')
    check('quote uses the ROUTED distance when tracking answers', routed.json().data?.distance_basis === 'routed', `(got ${routed.json().data?.distance_basis})`)
    check('the routed distance is exactly what tracking returned (not haversine)', inserted.at(-1)?.distance_km === 500, `(got ${inserted.at(-1)?.distance_km})`)

    __setRouteDistanceClientForTests({ routeDistanceKm: async () => { throw new Error('tracking unreachable') } })
    const fell = await shipperQuote('direct')
    check('quote FALLS BACK to the haversine estimate when tracking throws (never 500)', fell.statusCode === 200 && fell.json().data?.distance_basis === 'estimated', `(got ${fell.statusCode}/${fell.json().data?.distance_basis})`)
    check('the fallback distance is the haversine value, not the routed one', inserted.at(-1)?.distance_km !== 500 && (inserted.at(-1)?.distance_km ?? 0) > 0, `(got ${inserted.at(-1)?.distance_km})`)

    // Route tolls: tracking reports Google's CAR toll; the estimate scales it to the truck's axle
    // class (hcv → HCV Cargo 25-31T → 3-axle, 2.40 / 0.65 of a car).
    __setRouteDistanceClientForTests({ routeDistanceKm: async () => 1400, routeInfo: async () => ({ distance_km: 1400, toll: { status: 'priced', car_toll_inr: 1000 } }) })
    const tolled = (await shipperQuote('direct')).json().data
    check('route tolls priced from the route, at the truck\'s axle rate (₹1000 car → ₹3692)',
      tolled?.trip_estimate?.tolls?.basis === 'route' && tolled.trip_estimate.tolls.amount === Math.round(1000 * 2.4 / 0.65) && tolled.trip_estimate.tolls.axle_class === 'three_axle',
      JSON.stringify(tolled?.trip_estimate?.tolls))
    __setRouteDistanceClientForTests({ routeDistanceKm: async () => 1400, routeInfo: async () => ({ distance_km: 1400, toll: { status: 'unknown' } }) })
    const unknownToll = (await shipperQuote('direct')).json().data
    check('unknown route toll falls back to the class rate (HCV ₹1.80/km × 1400)',
      unknownToll?.trip_estimate?.tolls?.basis === 'class_rate' && unknownToll.trip_estimate.tolls.amount === 2520,
      JSON.stringify(unknownToll?.trip_estimate?.tolls))
    check('the persisted row carries the trip estimate', inserted.at(-1)?.breakdown_json?.trip_estimate?.shipper_indicative === unknownToll?.quoted_price)

    __setRouteDistanceClientForTests(null)

    await app.close()
  } finally {
    globalThis.fetch = realFetch
  }

  // The static half. Everything above proves the SERVICE is correct when the caller
  // sends booking_type; it cannot prove the caller sends it — and that omission was
  // the entire defect. So read the shipper's booking form as text and pin the call
  // site. A cross-package source assertion is unusual, but the coupling is real: the
  // wire default is `binding`, so a silent shipper is not an unlabelled quote, it is
  // a mislabelled one, and no test inside bt-pricing-service can see that happen.
  //
  // Known gap: CI path-filters the bt-pricing-service job on `bt-pricing-service/**`,
  // so a shipper-only PR will not run this. It guards the service side and documents
  // the contract; it is not a merge gate on the app.
  // The pre-unification shipper app was retired (2026-09-26); bt-app's Post a Load page is
  // the one booking form now.
  const formPath = new URL('../../bt-app/src/app/(app)/post/page.tsx', import.meta.url)
  let form: string
  try {
    form = await readFile(formPath, 'utf8')
  } catch {
    // Hard failure, not a skip: tests run from the monorepo checkout, and a silent
    // skip here would restore exactly the blind spot this check exists to close.
    check('shipper booking form is readable (monorepo checkout)', false, `(not found at ${formPath.pathname})`)
    return
  }
  const getQuoteCall = form.slice(form.indexOf('getPriceQuote({'), form.indexOf('setQuote(q)'))
  check(
    'shipper booking form SENDS booking_type when quoting',
    /booking_type:\s*bookingType\b/.test(getQuoteCall),
    '(the form knows its booking type; omitting it stores every auction as binding)',
  )
}

main().catch(err => { console.error(err); process.exit(1) })
