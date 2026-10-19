import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazily-constructed service-role client so importing this module (or a
// verification harness that injects a fake PodStore) does not require live
// credentials until a query is actually issued.
let client: SupabaseClient | null = null

export function getSupabase(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
    }
    client = createClient(url, key, { auth: { persistSession: false } })
  }
  return client
}
