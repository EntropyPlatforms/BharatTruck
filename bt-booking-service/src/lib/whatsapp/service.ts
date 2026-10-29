// ============================================================
// src/lib/whatsapp/service.ts — the bot's three jobs:
//
//   handleInbound()        answer one incoming message (the webhook calls this)
//   queueAlertMessage()    put a critical alert in the WhatsApp outbox (the alert sweep calls this)
//   dispatchWhatsAppOnce() send what is queued (Cloud Scheduler calls this through /internal)
//
// Replies to a person's own message are free-form (WhatsApp allows that for 24 hours after
// their last message). Alerts are business-initiated: inside that window they go as plain
// text, outside it only as the approved template named in WHATSAPP_ALERT_TEMPLATE.
//
// Alerts go only to numbers that have messaged the bot and been told, on their first menu,
// that critical alerts will come here — that is the opt-in WhatsApp requires — and never
// after STOP.
// ============================================================

import { resolvePersonas } from '@bharattruck/shared/personas'
import type { UserRole } from '@bharattruck/shared/auth'
import { supabase } from '../supabase.js'
import { laneLabel } from '../place.js'
import { listOpenAlertsForUser } from '../alerts/repository.js'
import { SEVERITY_RANK, type AlertSeverity } from '../alerts/types.js'
import { respond, intentOf, type AlertLine, type TripLine, type Turn } from './bot.js'
import type { InboundMessage } from './inbound.js'
import type { WhatsAppConfig } from './config.js'
import { resolveWhatsAppConfig } from './config.js'
import { WhatsAppSendError, type OutboundMessage, type WhatsAppSender } from './client.js'
import type { InboundGuard } from './guard.js'
import { indianMobileFromWaId, waIdFromStoredPhone } from './phone.js'
import { alertPath, appBaseUrl, appLink } from './links.js'
import {
  activeTrips, claimOutbox, dueOutbox, findPersonByMobile, getContact, insertOutbox, phoneOfUser,
  recordInbound, settleOutbox, updateContact, WhatsAppNotMigratedError, type Contact, type Person, type TripRow,
} from './repository.js'

type Logger = { warn(obj: unknown, msg: string): void }

/** A wa_id is a phone number: logs keep only its last four digits. */
export const maskWa = (waId: string) => `…${waId.slice(-4)}`

const firstName = (full: string | null) => (full ?? '').trim().split(/\s+/)[0]?.slice(0, 30) || null

// ── Inbound ──────────────────────────────────────────────────────────────────

export type InboundDeps = {
  config: WhatsAppConfig
  sender: WhatsAppSender
  guard: InboundGuard
  now?: () => Date
  log?: Logger
}
export type InboundOutcome = 'answered' | 'duplicate' | 'rate_limited'

const SEEN_TTL_S = 2 * 24 * 3600
const RATE_MAX = 20
const RATE_WINDOW_S = 60
const SORRY = 'Sorry, I couldn’t look that up just now. Please try again in a minute.'

async function send(deps: InboundDeps, message: OutboundMessage): Promise<void> {
  try {
    await deps.sender.send(message)
  } catch (err) {
    deps.log?.warn({ err: (err as Error).message, to: maskWa(message.to) }, 'whatsapp reply failed')
  }
}

/** Contact bookkeeping never stops the bot answering — before migration 0043 it is simply skipped. */
async function quietly<T>(deps: InboundDeps, what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (err) {
    if (!(err instanceof WhatsAppNotMigratedError)) deps.log?.warn({ err: (err as Error).message }, `whatsapp ${what} failed`)
    return null
  }
}

async function alertLines(userId: string, base: string | null): Promise<AlertLine[]> {
  const rows = await listOpenAlertsForUser(userId)
  return [...rows]
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || (a.opened_at < b.opened_at ? 1 : -1))
    .map((a) => ({
      severity: a.severity as AlertSeverity,
      title: a.title,
      subtitle: typeof a.detail?.subtitle === 'string' ? a.detail.subtitle : '',
      url: appLink(base, alertPath(a)),
    }))
}

const STATUS_ORDER: Record<string, number> = { in_transit: 0, delivery_asserted: 1, accepted: 2 }

function statusText(t: TripRow): string {
  if (t.status === 'in_transit') return 'On the way'
  if (t.status === 'delivery_asserted') return 'Delivered, waiting for confirmation'
  return t.pickup_date ? `Truck assigned · pickup ${t.pickup_date}` : 'Truck assigned'
}

async function tripLines(person: Person, base: string | null): Promise<TripLine[]> {
  const snapshot = await resolvePersonas(supabase, person.id, (person.role ?? 'shipper') as UserRole)
  const rows = await activeTrips(person.id, snapshot.driver_id, snapshot.fleet_owner_id)
  return rows
    .sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || String(a.pickup_date).localeCompare(String(b.pickup_date)))
    .map((t) => {
      // The page that owns this trip for THIS person: their load, their trip, or the fleet board.
      const path = t.shipper_id === person.id ? `/loads/${t.id}`
        : snapshot.driver_id && t.driver_id === snapshot.driver_id ? `/my-trips/${t.id}`
        : '/trips'
      return { lane: laneLabel(t.source_address, t.destination_address), status: statusText(t), url: appLink(base, path) }
    })
}

export async function handleInbound(msg: InboundMessage, deps: InboundDeps): Promise<InboundOutcome> {
  const nowIso = (deps.now?.() ?? new Date()).toISOString()
  if (!(await deps.guard.once(`wa:in:${msg.id}`, SEEN_TTL_S))) return 'duplicate'
  if (!(await deps.guard.allow(`wa:rl:${msg.from}`, RATE_MAX, RATE_WINDOW_S))) {
    deps.log?.warn({ from: maskWa(msg.from) }, 'whatsapp sender over the rate limit — message ignored')
    return 'rate_limited'
  }

  let person: Person | null
  try {
    const mobile = indianMobileFromWaId(msg.from)
    person = mobile ? await findPersonByMobile(mobile) : null
  } catch (err) {
    deps.log?.warn({ err: (err as Error).message }, 'whatsapp person lookup failed')
    await send(deps, { type: 'text', to: msg.from, body: SORRY })
    return 'answered'
  }

  const intent = intentOf(msg)
  const contact: Contact | null = await quietly(deps, 'contact record', () => recordInbound(msg.from, person?.id ?? null, nowIso))

  if (contact && intent === 'stop') await quietly(deps, 'opt-out', () => updateContact(msg.from, { opted_out_at: nowIso }, nowIso))
  if (contact && intent === 'start') {
    await quietly(deps, 'opt-in', () =>
      updateContact(msg.from, { opted_out_at: null, alerts_opt_in_at: person ? nowIso : contact.alerts_opt_in_at }, nowIso))
  }

  // The first menu a matched person sees is where they are told alerts will come here —
  // record the opt-in only if that write succeeds, so the notice and the record agree.
  let firstContact = false
  if (person && contact && intent === 'menu' && !contact.alerts_opt_in_at && !contact.opted_out_at) {
    firstContact = (await quietly(deps, 'opt-in', async () => {
      await updateContact(msg.from, { alerts_opt_in_at: nowIso }, nowIso)
      return true
    })) === true
  }

  const base = appBaseUrl()
  const turn: Turn = {
    person: person ? { firstName: firstName(person.full_name) } : null,
    firstContact,
    base,
    supportEmail: deps.config.supportEmail,
  }
  try {
    if (person && intent === 'alerts') turn.alerts = await alertLines(person.id, base)
    if (person && intent === 'trips') turn.trips = await tripLines(person, base)
  } catch (err) {
    deps.log?.warn({ err: (err as Error).message, intent }, 'whatsapp menu data failed')
    await send(deps, { type: 'text', to: msg.from, body: SORRY })
    return 'answered'
  }

  for (const r of respond(intent, turn)) {
    await send(deps, r.kind === 'text'
      ? { type: 'text', to: msg.from, body: r.body }
      : { type: 'buttons', to: msg.from, body: r.body, buttons: r.buttons })
  }
  return 'answered'
}

// ── Alerts → outbox ──────────────────────────────────────────────────────────

export type AlertForWhatsApp = {
  audience_user_id: string
  persona: string
  kind: string
  severity: string
  title: string
  detail: { subtitle?: unknown }
  subject_type: string
  subject_id: string
  dedupe_key: string
}
export type QueueOutcome = 'queued' | 'duplicate' | 'not_configured' | 'no_phone' | 'not_opted_in' | 'opted_out' | 'not_migrated' | 'failed'

const DOT: Record<string, string> = { critical: '🔴', warning: '🟠', info: '🔵' }

/** Queue one alert for WhatsApp. Never throws — an alert is saved whether or not this works. */
export async function queueAlertMessage(
  alert: AlertForWhatsApp,
  episode: string,
  log?: Logger,
  opts: { env?: Record<string, string | undefined>; now?: Date } = {},
): Promise<QueueOutcome> {
  const env = opts.env ?? process.env
  if (!resolveWhatsAppConfig(env).config) return 'not_configured'
  try {
    const waId = waIdFromStoredPhone(await phoneOfUser(alert.audience_user_id))
    if (!waId) return 'no_phone'
    const contact = await getContact(waId)
    if (!contact?.alerts_opt_in_at) return 'not_opted_in'
    if (contact.opted_out_at) return 'opted_out'

    const base = appBaseUrl(env)
    const url = appLink(base, alertPath(alert))
    const subtitle = typeof alert.detail?.subtitle === 'string' ? alert.detail.subtitle : ''
    const body = `${DOT[alert.severity] ?? '🔔'} ${alert.title}${subtitle ? `\n${subtitle}` : ''}${url ? `\n${url}` : ''}\n\nSend STOP to turn off WhatsApp alerts.`
    return await insertOutbox({
      wa_id: waId,
      user_id: alert.audience_user_id,
      kind: 'alert',
      body_text: body,
      // The alert template's three body variables: what happened, the detail, where to act.
      template_params: [alert.title, subtitle || alert.title, url ?? base ?? 'the BharatTruck app'],
      dedupe_key: `wa:alert:${alert.dedupe_key}:${episode}`,
    }, (opts.now ?? new Date()).toISOString())
  } catch (err) {
    if (err instanceof WhatsAppNotMigratedError) return 'not_migrated'
    log?.warn({ err: (err as Error).message, dedupe_key: alert.dedupe_key }, 'whatsapp alert could not be queued (alert itself is saved)')
    return 'failed'
  }
}

// ── Outbox → WhatsApp ────────────────────────────────────────────────────────

export type WhatsAppDispatchResult = { claimed: number; sent: number; skipped: number; failed: number }

const CLAIM_LEASE_S = 120
// Free-form messages are allowed for 24 hours after the person's last message; keep a margin.
const SESSION_WINDOW_MS = 24 * 3600 * 1000 - 10 * 60 * 1000
const backoffSeconds = (attempts: number) => Math.min(60 * 2 ** Math.max(0, attempts - 1), 3600)

/** Drain due outbox rows. Never throws on a single row: a bad row must not stop the rest. */
export async function dispatchWhatsAppOnce(
  deps: { config: WhatsAppConfig; sender: WhatsAppSender; now?: () => Date; log?: Logger },
  limit = 25,
): Promise<WhatsAppDispatchResult> {
  const result: WhatsAppDispatchResult = { claimed: 0, sent: 0, skipped: 0, failed: 0 }
  const now = deps.now?.() ?? new Date()
  const nowIso = now.toISOString()

  for (const candidate of await dueOutbox(nowIso, limit)) {
    const row = await claimOutbox(candidate, new Date(now.getTime() + CLAIM_LEASE_S * 1000).toISOString())
    if (!row) continue // another drain won it
    result.claimed++
    try {
      const contact = await getContact(row.wa_id)
      if (contact?.opted_out_at) {
        await settleOutbox(row.id, { status: 'skipped', last_error: 'opted out after it was queued' })
        result.skipped++
        continue
      }
      const lastIn = contact?.last_inbound_at ? Date.parse(contact.last_inbound_at) : NaN
      const inWindow = Number.isFinite(lastIn) && now.getTime() - lastIn < SESSION_WINDOW_MS
      let message: OutboundMessage
      if (inWindow) {
        message = { type: 'text', to: row.wa_id, body: row.body_text }
      } else if (deps.config.alertTemplate) {
        message = { type: 'template', to: row.wa_id, name: deps.config.alertTemplate, language: deps.config.templateLanguage, params: row.template_params }
      } else {
        await settleOutbox(row.id, { status: 'skipped', last_error: 'outside the 24-hour window and no alert template is configured' })
        result.skipped++
        continue
      }
      const sent = await deps.sender.send(message)
      await settleOutbox(row.id, { status: 'sent', sent_at: new Date().toISOString(), provider_message_id: sent.id, last_error: null })
      result.sent++
    } catch (err) {
      const retryable = !(err instanceof WhatsAppSendError) || err.retryable
      const exhausted = !retryable || row.attempts >= row.max_attempts
      await settleOutbox(row.id, {
        status: exhausted ? 'failed' : 'pending',
        last_error: (err as Error).message.slice(0, 500),
        next_attempt_at: new Date(now.getTime() + backoffSeconds(row.attempts) * 1000).toISOString(),
      }).catch((e) => deps.log?.warn({ err: (e as Error).message }, 'whatsapp outbox settle failed'))
      deps.log?.warn({ err: (err as Error).message, to: maskWa(row.wa_id) }, 'whatsapp alert send failed')
      result.failed++
    }
  }
  return result
}
