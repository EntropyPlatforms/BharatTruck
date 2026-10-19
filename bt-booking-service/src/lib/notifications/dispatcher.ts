// ============================================================
// src/lib/notifications/dispatcher.ts
//
// Responsibility: drain notification_outbox — claim due rows, resolve the
// recipient's preferences, render, send, and record the outcome.
//
// CONCURRENCY. There is no SELECT ... FOR UPDATE SKIP LOCKED through PostgREST,
// so the claim is an optimistic compare-and-swap on (id, attempts, status): two
// dispatchers reading the same candidate both try to write, and only one wins
// because `attempts` moves. That matters because two drains legitimately overlap
// in production — a Cloud Scheduler tick can land while an in-process interval is
// mid-drain — and the failure mode of getting it wrong is sending the same email
// twice, which users notice.
//
// LEASING. Claiming pushes next_attempt_at forward by CLAIM_LEASE_S. That single
// move covers both retry backoff AND crash recovery: if this process dies between
// claim and send, the row simply becomes due again when the lease expires, using
// the exact same due-query as everything else. No separate reaper to maintain.
// ============================================================

import {
  CATEGORY_PREFERENCE_COLUMN,
  EVENT_CATEGORY,
  smtpConfigured,
  type EmailSender,
  type NotificationEvent,
} from '@bharattruck/shared/notifications'
import { supabase } from '../supabase.js'
import { renderNotification, type RenderContext } from './templates.js'

type Logger = {
  warn(obj: unknown, msg: string): void
  info(obj: unknown, msg: string): void
}

// How long a claimed row stays invisible to other dispatchers. Comfortably longer
// than an SMTP round-trip (including a slow TLS handshake) so a healthy send is
// never double-claimed, short enough that a crashed process's work resumes quickly.
const CLAIM_LEASE_S = 120

// Exponential backoff between attempts: 1m, 2m, 4m, 8m, 16m. Capped so a permanently
// broken address cannot schedule itself years out and sit in the table forever.
const BACKOFF_BASE_S = 60
const BACKOFF_MAX_S = 3600

function backoffSeconds(attempts: number): number {
  return Math.min(BACKOFF_BASE_S * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_S)
}

type OutboxRow = {
  id: string
  event_type: string
  recipient_email: string
  recipient_user_id: string | null
  payload: Record<string, unknown>
  attempts: number
  max_attempts: number
  status: string
}

const OUTBOX_COLUMNS =
  'id, event_type, recipient_email, recipient_user_id, payload, attempts, max_attempts, status'

// -----------------------------------------------------------
// Preferences
// -----------------------------------------------------------

type Prefs = {
  email_marketplace: boolean
  email_trip_updates: boolean
  email_digests: boolean
  unsubscribe_token: string
}

/**
 * Read (or lazily create) the recipient's preference row.
 *
 * A missing row means "all defaults on" — we never require one to exist to send.
 * It is created on demand only when an opt-out-able email actually needs a token
 * for its unsubscribe link, so the table stays proportional to people who have
 * been sent optional mail rather than to every user who ever signed up.
 *
 * Returns null when there is no account behind the address at all (a consignee
 * receiving a delivery notice has no BharatTruck user), in which case there are no
 * preferences to honour and nothing to unsubscribe from.
 */
async function loadPreferences(userId: string | null): Promise<Prefs | null> {
  if (!userId) return null

  const { data, error } = await supabase
    .from('notification_preferences')
    .select('email_marketplace, email_trip_updates, email_digests, unsubscribe_token')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`notification_preferences select failed: ${error.message}`)
  if (data) return data as Prefs

  // No row yet — create the defaults so this user has a stable unsubscribe token.
  // Two dispatchers can race here; the PK on user_id makes the loser's insert a
  // duplicate, so re-read rather than treating it as an error.
  const { data: created, error: insertErr } = await supabase
    .from('notification_preferences')
    .insert({ user_id: userId })
    .select('email_marketplace, email_trip_updates, email_digests, unsubscribe_token')
    .maybeSingle()

  if (insertErr) {
    if (insertErr.code === '23505') {
      const { data: existing } = await supabase
        .from('notification_preferences')
        .select('email_marketplace, email_trip_updates, email_digests, unsubscribe_token')
        .eq('user_id', userId)
        .maybeSingle()
      return (existing as Prefs) ?? null
    }
    throw new Error(`notification_preferences insert failed: ${insertErr.message}`)
  }
  return (created as Prefs) ?? null
}

/** Has this recipient muted the category this event belongs to? */
function isOptedOut(event: string, prefs: Prefs | null): boolean {
  const category = EVENT_CATEGORY[event as NotificationEvent]
  // Transactional mail, and anything whose category we cannot determine, always sends.
  // Failing OPEN is deliberate: the cost of an extra email is a mild annoyance, the
  // cost of silently dropping a payment receipt is a support ticket and lost trust.
  if (!category || category === 'transactional') return false
  if (!prefs) return false
  const column = CATEGORY_PREFERENCE_COLUMN[category]
  return prefs[column] === false
}

// -----------------------------------------------------------
// Render context
// -----------------------------------------------------------

function unsubscribeUrl(token: string | null): string | null {
  const base = process.env.NOTIFICATIONS_PUBLIC_BASE_URL?.replace(/\/+$/, '')
  if (!base || !token) return null
  return `${base}/notifications/unsubscribe?token=${encodeURIComponent(token)}`
}

function renderContext(prefs: Prefs | null): RenderContext {
  return {
    shipperBaseUrl: process.env.SHIPPER_APP_BASE_URL ?? null,
    driverBaseUrl: process.env.DRIVER_APP_BASE_URL ?? null,
    unsubscribeUrl: unsubscribeUrl(prefs?.unsubscribe_token ?? null),
  }
}

// -----------------------------------------------------------
// Claim / settle
// -----------------------------------------------------------

/**
 * Compare-and-swap a candidate row into 'sending'.
 *
 * The WHERE clause is the whole point: it re-asserts every precondition we read the
 * candidate under (same attempts, still claimable, still due). A competing dispatcher
 * that got there first has already moved `attempts`, so our update matches zero rows
 * and we return null instead of sending a duplicate.
 */
async function claim(row: OutboxRow): Promise<OutboxRow | null> {
  const now = Date.now()
  const { data, error } = await supabase
    .from('notification_outbox')
    .update({
      status: 'sending',
      attempts: row.attempts + 1,
      locked_at: new Date(now).toISOString(),
      next_attempt_at: new Date(now + CLAIM_LEASE_S * 1000).toISOString(),
    })
    .eq('id', row.id)
    .eq('attempts', row.attempts)
    .in('status', ['pending', 'sending'])
    .select(OUTBOX_COLUMNS)
    .maybeSingle()

  if (error) throw new Error(`notification_outbox claim failed: ${error.message}`)
  return (data as OutboxRow) ?? null
}

async function markSent(id: string): Promise<void> {
  const nowIso = new Date().toISOString()
  await supabase
    .from('notification_outbox')
    .update({ status: 'sent', sent_at: nowIso, last_error: null })
    .eq('id', id)
}

async function markSkipped(id: string, reason: string): Promise<void> {
  await supabase
    .from('notification_outbox')
    .update({ status: 'skipped', last_error: reason, sent_at: null })
    .eq('id', id)
}

/**
 * Record a failed attempt: schedule a retry, or dead-letter once attempts are spent.
 *
 * 'failed' is terminal and deliberately NOT auto-retried — a row sitting in 'failed'
 * is a signal for a human (the failed-rows index in migration 021 exists for exactly
 * this query), not something to grind against a broken mail server forever.
 */
async function markAttemptFailed(row: OutboxRow, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err)

  // `row` is the row as returned BY claim(), which already incremented attempts — so
  // this is the count of attempts made, not one less. Adding one here would burn the
  // budget a try early and dead-letter after 4 of 5 attempts.
  const attempts = row.attempts
  const exhausted = attempts >= row.max_attempts

  await supabase
    .from('notification_outbox')
    .update({
      status: exhausted ? 'failed' : 'pending',
      last_error: message.slice(0, 500),
      locked_at: null,
      next_attempt_at: exhausted
        ? new Date().toISOString()
        : new Date(Date.now() + backoffSeconds(attempts) * 1000).toISOString(),
    })
    .eq('id', row.id)
}

// -----------------------------------------------------------
// dispatchOnce
// -----------------------------------------------------------

export type DispatchResult = {
  claimed: number
  sent: number
  skipped: number
  failed: number
}

/**
 * Refuse to drain in production when no SMTP transport is configured.
 *
 * Without this guard the dispatcher would happily run with ConsoleEmailSender:
 * every row would be claimed, "sent" successfully to stdout, and marked `sent` —
 * silently consuming the queue and destroying notifications that were never
 * delivered. That is precisely the failure mode that shipped once already with
 * the POD OTP (docs/BIBLE.md §5.4 item 10): the code path ran, nothing
 * errored, and no mail arrived.
 *
 * Leaving the rows PENDING is strictly better: the outbox accumulates, the
 * backlog is visible, and everything drains for real the moment credentials are
 * set. Dev is unaffected — console logging there is the point.
 */
export function dispatchBlockedReason(): string | null {
  if (process.env.NODE_ENV !== 'production') return null
  if (smtpConfigured()) return null
  return 'SMTP is not configured (SMTP_USER unset or EMAIL_DEV_MODE=true). ' +
    'Refusing to drain: rows would be marked sent without being delivered. ' +
    'Set the SMTP_* env on this service — see docs/BIBLE.md §7.1.'
}

/**
 * Drain up to `limit` due notifications.
 *
 * Rows are processed SEQUENTIALLY, not in parallel. SMTP providers throttle
 * aggressively on concurrent connections from one account (Gmail especially), and a
 * burst that trips that throttle gets the whole sender temporarily blocked — which
 * would take the login OTPs down with it. Throughput here is not the constraint;
 * a notification arriving a second later than it could have costs nothing.
 *
 * Never throws. A dispatcher that dies on one bad row stops delivering every other
 * row, so per-row failures are recorded and the loop continues.
 */
export async function dispatchOnce(
  sender: EmailSender,
  limit = 25,
  log?: Logger,
): Promise<DispatchResult> {
  const result: DispatchResult = { claimed: 0, sent: 0, skipped: 0, failed: 0 }

  const { data, error } = await supabase
    .from('notification_outbox')
    .select(OUTBOX_COLUMNS)
    .in('status', ['pending', 'sending'])
    .lte('next_attempt_at', new Date().toISOString())
    .order('next_attempt_at', { ascending: true })
    .limit(limit)

  if (error) throw new Error(`notification_outbox select failed: ${error.message}`)

  for (const candidate of (data ?? []) as OutboxRow[]) {
    let row: OutboxRow | null = null
    try {
      row = await claim(candidate)
      if (!row) continue // another dispatcher won it
      result.claimed++

      const prefs = await loadPreferences(row.recipient_user_id)

      if (isOptedOut(row.event_type, prefs)) {
        await markSkipped(row.id, 'recipient opted out of this category')
        result.skipped++
        continue
      }

      const message = renderNotification(row.event_type, row.payload ?? {}, renderContext(prefs))
      if (!message) {
        // Unknown event_type. Retryable on purpose: producers are allowed to deploy
        // ahead of this file, so the backoff window doubles as a grace period for the
        // template to ship. It dead-letters normally once attempts are spent.
        throw new Error(`no template registered for event '${row.event_type}'`)
      }

      await sender.send({ ...message, to: row.recipient_email })
      await markSent(row.id)
      result.sent++
    } catch (err) {
      result.failed++
      if (row) {
        try {
          await markAttemptFailed(row, err)
        } catch (bookkeepingErr) {
          // The row stays leased and becomes due again on lease expiry, so this is
          // self-healing — but it must be visible, not silent.
          log?.warn(
            { err: bookkeepingErr, id: row.id },
            'could not record notification failure (row will retry after lease expiry)',
          )
        }
      }
      log?.warn(
        { err, id: candidate.id, event: candidate.event_type },
        'notification send failed',
      )
    }
  }

  if (result.claimed > 0) {
    log?.info(result, 'notification dispatch complete')
  }
  return result
}

// -----------------------------------------------------------
// startDispatchLoop
//
// The in-process drain, for local dev and for any host where the container runs
// continuously.
//
// It is OFF by default in production and that is not an oversight: Cloud Run only
// guarantees CPU during a request unless CPU-always-allocated is set, and with
// min-instances=0 the container is frozen between requests — a setInterval would
// simply not fire, and the outbox would fill up silently. The supported production
// trigger is Cloud Scheduler POSTing /internal/notifications/dispatch (see
// routes/internal.ts). Turn this on with NOTIFICATIONS_DISPATCH_INTERVAL_MS only
// when the host actually runs the process continuously.
// -----------------------------------------------------------

export function startDispatchLoop(sender: EmailSender, log?: Logger): (() => void) | null {
  const intervalMs = Number(process.env.NOTIFICATIONS_DISPATCH_INTERVAL_MS ?? 0)
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return null

  const blocked = dispatchBlockedReason()
  if (blocked) {
    log?.warn({ reason: blocked }, 'notification dispatch loop NOT started')
    return null
  }

  let draining = false
  const timer = setInterval(() => {
    // Skip rather than stack: a drain slower than the interval must not have a second
    // one pile up behind it.
    if (draining) return
    draining = true
    void dispatchOnce(sender, 25, log)
      .catch((err) => log?.warn({ err }, 'notification dispatch loop iteration failed'))
      .finally(() => { draining = false })
  }, intervalMs)

  // Do not hold the process open on shutdown.
  timer.unref?.()
  log?.info({ intervalMs }, 'notification dispatch loop started')
  return () => clearInterval(timer)
}
