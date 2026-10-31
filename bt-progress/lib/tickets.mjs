// Client requests ("tickets") for the progress portal: the client raises a change, a feature or an
// add-on; the team answers, sets a status and links the PR that delivers it.
//
// Storage is one JSON object per ticket in a Cloud Storage bucket (TICKETS_BUCKET), written by
// the Cloud Run service's own identity — no database table, no migration, no key in the image.
// Every update is a read-modify-write guarded by the object's generation, so two people replying
// at once never overwrite each other.
//
// Access: the portal is public, so tickets sit behind two codes (Secret Manager → env):
//   PORTAL_CLIENT_CODE  raise requests, read them, reply
//   PORTAL_TEAM_CODE    everything the client can, plus status changes and PR links

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const TYPES = ['feature', 'change', 'addon', 'bug', 'question']
export const PRIORITIES = ['low', 'normal', 'high', 'urgent']
export const AREAS = ['Driver', 'Shipper', 'Fleet owner', 'Platform', 'Documents', 'Other']
export const STATUSES = ['new', 'reviewing', 'planned', 'in_progress', 'done', 'declined']

export class TicketError extends Error {
  constructor(message, status = 400, code = 'VALIDATION_ERROR') { super(message); this.status = status; this.code = code }
}

// ── access codes ────────────────────────────────────────────────────────────

const digest = (s) => createHash('sha256').update(String(s)).digest()
const same = (a, b) => timingSafeEqual(digest(a), digest(b))

/** 'team' | 'client' | null for a presented code. Constant-time against both codes. */
export function roleForCode(code, env = process.env) {
  if (!code || typeof code !== 'string') return null
  const team = env.PORTAL_TEAM_CODE, client = env.PORTAL_CLIENT_CODE
  const isTeam = !!team && same(code, team)
  const isClient = !!client && same(code, client)
  return isTeam ? 'team' : isClient ? 'client' : null
}

// ── validation ──────────────────────────────────────────────────────────────

function text(v, field, max, { required = true } = {}) {
  const s = typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : ''
  if (required && !s) throw new TicketError(`${field} is required`)
  if (s.length > max) throw new TicketError(`${field} must be ${max} characters or fewer`)
  return s
}
function oneOf(v, field, list, fallback) {
  if (v == null || v === '') { if (fallback !== undefined) return fallback; throw new TicketError(`${field} is required`) }
  if (!list.includes(v)) throw new TicketError(`${field} must be one of: ${list.join(', ')}`)
  return v
}

export function newTicketId(now = new Date()) {
  const d = now.toISOString().slice(2, 10).replace(/-/g, '') // yymmdd
  const r = randomBytes(3).toString('hex').toUpperCase()     // 6 hex
  return `R-${d}-${r}`
}

export function buildTicket(body, role, now = new Date()) {
  const at = now.toISOString()
  return {
    id: newTicketId(now),
    type: oneOf(body?.type, 'type', TYPES),
    title: text(body?.title, 'title', 140),
    details: text(body?.details, 'details', 5000),
    area: oneOf(body?.area, 'area', AREAS, 'Other'),
    priority: oneOf(body?.priority, 'priority', PRIORITIES, 'normal'),
    raised_by: text(body?.name, 'name', 80, { required: false }) || (role === 'team' ? 'BharatTruck team' : 'Client'),
    raised_by_role: role,
    status: 'new',
    pr: null,
    created_at: at,
    updated_at: at,
    thread: [],
  }
}

/** Apply a reply / status change / PR link to a ticket. Pure; returns the new ticket. */
export function applyUpdate(ticket, body, role, now = new Date()) {
  const at = now.toISOString()
  const t = { ...ticket, thread: [...ticket.thread] }
  const name = text(body?.name, 'name', 80, { required: false }) || (role === 'team' ? 'BharatTruck team' : 'Client')
  let changed = false

  if (body?.status != null) {
    if (role !== 'team') throw new TicketError('Only the team can change a status', 403, 'FORBIDDEN')
    const status = oneOf(body.status, 'status', STATUSES)
    if (status !== t.status) {
      t.thread.push({ at, kind: 'status', by_role: role, by_name: name, from: t.status, to: status })
      t.status = status; changed = true
    }
  }
  if (body?.pr !== undefined) {
    if (role !== 'team') throw new TicketError('Only the team can link a PR', 403, 'FORBIDDEN')
    const pr = body.pr === null || body.pr === '' ? null : Number(body.pr)
    if (pr !== null && !(Number.isInteger(pr) && pr > 0 && pr < 1e6)) throw new TicketError('pr must be a PR number')
    if (pr !== t.pr) { t.pr = pr; changed = true }
  }
  if (body?.comment != null) {
    const c = text(body.comment, 'comment', 2000)
    t.thread.push({ at, kind: 'comment', by_role: role, by_name: name, text: c })
    changed = true
  }
  if (!changed) throw new TicketError('Nothing to update')
  if (t.thread.length > 200) throw new TicketError('This request has too many replies — raise a new one', 409, 'TOO_LONG')
  t.updated_at = at
  return t
}

// ── stores ──────────────────────────────────────────────────────────────────
// get → { ticket, version } | null · create(ticket) → bool (false = id taken)
// update(ticket, version) → bool (false = changed underneath, re-read) · list → tickets

export class MemoryStore {
  constructor() { this.rows = new Map() }
  async list() { return [...this.rows.values()].map((r) => structuredClone(r.ticket)) }
  async get(id) { const r = this.rows.get(id); return r ? { ticket: structuredClone(r.ticket), version: r.version } : null }
  async create(ticket) { if (this.rows.has(ticket.id)) return false; this.rows.set(ticket.id, { ticket: structuredClone(ticket), version: 1 }); return true }
  async update(ticket, version) {
    const r = this.rows.get(ticket.id)
    if (!r || r.version !== version) return false
    this.rows.set(ticket.id, { ticket: structuredClone(ticket), version: version + 1 }); return true
  }
}

const META_TOKEN = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'
const GCS = 'https://storage.googleapis.com'

/** Cloud Storage via the JSON API and the service's metadata-server token (no SDK, no key). */
export class GcsStore {
  constructor(bucket, { fetchImpl = fetch, prefix = 'tickets/' } = {}) {
    this.bucket = bucket; this.fetch = fetchImpl; this.prefix = prefix; this.token = null; this.tokenExp = 0
  }
  async auth() {
    if (this.token && Date.now() < this.tokenExp - 60_000) return this.token
    const r = await this.fetch(META_TOKEN, { headers: { 'Metadata-Flavor': 'Google' } })
    if (!r.ok) throw new TicketError('Storage credentials unavailable', 503, 'STORAGE_UNAVAILABLE')
    const j = await r.json()
    this.token = j.access_token; this.tokenExp = Date.now() + Number(j.expires_in ?? 300) * 1000
    return this.token
  }
  name(id) { return encodeURIComponent(this.prefix + id + '.json') }
  async call(url, init = {}) {
    const r = await this.fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${await this.auth()}` } })
    if (r.status >= 500 || r.status === 401 || r.status === 403) {
      throw new TicketError(`Storage error ${r.status}`, 503, 'STORAGE_UNAVAILABLE')
    }
    return r
  }
  async get(id) {
    const r = await this.call(`${GCS}/storage/v1/b/${this.bucket}/o/${this.name(id)}?alt=media`)
    if (r.status === 404) return null
    if (!r.ok) throw new TicketError(`Storage error ${r.status}`, 503, 'STORAGE_UNAVAILABLE')
    return { ticket: await r.json(), version: r.headers.get('x-goog-generation') }
  }
  async write(ticket, ifGeneration) {
    const url = `${GCS}/upload/storage/v1/b/${this.bucket}/o?uploadType=media&name=${this.name(ticket.id)}&ifGenerationMatch=${ifGeneration}`
    const r = await this.call(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ticket) })
    if (r.status === 412) return false
    if (!r.ok) throw new TicketError(`Storage error ${r.status}`, 503, 'STORAGE_UNAVAILABLE')
    return true
  }
  create(ticket) { return this.write(ticket, 0) }
  update(ticket, version) { return this.write(ticket, version) }
  async list() {
    const names = []
    let page = ''
    do {
      const r = await this.call(`${GCS}/storage/v1/b/${this.bucket}/o?prefix=${encodeURIComponent(this.prefix)}&fields=items(name),nextPageToken${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`)
      if (!r.ok) throw new TicketError(`Storage error ${r.status}`, 503, 'STORAGE_UNAVAILABLE')
      const j = await r.json()
      for (const it of j.items ?? []) if (it.name.endsWith('.json')) names.push(it.name.slice(this.prefix.length, -5))
      page = j.nextPageToken ?? ''
    } while (page)
    const rows = await Promise.all(names.map((id) => this.get(id).catch(() => null)))
    return rows.filter(Boolean).map((r) => r.ticket)
  }
}

// ── service ────────────────────────────────────────────────────────────────

export async function createTicket(store, body, role, now = new Date()) {
  for (let i = 0; i < 4; i++) {
    const t = buildTicket(body, role, now)
    if (await store.create(t)) return t
  }
  throw new TicketError('Could not save the request — try again', 503, 'STORAGE_UNAVAILABLE')
}

export async function updateTicket(store, id, body, role, now = new Date()) {
  if (!/^R-\d{6}-[0-9A-F]{6}$/.test(id)) throw new TicketError('Request not found', 404, 'NOT_FOUND')
  for (let i = 0; i < 4; i++) {
    const row = await store.get(id)
    if (!row) throw new TicketError('Request not found', 404, 'NOT_FOUND')
    const next = applyUpdate(row.ticket, body, role, now)
    if (await store.update(next, row.version)) return next
  }
  throw new TicketError('This request changed while you were replying — reload and try again', 409, 'CONFLICT')
}

export async function listTickets(store) {
  const all = await store.list()
  return all.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
}
