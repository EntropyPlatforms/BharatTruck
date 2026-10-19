/**
 * Shared Supabase service-role client factory.
 *
 * Service-role bypasses RLS, so ALL authorization lives in app code. The client
 * is lazy (built on first use, not import) and validates SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY at that point (fail-fast).
 *
 * Test seam: __setServiceRoleClientForTests() injects an in-memory fake so the
 * route→service→repository stack can be exercised without a live Postgres. The
 * exported `supabase` Proxy keeps every existing `supabase.from(...)` call site
 * working unchanged while resolution stays lazy + test-overridable.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let realClient: SupabaseClient | null = null
let testClient: SupabaseClient | null = null

function getRealClient(): SupabaseClient {
  if (!realClient) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
    }
    realClient = createClient(url, key, { auth: { persistSession: false } })
  }
  return realClient
}

/** Resolve the active client (test override wins). */
export function getServiceRoleClient(): SupabaseClient {
  return testClient ?? getRealClient()
}

/** Test-only: inject a fake client (pass null to restore the real one). */
export function __setServiceRoleClientForTests(client: SupabaseClient | null): void {
  testClient = client
}

/** Drop-in `supabase.from(...)` handle: lazy + test-overridable via a Proxy. */
export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    const active = getServiceRoleClient()
    const value = Reflect.get(active as object, prop, receiver)
    return typeof value === 'function' ? value.bind(active) : value
  },
})
