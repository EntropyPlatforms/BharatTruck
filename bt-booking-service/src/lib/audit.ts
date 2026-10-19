import { supabase } from './supabase.js'

// -----------------------------------------------------------
// AuditStore — durable ops-override audit trail (PRD NFR). Injected as a
// dependency so it is faked in tests. The Supabase impl writes to
// ops_overrides (migration 012, not yet landed). Used best-effort by the ops
// routes: an audit-write failure must not block an ops operator from
// unsticking a trip (and keeps the endpoints working before 012 lands) — the
// failure is logged loudly, never swallowed silently.
// -----------------------------------------------------------

export type OpsOverrideEntry = {
  booking_id: string
  action: 'force_complete' | 'reassign'
  actor_user_id: string
  // The fleet this override was performed on behalf of (migration 0036) — so a delegated or
  // ops action is traceable to a fleet, not just to the acting user. null when the booking has
  // no fleet (a solo-driver trip) or on a pre-0036 database.
  acted_for_fleet_owner_id: string | null
  from_status: string | null
  to_status: string | null
  from_driver_id: string | null
  to_driver_id: string | null
}

export interface AuditStore {
  record(entry: OpsOverrideEntry): Promise<void>
}

export class SupabaseAuditStore implements AuditStore {
  async record(entry: OpsOverrideEntry): Promise<void> {
    const { error } = await supabase.from('ops_overrides').insert({
      booking_id:     entry.booking_id,
      action:         entry.action,
      actor_user_id:  entry.actor_user_id,
      from_status:    entry.from_status,
      to_status:      entry.to_status,
      from_driver_id: entry.from_driver_id,
      to_driver_id:   entry.to_driver_id,
      // Omitted entirely when null (a solo trip, or a pre-0036 database), so the audit write
      // keeps working before migration 0036 lands — the same forward-compat trick the booking
      // insert uses for consignee/geocode columns.
      ...(entry.acted_for_fleet_owner_id ? { acted_for_fleet_owner_id: entry.acted_for_fleet_owner_id } : {}),
      created_at:     new Date().toISOString(),
    })
    if (error) throw new Error(`ops_overrides insert failed: ${error.message}`)
  }
}

export function defaultAuditStore(): AuditStore {
  return new SupabaseAuditStore()
}
