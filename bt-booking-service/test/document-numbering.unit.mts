/**
 * Document-number allocation — the decision this whole slice turns on.
 *
 * §3.3: the LR series belongs to the FLEET OWNER and the invoice series to the
 * SHIPPER, each gapless, each per financial year, each reset on 1 April, and
 * none of them ever renumbered. A platform-wide counter is documentary evidence
 * that the PLATFORM operates the numbering rather than the carrier, which is the
 * fact that flips the GTA analysis (§1.3 red line 1) — a tax-and-liability event,
 * not a paperwork one.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE. The allocator itself is a plpgsql
 * function in migration 0024, because the allocation has to share a transaction
 * with the INSERT of the document and supabase-js has no transactions. There is
 * no Postgres in this suite, so this file does two separate things:
 *
 *   (1) It drives the REAL repository (src/lib/documents/repository.ts) against a
 *       MODEL of the SQL function — a single-threaded emulator with a per-series
 *       lock held for the life of the "transaction", which is what Postgres's
 *       row-level lock does. That pins the CONTRACT the caller depends on:
 *       exactly one round trip, no client-side number arithmetic, gapless and
 *       unique under concurrent issue, isolated per owner, idempotent per
 *       booking. If someone rewrites the repository to read the counter and
 *       format a number in Node, these checks fail.
 *
 *   (2) It asserts the invariants of the SQL FILE itself — no sequence, the
 *       allocation and the insert inside one function, no default or trigger on
 *       valid_upto, idempotent DDL. Those are the properties a future edit is
 *       most likely to quietly break, and they are checkable without a database.
 *
 * Run: npx tsx test/document-numbering.unit.mts
 */
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256-verification'
process.env.SUPABASE_URL = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'

import { readFileSync } from 'node:fs'

let passed = 0
const failures: string[] = []
function check(label: string, ok: boolean, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`) }
  else { failures.push(`${label} ${detail}`); console.log(`  ✗ ${label} ${detail}`) }
}

// ============================================================
// A model of migration 0024's allocator.
//
// Faithful to the SQL in the ways that matter:
//   - the counter is a ROW, not a sequence, so an aborted transaction returns
//     the number to the pool instead of burning it;
//   - the "row lock" is held from the UPDATE until the transaction ends, so a
//     second allocation for the SAME series waits and then reads the new value;
//   - a DIFFERENT series is a different row and is never blocked by it;
//   - the existence check, the allocation and the insert are one transaction, and
//     a unique violation on booking_id rolls back ALL of it (in the SQL that is
//     the plpgsql exception handler discarding its subtransaction) before
//     returning the document that won;
//   - a new counter row is SEEDED from the documents already in the series, and a
//     NUMBER collision heals the counter and retries instead of re-raising. Those
//     two together are what stop a series wedging permanently — see the
//     "a counter behind its own documents" section below.
//
// The FY label and the number assembly live HERE rather than in src/. Production
// numbering is entirely plpgsql, so a TypeScript formatter would be a second
// implementation of a frozen format with no caller — the model needs its own
// arithmetic precisely because the real thing does not import any.
// ============================================================

/** Indian FY, 1 April to 31 March, in IST. Mirrors public.indian_financial_year. */
function modelFinancialYear(at: Date): string {
  const ist = new Date(at.getTime() + ((5 * 60 + 30) * 60 * 1000))
  const month = ist.getUTCMonth() + 1
  const startYear = month >= 4 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`
}

/** `[PREFIX/]<FY>/<serial>` — what allocate_document_number assembles. */
function modelNumber(fy: string, serial: number, prefix: string | null): string {
  const number = `${prefix ? `${prefix}/` : ''}${fy}/${serial}`
  // Rule 46(b) at the same point the SQL checks it, and for the same reason: a
  // truncated number is a DIFFERENT number and collides with an earlier one.
  //
  // 54000 program_limit_exceeded, exactly as the SQL raises it — an exhausted
  // series is a CONFLICT the operator can act on ("open a second series"), never
  // an anonymous internal error.
  if (!/^[A-Za-z0-9/-]{1,16}$/.test(number)) {
    const err = new Error(`series exhausted: '${number}' exceeds Rule 46(b) 16 characters`)
    ;(err as Error & { code: string }).code = '54000'
    throw err
  }
  return number
}

type SeriesRow = { next: number; prefix: string | null }

class AllocatorModel {
  readonly series = new Map<string, SeriesRow>()
  readonly lrByBooking = new Map<string, Record<string, unknown>>()
  /** Numbers present in each series — the lorry_receipts_number_idx unique. */
  readonly issued = new Map<string, Set<string>>()
  /** Per-series mutex — Postgres's row-level lock, held to commit. */
  private locks = new Map<string, Promise<void>>()
  /** Set to make the INSERT fail once, the way a CHECK violation would. */
  failNextInsert = false
  rpcCalls: string[] = []
  /** How many times the counter had to be healed past a collision. */
  heals = 0
  now: () => Date = () => new Date('2026-08-06T10:00:00Z')

  key(kind: string, issuerKind: string, issuerId: string, fy: string) {
    return `${kind}|${issuerKind}|${issuerId}|${fy}`
  }

  private numbersIn(key: string): Set<string> {
    let set = this.issued.get(key)
    if (!set) { set = new Set(); this.issued.set(key, set) }
    return set
  }

  /**
   * Rows written into lorry_receipts WITHOUT going through the allocator — the
   * backfill of historical paper LRs, which is the obvious next task and the most
   * foreseeable way for a counter to end up behind its own table.
   */
  backfill(issuerId: string, numbers: string[], fy = '2026-27', issuerKind = 'fleet_owner') {
    const set = this.numbersIn(this.key('lr', issuerKind, issuerId, fy))
    numbers.forEach(n => set.add(n))
  }

  /** next_free_document_serial: only numbers in the shape THIS series generates. */
  private nextFreeSerial(key: string, fy: string, prefix: string | null): number {
    const shape = new RegExp(`^${prefix ? `${prefix}/` : ''}${fy}/([0-9]+)$`)
    let max = 0
    for (const n of this.numbersIn(key)) {
      const m = shape.exec(n)
      if (m) max = Math.max(max, Number(m[1]))
    }
    return max + 1
  }

  /** sync_document_series_counter: advance past everything already issued. */
  private heal(key: string, fy: string) {
    const row = this.series.get(key)
    if (!row) return
    row.next = Math.max(row.next, this.nextFreeSerial(key, fy, row.prefix))
    this.heals++
  }

  private async withRowLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const held = new Promise<void>(res => { release = res })
    this.locks.set(key, previous.then(() => held))
    await previous
    try { return await fn() } finally { release() }
  }

  async issueLorryReceipt(args: {
    p_booking_id: string
    p_issuer_kind: string
    p_issuer_id: string
    p_prefix: string | null
    p_payload: Record<string, unknown>
  }) {
    this.rpcCalls.push('issue_lorry_receipt')

    // Already issued → returned untouched. Never renumbered.
    const existing = this.lrByBooking.get(args.p_booking_id)
    if (existing) return existing

    const fy = modelFinancialYear(this.now())
    const key = this.key('lr', args.p_issuer_kind, args.p_issuer_id, fy)

    return this.withRowLock(key, async () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        let row = this.series.get(key)
        if (!row) {
          // A NEW counter is SEEDED from the documents already in the series, not
          // started at 1. Starting at 1 behind a backfilled row collides on the
          // very first allocation and on every one after it.
          row = { next: this.nextFreeSerial(key, fy, args.p_prefix ?? null), prefix: args.p_prefix ?? null }
          this.series.set(key, row)
        }

        // The UPDATE ... RETURNING next_number - 1. The prefix comes from the
        // STORED row: a series in flight never changes shape mid-year.
        const serial = row.next
        row.next += 1
        let number: string
        try {
          number = modelNumber(fy, serial, row.prefix)
        } catch (err) {
          // The whole transaction aborts, so the increment rolls back with it and
          // no number is burnt — the series just cannot advance past this point.
          row.next = serial
          throw err
        }

        // The window in which a real transaction is still open.
        await Promise.resolve()

        const failed = this.failNextInsert
        this.failNextInsert = false
        const lostTheRace = this.lrByBooking.has(args.p_booking_id)
        const numberTaken = this.numbersIn(key).has(number)

        if (failed || lostTheRace || numberTaken) {
          // ABORT. The counter increment is part of the same transaction, so it
          // goes back — this is precisely why a sequence is the wrong tool.
          row.next = serial
          if (lostTheRace) return this.lrByBooking.get(args.p_booking_id)!
          if (failed) throw new Error('simulated insert failure (check violation)')

          // A NUMBER collision, not a booking one. Re-raising here is what wedged
          // the series: the rollback already discarded the increment, so the next
          // request would allocate the identical colliding number, for ever. Heal
          // the counter past what is actually in the table and go round again.
          this.heal(key, fy)
          continue
        }

        const doc = {
          id: `lr-${number}`,
          booking_id: args.p_booking_id,
          lr_number: number,
          financial_year: fy,
          issuer_kind: args.p_issuer_kind,
          issuer_id: args.p_issuer_id,
          ...args.p_payload,
        }
        this.lrByBooking.set(args.p_booking_id, doc)
        this.numbersIn(key).add(number)
        return doc
      }
      throw new Error('document number still colliding after 3 attempts')
    })
  }
}

/** Supabase stand-in exposing only what the repository is allowed to touch. */
function fakeSupabase(model: AllocatorModel) {
  const touchedTables: string[] = []
  return {
    touchedTables,
    client: {
      from(table: string) {
        touchedTables.push(table)
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
              order: async () => ({ data: [], error: null }),
            }),
          }),
        }
      },
      async rpc(fn: string, args: any) {
        try {
          if (fn === 'issue_lorry_receipt') return { data: await model.issueLorryReceipt(args), error: null }
          return { data: null, error: { code: 'PGRST202', message: `no function ${fn}` } }
        } catch (err) {
          // Postgres SQLSTATEs travel back through PostgREST; keep the one the
          // allocator chose so the repository's mapping is exercised.
          const code = (err as { code?: string }).code ?? '23514'
          return { data: null, error: { code, message: (err as Error).message } }
        }
      },
    },
  }
}

const OWNER_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const OWNER_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const booking = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const LR_PAYLOAD = { consignor_name: 'Destinio Clothing Co.', consignee_name: 'Maru Enterprises' }

async function main() {
  const { __setSupabaseClientForTests } = await import('../src/lib/supabase.js')
  const docs = await import('../src/lib/documents/repository.js')

  const issue = (model: AllocatorModel, bookingId: string, issuerId: string, prefix: string | null = null) =>
    docs.issueLorryReceipt({
      bookingId,
      issuerKind: 'fleet_owner',
      issuerId,
      prefix,
      payload: LR_PAYLOAD,
    })

  console.log('\n── the caller never computes a number')
  {
    const model = new AllocatorModel()
    const fake = fakeSupabase(model)
    __setSupabaseClientForTests(fake.client as any)

    const lr = await issue(model, booking(1), OWNER_A)
    check('one issue is exactly one round trip', model.rpcCalls.length === 1, `(got ${model.rpcCalls.length})`)
    check('and it is the RPC, not a table write', model.rpcCalls[0] === 'issue_lorry_receipt')
    check(
      'the counter table is never read from Node',
      !fake.touchedTables.includes('document_series'),
      `(touched ${JSON.stringify(fake.touchedTables)})`,
    )
    check('the first document of the year is serial 1', lr.lr_number === '2026-27/1', `(got ${lr.lr_number})`)
  }

  console.log('\n── gapless and unique under concurrent issue')
  {
    const model = new AllocatorModel()
    __setSupabaseClientForTests(fakeSupabase(model).client as any)

    // 25 bookings for ONE fleet owner confirming at the same instant.
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => issue(model, booking(100 + i), OWNER_A)),
    )
    const numbers = results.map(r => r.lr_number)
    const serials = numbers.map(n => Number(n.split('/')[1])).sort((a, b) => a - b)

    check('every concurrent issue got a number', numbers.every(Boolean))
    check('no two bookings share a number', new Set(numbers).size === 25)
    check('the series is 1..25 with no gap', serials.every((s, i) => s === i + 1), `(got ${serials.join(',')})`)
    check('the counter is left pointing at 26', model.series.get(`lr|fleet_owner|${OWNER_A}|2026-27`)?.next === 26)
    check('every number satisfies Rule 46(b)', numbers.every(n => /^[A-Za-z0-9/-]{1,16}$/.test(n)))
  }

  console.log('\n── a failed insert must not burn a number')
  {
    const model = new AllocatorModel()
    __setSupabaseClientForTests(fakeSupabase(model).client as any)

    const first = await issue(model, booking(200), OWNER_A)
    check('first document is 2026-27/1', first.lr_number === '2026-27/1')

    // The transaction aborts AFTER the counter was incremented — a CHECK
    // violation, a disconnect, a crashed container. With a sequence this number
    // would be gone forever; with a counter row it rolls back.
    model.failNextInsert = true
    let threw = false
    try { await issue(model, booking(201), OWNER_A) } catch { threw = true }
    check('the failed issue surfaces as an error, not a silent success', threw)

    const next = await issue(model, booking(202), OWNER_A)
    check(
      'the NEXT document reuses the serial the aborted one had — no gap',
      next.lr_number === '2026-27/2',
      `(got ${next.lr_number})`,
    )
  }

  console.log('\n── a retried request never mints a second document')
  {
    const model = new AllocatorModel()
    __setSupabaseClientForTests(fakeSupabase(model).client as any)

    const a = await issue(model, booking(300), OWNER_A)
    const b = await issue(model, booking(300), OWNER_A)
    check('the same booking returns the same LR number', a.lr_number === b.lr_number)
    check('and the counter did not move', model.series.get(`lr|fleet_owner|${OWNER_A}|2026-27`)?.next === 2)

    // Two requests for one booking racing each other: the loser aborts on the
    // booking_id unique, gives its serial back, and returns the winner's row.
    const [x, y] = await Promise.all([issue(model, booking(301), OWNER_A), issue(model, booking(301), OWNER_A)])
    check('a concurrent double-submit converges on one document', x.lr_number === y.lr_number)
    check(
      'and the loser returned its serial to the pool',
      model.series.get(`lr|fleet_owner|${OWNER_A}|2026-27`)?.next === 3,
      `(next=${model.series.get(`lr|fleet_owner|${OWNER_A}|2026-27`)?.next})`,
    )
    const after = await issue(model, booking(302), OWNER_A)
    check('so the next booking is 2026-27/3, not /4', after.lr_number === '2026-27/3', `(got ${after.lr_number})`)
  }

  console.log('\n── two fleet owners NEVER share a series (§3.3 / red line 1)')
  {
    const model = new AllocatorModel()
    __setSupabaseClientForTests(fakeSupabase(model).client as any)

    const interleaved = await Promise.all([
      issue(model, booking(400), OWNER_A),
      issue(model, booking(401), OWNER_B),
      issue(model, booking(402), OWNER_A),
      issue(model, booking(403), OWNER_B),
    ])

    const a = interleaved.filter((_, i) => i % 2 === 0).map(r => r.lr_number)
    const b = interleaved.filter((_, i) => i % 2 === 1).map(r => r.lr_number)

    check('owner A numbers its own documents 1, 2', a.join() === '2026-27/1,2026-27/2', `(got ${a.join()})`)
    check('owner B ALSO starts at 1 — not 3', b.join() === '2026-27/1,2026-27/2', `(got ${b.join()})`)
    check('the two owners hold separate counter rows', model.series.size === 2)
    check(
      'neither owner can infer the other\'s document volume from its own numbers',
      model.series.get(`lr|fleet_owner|${OWNER_A}|2026-27`)?.next === 3 &&
      model.series.get(`lr|fleet_owner|${OWNER_B}|2026-27`)?.next === 3,
    )
  }

  console.log('\n── the series resets on 1 April, structurally')
  {
    const model = new AllocatorModel()
    __setSupabaseClientForTests(fakeSupabase(model).client as any)

    model.now = () => new Date('2026-03-31T12:00:00+05:30')
    const march = await issue(model, booking(500), OWNER_A)
    check('31 March issues into FY 2025-26', march.lr_number === '2025-26/1', `(got ${march.lr_number})`)

    model.now = () => new Date('2026-04-01T09:00:00+05:30')
    const april = await issue(model, booking(501), OWNER_A)
    check('1 April starts a NEW series at 1', april.lr_number === '2026-27/1', `(got ${april.lr_number})`)
    check('the old year\'s counter is untouched', model.series.get(`lr|fleet_owner|${OWNER_A}|2025-26`)?.next === 2)
    check('no scheduled job is involved — the FY is part of the counter key', model.series.size === 2)

    // The IST boundary again, this time through the allocator: 23:00 UTC on
    // 31 March is already 1 April in Kolkata.
    model.now = () => new Date('2026-03-31T23:00:00Z')
    const boundary = await issue(model, booking(502), OWNER_A)
    check('a 31-Mar-23:00-UTC issue lands in FY 2026-27', boundary.lr_number === '2026-27/2', `(got ${boundary.lr_number})`)
  }

  console.log('\n── a per-owner prefix is frozen at the first document of the year')
  {
    const model = new AllocatorModel()
    __setSupabaseClientForTests(fakeSupabase(model).client as any)

    const first = await issue(model, booking(600), OWNER_A, 'MA')
    check('the prefix shapes the number like the Maru specimen', first.lr_number === 'MA/2026-27/1')

    const second = await issue(model, booking(601), OWNER_A, 'ZZ')
    check(
      'a different prefix later is IGNORED, not applied mid-series',
      second.lr_number === 'MA/2026-27/2',
      `(got ${second.lr_number})`,
    )
  }

  console.log('\n── a counter behind its own documents must SELF-HEAL, not wedge')
  {
    // 🔴 The wedge. Backfilling historical paper LRs into lorry_receipts without
    // touching document_series is the obvious next task, and it leaves the counter
    // pointing at a number that already exists. The insert then fails on the
    // number index — and because catching that exception rolls the subtransaction
    // back, the counter increment goes back with it. A handler that merely
    // re-raises therefore leaves next_number exactly where it was, so the NEXT
    // request allocates the same number and fails identically. One backfill takes
    // a party out for the rest of the financial year.

    // (a) The counter is SEEDED when the series row is first created.
    {
      const model = new AllocatorModel()
      __setSupabaseClientForTests(fakeSupabase(model).client as any)
      model.backfill(OWNER_A, ['2026-27/1', '2026-27/2', '2026-27/3'])

      const first = await issue(model, booking(700), OWNER_A)
      check(
        'the first allocation after a backfill continues the series, not restarts it',
        first.lr_number === '2026-27/4',
        `(got ${first.lr_number})`,
      )
      check('no healing was needed — the seed got it right', model.heals === 0)
      const second = await issue(model, booking(701), OWNER_A)
      check('and it keeps going', second.lr_number === '2026-27/5', `(got ${second.lr_number})`)
    }

    // (b) An EXISTING counter that has fallen behind heals on collision. This is
    //     the case the seed cannot cover: the series row was created first, then
    //     rows appeared underneath it.
    {
      const model = new AllocatorModel()
      __setSupabaseClientForTests(fakeSupabase(model).client as any)

      const one = await issue(model, booking(710), OWNER_A)
      check('a normal first document', one.lr_number === '2026-27/1')

      // Now a backfill lands on top of the live counter, which still says 2.
      model.backfill(OWNER_A, ['2026-27/2', '2026-27/3', '2026-27/4'])

      const next = await issue(model, booking(711), OWNER_A)
      check(
        'the next issue steps over the backfilled block instead of 500ing',
        next.lr_number === '2026-27/5',
        `(got ${next.lr_number})`,
      )
      check('and it took exactly one heal to get there', model.heals === 1, `(heals=${model.heals})`)

      // THE ORIGINAL BUG, stated as a check: three consecutive attempts all failed
      // with the same duplicate key and next_number never moved. If the handler
      // re-raises, the two issues below both throw and the counter stays at 2.
      const after1 = await issue(model, booking(712), OWNER_A)
      const after2 = await issue(model, booking(713), OWNER_A)
      check('consecutive requests keep succeeding — the series is not wedged',
        after1.lr_number === '2026-27/6' && after2.lr_number === '2026-27/7',
        `(got ${after1.lr_number}, ${after2.lr_number})`)
      check('and no further healing was needed', model.heals === 1)
    }

    // (c) Healing NEVER pulls a counter backwards. That would reissue a number
    //     already printed on a document someone is holding.
    {
      const model = new AllocatorModel()
      __setSupabaseClientForTests(fakeSupabase(model).client as any)
      for (const b of [720, 721, 722]) await issue(model, booking(b), OWNER_A)
      const key = model.key('lr', 'fleet_owner', OWNER_A, '2026-27')
      check('three documents leave the counter at 4', model.series.get(key)?.next === 4)

      // A backfill of numbers BELOW the counter changes nothing.
      model.backfill(OWNER_A, ['2026-27/1'])
      const next = await issue(model, booking(723), OWNER_A)
      check('a stale backfill does not rewind the series', next.lr_number === '2026-27/4', `(got ${next.lr_number})`)
    }

    // (d) A differently-shaped historical number must NOT consume serials. The
    //     §11.1 Maru specimen 'MA/4135/2526' cannot collide with anything this
    //     allocator produces, so counting it would put a real gap in the series.
    {
      const model = new AllocatorModel()
      __setSupabaseClientForTests(fakeSupabase(model).client as any)
      model.backfill(OWNER_A, ['MA/4135/2526', '2025-26/900'])

      const first = await issue(model, booking(730), OWNER_A)
      check(
        'a paper number in another shape does not skip serials',
        first.lr_number === '2026-27/1',
        `(got ${first.lr_number})`,
      )
    }
  }

  console.log('\n── a series must not run out of numbers mid-year (Rule 46(b))')
  {
    // 🔴 The second wedge. 'ABCD/2026-27/999' is exactly 16 characters, so a
    // 4-character prefix caps an owner at 999 documents for the whole year —
    // and there is no product path to shorten a prefix, because the shape of a
    // series in flight is frozen at its first document. The fix is upstream: the
    // prefix a caller may supply is capped so the budget is adequate.
    const { SERIES_PREFIX_PATTERN, MAX_SERIES_PREFIX_LENGTH, serialBudgetForPrefix, MIN_SERIALS_PER_FINANCIAL_YEAR } =
      await import('../src/lib/documents/rules.js')

    check('a 4-character prefix cannot reach the allocator at all',
      !SERIES_PREFIX_PATTERN.test('ABCD'))
    check('the admissible prefixes all hold a year of real operation',
      serialBudgetForPrefix('x'.repeat(MAX_SERIES_PREFIX_LENGTH)) >= MIN_SERIALS_PER_FINANCIAL_YEAR)

    // And the allocator still refuses to truncate if a series somehow gets there:
    // a truncated number is a DIFFERENT number and collides with an earlier one.
    const model = new AllocatorModel()
    __setSupabaseClientForTests(fakeSupabase(model).client as any)
    const key = model.key('lr', 'fleet_owner', OWNER_A, '2026-27')
    model.series.set(key, { next: serialBudgetForPrefix('AB') + 1, prefix: 'AB' })

    let status = 0
    try { await issue(model, booking(800), OWNER_A, 'AB') }
    catch (err) { status = (err as { httpStatus?: number }).httpStatus ?? -1 }
    check('past the budget the allocator refuses rather than truncating', status !== 0)
    check(
      'and it surfaces as an actionable 409, not an anonymous 500',
      status === 409,
      `(got ${status})`,
    )
    check('no number was burnt getting there',
      model.series.get(key)?.next === serialBudgetForPrefix('AB') + 1,
      `(next=${model.series.get(key)?.next})`)
  }

  console.log('\n── the migration file itself')
  {
    const raw = readFileSync(new URL('../../supabase/migrations/0024_freight_documents.sql', import.meta.url), 'utf8')

    // Assert on the CODE, not the prose. The comments in that file talk about
    // sequences and generated columns precisely to explain why they are not used,
    // so a naive grep over the whole file would match its own reasoning.
    const sql = raw
      .split('\n')
      .map(line => line.replace(/--.*$/, ''))
      .join('\n')

    // A sequence does not roll back. Any failure between nextval() and commit
    // burns a number permanently, and Rule 46(b) wants a CONSECUTIVE series.
    check('no sequence is used for document numbers', !/create\s+sequence|nextval\s*\(/i.test(sql))
    check('the counter is a row in document_series', /create table if not exists public\.document_series/.test(sql))
    check(
      'allocation is an UPDATE ... RETURNING on that row (the lock IS the serialisation)',
      /update public\.document_series[\s\S]{0,400}returning next_number - 1/.test(sql),
    )
    check(
      'the series is unique per (kind, issuer, financial year)',
      /unique \(series_kind, issuer_kind, issuer_id, financial_year\)/.test(sql),
    )

    // Allocation and persistence in ONE function = one implicit transaction.
    const issueFn = sql.slice(sql.indexOf('function public.issue_lorry_receipt'), sql.indexOf('function public.issue_freight_invoice'))
    check('issue_lorry_receipt allocates…', /allocate_document_number\('lr'/.test(issueFn))
    check('…and inserts the document in the same function', /insert into public\.lorry_receipts/.test(issueFn))
    check('…and rolls back onto the existing row on a unique violation', /when unique_violation then/.test(issueFn))

    // 🔴 The wedge fix, asserted on the SQL itself. A handler that only re-raises
    // leaves next_number where the rollback left it, so every later request
    // collides identically — a permanent 500 for one party for the rest of the FY.
    check('a new counter is SEEDED from the documents already in the series',
      /insert into public\.document_series[\s\S]{0,400}next_number[\s\S]{0,400}next_free_document_serial/.test(sql))
    check('next_free_document_serial counts only numbers this series would generate',
      /v_pattern := '\^' \|\| coalesce\(p_prefix \|\| '\/', ''\) \|\| p_financial_year/.test(sql))
    check('the collision handler HEALS the counter rather than re-raising',
      /when unique_violation then[\s\S]{0,900}sync_document_series_counter/.test(issueFn))
    check('and the invoice side heals too',
      /when unique_violation then[\s\S]{0,900}sync_document_series_counter\('invoice'/.test(sql))
    check('healing never pulls a counter backwards',
      /set next_number = greatest\(next_number, v_free\)/.test(sql))
    check('the retry is bounded, so a genuine anomaly is not spun on',
      /v_attempt >= 3/.test(sql))

    // Rule 46(b) overflow: the prefix budget is what stops a series running out,
    // and the ceiling reports as something a service layer can act on.
    check('the series prefix is capped at 2 characters (99,999 numbers a year)',
      /prefix\s+text check \(prefix ~ '\^\[A-Za-z0-9-\]\{1,2\}\$'\)/.test(sql))
    check('an exhausted series raises program_limit_exceeded, not check_violation',
      /program_limit_exceeded/.test(sql) && !/errcode = 'check_violation'/.test(sql))

    check(
      'the invoice series belongs to the SHIPPER, not the carrier',
      /allocate_document_number\('invoice', 'shipper'/.test(sql),
    )

    // Rule 46(b) at the storage layer, so no code path can bypass it.
    check(
      'lr_number carries the Rule 46(b) CHECK',
      /lr_number\s+text not null\s*\n?\s*check \(lr_number ~ '\^\[A-Za-z0-9\/-\]\{1,16\}\$'\)/.test(sql),
    )
    check(
      'invoice_number carries it too',
      /invoice_number\s+text not null\s*\n?\s*check \(invoice_number ~ '\^\[A-Za-z0-9\/-\]\{1,16\}\$'\)/.test(sql),
    )

    // §4.1 — the GST-inclusive formula, enforced by the database.
    check(
      'consignment_value_inr is generated from the Rule 138 formula',
      /consignment_value_inr[\s\S]{0,200}generated always as \(taxable_value_inr \+ cgst_inr \+ sgst_inr \+ utgst_inr[\s\S]{0,80}- exempt_value_inr\) stored/.test(sql),
    )
    check(
      'charged weight is stored separately from actual, and cannot be lower',
      /charged_weight_kg >= actual_weight_kg/.test(sql),
    )
    check(
      'the LR total is generated from the separate charge lines',
      /total_charge_inr[\s\S]{0,200}generated always as \(freight_charge_inr \+ stationary_charge_inr[\s\S]{0,120}stored/.test(sql),
    )

    // §4.4 — valid_upto is copied from the portal. No default, no trigger, no
    // generated expression: the only way a value gets in is by being given.
    const ewbStart = sql.indexOf('create table if not exists public.eway_bill_records')
    const ewbTable = sql.slice(ewbStart, sql.indexOf('\n);', ewbStart))
    const validUptoLine = ewbTable.split('\n').find(l => /^\s*valid_upto\s/.test(l)) ?? ''
    check('valid_upto is a plain required column', /valid_upto\s+timestamptz not null\s*,?\s*$/.test(validUptoLine.trim() + ''), `(line: ${validUptoLine.trim()})`)
    check('valid_upto has no default', !/valid_upto[^\n]*default/i.test(ewbTable))
    check('valid_upto is not a generated column', !/valid_upto[^\n]*generated always/i.test(ewbTable))
    check('no trigger recomputes it', !/create\s+(or replace\s+)?trigger/i.test(sql))
    check('Part B entry is recorded (Rule 138(5A))', /part_b_entered_at\s+timestamptz/.test(sql))
    check('the issuing portal is recorded (portal affinity)', /issuing_portal\s+public\.ewb_portal not null/.test(sql))

    // §4.5 — the table's own comment promises you can ask "which bill was live
    // when the vehicle was stopped". That needs a status, and it needs the number
    // NOT to be globally unique, because one consolidated bill can legitimately
    // cover two bookings (D-16).
    check('an e-way bill carries a status', /status\s+public\.ewb_status not null default 'active'/.test(sql))
    check("but never 'expired' — that is derived from valid_upto and the clock",
      /create type public\.ewb_status as enum \('active', 'cancelled', 'rejected'\)/.test(sql))
    check('a status change is dated', /eway_bill_status_change_is_dated/.test(sql))
    check('the bill number is unique PER BOOKING, not globally',
      /constraint eway_bill_records_booking_number_key unique \(booking_id, ewb_number\)/.test(sql) &&
      !/ewb_number\s+text not null unique/.test(sql))
    check('the expiry sweep ignores bills nobody is relying on any more',
      /where part_b_entered_at is not null and status = 'active'/.test(sql))

    // Idempotency — the file may be re-run against a database that has some of it.
    const creates = sql.match(/create table[^;]*?public\./g) ?? []
    check('every create table is guarded', creates.every(c => /if not exists/.test(c)), `(${creates.length} tables)`)
    const indexes = sql.match(/create (unique )?index[^;]*?on/g) ?? []
    check('every create index is guarded', indexes.every(i => /if not exists/.test(i)), `(${indexes.length} indexes)`)
    const types = sql.match(/create type public\.\w+/g) ?? []
    check('all six enums are created behind a pg_type guard', types.length === 6 && (sql.match(/if not exists \(select 1 from pg_type where typname/g) ?? []).length === 6, `(${types.length} types)`)
    check('a table that already exists in an older shape is caught up, not skipped',
      /alter table public\.eway_bill_records add column if not exists status/.test(sql))

    // The document-minting functions must not be reachable from a browser key.
    // Naming anon/authenticated is not enough — they are members of PUBLIC, and
    // Postgres grants EXECUTE to PUBLIC on every new function, so the revoke has
    // to name PUBLIC and the grant back to service_role has to follow it.
    check('EXECUTE is revoked from PUBLIC on the issuing functions',
      /revoke execute on function[\s\S]{0,500}?from public;/.test(sql))
    check('and granted back to service_role', /grant execute on function[\s\S]{0,500}?to service_role;/.test(sql))

    // The additive rule: this migration runs against a live DB with 677 bookings.
    check('no existing column is altered', !/alter table public\.(bookings|users|drivers|quotes|fleet_owners|payouts)/.test(sql))
    check('no table or column is dropped', !/\bdrop (table|column|type)\b/i.test(sql))
    // Constraint drops ARE allowed, but only on tables this file itself creates —
    // dropping one from a pre-existing table would break the additive rule.
    const OWN_TABLES = ['document_series', 'lorry_receipts', 'freight_invoices', 'eway_bill_records']
    const constraintDrops = sql.match(/alter table public\.(\w+)[^;]*?drop constraint/gi) ?? []
    check('any constraint drop is scoped to a table this migration creates',
      constraintDrops.every(d => OWN_TABLES.some(t => d.includes(`public.${t}`))),
      `(${constraintDrops.length} drops)`)
    check('it does not depend on 0023 (payout_split)', !/payouts|payee_type|revenue_share_pct/.test(sql))
  }

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach(f => console.log(`  - ${f}`)); process.exit(1) }
}

main().catch(err => { console.error(err); process.exit(1) })
