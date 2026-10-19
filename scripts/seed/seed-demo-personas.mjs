#!/usr/bin/env node
// =============================================================================
//  seed-demo-personas.mjs — a clean, realistic demo dataset via the REAL API flow
// =============================================================================
// Loginable accounts for every persona (Shipper, Driver, Fleet owner, Distributor),
// populated by driving the actual UI flow through the gateway: fleet profile + trucks
// + invited/accepted drivers, posted loads, bids, and an awarded + assigned +
// in-transit trip with a GPS trail, plus open auctions to bid on.
//
// PURE API — no secrets, no direct DB. Two things the UI relies on that a script
// can't obtain (the email-verify OTP and the phone OTP) are set out-of-band with the
// SQL tool BETWEEN the two phases: email_verified=true so login works, and
// users.phone_number so invite-by-phone works.
//
//   node scripts/seed/seed-demo-personas.mjs register   # create the 5 accounts
//   <SQL: set email_verified=true for the 5, phone_number for the 2 drivers>
//   node scripts/seed/seed-demo-personas.mjs run         # everything else, via API
// =============================================================================
const GW = 'https://bt-gateway-itcdoenefa-el.a.run.app'
const PHASE = process.argv[2] || 'register'

let step = 0
const log = (t) => console.log(`\n▶ ${++step}. ${t}`)
const ok = (m) => console.log(`   ✅ ${m}`)
const warn = (m) => console.log(`   ⚠️  ${m}`)

async function api(method, path, { token, body } = {}) {
  const headers = {}
  if (body) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${GW}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text(); let json = null; try { json = JSON.parse(text) } catch {}
  return { status: res.status, ok: res.ok, json, text, data: json?.data ?? json }
}
async function login(email, password) {
  const r = await api('POST', '/api/auth/email/login', { body: { email, password } })
  if (!r.data?.access_token) { console.error(`login ${email} → ${r.status} ${r.text.slice(0,160)}`); process.exit(1) }
  return { email, token: r.data.access_token, userId: r.data.user?.id }
}

const ACTORS = {
  rajesh: { email: 'rajesh@bharattruck.in', pw: 'rajesh123', name: 'Rajesh Kumar',  role: 'fleet_owner' },
  vijay:  { email: 'vijay@bharattruck.in',  pw: 'vijay123',  name: 'Vijay Singh',   role: 'driver' },
  mahesh: { email: 'mahesh@bharattruck.in', pw: 'mahesh123', name: 'Mahesh Rao',    role: 'driver' },
  anita:  { email: 'anita@bharattruck.in',  pw: 'anita123',  name: 'Anita Desai',   role: 'shipper' },
  deepak: { email: 'deepak@bharattruck.in', pw: 'deepak123', name: 'Deepak Sharma', role: 'fleet_owner' },
}
const PHONES = { 'vijay@bharattruck.in': '+919820011111', 'mahesh@bharattruck.in': '+919820022222' }

// load_type is a pricing enum ('general'|'fragile'|'perishable'|'hazardous'|'heavy_machinery')
// and MUST be identical on the quote and the booking (the server binds them, service.ts).
const consignee = (name, phone, city) => ({ name, phone, city })
const LOADS = [
  { from: 'Bhiwandi Warehouse, Mumbai', to: 'Narela Industrial Area, Delhi', srcLat: 19.29, srcLng: 73.06, dstLat: 28.85, dstLng: 77.09, load: 'fragile', weight: 12000, vtype: 'hcv', type: 'auction', cons: consignee('Rohit Traders', '9812345678', 'Delhi') },
  { from: 'Chakan MIDC, Pune', to: 'Jeedimetla, Hyderabad', srcLat: 18.76, srcLng: 73.86, dstLat: 17.50, dstLng: 78.45, load: 'general', weight: 8000, vtype: 'mini_truck', type: 'auction', cons: consignee('Sai Motors', '9898989898', 'Hyderabad') },
  { from: 'Naroda GIDC, Ahmedabad', to: 'Vashi APMC, Navi Mumbai', srcLat: 23.07, srcLng: 72.66, dstLat: 19.07, dstLng: 73.00, load: 'general', weight: 6000, vtype: 'lcv', type: 'direct', cons: consignee('Mumbai Fabrics', '9876500000', 'Mumbai') },
  { from: 'Peenya, Bengaluru', to: 'Ambattur, Chennai', srcLat: 13.03, srcLng: 77.52, dstLat: 13.11, dstLng: 80.16, load: 'heavy_machinery', weight: 15000, vtype: 'hcv', type: 'auction', cons: consignee('TN Industries', '9812311111', 'Chennai') },
]

async function postLoad(shipper, L) {
  const q = await api('POST', '/api/pricing/quote', { token: shipper.token, body: { source_lat: L.srcLat, source_lng: L.srcLng, dest_lat: L.dstLat, dest_lng: L.dstLng, vehicle_type: L.vtype, load_type: L.load, weight_kg: L.weight, booking_type: L.type } })
  if (!q.data?.quote_id) { warn(`quote ${L.from}→${L.to}: ${q.text.slice(0,140)}`); return }
  const body = { quote_id: q.data.quote_id, source_address: L.from, source_lat: L.srcLat, source_lng: L.srcLng, destination_address: L.to, dest_lat: L.dstLat, dest_lng: L.dstLng, load_type: L.load, weight_kg: L.weight, vehicle_type: L.vtype, pickup_date: new Date(Date.now()+864e5).toISOString().slice(0,10), booking_type: L.type, consignee: L.cons }
  if (L.type === 'auction') body.auction_deadline = new Date(Date.now()+6*3600e3).toISOString()
  const b = await api('POST', '/api/bookings/', { token: shipper.token, body })
  b.ok ? ok(`load ${L.from.split(',')[0]} → ${L.to.split(',')[0]}  [${L.type}]`) : warn(`post ${L.from}: ${b.status} ${b.text.slice(0,160)}`)
}

// ═══════════════════════════════════════════════════════════════════════════════
if (PHASE === 'register') {
  console.log('╔══ SEED phase 1: register the 5 accounts ══╗')
  log('Register (email/password + primary persona)')
  for (const a of Object.values(ACTORS)) {
    const r = await api('POST', '/api/auth/email/register', { body: { email: a.email, password: a.pw, full_name: a.name, role: a.role } })
    ;(r.ok || r.json?.code === 'EMAIL_EXISTS') ? ok(`${a.role.padEnd(11)} ${a.email} (${a.name})`) : warn(`register ${a.email}: ${r.status} ${r.text.slice(0,120)}`)
  }
  console.log('\n✅ phase 1 done → now verify emails + set driver phones via SQL, then run `run`.')
}

// ═══════════════════════════════════════════════════════════════════════════════
if (PHASE === 'run') {
  console.log('╔══ SEED phase 2: fleet + trucks + loads + drivers + a live trip ══╗')
  const A = {}
  log('Login all personas (proves the password path)')
  for (const [k, a] of Object.entries(ACTORS)) { A[k] = { ...(await login(a.email, a.pw)), full_name: a.name }; ok(`${a.role.padEnd(11)} ${a.email}`) }

  log('Fleet owners create their fleet profile (POST /fleet-owners/me — D-32)')
  for (const k of ['rajesh', 'deepak']) {
    const r = await api('POST', '/api/fleet-owners/me', { token: A[k].token, body: {} })
    r.ok ? ok(`${ACTORS[k].name} → fleet profile`) : warn(`fleet-owner ${k}: ${r.status} ${r.text.slice(0,120)}`)
  }

  log('Fleet owner Rajesh — company profile')
  await api('PATCH', '/api/fleet/owners/me', { token: A.rajesh.token, body: { company_name: 'Rajesh Roadlines', gstin: '27ABCDR1234M1Z5', city: 'Mumbai', state: 'Maharashtra', contact_phone: '+919820000001', monthly_overhead_inr: 180000 } })
  ok('Rajesh Roadlines — Mumbai, ₹1.8L/mo overhead')

  log('Fleet owner Rajesh — add 3 trucks')
  const cats = (await api('GET', '/api/fleet/vehicles/model-categories', { token: A.rajesh.token })).data || []
  const catAt = (i) => cats[Math.min(Math.max(i, 0), cats.length - 1)] // cats are plain strings, heaviest last
  const trucks = [
    { rc_number: 'MH12AB3456', model_category: catAt(cats.length - 1), capacity_tons: 16, body_type: 'container', emission_norm: 'BS6', manufacture_year: 2022, fuel_type: 'diesel', rc_expiry: '2027-03-31' },
    { rc_number: 'MH14CD7890', model_category: catAt(4), capacity_tons: 9,  body_type: 'open', emission_norm: 'BS6', manufacture_year: 2021, fuel_type: 'diesel', rc_expiry: '2026-11-30' },
    { rc_number: 'MH01EF2345', model_category: catAt(2), capacity_tons: 4,  body_type: 'closed', emission_norm: 'BS4', manufacture_year: 2020, fuel_type: 'diesel', rc_expiry: '2026-08-31' },
  ]
  for (const t of trucks) { const v = await api('POST', '/api/fleet/vehicles', { token: A.rajesh.token, body: t }); v.ok ? ok(`truck ${t.rc_number} (${t.model_category})`) : warn(`truck ${t.rc_number}: ${v.status} ${v.text.slice(0,140)}`) }

  log('Distributor Deepak — profile + 1 truck (ships AND carries)')
  await api('PATCH', '/api/fleet/owners/me', { token: A.deepak.token, body: { company_name: 'Deepak Distributors', city: 'Surat', state: 'Gujarat', contact_phone: '+919820000002' } })
  const dv = await api('POST', '/api/fleet/vehicles', { token: A.deepak.token, body: { rc_number: 'GJ05GH6789', model_category: catAt(4), capacity_tons: 9, body_type: 'closed', emission_norm: 'BS6', manufacture_year: 2023, fuel_type: 'diesel', rc_expiry: '2027-06-30' } })
  dv.ok ? ok('Deepak Distributors — Surat, 1 truck') : warn(`deepak truck: ${dv.status} ${dv.text.slice(0,120)}`)

  log('Shipper Anita — post 4 loads')
  for (const L of LOADS) await postLoad(A.anita, L)
  log('Distributor Deepak — post 1 load (his own goods)')
  await postLoad(A.deepak, { from: 'Sachin GIDC, Surat', to: 'Bhiwandi, Mumbai', srcLat: 21.08, srcLng: 72.88, dstLat: 19.29, dstLng: 73.06, load: 'general', weight: 7000, vtype: 'lcv', type: 'direct', cons: consignee('Mumbai Retail', '9800011111', 'Mumbai') })

  log('Rajesh invites Vijay & Mahesh; they accept')
  async function affiliate(driverKey) {
    const inv = await api('POST', '/api/fleet/drivers/invite', { token: A.rajesh.token, body: { driver_phone: PHONES[ACTORS[driverKey].email] } })
    if (!inv.ok) { warn(`invite ${driverKey}: ${inv.status} ${inv.text.slice(0,140)}`); return }
    const resp = await api('POST', `/api/fleet/drivers/invites/${inv.data.id}/respond`, { token: A[driverKey].token, body: { action: 'accept' } })
    resp.ok ? ok(`${ACTORS[driverKey].name} affiliated`) : warn(`accept ${driverKey}: ${resp.status} ${resp.text.slice(0,140)}`)
  }
  await affiliate('vijay'); await affiliate('mahesh')

  const vehicles = (await api('GET', '/api/fleet/vehicles', { token: A.rajesh.token })).data || []
  const roster = (await api('GET', '/api/fleet/drivers', { token: A.rajesh.token })).data || []
  const vijayDriverId = roster.find(r => r.phone_number === PHONES['vijay@bharattruck.in'])?.driver_id || roster[0]?.driver_id

  log('Rajesh bids on the open auctions')
  const auctions = (await api('GET', '/api/fleet/auctions', { token: A.rajesh.token })).data?.auctions || []
  const bidOn = {}
  for (const au of auctions) {
    const amt = Math.round((au.quoted_price || 50000) * 1.05)
    const r = await api('POST', `/api/bookings/${au.id}/quotes`, { token: A.rajesh.token, body: { amount: amt, message: 'Available, BS6 truck, can start today.' } })
    r.ok ? (bidOn[au.id] = r.data.id, ok(`bid ₹${amt} on ${au.source_address?.split(',')[0]} → ${au.destination_address?.split(',')[0]}`)) : warn(`bid ${au.id}: ${r.status} ${r.text.slice(0,120)}`)
  }

  log('Award one auction to Rajesh; assign truck+driver; start; GPS trail')
  const target = auctions.find(a => (a.source_address || '').includes('Bhiwandi Warehouse')) || auctions[0]
  if (target && bidOn[target.id] && vehicles[0] && vijayDriverId) {
    const award = await api('PATCH', `/api/bookings/${target.id}/quotes/${bidOn[target.id]}/accept`, { token: A.anita.token })
    award.ok ? ok('awarded to Rajesh Roadlines') : warn(`award: ${award.status} ${award.text.slice(0,160)}`)
    const asg = await api('POST', `/api/fleet/bookings/${target.id}/assign`, { token: A.rajesh.token, body: { driver_id: vijayDriverId, vehicle_id: vehicles[0].id } })
    asg.ok ? ok(`assigned ${vehicles[0].rc_number} + Vijay`) : warn(`assign: ${asg.status} ${asg.text.slice(0,180)}`)
    const start = await api('PATCH', `/api/bookings/${target.id}/start`, { token: A.vijay.token })
    start.ok ? ok('trip started (in_transit)') : warn(`start: ${start.status} ${start.text.slice(0,140)}`)
    for (const p of [{ lat: 19.9, lng: 74.5 }, { lat: 21.7, lng: 75.6 }, { lat: 24.6, lng: 76.8 }, { lat: 26.9, lng: 76.9 }])
      await api('POST', '/api/location/update', { token: A.vijay.token, body: { ...p, heading: 15, speed_kmh: 58, accuracy_m: 8, booking_id: target.id } })
    ok('GPS trail pushed along the corridor')
  } else warn('could not run the trip (missing auction/bid/vehicle/driver)')

  console.log(`\n${'═'.repeat(66)}\n✅ SEED COMPLETE — logins (email / password):`)
  console.log('  🚚 FLEET OWNER   rajesh@bharattruck.in  / rajesh123   ← log in here')
  console.log('  🧑 DRIVER        vijay@bharattruck.in   / vijay123')
  console.log('  🧑 DRIVER        mahesh@bharattruck.in  / mahesh123')
  console.log('  📦 SHIPPER       anita@bharattruck.in   / anita123')
  console.log('  🏬 DISTRIBUTOR   deepak@bharattruck.in  / deepak123')
  console.log('═'.repeat(66))
}

// ═══════════════════════════════════════════════════════════════════════════════
// Idempotent tail: award Anita's Mumbai→Delhi to Rajesh, assign, start, GPS — run
// this alone (after `run`) to close the loop without re-posting loads.
if (PHASE === 'finish') {
  console.log('╔══ Finish: award → assign → start → GPS on the existing Mumbai→Delhi load ══╗')
  const A = {}
  for (const [k, a] of Object.entries(ACTORS)) A[k] = { ...(await login(a.email, a.pw)), full_name: a.name }
  const auctions = (await api('GET', '/api/fleet/auctions', { token: A.rajesh.token, })).data?.auctions || []
  const target = auctions.find(a => (a.source_address || '').includes('Bhiwandi Warehouse'))
  const vehicles = (await api('GET', '/api/fleet/vehicles', { token: A.rajesh.token })).data || []
  const roster = (await api('GET', '/api/fleet/drivers', { token: A.rajesh.token })).data || []
  const vijayDriverId = roster.find(r => r.phone_number === PHONES['vijay@bharattruck.in'])?.driver_id || roster[0]?.driver_id
  const hcv = vehicles.find(v => v.rc_number === 'MH12AB3456') || vehicles[0]
  if (!target) { warn('Mumbai→Delhi auction not found (already awarded?)'); process.exit(0) }
  log(`target ${target.id} — bid ${target.my_bid?.id}`)
  const award = await api('PATCH', `/api/bookings/${target.id}/quotes/${target.my_bid?.id}/accept`, { token: A.anita.token })
  award.ok ? ok('awarded to Rajesh Roadlines') : warn(`award: ${award.status} ${award.text.slice(0,180)}`)
  const asg = await api('POST', `/api/fleet/bookings/${target.id}/assign`, { token: A.rajesh.token, body: { driver_id: vijayDriverId, vehicle_id: hcv?.id } })
  asg.ok ? ok(`assigned ${hcv?.rc_number} + Vijay`) : warn(`assign: ${asg.status} ${asg.text.slice(0,200)}`)
  const start = await api('PATCH', `/api/bookings/${target.id}/start`, { token: A.vijay.token })
  start.ok ? ok('trip started (in_transit)') : warn(`start: ${start.status} ${start.text.slice(0,140)}`)
  for (const p of [{ lat: 19.9, lng: 74.5 }, { lat: 21.7, lng: 75.6 }, { lat: 24.6, lng: 76.8 }, { lat: 26.9, lng: 76.9 }])
    await api('POST', '/api/location/update', { token: A.vijay.token, body: { ...p, heading: 15, speed_kmh: 58, accuracy_m: 8, booking_id: target.id } })
  ok('GPS trail pushed along the Mumbai→Delhi corridor')
}
