#!/usr/bin/env node
// =============================================================================
//  trip-e2e.mjs — drive ONE real booking through the LIVE stack, end to end
// =============================================================================
// Proves the Completed-Paid-Trip path with real REST calls through the gateway, and asserts the
// DB side-effect after every step. No UI. This is the "does the backend actually work" test.
//
//   shipper logs in ─▶ price quote ─▶ post booking ─▶ driver logs in ─▶ driver bids
//     ─▶ shipper awards ─▶ driver starts ─▶ GPS ─▶ POD OTP emailed ─▶ verify ─▶ settle
//
// The POD step emails a 6-digit code to the booking's receiver_email. Run in two passes:
//   PASS 1 (no OTP):  node scripts/qa/trip-e2e.mjs
//                     -> runs through request-otp, prints the booking id, stops.
//   PASS 2 (w/ OTP):  OTP=123456 BOOKING=<id> node scripts/qa/trip-e2e.mjs
//                     -> resumes an existing in-flight booking, verifies OTP, settles.
//
// Reads JWT_SECRET / SUPABASE_* from the live bt-booking-service Cloud Run env. Prints no secrets.
// =============================================================================
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'

const PROJECT = 'project-aa0faf06-c115-438a-a36'
const GW = 'https://bt-gateway-itcdoenefa-el.a.run.app'
const RECEIVER = process.env.RECEIVER // the inbox the delivery OTP lands in (required)
if (!RECEIVER) { console.error('Set RECEIVER=<inbox you can read> — the delivery OTP is emailed there.'); process.exit(1) }
const OTP = process.env.OTP || null
const RESUME_BOOKING = process.env.BOOKING || null

// ── live secrets (names/values never printed) ────────────────────────────────
const env = Object.fromEntries(JSON.parse(execFileSync('gcloud', ['run', 'services', 'describe',
  'bt-booking-service', '--region=asia-south1', `--project=${PROJECT}`,
  '--format=json(spec.template.spec.containers[0].env)'], { encoding: 'utf8' }))
  .spec.template.spec.containers[0].env.map(e => [e.name, e.value ?? '']))
const { SUPABASE_URL: U, SUPABASE_SERVICE_ROLE_KEY: K, JWT_SECRET } = env

// ── helpers ──────────────────────────────────────────────────────────────────
const c = (s) => s // color noop
let step = 0
function log(title) { console.log(`\n${'═'.repeat(72)}\n▶ STEP ${++step}: ${title}\n${'─'.repeat(72)}`) }
function ok(m) { console.log(`   ✅ ${m}`) }
function bad(m) { console.log(`   ❌ ${m}`) }
function info(m) { console.log(`   • ${m}`) }

async function api(method, path, { token, body } = {}) {
  // Only set content-type when there IS a body — Fastify rejects a body-less request that still
  // declares application/json (FST_ERR_CTP_EMPTY_JSON_BODY). The award/start PATCHes take no body.
  const headers = {}
  if (body) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${GW}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  let json = null; const text = await res.text()
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, ok: res.ok, json, text }
}
const rest = async (p, init) => {
  const r = await fetch(`${U}/rest/v1/${p}`, { ...init, headers: { apikey: K, Authorization: `Bearer ${K}`, 'content-type': 'application/json', Prefer: 'return=representation', ...(init?.headers || {}) } })
  const t = await r.text(); return t ? JSON.parse(t) : null
}
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
function mint(userId, role) {
  const now = Math.floor(Date.now() / 1000)
  const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ userId, role, iat: now, exp: now + 3 * 3600 })
  return `${h}.${p}.${crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url')}`
}
// Real login (proves the password path); fall back to a minted token if the login path errors.
async function auth(email, password, role, userId) {
  const r = await api('POST', '/api/auth/email/login', { body: { email, password } })
  const d = r.json?.data || r.json || {}
  const tok = d.access_token || d.accessToken || d.token
  if (r.ok && tok) { ok(`login ${email} → real JWT (role ${d.user?.role || role})`); return { token: tok, via: 'login' } }
  bad(`login ${email} → HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 140)}`)
  info(`falling back to a minted ${role} token to continue the trip`)
  return { token: mint(userId, role), via: 'mint' }
}
const bookingStatus = async (id) => (await rest(`bookings?select=status,driver_id,quoted_price&id=eq.${id}`))[0]

// ── actors (seeded, verified) ────────────────────────────────────────────────
// Independent (non-fleet) driver: a fleet driver is correctly blocked from bidding directly
// (the owner bids + assigns), so the shipper→driver→POD→settle path uses an independent driver.
const SHIPPER = { email: 'demo-shipper@bharattruck.dev', pw: 'demo-shipper-2026' }
const DRIVER = { email: 'demo-driver@bharattruck.dev', pw: 'demo-driver-2026' }

// resolve their ids from the DB (for mint fallback + assertions)
const shipperUser = (await rest(`users?select=id,role&email=eq.${encodeURIComponent(SHIPPER.email)}`))[0]
const driverUser = (await rest(`users?select=id,role&email=eq.${encodeURIComponent(DRIVER.email)}`))[0]
const driverRow = (await rest(`drivers?select=id&user_id=eq.${driverUser.id}`))[0]

console.log(`\n╔══ BharatTruck end-to-end trip test (LIVE) ══╗`)
console.log(`  shipper : ${SHIPPER.email} (users.id ${shipperUser.id})`)
console.log(`  driver  : ${DRIVER.email} (users.id ${driverUser.id}, drivers.id ${driverRow.id})`)
console.log(`  receiver: ${RECEIVER}`)

// ═══════════════════════════════════════════════════════════════════════════
// AUTH surface probe (what's present / missing) — the user asked to assess this
// ═══════════════════════════════════════════════════════════════════════════
log('AUTH surface probe')
{
  const forgot = await api('POST', '/api/auth/forgot-password', { body: { email: SHIPPER.email } })
  const reset = await api('POST', '/api/auth/reset-password', { body: { token: 'x', password: 'y' } })
  info(`POST /api/auth/forgot-password → ${forgot.status} ${forgot.status === 404 ? '(MISSING — no password recovery)' : ''}`)
  info(`POST /api/auth/reset-password  → ${reset.status} ${reset.status === 404 ? '(MISSING)' : ''}`)
  const refresh = await api('POST', '/api/auth/refresh', { body: { refreshToken: 'x' } })
  info(`POST /api/auth/refresh         → ${refresh.status} (present: ${refresh.status !== 404})`)
}

// ═══════════════════════════════════════════════════════════════════════════
const shipper = await auth(SHIPPER.email, SHIPPER.pw, 'shipper', shipperUser.id)
const driver = await auth(DRIVER.email, DRIVER.pw, 'driver', driverUser.id)

let bookingId = RESUME_BOOKING

if (!bookingId) {
  // STEP: price quote (shipper) ────────────────────────────────────────────
  log('Shipper gets a price quote (bt-pricing-service)')
  const route = { source_lat: 19.0760, source_lng: 72.8777, dest_lat: 28.7041, dest_lng: 77.1025 } // Mumbai→Delhi
  const q = await api('POST', '/api/pricing/quote', {
    token: shipper.token,
    body: { ...route, vehicle_type: 'hcv', load_type: 'general', weight_kg: 12000 },
  })
  if (!q.ok) { bad(`quote failed HTTP ${q.status}: ${q.text.slice(0, 200)}`); process.exit(1) }
  const quoteId = q.json?.data?.quote_id || q.json?.quote_id
  const price = q.json?.data?.total ?? q.json?.data?.price ?? q.json?.data?.quoted_price
  ok(`quote_id ${quoteId}  price ₹${price}`)
  info(`pricing breakdown: ${JSON.stringify(q.json?.data).slice(0, 200)}`)

  // STEP: create booking (shipper) ───────────────────────────────────────────
  log('Shipper posts the booking (auction)')
  const today = new Date(); today.setUTCDate(today.getUTCDate() + 1)
  const pickup_date = today.toISOString().slice(0, 10)
  const deadline = new Date(Date.now() + 6 * 3600 * 1000).toISOString()
  const cb = await api('POST', '/api/bookings/', {
    token: shipper.token,
    body: {
      quote_id: quoteId,
      source_address: 'Bhiwandi Warehouse, Mumbai', source_lat: 19.0760, source_lng: 72.8777,
      destination_address: 'Narela Industrial Area, Delhi', dest_lat: 28.7041, dest_lng: 77.1025,
      load_type: 'general', weight_kg: 12000, vehicle_type: 'hcv',
      pickup_date, receiver_email: RECEIVER,
      booking_type: 'auction', auction_deadline: deadline,
    },
  })
  if (!cb.ok) { bad(`create booking failed HTTP ${cb.status}: ${cb.text.slice(0, 300)}`); process.exit(1) }
  bookingId = cb.json?.data?.id || cb.json?.id
  ok(`booking ${bookingId} created`)
  const st = await bookingStatus(bookingId)
  info(`DB: bookings.status=${st?.status}, quoted_price=₹${st?.quoted_price}, driver_id=${st?.driver_id ?? 'null'}`)

  // STEP: driver bids ─────────────────────────────────────────────────────────
  log('Driver submits a quote/bid')
  const bid = await api('POST', `/api/bookings/${bookingId}/quotes`, {
    token: driver.token, body: { amount: 83500, message: 'Available, BS6 HCV, can start today.' },
  })
  if (!bid.ok) { bad(`bid failed HTTP ${bid.status}: ${bid.text.slice(0, 300)}`); process.exit(1) }
  const quoteRow = bid.json?.data?.id || bid.json?.id
  ok(`quote ${quoteRow} submitted (₹83,500)`)
  const qcount = (await rest(`quotes?select=id&booking_id=eq.${bookingId}`)).length
  info(`DB: quotes rows for booking = ${qcount}`)

  // STEP: shipper awards ──────────────────────────────────────────────────────
  log('Shipper awards the quote (auction → accepted)')
  const award = await api('PATCH', `/api/bookings/${bookingId}/quotes/${quoteRow}/accept`, { token: shipper.token })
  if (!award.ok) { bad(`award failed HTTP ${award.status}: ${award.text.slice(0, 300)}`); process.exit(1) }
  let st2 = await bookingStatus(bookingId)
  ;(st2?.status === 'accepted' && st2?.driver_id) ? ok(`DB: status=accepted, driver_id=${st2.driver_id}`) : bad(`DB: status=${st2?.status}, driver_id=${st2?.driver_id}`)

  // STEP: driver starts ───────────────────────────────────────────────────────
  log('Driver starts the trip (accepted → in_transit)')
  const start = await api('PATCH', `/api/bookings/${bookingId}/start`, { token: driver.token })
  if (!start.ok) { bad(`start failed HTTP ${start.status}: ${start.text.slice(0, 300)}`); process.exit(1) }
  let st3 = await bookingStatus(bookingId)
  st3?.status === 'in_transit' ? ok(`DB: status=in_transit`) : bad(`DB: status=${st3?.status}`)

  // STEP: GPS ─────────────────────────────────────────────────────────────────
  log('Driver posts GPS (Redis live + location_history breadcrumb)')
  const before = (await rest(`location_history?select=id&booking_id=eq.${bookingId}`)).length
  const g = await api('POST', '/api/location/update', {
    token: driver.token, body: { lat: 20.5, lng: 75.0, heading: 20, speed_kmh: 55, accuracy_m: 8, booking_id: bookingId },
  })
  g.ok ? ok(`GPS accepted HTTP ${g.status}`) : bad(`GPS HTTP ${g.status}: ${g.text.slice(0, 160)}`)
  const after = (await rest(`location_history?select=id&booking_id=eq.${bookingId}`)).length
  info(`DB: location_history for booking ${before} → ${after}`)

  // STEP: POD request-otp ─────────────────────────────────────────────────────
  log('Driver requests the POD OTP (emails the receiver)')
  const ro = await api('POST', '/api/cargo/pod/request-otp', { token: driver.token, body: { booking_id: bookingId } })
  ro.ok ? ok(`request-otp HTTP ${ro.status} → OTP emailed to ${RECEIVER}`) : bad(`request-otp HTTP ${ro.status}: ${ro.text.slice(0, 240)}`)
  info(`response: ${JSON.stringify(ro.json).slice(0, 200)}`)

  console.log(`\n${'═'.repeat(72)}`)
  console.log(`PASS 1 complete. Booking ${bookingId} is in_transit with an OTP emailed to ${RECEIVER}.`)
  console.log(`Fetch the OTP, then run:\n   OTP=<code> BOOKING=${bookingId} node scripts/qa/trip-e2e.mjs`)
  console.log(`${'═'.repeat(72)}`)
  process.exit(0)
}

// ═══════════════════════════════════════════════════════════════════════════
// PASS 2 — verify OTP + settle (resume an in-flight booking)
// ═══════════════════════════════════════════════════════════════════════════
if (!OTP) { bad('BOOKING set but no OTP — pass OTP=<code>'); process.exit(1) }

log(`Resuming booking ${bookingId} — receiver verifies the OTP`)
const podBefore = (await rest(`pod_receipts?select=id&booking_id=eq.${bookingId}`)).length
const v = await api('POST', '/api/cargo/pod/verify-otp', { body: { booking_id: bookingId, otp: OTP } })
v.ok ? ok(`verify-otp HTTP ${v.status}`) : bad(`verify-otp HTTP ${v.status}: ${v.text.slice(0, 240)}`)
const st4 = await bookingStatus(bookingId)
st4?.status === 'completed' ? ok(`DB: status=completed`) : bad(`DB: status=${st4?.status} (expected completed)`)
const podAfter = (await rest(`pod_receipts?select=id,booking_id&booking_id=eq.${bookingId}`)).length
podAfter > podBefore ? ok(`DB: pod_receipts ${podBefore} → ${podAfter} — POD PROVEN`) : bad(`DB: pod_receipts unchanged (${podAfter})`)

log('Settle the trip (cash-recorded → paid, writes payments + payout)')
const payBefore = (await rest(`payments?select=id&booking_id=eq.${bookingId}`)).length
const settle = await api('POST', '/api/payments/settle', {
  token: shipper.token,
  body: { booking_id: bookingId, amount: st4?.quoted_price || 83500, mode: 'cash', reference: 'e2e-test' },
})
settle.ok ? ok(`settle HTTP ${settle.status}`) : bad(`settle HTTP ${settle.status}: ${settle.text.slice(0, 240)}`)
const st5 = await bookingStatus(bookingId)
st5?.status === 'paid' ? ok(`DB: status=paid`) : bad(`DB: status=${st5?.status} (expected paid)`)
const payAfter = (await rest(`payments?select=id,amount,mode&booking_id=eq.${bookingId}`))
const payouts = (await rest(`payouts?select=id,payee_type,amount&booking_id=eq.${bookingId}`))
payAfter.length > payBefore ? ok(`DB: payments ${payBefore} → ${payAfter.length} — PAYMENT RECORDED`) : bad(`DB: payments unchanged`)
info(`DB: payments=${JSON.stringify(payAfter).slice(0, 160)}`)
info(`DB: payouts=${JSON.stringify(payouts).slice(0, 160)}`)

console.log(`\n${'═'.repeat(72)}`)
console.log(`RESULT: booking ${bookingId} — status=${st5?.status}, pod_receipts=${podAfter}, payments=${payAfter.length}, payouts=${payouts.length}`)
console.log(`This is the first booking to traverse the full production path if all four are non-zero.`)
console.log(`${'═'.repeat(72)}`)
