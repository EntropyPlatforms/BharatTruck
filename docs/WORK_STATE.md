# WORK STATE — the architecture build, live index

> **Purpose:** one place that answers *"what is in flight, what is done, what is next"* for the
> unified-identity + compliance build. Updated as work lands. **Deleted when the build completes** —
> this is a working index, not a permanent doc (see `BIBLE.md §0.3` on why we do not keep
> parallel status docs alive).
>
> Companions: `ARCHITECTURE_UNIFIED_IDENTITY.md` (locked decisions) ·
> `INDIA_FREIGHT_COMPLIANCE.md` (legal constraints) · `BLOCKERS.md` (needs a human)
>
> Last updated: **2026-08-03**

---

## Migration numbers — CENTRALLY ASSIGNED

Numbers collide silently and the damage shows up in production. **Ask before taking one.**

| # | File | Owner | State |
|---|---|---|---|
| 0022 | `0022_unified_identity.sql` | main session | ✅ **applied to prod** 2026-08-03, verified, ledger written |
| 0023 | `0023_payout_split.sql` | `feat/payout-split` | in flight |
| 0024 | `0024_vehicle_schedule.sql` | `feat/truck-availability` | in flight |
| 0025 | `0025_pod_evidence.sql` | `feat/pod-rebuild` (delegated) | reserved |
| 0026 | `0026_freight_documents.sql` | `feat/freight-documents` (delegated) | reserved |

> ⚠️ `0019` is **taken** by the unmerged `feat/tracking-geofencing-fleet-board` branch. Do not reuse it.

---

## Branches in flight

### Open PRs — awaiting merge

| PR | Branch | Scope | CI |
|---|---|---|---|
| [#40](https://github.com/Entropy-LLP/bharattruck/pull/40) | `docs/cd-batch-merge-gotcha` | CD eviction trap + gateway HTML 429 | — |
| [#41](https://github.com/Entropy-LLP/bharattruck/pull/41) | `docs/india-freight-compliance` | compliance reference | — |
| [#42](https://github.com/Entropy-LLP/bharattruck/pull/42) | `feat/unified-identity` | persona model, 0022, shared resolver | green |
| [#43](https://github.com/Entropy-LLP/bharattruck/pull/43) | `feat/commercial-visibility` | visibility follows ownership (booking) | green |
| [#44](https://github.com/Entropy-LLP/bharattruck/pull/44) | `feat/affiliation-ownership` | affiliation reports ownership + driver app | green |

> **Merge one at a time and wait for each deploy.** Back-to-back merges evict queued CD runs and
> silently skip deploys — see `BIBLE.md §5.3` and PR #40.

### Being built now — parallel workflow, isolated worktrees

| Branch | Slice | Migration |
|---|---|---|
| `feat/payout-split` | fleet↔driver revenue split; `payouts` unique moves to `(booking_id, payee_type)` | 0023 |
| `feat/pricing-advisory` | platform quote becomes advisory for auctions (D-11 + GTA red line 3) | — |
| `feat/phone-otp-provider-seam` | one SMS provider seam so DLT wiring is config (D-14) | — |
| `feat/truck-availability` | the truck carries the schedule; no double-booking (D-19, D-8) | 0024 |

### Delegated — worktrees prepared, sessions to be spun up

Each has a `BRIEF.md` at its worktree root with full context, the locked decisions it must honour,
and its assigned migration number.

| Worktree | Branch | Scope |
|---|---|---|
| `.claude/worktrees/pod-rebuild` | `feat/pod-rebuild` | POD evidence, geofenced OTP, discrepancy capture, idempotent states (D-13, D-14) |
| `.claude/worktrees/freight-documents` | `feat/freight-documents` | LR series, e-way bill record+upload, invoice, multi-truck (D-15..D-18) |

> Both edit `bt-booking-service`. They must coordinate before touching `src/lib/service.ts` outside
> their own path.

---

## Decision coverage

| | Decision | State |
|---|---|---|
| D-1, D-5 | person accounts; no KYC gate at MVP | ✅ no code needed |
| D-6 | trucks person-owned; ownership drives visibility + marketplace | ✅ coded (#42/#43/#44) |
| D-2, D-3 | auth identifies the user; emergent personas | 🟠 schema + resolver landed; services still authorize on `role`; `/auth/me` not wired |
| D-7 | revenue split | 🟠 column live; `resolvePayees` in flight |
| D-19, D-8 | truck schedule; multi-fleet | 🟠 in flight |
| D-11 | pricing advisory | 🟠 in flight |
| D-14 | phone OTP stubbed everywhere | 🟠 in flight |
| D-10 | direct-attach | ✅ `PATCH /bookings/:id/direct-attach`; all three award paths stamp `award_path` |
| D-13 | POD rebuild, QR scrapped | ⬜ delegated |
| D-15–D-18 | invoice, multi-truck, LR, e-way bill record | ⬜ delegated |
| D-12 | Razorpay Route | ⬜ next (build inert — no creds, `BLOCKERS.md` B-1) |
| D-4 | typed KYC docs across personas | ⬜ not started |
| D-9 | joint trip history | ⬜ not enforced |
| D-20 | reputation | ⬜ deliberately deferred |

---

## Next, in order

1. Razorpay Route disbursement, **built inert** — consumes `resolvePayees` from `feat/payout-split`
2. `/auth/me` capabilities — needs `bt-auth-service` onto `@bharattruck/shared` (a build change:
   Dockerfile, CI path filter, `.npmrc`; deserves its own reviewable PR)
3. Direct-attach award flow (D-10)
4. Typed KYC documents across personas (D-4)
5. Retire `role`-based authorization service by service

## Known sequencing traps

- **Prod schema is ahead of `main`.** Correct direction for additive migrations — new columns sit
  unread until #42–#44 land. The reverse would be the problem and cannot happen here.
- **`bt-auth-service` is not on `@bharattruck/shared`.** Anything needing the persona resolver inside
  auth-service is blocked on that build change. Do not inline a second copy of the resolver.
- **Two delegated branches share `bt-booking-service`.** Sequence them or split by file.
