// bt-progress server — serves the static portal (index.html, progress.json, requests.html) exactly
// as nginx did, plus the client requests API under /api/. Node built-ins only, no npm install.
//
//   POST  /api/session            { code } → { role }            check an access code
//   GET   /api/tickets            → { tickets }                   (code in x-portal-code)
//   POST  /api/tickets            { type, title, details, area, priority, name } → ticket
//   PATCH /api/tickets/:id        { comment?, status?, pr?, name? } → ticket   (status/pr: team)
//   GET   /health                 → { ok, tickets: 'ready' | 'not_configured' }
//         (not /healthz: Cloud Run's front end answers that path itself with a 404)
//
// Env: PORT (8080) · TICKETS_BUCKET · PORTAL_CLIENT_CODE · PORTAL_TEAM_CODE. Without a bucket the
// API answers 503 in production and keeps tickets in memory elsewhere (local preview only).

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AREAS, GcsStore, MemoryStore, PRIORITIES, STATUSES, TYPES, TicketError,
  createTicket, listTickets, roleForCode, updateTicket,
} from './lib/tickets.mjs'

const SITE = fileURLToPath(new URL('./site/', import.meta.url))
const TYPES_BY_EXT = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
}
const MAX_BODY = 32 * 1024

const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
}

/** A tiny fixed-window limiter, per client IP and bucket name. */
export function rateLimiter(limit, windowMs) {
  const hits = new Map()
  return (key, now = Date.now()) => {
    const h = hits.get(key)
    if (!h || now - h.start > windowMs) { hits.set(key, { start: now, n: 1 }); return true }
    h.n++
    if (hits.size > 10_000) hits.clear()
    return h.n <= limit
  }
}

export function createPortalServer({ store, env = process.env, log = console } = {}) {
  const failedCode = rateLimiter(10, 10 * 60_000) // wrong codes per IP
  const writes = rateLimiter(30, 10 * 60_000)     // new requests + replies per IP
  const configured = () => !!store && !!(env.PORTAL_CLIENT_CODE || env.PORTAL_TEAM_CODE)

  function send(res, status, body, headers = {}) {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body)
    res.writeHead(status, { ...BASE_HEADERS, ...(isJson ? { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } : {}), ...headers })
    res.end(isJson ? JSON.stringify(body) : body)
  }
  const fail = (res, err) => {
    if (err instanceof TicketError) return send(res, err.status, { success: false, error: err.message, code: err.code })
    log.error?.(JSON.stringify({ level: 'error', msg: 'portal api error', err: String(err?.stack ?? err) }))
    return send(res, 500, { success: false, error: 'Something went wrong — try again', code: 'INTERNAL_ERROR' })
  }

  async function readJson(req) {
    let size = 0; const chunks = []
    for await (const c of req) { size += c.length; if (size > MAX_BODY) throw new TicketError('Request too large', 413, 'TOO_LARGE'); chunks.push(c) }
    if (!chunks.length) return {}
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new TicketError('Body must be JSON') }
  }

  // Cloud Run appends the caller's address to X-Forwarded-For; the first entries can be forged.
  const ipOf = (req) => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',').pop().trim()

  function authorize(req) {
    const ip = ipOf(req)
    if (!configured()) throw new TicketError('Requests are not set up on this portal yet', 503, 'NOT_CONFIGURED')
    const role = roleForCode(String(req.headers['x-portal-code'] ?? ''), env)
    if (!role) {
      if (!failedCode(ip)) throw new TicketError('Too many wrong codes — wait 10 minutes', 429, 'RATE_LIMITED')
      throw new TicketError('That access code is not right', 401, 'UNAUTHORIZED')
    }
    return role
  }

  async function api(req, res, path) {
    if (path === '/api/session' && req.method === 'POST') {
      const body = await readJson(req)
      req.headers['x-portal-code'] = typeof body.code === 'string' ? body.code : ''
      const role = authorize(req)
      return send(res, 200, { success: true, data: { role, types: TYPES, areas: AREAS, priorities: PRIORITIES, statuses: STATUSES } })
    }
    if (path === '/api/tickets' && req.method === 'GET') {
      authorize(req)
      return send(res, 200, { success: true, data: { tickets: await listTickets(store) } })
    }
    if (path === '/api/tickets' && req.method === 'POST') {
      const role = authorize(req)
      if (!writes(ipOf(req))) throw new TicketError('Too many requests from here — wait a few minutes', 429, 'RATE_LIMITED')
      const t = await createTicket(store, await readJson(req), role)
      return send(res, 201, { success: true, data: t })
    }
    const m = /^\/api\/tickets\/([A-Za-z0-9-]+)$/.exec(path)
    if (m && req.method === 'PATCH') {
      const role = authorize(req)
      if (!writes(ipOf(req))) throw new TicketError('Too many requests from here — wait a few minutes', 429, 'RATE_LIMITED')
      const t = await updateTicket(store, m[1], await readJson(req), role)
      return send(res, 200, { success: true, data: t })
    }
    throw new TicketError('Not found', 404, 'NOT_FOUND')
  }

  async function file(req, res, path) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { allow: 'GET, HEAD' })
    let rel = decodeURIComponent(path)
    if (rel.endsWith('/')) rel += 'index.html'
    const full = normalize(join(SITE, rel))
    let target = full.startsWith(SITE.endsWith(sep) ? SITE : SITE + sep) ? full : null
    if (target) { try { if (!(await stat(target)).isFile()) target = null } catch { target = null } }
    // Unknown paths fall back to the log page, as nginx's try_files did.
    if (!target) target = join(SITE, 'index.html')
    const body = await readFile(target)
    const cache = target.endsWith(`${sep}progress.json`) ? 'no-store' : 'no-cache'
    res.writeHead(200, { ...BASE_HEADERS, 'content-type': TYPES_BY_EXT[extname(target)] ?? 'application/octet-stream', 'cache-control': cache })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  return createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    try {
      if (path === '/health') return send(res, 200, { ok: true, tickets: configured() ? 'ready' : 'not_configured' })
      if (path.startsWith('/api/')) return await api(req, res, path)
      return await file(req, res, path)
    } catch (err) {
      return fail(res, err)
    }
  })
}

function storeFromEnv(env = process.env) {
  if (env.TICKETS_BUCKET) return new GcsStore(env.TICKETS_BUCKET)
  if (env.NODE_ENV === 'production') return null
  console.warn('TICKETS_BUCKET unset — requests are kept in memory (local preview only)')
  return new MemoryStore()
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const port = Number(process.env.PORT) || 8080
  createPortalServer({ store: storeFromEnv() }).listen(port, () => console.log(`bt-progress on :${port}`))
}
