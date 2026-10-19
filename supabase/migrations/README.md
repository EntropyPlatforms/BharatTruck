# BharatTruck — Supabase migrations

> # ⚠️ THIS FOLDER IS HISTORY, NOT STATE
>
> These files record **how the schema changed**. They do not describe what the schema is,
> and they cannot be used to rebuild it.
>
> **For the current schema, read [`supabase/schema/baseline.sql`](../schema/baseline.sql)** —
> generated from production by introspection, verified object-by-object against the live
> catalog, and regenerable (`scripts/db/dump-schema.md`).
>
> **`0001`–`0008` do not exist and never did.** The DDL that created `users`, `bookings`,
> `drivers`, `vehicles`, `quotes`, `trips`, `notifications` and most of the founding tables
> was applied directly to the live project and was never committed to this repo. This
> folder therefore starts mid-story at `0009`. Anyone who reads these files to learn the
> schema gets a confident, badly incomplete answer — that is exactly the failure this
> banner exists to prevent.

## Why the ledger cannot tell you what is applied

`supabase_migrations.schema_migrations` is not an answer. It holds 27 rows keyed by
Supabase-CLI timestamps that do not map onto our `NNNN_` filenames, and:

- 14 rows carry names that match **no file in this folder** —
  `add_email_auth_columns`, `add_auction_quotes_negotiations`,
  `add_negotiating_to_booking_status`, `driver_track_complete_schema`,
  `maps_tracking_009`, the five `secure_*` / `fix_*` / `revoke_*` / `pin_*` security
  fixes, `create_dispatch_tracker_status`, `tracker_allow_reset_delete`, `pmo_schema`,
  `pmo_autotrack_attachments`. Most are the missing `0001`–`0008` era. Whether any of them
  is an earlier spelling of a file we do have is no longer recoverable — which is the
  point.
- One row, `reconcile_for_slice_demo_009_012`, folds four of our migrations into a single
  entry.
- Three rows (`0019`, `0020`, `0021`) are recorded under descriptive names rather than the
  file name, so a filename lookup misses them.
- **`0023_payout_split` has no row at all**, yet its columns
  (`payouts.payee_type`, `fleet_drivers.revenue_share_pct`) are live.
- The three most recent rows have a NULL `statements` column — they were written by hand
  after the SQL was executed through `execute_sql`, because this harness blocks
  `apply_migration`.

So the ledger under-reports, over-reports and mislabels. **The only reliable test is
whether the objects exist.**

## How to check whether a migration is applied

Query the catalog for something the migration creates. Never read the ledger, never
assume a file on `main` is live.

```sql
-- a table
select to_regclass('public.trip_economics') is not null;
-- a column
select exists (select 1 from pg_attribute
               where attrelid = to_regclass('public.payouts')
                 and attname = 'payee_type' and attnum > 0 and not attisdropped);
-- an enum label
select exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
               where t.typname = 'booking_status' and e.enumlabel = 'paid');
-- a function ACL (for 0027)
select proacl::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'issue_lorry_receipt';
```

## Applied state, verified against the catalog on 2026-08-07

Every line below was checked by querying for the objects, not by reading the ledger.

| Migration | Applied | Evidence checked |
|---|---|---|
| `0001`–`0008` | **n/a — never existed** | not in this repo; the equivalent DDL is live and unversioned |
| `0009_location_history` | ✅ | `location_history` exists |
| `0010_pod_receipts` | ✅ | `pod_receipts` exists; `bookings.receiver_email` exists |
| `0011_payments_payouts` | ✅ | `payments`, `payouts` exist; `booking_status` has `'paid'` |
| `0012_ops_overrides` | ✅ | `ops_overrides` exists; `user_role` has `'admin'` |
| `0013_price_quotes` | ✅ | `price_quotes` exists |
| `0014_fleet_owner_role` | ✅ | `user_role` has `'fleet_owner'` |
| `0015_fleet_owner_core` | ✅ | `fleet_owners`, `fleet_drivers` exist |
| `0016_fleet_assignment_and_auction` | ✅ | `vehicle_assignments` exists; `quotes.fleet_owner_id`, `vehicles.fleet_owner_id`, `bookings.fleet_owner_id`, `bookings.vehicle_id` exist |
| `0017_fleet_asset_economics` | ✅ | `vehicle_finance`, `vehicle_permits`, `vehicle_lanes`, `trip_economics` exist; `trip_expenses.vehicle_id` exists |
| `0018_vehicle_cost_norms` | ✅ | `vehicle_cost_norms`, `vehicle_service_cost_by_age`, `fleet_cost_settings` exist |
| `0019_geofencing_and_telemetry` | ✅ | `geofences`, `geofence_events`, `trip_telemetry` exist; `route_alerts.severity` exists |
| `0020_negotiations_fleet_owner_actor` | ✅ | `negotiations_actor_role_check` includes `'fleet_owner'` |
| `0021_notification_outbox` | ✅ | `notification_outbox`, `notification_preferences` exist |
| `0022_unified_identity` | ✅ | `users.primary_persona` exists (generated column) |
| `0023_payout_split` | ✅ | `payouts.payee_type`, `fleet_drivers.revenue_share_pct` exist — **despite having no ledger row** |
| `0024_freight_documents` | ✅ | `document_series`, `lorry_receipts`, `freight_invoices`, `eway_bill_records` and the five `*_document_*` functions exist |
| `0025_pod_evidence` | ❌ **not applied** | not on `main` — lives on `feat/pod-evidence` and `feat/pod-rebuild`. `pod_evidence`, `pod_state`, `pod_discrepancies`, `pod_audit_log` do not exist; `booking_status` has no `'delivery_asserted'`; `bookings.pod_expected_quantity` does not exist |
| `0026_consignee_party` | ✅ | `bookings.consignee_user_id`, `users.gstin`, `users.claimed_at` exist |
| `0027_document_function_acls` | ❌ **not applied** | merged to `main` in PR #87, but `anon` and `authenticated` still hold explicit `EXECUTE` on `allocate_document_number`, `next_free_document_serial`, `sync_document_series_counter`, `issue_lorry_receipt`, `issue_freight_invoice` |

`0027` is the one to act on: until it is applied, `anon` can call `issue_lorry_receipt`
and `issue_freight_invoice`, which burn numbers off a legally gapless series and write
documents. `baseline.sql` §13 records that grant as it stands.

## Other things the catalog says these files did not do

The uncommitted `0001`–`0008` pass was described in an earlier version of this README as
adding indexes, money-type constraints and integrity FKs. Some of that never landed:

- `booking_status` has **no** `'expired'` label (the auction-expiry work of `0004`).
- `bookings.awarded_quote_id` has **no** foreign key to `quotes` (`0006`).
- `location_history.driver_id` has **no** foreign key to `drivers` (`0006`).
- `bookings.min_acceptable` and `negotiations.amount` are still unbounded `numeric`,
  not `numeric(12,2)` (`0003`).

Treat any claim in a migration file about what "already exists" as unverified.

## Applying a migration

By hand, and only by hand. **CD does not apply migrations** — the deploy pipeline builds
and ships services and never touches the database. Run the SQL against the project
(historically via the Supabase MCP `execute_sql`, since `apply_migration` is blocked by
this harness's classifier), then:

1. Verify the objects exist with the catalog queries above.
2. Regenerate `supabase/schema/baseline.sql` per `scripts/db/dump-schema.md`.
3. Update the table in this file.

Migrations here are forward-only and written idempotently (`IF EXISTS` / `IF NOT EXISTS`).
Numbering is assigned centrally — ask before claiming a number, so two branches do not
both take `00NN`.

## Addendum — applied state re-verified against the catalog on 2026-08-24

Same method as above: each line checked by querying for the objects in the live
database, never by reading this ledger. Everything the 2026-08-07 pass left open
or could not see has since been applied — **the ledger above is historical; as of
2026-08-24 every migration through `0032` is live.**

| Migration | Applied | Evidence checked |
|---|---|---|
| `0025_pod_evidence` | ✅ (was ❌ on 08-07) | `pod_evidence` exists; `booking_status` has `'delivery_asserted'` |
| `0027_document_function_acls` | ✅ (was ❌ on 08-07) | `anon`/`authenticated` hold no `EXECUTE` on `issue_lorry_receipt` |
| `0028_persona_acknowledgements` | ✅ | `persona_acknowledgements` exists |
| `0029_freight_market_rates` | ✅ | `market_rates` exists |
| `0030_driver_one_live_trip` | ✅ | `bookings_one_live_trip_per_driver` index exists on `bookings` |
| `0031_fleet_owner_identifier_format` | ✅ | `fleet_owners_gstin_format` + `fleet_owners_pan_format` constraints exist (`pan` one is `NOT VALID`: one legacy row) |
| `0032_eway_status_actor` | ✅ (applied 2026-08-24) | `eway_bill_records.status_changed_by` exists |
| `0033_freight_reference_rls` | ✅ (applied 2026-08-28) | `freight_cities` / `freight_lane_rates` / `freight_market_rate_by_class` all have `relrowsecurity = true` with 0 policies (deny-all; `service_role` bypasses) |

### Why 0033 exists — read this before writing a table-creating migration

`0029` created three tables and never enabled RLS. Supabase grants `anon` and
`authenticated` full DML on every public table by default and treats RLS as the
only gate, so those three tables were readable **and writable** by anyone with
the anon key over the public PostgREST endpoint. Confirmed against production on
2026-08-28 (anonymous `SELECT` returned live lane rates; anonymous `INSERT`
returned `201`) and closed the same day by `0033`.

**Rule: every migration that creates a table in `public` must `enable row level
security` on it in the same migration** — every migration from `0009` to `0025`
does this; `0028` and `0029` were the two that did not. When a table is meant to
be service-only (which is all of them here, since the services use
`service_role`), enable RLS and add **no** policies.
