#!/usr/bin/env node
// =============================================================================
//  drive-gps.mjs — replay a GPS track for a real booking against the LIVE stack
// =============================================================================
// Simulates a driver's phone posting GPS to the live gateway so you can watch a truck move on
// the fleet console (/map) or the shipper's live-track map without actually driving.
//
// It exercises the real production path end to end:
//   driver JWT -> gateway /api/location/update -> bt-booking-service
//     -> Redis  `loc:driver:<drivers.id>`      (live position, 30s TTL)
//     -> Redis  `loc:bc-gate:<bookingId>`      (SET NX EX 12 throttle gate)
//     -> Postgres `location_history`           (durable breadcrumb, ~1 per 12s)
//
// The 30s TTL is why the console shows "0 reporting" moments after you stop: that is correct
// behaviour, not a bug. Keep this running to keep the truck alive on the map.
//
// USAGE
//   node scripts/qa/drive-gps.mjs                     # auto-pick an in_transit fleet booking
//   node scripts/qa/drive-gps.mjs <bookingId>         # a specific booking
//   INTERVAL_MS=5000 node scripts/qa/drive-gps.mjs    # post faster (breadcrumbs still gate at 12s)
//
// Reads JWT_SECRET / SUPABASE_* from the live bt-booking-service Cloud Run env, so it needs an
// authenticated gcloud session and prints no secrets.
// =============================================================================
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'

const PROJECT = process.env.PROJECT || 'project-aa0faf06-c115-438a-a36'
const REGION = process.env.REGION || 'asia-south1'
const GW = process.env.GATEWAY_URL || 'https://bt-gateway-itcdoenefa-el.a.run.app'
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 13_000)

const env = Object.fromEntries(JSON.parse(execFileSync('gcloud', ['run', 'services', 'describe',
  'bt-booking-service', `--region=${REGION}`, `--project=${PROJECT}`,
  '--format=json(spec.template.spec.containers[0].env)'], { encoding: 'utf8' }))
  .spec.template.spec.containers[0].env.map(e => [e.name, e.value ?? '']))
const { SUPABASE_URL: U, SUPABASE_SERVICE_ROLE_KEY: K, JWT_SECRET } = env
if (!U || !K || !JWT_SECRET) { console.error('FATAL: could not read env from bt-booking-service'); process.exit(1) }

const rest = async (p) => {
  const r = await fetch(`${U}/rest/v1/${p}`, { headers: { apikey: K, Authorization: `Bearer ${K}` } })
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${await r.text()}`)
  return r.json()
}
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
function mint(userId, role) {
  const now = Math.floor(Date.now() / 1000)
  const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ userId, role, iat: now, exp: now + 6 * 3600 })
  return `${h}.${p}.${crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url')}`
}

// ── pick the booking ─────────────────────────────────────────────────────────
let bookingId = process.argv[2]
if (!bookingId) {
  const owner = (await rest('fleet_owners?select=id,company_name'))[0]
  const affiliated = (await rest(`fleet_drivers?select=driver_id&fleet_owner_id=eq.${owner.id}&status=eq.active`))
    .map(a => a.driver_id)
  const inTransit = await rest('bookings?select=id,driver_id&status=eq.in_transit&limit=50')
  const hit = inTransit.find(b => affiliated.includes(b.driver_id))
  if (!hit) { console.error('No in_transit booking for an active fleet driver. Pass a bookingId.'); process.exit(1) }
  bookingId = hit.id
  console.log(`fleet   : ${owner.company_name}`)
}

const booking = (await rest(`bookings?select=id,status,driver_id&id=eq.${bookingId}`))[0]
if (!booking) { console.error(`booking ${bookingId} not found`); process.exit(1) }
if (booking.status !== 'in_transit') console.warn(`WARN booking is '${booking.status}', not 'in_transit' — the map only shows in-transit trucks`)
const drv = (await rest(`drivers?select=id,user_id&id=eq.${booking.driver_id}`))[0]
const usr = (await rest(`users?select=id,full_name,email&id=eq.${drv.user_id}`))[0]

console.log(`driver  : ${usr.full_name} <${usr.email}>`)
console.log(`booking : ${booking.id} (${booking.status})`)
console.log(`posting every ${INTERVAL_MS / 1000}s — breadcrumbs gate at 12s. Ctrl-C to stop.\n`)

// ── drive ────────────────────────────────────────────────────────────────────
// Nagpur → north-east along the corridor. Roughly 180 m per step at a 13s cadence ≈ 50 km/h.
const token = mint(usr.id, 'driver')
let lat = 21.1458, lng = 79.0882, n = 0
const started = (await rest(`location_history?select=id&booking_id=eq.${booking.id}`)).length

process.on('SIGINT', async () => {
  const now = (await rest(`location_history?select=id&booking_id=eq.${booking.id}`)).length
  console.log(`\nstopped. breadcrumbs: ${started} -> ${now} (+${now - started}) after ${n} points posted.`)
  console.log('Live position expires from Redis 30s after the last post — the map going quiet is correct.')
  process.exit(0)
})

for (;;) {
  lat += 0.0013; lng += 0.0023; n++
  const body = { lat: +lat.toFixed(6), lng: +lng.toFixed(6), heading: 45, speed_kmh: 50 + (n % 9), accuracy_m: 7, booking_id: booking.id }
  try {
    const r = await fetch(`${GW}/api/location/update`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    console.log(`  #${String(n).padStart(3)}  ${body.lat},${body.lng}  ${body.speed_kmh} km/h  -> ${r.status}${r.ok ? '' : ' ' + (await r.text()).slice(0, 120)}`)
  } catch (e) {
    console.log(`  #${n} network error: ${e.message}`)
  }
  await new Promise(s => setTimeout(s, INTERVAL_MS))
}
