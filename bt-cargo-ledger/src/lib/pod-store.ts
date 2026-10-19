import { getSupabase } from './supabase.js'

// -----------------------------------------------------------
// PodStore — durable proof-of-delivery artifact writer. Injected as a
// dependency so it is trivially faked in tests. The Supabase-backed
// impl writes to pod_receipts (migration 010, not yet landed) and is
// used best-effort by pod-service: a write failure must never undo a
// trip that booking-service has already completed.
// -----------------------------------------------------------

export type PodReceipt = {
  booking_id: string
  receiver_email: string
  verified_via: string  // 'receiver_otp'
}

export interface PodStore {
  record(receipt: PodReceipt): Promise<void>
}

export class SupabasePodStore implements PodStore {
  async record(receipt: PodReceipt): Promise<void> {
    const { error } = await getSupabase().from('pod_receipts').insert({
      booking_id:    receipt.booking_id,
      receiver_email: receipt.receiver_email,
      verified_via:  receipt.verified_via,
      verified_at:   new Date().toISOString(),
    })
    if (error) throw new Error(`pod_receipts insert failed: ${error.message}`)
  }
}

export function defaultPodStore(): PodStore {
  return new SupabasePodStore()
}
