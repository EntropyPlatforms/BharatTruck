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
import { type SupabaseClient } from '@supabase/supabase-js';
/** Resolve the active client (test override wins). */
export declare function getServiceRoleClient(): SupabaseClient;
/** Test-only: inject a fake client (pass null to restore the real one). */
export declare function __setServiceRoleClientForTests(client: SupabaseClient | null): void;
/** Drop-in `supabase.from(...)` handle: lazy + test-overridable via a Proxy. */
export declare const supabase: SupabaseClient;
