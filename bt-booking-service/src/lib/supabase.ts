/**
 * Supabase service-role client for bt-booking-service.
 *
 * The lazy factory + test-injection seam now live in @bharattruck/shared/db
 * (extracted in T-BE-7). This module just re-exports them under the names this
 * service (and its harnesses / the cross-service harnesses) already use, so no
 * call site changes and behaviour is identical.
 */
export {
  supabase,
  __setServiceRoleClientForTests as __setSupabaseClientForTests,
} from '@bharattruck/shared/db'
