#!/usr/bin/env node
// bt-quality/e2e.mjs — end-to-end checks against the LIVE BharatTruck deployment.
//
//   node bt-quality/e2e.mjs [out.json]
//
// READ-ONLY BY DESIGN. Nothing here creates, edits or deletes anything on production: no
// registration, no bookings, no writes. The API checks are GETs, plus two POSTs with an
// EMPTY body that the server must reject at validation (they never reach a handler).
//
// Four groups:
//   api      the gateway is up, every protected area refuses an anonymous or forged caller,
//            bad input is answered with 4xx (not a crash)
//   web      the app, its key assets and the progress portal are served
//   browser  a real headless Chrome loads the pages: the landing renders and its tabs work,
//            the sign-in form is there, a protected page sends a signed-out visitor to
//            sign-in, the theme matches the time in India, nothing overflows on a phone
//   signed-in  (only when E2E_EMAIL / E2E_PASSWORD are set — a dedicated TEST account)
//   integrations  which outside services are switched on, and that each answers (same test account)
//            sign in, read the profile and the feed, open the app signed in
//
// Config (env): APP_URL, API_URL, PROGRESS_URL, CHROME (path to a Chrome/Edge binary; the
// browser group is reported as "skipped" when none is found), E2E_EMAIL, E2E_PASSWORD.
// Needs Node 22+ (global WebSocket, used to drive Chrome). No dependencies.
// Exit code is always 0 once the JSON is written — a failed check is a result, not a crash.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const APP = (process.env.APP_URL ?? 'https://bt-app-itcdoenefa-el.a.run.app').replace(/\/$/, '')
const API = (process.env.API_URL ?? 'https://bt-gateway-itcdoenefa-el.a.run.app').replace(/\/$/, '')
const PROGRESS = (process.env.PROGRESS_URL ?? 'https://bt-progress-itcdoenefa-el.a.run.app').replace(/\/$/, '')
const out = resolve(process.argv[2] ?? 'quality-e2e.json')
const EMAIL = process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD

const checks = []
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Run one check. `fn` returns a short detail string, or throws with the reason it failed. */
async function check(group, name, fn) {
  const started = Date.now()
  let status = 'pass', detail = ''
  try { detail = (await fn()) ?? '' } catch (e) { status = 'fail'; detail = String(e?.message ?? e).slice(0, 400) }
  checks.push({ group, name, status, duration_ms: Date.now() - started, detail })
  console.log(`  ${status.toUpperCase().padEnd(4)} [${group}] ${name}${detail ? ` — ${detail}` : ''}`)
}
function skip(group, name, reason) {
  checks.push({ group, name, status: 'skip', duration_ms: 0, detail: reason })
  console.log(`  SKIP [${group}] ${name} — ${reason}`)
}
function expect(cond, message) { if (!cond) throw new Error(message) }

async function http(url, init = {}) {
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(25_000), ...init })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, text, json, headers: res.headers }
}

// ── api ───────────────────────────────────────────────────────────────────────

await check('api', 'Gateway health', async () => {
  const r = await http(`${API}/health`)
  expect(r.status === 200 && r.json?.status === 'ok', `expected 200 {status:"ok"}, got ${r.status} ${r.text.slice(0, 80)}`)
  return 'status ok'
})

const PROTECTED = [
  ['Account (auth)', '/api/auth/me'],
  ['Loads (booking)', '/api/bookings/'],
  ['Home feed', '/api/me/feed'],
  ['Dashboard summary', '/api/me/summary'],
  ['Onboarding', '/api/onboarding/status'],
  ['Trucks (fleet)', '/api/fleet/vehicles'],
  ['Fleet P&L (fleet)', '/api/fleet/analytics/summary'],
  ['Live Fleet (tracking)', '/api/tracking/fleet/overview'],
]
for (const [label, path] of PROTECTED) {
  await check('api', `${label} refuses an anonymous caller`, async () => {
    const r = await http(API + path)
    expect(r.status === 401, `GET ${path} without a token must be 401, got ${r.status}`)
    return '401'
  })
}
for (const [label, path] of [['Account (auth)', '/api/auth/me'], ['Live Fleet (tracking)', '/api/tracking/fleet/overview'], ['Trucks (fleet)', '/api/fleet/vehicles']]) {
  await check('api', `${label} refuses a forged token`, async () => {
    const r = await http(API + path, { headers: { authorization: 'Bearer not.a.real.token' } })
    expect(r.status === 401, `GET ${path} with a forged token must be 401, got ${r.status}`)
    return '401'
  })
}
await check('api', 'Pricing refuses an anonymous quote request', async () => {
  const r = await http(`${API}/api/pricing/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  expect(r.status === 401, `expected 401, got ${r.status}`)
  return '401'
})
await check('api', 'Sign-in rejects an empty request cleanly', async () => {
  const r = await http(`${API}/api/auth/email/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  expect(r.status === 400, `an empty body must be a 400 validation error, got ${r.status}`)
  expect(r.json && r.json.success === false, 'the error must be the JSON envelope { success: false, … }')
  return '400 with the JSON error envelope'
})
await check('api', 'Unknown API route is a clean 4xx, not a server error', async () => {
  const r = await http(`${API}/api/does-not-exist-${Date.now()}`)
  expect(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status}`)
  return String(r.status)
})

// ── web ───────────────────────────────────────────────────────────────────────

for (const [label, path, type] of [
  ['Home page', '/', 'text/html'],
  ['Sign-in page', '/login', 'text/html'],
  ['App icon', '/icon.svg', 'image/svg'],
  ['Day banner photo', '/images/highway-milestone.webp', 'image/webp'],
  ['Night banner photo', '/images/highway-india-map-night.webp', 'image/webp'],
]) {
  await check('web', `${label} is served`, async () => {
    const r = await http(APP + path)
    expect(r.status === 200, `GET ${path} expected 200, got ${r.status}`)
    const ct = r.headers.get('content-type') ?? ''
    expect(ct.includes(type), `expected content-type ${type}, got ${ct}`)
    return `200 ${ct.split(';')[0]}`
  })
}
await check('web', 'Client progress portal is up and has data', async () => {
  const r = await http(`${PROGRESS}/progress.json`)
  expect(r.status === 200 && r.json, `progress.json expected 200 JSON, got ${r.status}`)
  const n = Array.isArray(r.json.entries) ? r.json.entries.length : Array.isArray(r.json.items) ? r.json.items.length : null
  return n === null ? 'valid JSON' : `${n} entries`
})

// ── browser (headless Chrome over the DevTools protocol) ──────────────────────

function findChrome() {
  const candidates = [
    process.env.CHROME,
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean)
  return candidates.find(p => existsSync(p)) ?? null
}

async function withBrowser(fn) {
  const bin = findChrome()
  if (!bin) return false
  const profile = mkdtempSync(join(tmpdir(), 'bt-e2e-'))
  const port = 9400 + Math.floor(Math.random() * 500)
  const proc = spawn(bin, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox', '--hide-scrollbars', '--mute-audio',
    // CI runners have a small /dev/shm; without this Chrome can die at startup.
    '--disable-dev-shm-usage', '--no-default-browser-check',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' })
  let ws
  try {
    let targets
    for (let i = 0; i < 160; i++) {
      try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (targets.length) break } catch { /* not up yet */ }
      await sleep(250)
    }
    const page = targets?.find(t => t.type === 'page')
    if (!page) throw new Error('Chrome did not start')
    ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
    let seq = 0
    const pending = new Map()
    const waiters = []
    const errors = []
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id)
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
      } else if (msg.method === 'Runtime.exceptionThrown') {
        errors.push((msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text).split('\n')[0])
      } else if (msg.method) {
        for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].name === msg.method) waiters.splice(i, 1)[0].fn(msg.params)
      }
    })
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
    const waitEvent = (name, timeout = 45_000) => new Promise(resolve => { const t = setTimeout(() => resolve(null), timeout); waiters.push({ name, fn: p => { clearTimeout(t); resolve(p) } }) })
    await send('Page.enable'); await send('Runtime.enable')
    const browser = {
      errors,
      async viewport(width, height) { await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 }) },
      async goto(url, settle = 2500) {
        errors.length = 0
        const loaded = waitEvent('Page.loadEventFired')
        await send('Page.navigate', { url })
        await loaded
        await sleep(settle)
      },
      /**
       * Wait until `expression` is truthy in the page (polled), up to `timeout` ms. The app
       * renders on the client after it has checked for a session, so "the load event fired"
       * is not "the page is drawn" — on a cold start that gap is several seconds, and a
       * fixed sleep made the first CI run report an empty page. Returns whether it appeared.
       */
      async waitFor(expression, timeout = 30_000) {
        const until = Date.now() + timeout
        while (Date.now() < until) {
          try { if (await this.evaluate(`!!(${expression})`)) return true } catch { /* mid-navigation: try again */ }
          await sleep(500)
        }
        return false
      },
      /** Evaluate an expression (may be async) in the page and return its JSON value. */
      async evaluate(expression) {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] ?? 'evaluation failed')
        return r.result.value
      },
    }
    await fn(browser)
  } finally {
    try { ws?.close() } catch { /* already closed */ }
    try { proc.kill() } catch { /* already gone */ }
    await sleep(300)
    try { rmSync(profile, { recursive: true, force: true }) } catch { /* profile still locked: left in tmp */ }
  }
  return true
}

/** Dark from 19:00 to 06:00 Indian time — the same rule as bt-app/src/lib/theme.ts. */
function nightInIndia(now = new Date()) {
  const h = Math.floor((now.getUTCHours() * 60 + now.getUTCMinutes() + 330) / 60) % 24
  return h >= 19 || h < 6
}

let signedInToken = null
if (EMAIL && PASSWORD) {
  await check('signed-in', 'Test account can sign in', async () => {
    const r = await http(`${API}/api/auth/email/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) })
    expect(r.status === 200 && r.json?.success, `sign-in expected 200, got ${r.status} ${r.json?.error ?? ''}`)
    const d = r.json.data ?? r.json
    expect(d.access_token, 'the response carried no access token')
    signedInToken = d.access_token
    return 'access token issued'
  })
  for (const [label, path] of [['Profile', '/api/auth/me'], ['Home feed', '/api/me/feed'], ['Dashboard summary', '/api/me/summary'], ['Loads list', '/api/bookings/']]) {
    await check('signed-in', `${label} loads for the signed-in account`, async () => {
      expect(signedInToken, 'no session (sign-in failed)')
      const r = await http(API + path, { headers: { authorization: `Bearer ${signedInToken}` } })
      expect(r.status === 200 && r.json?.success !== false, `GET ${path} expected 200, got ${r.status} ${r.json?.error ?? ''}`)
      return '200'
    })
  }
} else {
  skip('signed-in', 'Signed-in journey (sign in, profile, feed, loads)', 'No test account configured — set the E2E_EMAIL and E2E_PASSWORD repository secrets to switch this on.')
}

// ── integrations ──────────────────────────────────────────────────────────────
// Each outside service the app can use, as the LIVE site reports it: document reading
// (Google Document AI), the GST portal and DigiLocker (Sandbox), Razorpay, the e-way bill
// portal link. A service that is not configured is reported as SKIPPED with the reason, so
// the portal shows exactly what is on and what is not. A configured service is then given one
// small real call, so "on" means "answers", not just "has a key". Each probe costs at most one
// metered call per run. Read-only: nothing is created, saved or sent to anyone.

// A 1×1 white PNG — enough to prove Document AI accepts our calls (it returns no text).
const BLANK_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='
// A GSTIN that Sandbox's own documentation uses as its example of a registered business.
const KNOWN_GSTIN = '27AAPFU0939F1ZV'

if (signedInToken) {
  const auth = { authorization: `Bearer ${signedInToken}` }
  const get = (path) => http(API + path, { headers: auth })
  const post = (path, body) => http(API + path, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) })

  // Document reading (licence / cheque / Aadhaar / GST certificate / invoices)
  const ocr = await get('/api/onboarding/ocr/config')
  if (ocr.status === 200 && ocr.json?.data?.enabled) {
    await check('integrations', 'Document reading (Google Document AI) answers', async () => {
      const r = await post('/api/onboarding/ocr', { kind: 'pan', mime_type: 'image/png', content_base64: BLANK_PNG })
      expect(r.status === 200, `scan expected 200, got ${r.status} ${r.json?.error ?? ''}`)
      return `processor reachable (blank image read, ${r.json?.data?.found ?? 0} fields as expected)`
    })
  } else {
    skip('integrations', 'Document reading (Google Document AI)', ocr.status === 200 ? 'Switched off — DOCAI_OCR_PROCESSOR_ID is not set on bt-auth-service.' : `config endpoint answered ${ocr.status}`)
  }

  // Sandbox: GST portal lookups + DigiLocker
  const kyc = await get('/api/kyc/config')
  const kycData = kyc.status === 200 ? kyc.json?.data : null
  if (kycData?.gst_lookup) {
    await check('integrations', 'GST portal lookup (Sandbox) answers', async () => {
      const r = await get(`/api/kyc/gst/${KNOWN_GSTIN}/profile`)
      expect(r.status === 200, `lookup expected 200, got ${r.status} ${r.json?.error ?? ''}`)
      expect(r.json?.data?.valid, 'the portal did not recognise a known registered GSTIN')
      return `${r.json.data.legal_name ?? 'registration'} — ${r.json.data.status ?? 'status unknown'}`
    })
  } else {
    skip('integrations', 'GST portal lookup (Sandbox)', kycData ? 'Switched off — SANDBOX_API_KEY / SANDBOX_API_SECRET are not set on bt-auth-service.' : `config endpoint answered ${kyc.status}`)
  }
  if (kycData?.digilocker) {
    await check('integrations', 'DigiLocker (Sandbox) opens a consent session', async () => {
      const r = await post('/api/kyc/digilocker/session', { doc_types: ['driving_license'], redirect_url: `${APP}/driver-profile` })
      expect(r.status === 200, `session expected 200, got ${r.status} ${r.json?.error ?? ''}`)
      expect(typeof r.json?.data?.authorization_url === 'string' && r.json.data.authorization_url.startsWith('https://'), 'no consent URL returned')
      return 'consent URL issued (nobody is sent to it)'
    })
  } else {
    skip('integrations', 'DigiLocker (Sandbox)', kycData ? 'Switched off — needs the Sandbox keys on bt-auth-service.' : `config endpoint answered ${kyc.status}`)
  }
  await check('integrations', 'Identity checks provider', async () => {
    expect(kycData, `config endpoint answered ${kyc.status}`)
    return kycData.provider === 'console'
      ? 'no provider wired — PAN / bank / Aadhaar checks go to ops review (set KYC_PROVIDER=sandbox)'
      : `provider: ${kycData.provider} — PAN, bank and Aadhaar checks are answered automatically`
  })

  // Razorpay
  const pay = await get('/api/payments/config')
  if (pay.status === 200 && pay.json?.data?.razorpay?.enabled) {
    await check('integrations', 'Razorpay online payment', async () => {
      const rz = pay.json.data.razorpay
      return `switched on, ${rz.test_mode ? 'TEST keys (no real money)' : 'LIVE keys — real money'}`
    })
  } else {
    skip('integrations', 'Razorpay online payment', pay.status === 200 ? 'Switched off — RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set on bt-payment-service.' : `config endpoint answered ${pay.status}`)
  }

  // E-way bill portal link (per shipper)
  const ewb = await get('/api/bookings/eway-portal/credentials')
  if (ewb.status === 200) {
    const d = ewb.json?.data
    if (d?.configured) await check('integrations', 'E-way bill portal (NIC via Sandbox)', async () => `linked for the test account: GSTIN ${d.gstin}`)
    else skip('integrations', 'E-way bill portal (NIC via Sandbox)', 'Not linked for the test account — a GST-registered shipper links their portal API login in Settings → E-way bill portal.')
  } else if (ewb.json?.code === 'NOT_MIGRATED') {
    await check('integrations', 'E-way bill portal (NIC via Sandbox)', async () => { throw new Error('migration 0040_eway_portal_credentials.sql has not been applied') })
  } else {
    skip('integrations', 'E-way bill portal (NIC via Sandbox)', `credentials endpoint answered ${ewb.status}`)
  }
} else {
  skip('integrations', 'Outside services (document reading, GST portal, DigiLocker, Razorpay, e-way bill)', 'Needs the signed-in test account — set the E2E_EMAIL and E2E_PASSWORD repository secrets.')
}

// Chrome occasionally fails to come up on a busy CI runner ("Chrome did not start" cost one
// whole run its browser checks). Starting it is not what is under test, so try up to three
// times; only a failure to START is retried — once the checks have begun, results stand.
async function withBrowserRetry(fn) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = checks.length
    try { return await withBrowser(fn) } catch (e) {
      lastError = e
      if (checks.length !== before) throw e
      console.log(`  browser start attempt ${attempt} failed: ${String(e?.message ?? e).slice(0, 120)}`)
      await sleep(3000)
    }
  }
  throw lastError
}

const ranBrowser = await withBrowserRetry(async b => {
  await check('browser', 'Home page renders its headline and calls to action', async () => {
    await b.goto(`${APP}/`)
    await b.waitFor(`document.querySelector('h1')?.innerText`)
    const v = await b.evaluate(`({ h1: document.querySelector('h1')?.innerText ?? '', cta: [...document.querySelectorAll('a')].filter(a => /Post a load|Create account/.test(a.innerText)).length })`)
    expect(/every truck/i.test(v.h1), `headline not found (h1 was "${v.h1.slice(0, 60)}")`)
    expect(v.cta >= 2, `expected the Post a load / Create account links, found ${v.cta}`)
    expect(b.errors.length === 0, `page threw: ${b.errors[0]}`)
    return 'headline, calls to action, no script errors'
  })
  await check('browser', 'Home page sample card: the three tabs switch', async () => {
    expect(await b.waitFor(`document.getElementById('hero-tab-bids')`), 'the sample card never appeared')
    const v = await b.evaluate(`(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms))
      const panel = () => document.getElementById('hero-panel')?.innerText ?? ''
      document.getElementById('hero-tab-bids')?.click(); await wait(400); const bids = panel()
      document.getElementById('hero-tab-documents')?.click(); await wait(400); const docs = panel()
      document.getElementById('hero-tab-tracking')?.click(); await wait(400)
      return { bids: /bids received/i.test(bids), docs: /Proof of delivery/i.test(docs), img: !!document.querySelector('#hero-panel img') }
    })()`)
    expect(v.bids, 'the Bids tab did not show the bids list')
    expect(v.docs, 'the Documents tab did not show the documents list')
    expect(v.img, 'the Live tracking tab did not show the map picture')
    return 'Bids, Documents and Live tracking all render'
  })
  await check('browser', 'Theme matches the time in India', async () => {
    const dark = await b.evaluate(`document.documentElement.classList.contains('dark')`)
    const night = nightInIndia()
    expect(dark === night, `it is ${night ? 'night' : 'day'} in India but the page is ${dark ? 'dark' : 'light'}`)
    return night ? 'night → dark' : 'day → light'
  })
  await check('browser', 'Sign-in page shows the form', async () => {
    await b.goto(`${APP}/login`)
    await b.waitFor(`document.querySelector('input[type=password]')`)
    const v = await b.evaluate(`({ email: !!document.querySelector('input[type=email]'), password: !!document.querySelector('input[type=password]'), submit: [...document.querySelectorAll('button[type=submit]')].some(x => /Sign in/.test(x.innerText)) })`)
    expect(v.email && v.password && v.submit, `missing: ${Object.entries(v).filter(([, ok]) => !ok).map(([k]) => k).join(', ')}`)
    expect(b.errors.length === 0, `page threw: ${b.errors[0]}`)
    return 'email, password and Sign in present'
  })
  await check('browser', 'A signed-out visitor to the dashboard is sent to sign-in', async () => {
    await b.goto(`${APP}/dashboard`)
    await b.waitFor(`location.pathname === '/login'`, 20_000)
    const path = await b.evaluate(`location.pathname`)
    expect(path === '/login', `expected to land on /login, landed on ${path}`)
    return 'redirected to /login'
  })
  await check('browser', 'Home page fits a phone screen (no sideways scroll)', async () => {
    await b.viewport(390, 844)
    await b.goto(`${APP}/`)
    expect(await b.waitFor(`document.querySelector('h1')?.innerText`), 'the page never rendered at phone width')
    const v = await b.evaluate(`({ doc: document.documentElement.scrollWidth, win: window.innerWidth })`)
    await b.viewport(1440, 900)
    expect(v.doc <= v.win + 1, `the page is ${v.doc}px wide on a ${v.win}px screen`)
    return `${v.doc}px wide on a ${v.win}px screen`
  })
  if (signedInToken) {
    await check('signed-in', 'The app opens signed in and shows Home', async () => {
      await b.goto(`${APP}/login`, 1000)
      await b.evaluate(`localStorage.setItem('bt_app_token', ${JSON.stringify(signedInToken)})`)
      await b.goto(`${APP}/home`)
      await b.waitFor(`/Good (morning|afternoon|evening)/.test(document.querySelector('h1')?.innerText ?? '')`)
      const v = await b.evaluate(`({ path: location.pathname, h1: document.querySelector('h1')?.innerText ?? '' })`)
      expect(v.path === '/home', `expected /home, landed on ${v.path}`)
      expect(/Good (morning|afternoon|evening)/.test(v.h1), `greeting not found (h1 was "${v.h1.slice(0, 60)}")`)
      await b.evaluate(`localStorage.clear()`)
      return 'Home greets the signed-in user'
    })
  }
}).catch(e => { checks.push({ group: 'browser', name: 'Browser session', status: 'fail', duration_ms: 0, detail: String(e?.message ?? e).slice(0, 300) }); return true })
if (!ranBrowser) skip('browser', 'Browser checks (home, sign-in, redirect, theme, phone)', 'No Chrome or Edge binary found on this machine — set CHROME to its path.')

const count = s => checks.filter(c => c.status === s).length
const result = {
  suite: 'e2e',
  target: { app: APP, api: API },
  finished_at: new Date().toISOString(),
  status: count('fail') > 0 ? 'fail' : 'pass',
  totals: { checks: checks.length, pass: count('pass'), fail: count('fail'), skip: count('skip') },
  checks,
}
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(result, null, 2))
console.log(`e2e: ${result.status.toUpperCase()} — ${result.totals.pass} passed, ${result.totals.fail} failed, ${result.totals.skip} skipped → ${out}`)
