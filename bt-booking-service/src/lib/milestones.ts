// ============================================================
// src/lib/milestones.ts
//
// When a booking was accepted, started, delivered and paid — read from the
// booking_milestones view (migration 0041), which a trigger fills on every status
// change. Before 0041 is applied the view does not exist and every booking simply has
// no milestones; callers fall back to updated_at. A backfilled booking carries only its
// status at the time 0041 ran (has_backfill = true).
// ============================================================

import { supabase } from './supabase.js'
import { isMissingRelation } from './db-errors.js'

export type Milestones = {
  accepted_at: string | null
  started_at: string | null
  delivered_at: string | null
  paid_at: string | null
  has_backfill: boolean
}

const CHUNK = 200

export async function getMilestones(bookingIds: string[]): Promise<Map<string, Milestones>> {
  const out = new Map<string, Milestones>()
  const ids = [...new Set(bookingIds)]
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await supabase
      .from('booking_milestones')
      .select('booking_id, accepted_at, started_at, delivered_at, paid_at, has_backfill')
      .in('booking_id', ids.slice(i, i + CHUNK))
    if (error) {
      if (isMissingRelation(error)) return new Map() // 0041 not applied yet: no history to read
      throw new Error(`booking_milestones select failed: ${error.message}`)
    }
    for (const r of (data ?? []) as Array<Milestones & { booking_id: string }>) {
      out.set(r.booking_id, {
        accepted_at: r.accepted_at ?? null,
        started_at: r.started_at ?? null,
        delivered_at: r.delivered_at ?? null,
        paid_at: r.paid_at ?? null,
        has_backfill: !!r.has_backfill,
      })
    }
  }
  return out
}
