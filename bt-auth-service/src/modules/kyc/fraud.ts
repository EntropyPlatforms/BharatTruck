// Duplicate detection over the SHA-256 dedup columns (migration 0038) and fuzzy name matching to
// catch identity reuse across accounts. The hashes are computed with lib/encryption.hashForLookup,
// so the same normalisation is used at write time and here.

import type { SupabaseClient } from '@supabase/supabase-js'

const TABLE = 'user_kyc'

async function hashClashesElsewhere(
  supabase: SupabaseClient,
  column: 'aadhaar_hash' | 'pan_hash',
  hash: string,
  excludeUserId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('user_id')
    .eq(column, hash)
    .neq('user_id', excludeUserId)
    .limit(1)
  if (error) throw new Error(`${TABLE} ${column} dedup lookup failed: ${error.message}`)
  return (data?.length ?? 0) > 0
}

/** True if this Aadhaar hash already belongs to a DIFFERENT user — the same Aadhaar on two accounts. */
export function checkDuplicateAadhaar(supabase: SupabaseClient, hash: string, excludeUserId: string): Promise<boolean> {
  return hashClashesElsewhere(supabase, 'aadhaar_hash', hash, excludeUserId)
}

/** True if this PAN hash already belongs to a DIFFERENT user. */
export function checkDuplicatePAN(supabase: SupabaseClient, hash: string, excludeUserId: string): Promise<boolean> {
  return hashClashesElsewhere(supabase, 'pan_hash', hash, excludeUserId)
}

// ── fuzzy name match (PURE) ─────────────────────────────────────────────────────

const SALUTATIONS = /^(mr|mrs|ms|miss|dr|shri|smt|kum|m\/s)\.?\s+/i

function normaliseName(name: string): string {
  let n = name.trim().toLowerCase().replace(SALUTATIONS, '')
  n = n.replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()
  return n
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const curr = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    prev = curr
  }
  return prev[b.length]
}

/**
 * True when two names are close enough to be the same person: normalised Levenshtein distance
 * (distance ÷ longer length) ≤ 0.40. Tolerates initials, salutations, punctuation and spacing
 * differences between what a user typed and what the ID authority has on record; two empty names
 * are NOT a match (nothing to compare).
 */
export function fuzzyNameMatch(name1: string, name2: string): boolean {
  const a = normaliseName(name1)
  const b = normaliseName(name2)
  if (!a || !b) return false
  if (a === b) return true
  const distance = levenshtein(a, b)
  return distance / Math.max(a.length, b.length) <= 0.4
}
