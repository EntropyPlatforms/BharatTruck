// ============================================================
// src/lib/db-errors.ts
//
// PostgREST reports an unknown table or view as 42P01 / PGRST205 (same codes the
// documents and consignee repositories already key on). Code that reads a relation a
// pending migration creates uses this to degrade instead of 500ing, because migrations
// are applied BY HAND and CD can deploy the reader first (see .github/workflows/ci.yml,
// "migration hand-apply gate").
// ============================================================

type DbError = { code?: string | null; message?: string | null } | null | undefined

const MISSING_RELATION_CODES = new Set(['42P01', 'PGRST205'])

export function isMissingRelation(error: DbError): boolean {
  if (!error) return false
  if (error.code && MISSING_RELATION_CODES.has(error.code)) return true
  return /could not find the table|relation .* does not exist/i.test(error.message ?? '')
}
