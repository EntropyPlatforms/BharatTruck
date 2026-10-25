// ============================================================
// src/lib/alerts/types.ts
//
// The alerts contract (migration 0042). An alert is a problem that exists because
// TIME passed — a truck silent for 15 minutes, a delivery unpaid for 3 days, a licence
// about to expire — so it must be found on a schedule and kept somewhere the Home feed
// and email can read when nobody has the dashboard open. Rules decide what is wrong;
// the table only stores the answer. One row per fact (dedupe_key).
// ============================================================

export type AlertSeverity = 'critical' | 'warning' | 'info'

/**
 * Whose idiom the alert renders in — the feed's persona tag. Money follows ownership
 * (docs/ARCHITECTURE_UNIFIED_IDENTITY.md §1.1): a 'driver' alert NEVER carries a freight
 * amount; 'fleet', 'carrier' and 'shipper' are the stakeholders who see money.
 */
export type AlertPersona = 'fleet' | 'carrier' | 'driver' | 'shipper'

export type AlertKind =
  | 'gps_silent' | 'trip_not_started' | 'unpaid_overdue' | 'licence_expiring'
  // Wave 1 of the ranked new alerts (rules-wave1.ts)
  | 'ewb_expiring' | 'delivered_away' | 'documents_not_ready' | 'pickup_no_truck' | 'at_drop_not_delivered'
  | 'damage_reported' | 'delivery_unconfirmed' | 'no_bids' | 'truck_idle'

export type AlertSubjectType = 'booking' | 'vehicle' | 'driver'

/** What a rule produces. The sweep turns drafts into rows (insert / refresh / resolve). */
export type AlertDraft = {
  audience_user_id: string
  persona: AlertPersona
  kind: AlertKind
  severity: AlertSeverity
  subject_type: AlertSubjectType
  subject_id: string
  title: string
  /** `subtitle` is the one-line explanation the feed shows; the rest is template context. */
  detail: { subtitle: string; booking_id?: string; [k: string]: unknown }
  dedupe_key: string
}

export type AlertRow = AlertDraft & {
  id: string
  opened_at: string
  last_seen_at: string
  acknowledged_at: string | null
  resolved_at: string | null
}

/**
 * How often each kind is evaluated. GPS silence matters within minutes; money and
 * documents move by the day. Cloud Scheduler calls the sweep once per cadence.
 */
export type SweepCadence = 'frequent' | 'daily'

export const KINDS_BY_CADENCE: Record<SweepCadence, AlertKind[]> = {
  // Within the hour: a lapsing e-way bill, a truck waiting at the drop, a fresh damage report.
  frequent: ['gps_silent', 'ewb_expiring', 'at_drop_not_delivered', 'delivered_away', 'damage_reported', 'no_bids'],
  // By the day (08:00 IST): tomorrow's pickups, unconfirmed deliveries, idle trucks.
  daily: ['trip_not_started', 'unpaid_overdue', 'licence_expiring', 'documents_not_ready', 'pickup_no_truck', 'delivery_unconfirmed', 'truck_idle'],
}

export const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 }

/** The sweep's report — returned to Cloud Scheduler and logged. */
export type SweepResult = {
  cadence: SweepCadence
  evaluated_kinds: AlertKind[]
  /** Kinds whose facts could not be loaded. Their open alerts are left untouched, not resolved. */
  failed_kinds: AlertKind[]
  opened: number
  refreshed: number
  escalated: number
  resolved: number
  emailed: number
}

/** Thrown when migration 0042 is not applied yet; the route answers 503 with this code. */
export class AlertsNotMigratedError extends Error {
  readonly code = 'ALERTS_NOT_MIGRATED'
  constructor() {
    super('The alerts table does not exist yet — apply supabase/migrations/0042_alerts.sql')
  }
}
