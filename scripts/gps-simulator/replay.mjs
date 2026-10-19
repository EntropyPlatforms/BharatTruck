#!/usr/bin/env node
// scripts/gps-simulator/replay.mjs
//
// Route-replay GPS simulator (T-115). Replays a recorded lat/lng path by POSTing to
// the driver location-ingestion endpoint as a demo driver, ~1 point / interval, so
// live tracking (the shipper map) can be exercised WITHOUT a real drive.
//
// Contract (verified against bt-booking-service/src/routes/location.ts, bt-gateway
// nginx.conf, and driver/src/lib/api.ts):
//   POST {api}/api/location/update
//   Authorization: Bearer <driver access_token>
//   Content-Type: application/json
//   body (snake_case): { lat, lng, heading?, speed_kmh?, accuracy_m?, booking_id? }
//   Server derives drivers.id from the token (getDriverByUserId); the token's user
//   MUST be the driver assigned to booking_id, and the booking MUST be 'accepted'
//   or 'in_transit' — otherwise the service returns 403/409 (surfaced by this tool).
//
// Node 20+ (uses global fetch). No dependencies.
//
// Usage:
//   node replay.mjs --booking <uuid> [--path <file>] [--interval 10] \
//        [--api http://localhost:8080] [--token <jwt> | --login-email <e> --login-password <p>] \
//        [--loop] [--dry-run] [--accuracy 8]
//
// Env fallbacks: NEXT_PUBLIC_API_URL/BT_API_BASE, BT_BOOKING_ID, BT_PATH_FILE,
//   BT_INTERVAL, BT_DRIVER_TOKEN, BT_DRIVER_EMAIL, BT_DRIVER_PASSWORD.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── arg parsing ───────────────────────────────────────────────
function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      args[key] = true // boolean flag
    } else {
      args[key] = next
      i++
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

if (args.help || args.h) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 30).join('\n').replace(/^\/\/ ?/gm, ''))
  process.exit(0)
}

const API_BASE = (args.api || process.env.NEXT_PUBLIC_API_URL || process.env.BT_API_BASE || 'http://localhost:8080').replace(/\/$/, '')
const BOOKING_ID = args.booking || process.env.BT_BOOKING_ID || null
const PATH_FILE = resolve(args.path || process.env.BT_PATH_FILE || resolve(__dirname, 'sample-path.json'))
const INTERVAL_S = Number(args.interval || process.env.BT_INTERVAL || 10)
const ACCURACY_M = Number(args.accuracy || 8)
const LOOP = Boolean(args.loop)
const DRY_RUN = Boolean(args['dry-run'])
let TOKEN = args.token || process.env.BT_DRIVER_TOKEN || null
const EMAIL = args['login-email'] || process.env.BT_DRIVER_EMAIL || null
const PASSWORD = args['login-password'] || process.env.BT_DRIVER_PASSWORD || null

// ── validation ────────────────────────────────────────────────
function die(msg) { console.error(`ERROR: ${msg}`); process.exit(1) }

if (!Number.isFinite(INTERVAL_S) || INTERVAL_S <= 0) die('--interval must be a positive number of seconds')
if (!BOOKING_ID && !DRY_RUN) die('--booking <uuid> is required (or run with --dry-run). Without it the truck is not bound to a trip and the shipper map will not move.')
if (!TOKEN && !(EMAIL && PASSWORD) && !DRY_RUN) die('provide --token <jwt> OR --login-email + --login-password (or --dry-run)')

// ── geo helpers (heading + speed when the path omits them) ─────
const toRad = (d) => (d * Math.PI) / 180
const toDeg = (r) => (r * 180) / Math.PI

function haversineKm(a, b) {
  const R = 6371
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function bearingDeg(a, b) {
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat)
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

// ── path loading + normalization ──────────────────────────────
function loadPath(file) {
  let raw
  try { raw = JSON.parse(readFileSync(file, 'utf8')) }
  catch (e) { die(`could not read/parse path file ${file}: ${e.message}`) }

  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.points) ? raw.points : null
  if (!list || list.length === 0) die(`path file ${file} must be a non-empty JSON array (or {points:[...]})`)

  const points = list.map((p, i) => {
    let lat, lng, heading, speed_kmh
    if (Array.isArray(p)) { [lat, lng] = p }
    else { ({ lat, lng, heading, speed_kmh } = p) }
    lat = Number(lat); lng = Number(lng)
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) die(`point ${i}: invalid lat ${lat}`)
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) die(`point ${i}: invalid lng ${lng}`)
    return { lat, lng, heading, speed_kmh }
  })

  // Derive heading/speed for any point that omits them, from the step to the next point.
  for (let i = 0; i < points.length; i++) {
    const cur = points[i]
    const nxt = points[i + 1]
    if (cur.heading == null) cur.heading = nxt ? bearingDeg(cur, nxt) : (points[i - 1]?.heading ?? 0)
    if (cur.speed_kmh == null) {
      cur.speed_kmh = nxt ? Math.round((haversineKm(cur, nxt) / (INTERVAL_S / 3600)) * 10) / 10 : 0
    }
  }
  return points
}

// ── HTTP ──────────────────────────────────────────────────────
async function postJson(path, body, token) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  let json = null
  try { json = await res.json() } catch { /* non-JSON */ }
  return { status: res.status, json }
}

async function login() {
  console.log(`[auth] logging in as ${EMAIL} via ${API_BASE}/api/auth/email/login`)
  const { status, json } = await postJson('/api/auth/email/login', { email: EMAIL, password: PASSWORD })
  if (status !== 200 || !json?.success || !json?.data?.access_token) {
    die(`login failed (HTTP ${status}): ${json?.error || json?.message || 'no access_token in response'}`)
  }
  console.log('[auth] got driver access_token')
  return json.data.access_token
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── main ──────────────────────────────────────────────────────
let stopping = false
process.on('SIGINT', () => { console.log('\n[sim] SIGINT — stopping after current point'); stopping = true })

async function sendPoint(pt, idx, total) {
  const body = {
    lat: pt.lat,
    lng: pt.lng,
    heading: pt.heading,
    speed_kmh: pt.speed_kmh,
    accuracy_m: ACCURACY_M,
    ...(BOOKING_ID ? { booking_id: BOOKING_ID } : {}),
  }
  const label = `[${idx + 1}/${total}] ${pt.lat.toFixed(5)},${pt.lng.toFixed(5)} hdg=${Math.round(pt.heading)} spd=${pt.speed_kmh}km/h`
  if (DRY_RUN) {
    console.log(`DRY  ${label} -> POST ${API_BASE}/api/location/update ${JSON.stringify(body)}`)
    return true
  }
  let { status, json } = await postJson('/api/location/update', body, TOKEN)
  if (status === 401 && EMAIL && PASSWORD) {
    console.log('[auth] 401 — refreshing token')
    TOKEN = await login()
    ;({ status, json } = await postJson('/api/location/update', body, TOKEN))
  }
  const ok = status === 200 && json?.success
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} -> HTTP ${status}${ok ? '' : ' ' + JSON.stringify(json)}`)
  return ok
}

async function main() {
  const points = loadPath(PATH_FILE)
  console.log(`[sim] ${points.length} points from ${PATH_FILE}`)
  console.log(`[sim] api=${API_BASE} booking=${BOOKING_ID || '(none)'} interval=${INTERVAL_S}s loop=${LOOP} dryRun=${DRY_RUN}`)
  if (!TOKEN && !DRY_RUN) TOKEN = await login()

  let sent = 0, failed = 0
  do {
    for (let i = 0; i < points.length; i++) {
      if (stopping) break
      const ok = await sendPoint(points[i], i, points.length)
      ok ? sent++ : failed++
      if (i < points.length - 1 && !stopping) await sleep(INTERVAL_S * 1000)
    }
    if (LOOP && !stopping) await sleep(INTERVAL_S * 1000)
  } while (LOOP && !stopping)

  console.log(`[sim] done: ${sent} sent, ${failed} failed`)
  process.exit(failed > 0 && !DRY_RUN ? 1 : 0)
}

main().catch((e) => die(e?.stack || String(e)))
