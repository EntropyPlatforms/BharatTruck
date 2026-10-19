// ============================================================
// src/lib/alerts/service.ts
//
// The alert sweep. Cloud Scheduler calls POST /internal/alerts/sweep — every 5 minutes
// with cadence=frequent (GPS silence) and once a day with cadence=daily (money and
// documents) — because Cloud Run freezes containers between requests, so an in-process
// timer would not fire (the same reason the email outbox is drained by Scheduler).
//
// One sweep = load facts -> run the pure rules -> reconcile with the alerts table:
//   - a new problem       -> INSERT (opened)
//   - a known problem     -> refresh title/detail/last_seen_at; severity may escalate
//   - a resolved problem  -> REOPEN the same row (new episode)
//   - a problem that went away -> resolved_at = now
// A rule whose facts fail to load is skipped AND its open alerts are left alone: "could
// not check" must never read as "all clear".
//
// Critical alerts are also emailed once per episode through the existing outbox
// (event 'alert_raised'); the outbox's dedupe key makes a re-run send nothing new.
// ============================================================

import { enqueueNotification } from '@bharattruck/shared/notifications'
import { getMilestones } from '../milestones.js'
import { istDate } from '../ist.js'
import { recipientByUserId } from '../notifications/recipients.js'
import { driverNamesByIds } from '../feed/repository.js'
import * as repo from './repository.js'
import {
  gpsSilentAlerts, licenceExpiringAlerts, tripNotStartedAlerts, unpaidOverdueAlerts, LICENCE_WARN_DAYS,
} from './rules.js'
import {
  KINDS_BY_CADENCE, SEVERITY_RANK,
  type AlertDraft, type AlertKind, type AlertRow, type SweepCadence, type SweepResult,
} from './types.js'

type Logger = { warn(obj: unknown, msg: string): void }

const DAY_MS = 24 * 60 * 60 * 1000

async function draftsFor(kind: AlertKind, now: Date): Promise<AlertDraft[]> {
  switch (kind) {
    case 'gps_silent': {
      const trips = await repo.listBookingsByStatus(['in_transit'])
      if (trips.length === 0) return []
      const ids = trips.map((b) => b.id)
      const [fixes, milestones, audience] = await Promise.all([
        repo.lastFixByBooking(ids),
        getMilestones(ids),
        repo.loadAudience(trips.map((b) => b.driver_id), trips.map((b) => b.fleet_owner_id)),
      ])
      return gpsSilentAlerts(
        trips.map((b) => ({ booking: b, lastFixAt: fixes.get(b.id) ?? null, startedAt: milestones.get(b.id)?.started_at ?? null })),
        audience, now,
      )
    }
    case 'trip_not_started': {
      const accepted = await repo.listBookingsByStatus(['accepted'])
      if (accepted.length === 0) return []
      const audience = await repo.loadAudience(accepted.map((b) => b.driver_id), accepted.map((b) => b.fleet_owner_id))
      return tripNotStartedAlerts(accepted, audience, now)
    }
    case 'unpaid_overdue': {
      const completed = await repo.listBookingsByStatus(['completed'])
      if (completed.length === 0) return []
      const ids = completed.map((b) => b.id)
      const [milestones, audience] = await Promise.all([
        getMilestones(ids),
        repo.loadAudience(completed.map((b) => b.driver_id), completed.map((b) => b.fleet_owner_id)),
      ])
      return unpaidOverdueAlerts(
        completed.map((b) => ({ booking: b, deliveredAt: milestones.get(b.id)?.delivered_at ?? null })),
        audience, now,
      )
    }
    case 'licence_expiring': {
      const cutoff = istDate(new Date(now.getTime() + LICENCE_WARN_DAYS * DAY_MS))
      const licences = await repo.listLicencesExpiringBy(cutoff)
      if (licences.length === 0) return []
      const driverIds = licences.map((l) => l.driver_id)
      const [seats, names] = await Promise.all([repo.activeSeatsForDrivers(driverIds), driverNamesByIds(driverIds)])
      const audience = await repo.loadAudience(driverIds, [...seats.values()].flat())
      return licenceExpiringAlerts(
        licences.map((l) => ({ ...l, driver_name: names.get(l.driver_id) ?? null, fleet_owner_ids: seats.get(l.driver_id) ?? [] })),
        audience, now,
      )
    }
  }
}

/** The columns a refresh may change. Identity (who, what, about which subject) never moves. */
const content = (d: AlertDraft) => ({ severity: d.severity, title: d.title, detail: d.detail })

export async function runAlertSweep(cadence: SweepCadence, now: Date, log?: Logger): Promise<SweepResult> {
  await repo.assertAlertsTable()
  const nowIso = now.toISOString()

  const drafts: AlertDraft[] = []
  const evaluated: AlertKind[] = []
  const failed: AlertKind[] = []
  for (const kind of KINDS_BY_CADENCE[cadence]) {
    try {
      drafts.push(...(await draftsFor(kind, now)))
      evaluated.push(kind)
    } catch (err) {
      log?.warn({ err, kind }, 'alert rule could not load its facts — its open alerts are left as they were')
      failed.push(kind)
    }
  }

  const existing = await repo.getAlertsByKeys(drafts.map((d) => d.dedupe_key))
  let opened = 0, refreshed = 0, escalated = 0, resolved = 0, emailed = 0
  const toEmail: Array<{ draft: AlertDraft; episode: string }> = []

  for (const d of drafts) {
    const row: AlertRow | undefined = existing.get(d.dedupe_key)
    if (!row) {
      if (await repo.insertAlert({ ...d, opened_at: nowIso, last_seen_at: nowIso })) {
        opened++
        if (d.severity === 'critical') toEmail.push({ draft: d, episode: nowIso })
      } else {
        refreshed++ // an overlapping sweep opened it a moment ago
      }
    } else if (row.resolved_at) {
      // The same problem came back: reopen the same row as a new episode.
      if (await repo.reopenAlert(row.id, { ...content(d), opened_at: nowIso, last_seen_at: nowIso, resolved_at: null, acknowledged_at: null })) {
        opened++
        if (d.severity === 'critical') toEmail.push({ draft: d, episode: nowIso })
      } else {
        refreshed++ // an overlapping sweep reopened it a moment ago
      }
    } else {
      await repo.updateAlert(row.id, { ...content(d), last_seen_at: nowIso })
      if (SEVERITY_RANK[d.severity] > SEVERITY_RANK[row.severity]) {
        escalated++
        if (d.severity === 'critical') toEmail.push({ draft: d, episode: row.opened_at })
      } else {
        refreshed++
      }
    }
  }

  // Resolve what no rule raised this time — only for kinds that were actually checked.
  if (evaluated.length > 0) {
    const live = new Set(drafts.map((d) => d.dedupe_key))
    for (const row of await repo.listOpenAlertsByKinds(evaluated)) {
      if (live.has(row.dedupe_key)) continue
      await repo.updateAlert(row.id, { resolved_at: nowIso })
      resolved++
    }
  }

  // Critical alerts reach people by email, once per episode. Never fails the sweep.
  for (const { draft, episode } of toEmail) {
    try {
      const to = await recipientByUserId(draft.audience_user_id)
      if (!to) continue
      await enqueueNotification({
        event: 'alert_raised',
        to: to.email,
        userId: to.userId,
        payload: {
          kind: draft.kind,
          persona: draft.persona,
          severity: draft.severity,
          title: draft.title,
          subtitle: draft.detail.subtitle,
          booking_id: draft.detail.booking_id ?? null,
        },
        dedupeKey: `alert_raised:${draft.dedupe_key}:${episode}`,
      }, log)
      emailed++
    } catch (err) {
      log?.warn({ err, dedupe_key: draft.dedupe_key }, 'alert email could not be queued (alert itself is saved)')
    }
  }

  return { cadence, evaluated_kinds: evaluated, failed_kinds: failed, opened, refreshed, escalated, resolved, emailed }
}
