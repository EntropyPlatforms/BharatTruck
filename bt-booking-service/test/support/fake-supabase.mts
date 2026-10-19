/**
 * An in-memory stand-in for the service-role Supabase client, shared by the alerts and
 * summary suites. Same idea as the inline fakes in me-feed.e2e.mts, with the operators
 * those code paths use (count/head, order, limit, gte/lte, not-is) and two fault hooks:
 *
 *   missing — the table answers like PostgREST does for a relation a pending migration
 *             has not created yet (PGRST205), to pin the "degrade, don't 500" behaviour;
 *   failing — the table answers a generic error, to pin "could not check ≠ all clear".
 *
 * Lives under test/support/ so the package's `test/*.mts` runner does not execute it.
 */
export type Row = Record<string, any>

const UNIQUE: Record<string, string> = { alerts: 'dedupe_key', notification_outbox: 'dedupe_key' }

export function createFakeSupabase() {
  const store: Record<string, Row[]> = {}
  const missing = new Set<string>()
  const failing = new Set<string>()
  let seq = 0

  class Query {
    private filters: Array<(r: Row) => boolean> = []
    private mode: 'select' | 'insert' | 'update' = 'select'
    private payload: any = null
    private headOnly = false
    private orderBy: { col: string; asc: boolean } | null = null
    private max: number | null = null
    constructor(private table: string) {}

    select(_cols?: string, opts?: { count?: string; head?: boolean }) { if (opts?.head) this.headOnly = true; return this }
    insert(p: Row | Row[]) { this.mode = 'insert'; this.payload = p; return this }
    update(p: Row) { this.mode = 'update'; this.payload = p; return this }
    eq(c: string, v: any) { this.filters.push((r) => r[c] === v); return this }
    neq(c: string, v: any) { this.filters.push((r) => r[c] !== v); return this }
    in(c: string, vs: any[]) { this.filters.push((r) => vs.includes(r[c])); return this }
    is(c: string, v: any) { this.filters.push((r) => (r[c] ?? null) === v); return this }
    not(c: string, op: string, v: any) {
      if (op === 'is') this.filters.push((r) => (r[c] ?? null) !== v)
      else if (op === 'in') {
        const list = String(v).replace(/[()]/g, '').split(',')
        this.filters.push((r) => !list.includes(String(r[c])))
      }
      return this
    }
    gte(c: string, v: any) { this.filters.push((r) => r[c] != null && r[c] >= v); return this }
    lte(c: string, v: any) { this.filters.push((r) => r[c] != null && r[c] <= v); return this }
    gt(c: string, v: any) { this.filters.push((r) => r[c] != null && r[c] > v); return this }
    lt(c: string, v: any) { this.filters.push((r) => r[c] != null && r[c] < v); return this }
    or(expr: string) {
      const terms = expr.split(',').map((t) => t.split('.'))
      this.filters.push((r) => terms.some(([col, op, ...rest]) => op === 'eq' && String(r[col] ?? '') === rest.join('.')))
      return this
    }
    order(col: string, opts?: { ascending?: boolean }) { this.orderBy = { col, asc: opts?.ascending !== false }; return this }
    limit(n: number) { this.max = n; return this }

    private run(): { data: any; count: number | null; error: any } {
      if (missing.has(this.table)) {
        return { data: null, count: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${this.table}' in the schema cache` } }
      }
      if (failing.has(this.table)) return { data: null, count: null, error: { code: 'XX000', message: `injected failure on ${this.table}` } }
      const rows = (store[this.table] ??= [])

      if (this.mode === 'insert') {
        const items: Row[] = Array.isArray(this.payload) ? this.payload : [this.payload]
        const key = UNIQUE[this.table]
        for (const it of items) {
          if (key && rows.some((r) => r[key] === it[key])) {
            return { data: null, count: 0, error: { code: '23505', message: `duplicate key value violates unique constraint (${key})` } }
          }
        }
        const inserted = items.map((it) => ({ id: it.id ?? `${this.table}-${++seq}`, ...it }))
        rows.push(...inserted)
        return { data: inserted, count: inserted.length, error: null }
      }

      let hit = rows.filter((r) => this.filters.every((f) => f(r)))
      if (this.mode === 'update') {
        hit.forEach((r) => Object.assign(r, this.payload))
        return { data: hit, count: hit.length, error: null }
      }
      if (this.orderBy) {
        const { col, asc } = this.orderBy
        hit = [...hit].sort((a, b) => (a[col] === b[col] ? 0 : (a[col] < b[col] ? -1 : 1) * (asc ? 1 : -1)))
      }
      const count = hit.length
      if (this.max != null) hit = hit.slice(0, this.max)
      return { data: this.headOnly ? null : hit.map((r) => ({ ...r })), count, error: null }
    }

    maybeSingle() { const r = this.run(); return Promise.resolve({ data: r.data?.length ? r.data[0] : null, error: r.error }) }
    single() { return this.maybeSingle() }
    then(f: (v: any) => any, rj?: (e: any) => any) { return Promise.resolve(this.run()).then(f, rj) }
  }

  return {
    client: { from: (t: string) => new Query(t) },
    store,
    missing,
    failing,
    reset() {
      for (const k of Object.keys(store)) delete store[k]
      missing.clear()
      failing.clear()
    },
  }
}

/** A tiny pass/fail recorder in the house style (PASS/FAIL lines, non-zero exit on failure). */
export function createChecker() {
  let passed = 0
  const failures: string[] = []
  return {
    check(name: string, cond: boolean, detail = '') {
      if (cond) { passed++; console.log(`  PASS  ${name}`) } else { failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`) }
    },
    finish() {
      console.log(`\n${failures.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${passed} checks passed, ${failures.length} failed`)
      if (failures.length) { failures.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
    },
  }
}
