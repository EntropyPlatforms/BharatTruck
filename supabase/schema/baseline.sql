-- =====================================================================================
-- BharatTruck — schema `public` BASELINE
--
-- GENERATED FROM PRODUCTION on 2026-09-20 by introspecting the live catalog of the
-- Supabase project `bharattruck-mvp` (rxbdzbcndpzznvqcbimg, PostgreSQL 17.6) — not
-- hand-written, not derived from the migration files. Reflects every migration applied to
-- prod through 0039 (the 0032–0038 hardening set + 0039 verified-delivery POD, plus the
-- earlier deltas that had accrued since the 2026-08-07 baseline).
--
-- THIS FILE IS THE SOURCE OF TRUTH FOR THE CURRENT SCHEMA. `supabase/migrations/*.sql`
-- is history: it is incomplete (0001-0008 were never committed — see
-- supabase/migrations/README.md) and reading it will give you a confident but wrong
-- picture of what the database actually looks like. Read this file instead.
--
-- IT IS REGENERABLE. `scripts/db/dump-schema.md` contains every query that produced
-- every section below, in order. Re-run them and replace this file wholesale.
--
-- HAND-EDITING IT IS MEANINGLESS. This file describes what IS. Editing it does not
-- change the database; it only makes the file wrong until the next regeneration
-- silently reverts your edit. To change the schema: write a migration, apply it by
-- hand (see supabase/schema/README.md), then regenerate this file.
--
-- Faithfulness notes — read before trusting a detail:
--   * Objects owned by extensions are EXCLUDED (they belong to the extension, not to
--     us): the `spatial_ref_sys` table, the `geometry_columns` / `geography_columns`
--     views and 744 PostGIS/pgcrypto/uuid-ossp functions. `CREATE EXTENSION` recreates
--     them.
--   * Constraint, index, function, trigger and view bodies are verbatim
--     `pg_get_constraintdef` / `pg_indexes.indexdef` / `pg_get_functiondef` /
--     `pg_get_triggerdef` / `pg_get_viewdef` output. Nothing there was retyped.
--   * Indexes that back a PRIMARY KEY or UNIQUE constraint are NOT emitted in the index
--     section — they are created by the constraint. They were identified by
--     `pg_constraint.conindid` pointing at the index, not by name matching.
--   * Column order is `pg_attribute.attnum` order, i.e. physical order, which is what
--     `SELECT *` returns.
--   * Enum labels are in `enumsortorder` order. That order is semantic (it is the
--     ordering `<` uses) — do not re-alphabetise them.
--
-- Contents, with the counts verified against the catalog after generation:
--   1. Extensions .................  7
--   2. Enum types .................  16
--   3. Tables .....................  75   (+1 extension-owned: spatial_ref_sys)
--   4. Primary key / unique .......  107
--   5. Check constraints ..........  185
--   6. Foreign keys ...............  124
--   7. Indexes (non-constraint) ...  129  (237 total in schema, 108 back constraints)
--   8. Functions ..................  15   (+744 extension-owned)
--   9. Triggers ...................  15
--  10. Views ......................  2    (+2 extension-owned)
--  11. Row level security ......... 75 tables, 34 policies
--  12. Comments ................... 34 table, 43 column, 6 function
--  13. Grants ..................... see section
-- =====================================================================================


-- =====================================================================================
-- 1. EXTENSIONS
-- =====================================================================================
-- `plpgsql` is in pg_catalog and always present. `pg_graphql` and `supabase_vault` are
-- installed and upgraded by the Supabase platform into their own schemas; they are
-- recorded here for completeness, not because we manage them.
--
-- PostGIS is installed INTO `public`. Note what that does and does not mean: it is the
-- source of `spatial_ref_sys`, two views and 744 functions in this schema, and it is
-- why the raw object counts above look inflated. It is NOT in use — there are ZERO
-- geometry/geography columns in the schema, and every coordinate in this database is a
-- plain `numeric` or `double precision` lat/lng pair, exactly as the frozen Maps
-- contract requires (docs/BIBLE.md §3.1, "no PostGIS").

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;   -- 1.1
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;      -- 1.3  (gen_random_uuid)
CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions; -- 1.11
CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;           -- 3.3.7 (installed, unused)
-- Platform-managed, listed for completeness:
--   pg_graphql      1.5.11  @ graphql
--   supabase_vault  0.3.1   @ vault
--   plpgsql         1.0     @ pg_catalog


-- =====================================================================================
-- 2. ENUM TYPES
-- =====================================================================================
-- Labels are in sort order. Postgres cannot remove or reorder a label, so this order is
-- part of the contract.

CREATE TYPE public.booking_award_path AS ENUM ('auction', 'instant', 'direct_attach');
CREATE TYPE public.booking_status AS ENUM ('pending', 'negotiating', 'accepted', 'in_transit', 'completed', 'cancelled', 'paid', 'delivery_asserted');
CREATE TYPE public.delivery_mode AS ENUM ('GODOWN', 'DOOR');
CREATE TYPE public.doc_type_enum AS ENUM ('INV', 'BIL', 'BOE', 'BOP', 'TXN', 'OTH');
CREATE TYPE public.document_issuer_kind AS ENUM ('fleet_owner', 'driver', 'shipper');
CREATE TYPE public.document_series_kind AS ENUM ('lr', 'invoice');
CREATE TYPE public.eway_bill_status AS ENUM ('active', 'cancelled', 'expired');
CREATE TYPE public.ewb_portal AS ENUM ('NIC1', 'NIC2');
CREATE TYPE public.ewb_status AS ENUM ('active', 'cancelled', 'rejected');
CREATE TYPE public.freight_term AS ENUM ('PAID', 'TO_PAY', 'TO_BE_BILLED');
CREATE TYPE public.kyc_status_enum AS ENUM ('pending', 'verified', 'rejected');
CREATE TYPE public.notification_type AS ENUM ('booking_update', 'trip_update', 'payment', 'general');
CREATE TYPE public.supply_type_enum AS ENUM ('outward', 'inward', 'others');
CREATE TYPE public.trip_status AS ENUM ('active', 'completed', 'cancelled');
CREATE TYPE public.user_role AS ENUM ('shipper', 'driver', 'admin', 'fleet_owner');
CREATE TYPE public.vehicle_type_enum AS ENUM ('HCV', 'MCV', 'LCV', 'auto', 'bicycle', 'others');


-- =====================================================================================
-- 3. TABLES
-- =====================================================================================
-- Columns in physical (attnum) order. Constraints are in sections 4-6 so the tables can
-- be created in any order without dependency ordering games.

CREATE TABLE public.bank_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    account_number_enc text NOT NULL,
    account_number_last4 character varying(4) NOT NULL,
    ifsc character varying(11) NOT NULL,
    bank_name character varying(100),
    account_holder_name character varying(100) NOT NULL,
    is_primary boolean DEFAULT true NOT NULL,
    verification_status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.booking_responses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    action text NOT NULL,
    decline_reason text,
    report_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.bookings (
    id uuid DEFAULT uuid_generate_v4() NOT NULL,
    shipper_id uuid NOT NULL,
    driver_id uuid,
    shipper_name text NOT NULL,
    shipper_contact text NOT NULL,
    source_address text NOT NULL,
    source_lat numeric(10,8) NOT NULL,
    source_lng numeric(11,8) NOT NULL,
    destination_address text NOT NULL,
    dest_lat numeric(10,8) NOT NULL,
    dest_lng numeric(11,8) NOT NULL,
    load_type text NOT NULL,
    weight_kg numeric(10,2) NOT NULL,
    quoted_price numeric(10,2) NOT NULL,
    final_price numeric(10,2),
    pickup_date date NOT NULL,
    pickup_time_slot text,
    status booking_status DEFAULT 'pending'::booking_status,
    special_instructions text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    booking_type text DEFAULT 'direct'::text NOT NULL,
    target_driver_id uuid,
    auction_deadline timestamp with time zone,
    min_acceptable numeric,
    awarded_quote_id uuid,
    dimensions_json jsonb,
    receiver_email text,
    fleet_owner_id uuid,
    vehicle_id uuid,
    award_path booking_award_path DEFAULT 'auction'::booking_award_path NOT NULL,
    consignee_user_id uuid,
    pod_expected_quantity numeric,
    pod_quantity_unit text,
    source_place_id text,
    source_pincode text,
    source_state_code text,
    dest_place_id text,
    dest_pincode text,
    dest_state_code text,
    source_gate_lat numeric(10,8),
    source_gate_lng numeric(11,8),
    dest_gate_lat numeric(10,8),
    dest_gate_lng numeric(11,8)
);

CREATE TABLE public.diesel_prices (
    state_code text NOT NULL,
    state_name text NOT NULL,
    price_inr numeric(8,2) NOT NULL,
    effective_from date DEFAULT CURRENT_DATE NOT NULL,
    source text DEFAULT 'seed_2026_approx'::text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.dispatch_tracker_status (
    item_id text NOT NULL,
    status text NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.document_extractions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    kind text NOT NULL,
    source text NOT NULL,
    raw_payload text,
    parsed_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.document_series (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    series_kind document_series_kind NOT NULL,
    issuer_kind document_issuer_kind NOT NULL,
    issuer_id uuid NOT NULL,
    financial_year text NOT NULL,
    prefix text,
    next_number bigint DEFAULT 1 NOT NULL,
    last_issued_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.driver_insurance (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    vehicle_id uuid NOT NULL,
    policy_number character varying(50),
    provider character varying(100),
    storage_path text,
    expiry_date date,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.driver_licenses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    dl_number character varying(30) NOT NULL,
    dl_storage_path text,
    vehicle_classes text[] DEFAULT '{}'::text[],
    expiry_date date,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.driver_reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    reviewer_id uuid NOT NULL,
    rating integer NOT NULL,
    comment text,
    tags text[] DEFAULT '{}'::text[],
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.drivers (
    id uuid DEFAULT uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    is_available boolean DEFAULT true,
    truck_number text,
    truck_type text,
    truck_capacity_kg integer,
    vehicle_registration_number text,
    license_number text,
    license_expiry_date date,
    insurance_provider text,
    insurance_policy_number text,
    insurance_expiry_date date,
    current_latitude numeric(10,8),
    current_longitude numeric(11,8),
    total_trips integer DEFAULT 0,
    total_distance_km numeric(10,2) DEFAULT 0,
    average_rating numeric(3,2) DEFAULT 0,
    total_earnings numeric(12,2) DEFAULT 0,
    bank_account_number text,
    bank_ifsc_code text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    photo_url text,
    languages text[] DEFAULT '{}'::text[],
    home_base_city character varying(100),
    home_base_lat numeric(10,8),
    home_base_lng numeric(11,8),
    verification_badge text DEFAULT 'pending'::text NOT NULL
);

CREATE TABLE public.eway_bill_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    ewb_number text NOT NULL,
    generated_at timestamp with time zone NOT NULL,
    valid_upto timestamp with time zone NOT NULL,
    issuing_portal ewb_portal NOT NULL,
    status ewb_status DEFAULT 'active'::ewb_status NOT NULL,
    status_changed_at timestamp with time zone,
    status_reason text,
    part_b_entered_at timestamp with time zone,
    document_number text,
    consignment_value_inr numeric(14,2),
    document_uri text,
    recorded_by uuid,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    status_changed_by uuid
);

CREATE TABLE public.eway_bills (
    id uuid DEFAULT uuid_generate_v4() NOT NULL,
    booking_id uuid NOT NULL,
    ewb_number text NOT NULL,
    supply_type supply_type_enum DEFAULT 'outward'::supply_type_enum NOT NULL,
    doc_type doc_type_enum NOT NULL,
    doc_number text NOT NULL,
    doc_date date NOT NULL,
    from_gstin text NOT NULL,
    to_gstin text NOT NULL,
    transporter_gstin text,
    vehicle_number text,
    vehicle_type vehicle_type_enum DEFAULT 'HCV'::vehicle_type_enum NOT NULL,
    trans_distance_km integer NOT NULL,
    item_list jsonb,
    status eway_bill_status DEFAULT 'active'::eway_bill_status,
    generated_at timestamp with time zone DEFAULT now(),
    cancelled_at timestamp with time zone,
    cancellation_reason text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.fleet_cost_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    fleet_owner_id uuid,
    diesel_price_inr numeric(8,2) DEFAULT 90.00 NOT NULL,
    def_price_inr numeric(8,2) DEFAULT 45.00 NOT NULL,
    engine_oil_price_inr numeric(8,2) DEFAULT 420.00 NOT NULL,
    gear_oil_price_inr numeric(8,2) DEFAULT 390.00 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.fleet_drivers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    fleet_owner_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    monthly_salary_inr numeric(12,2),
    invited_by uuid,
    invited_at timestamp with time zone DEFAULT now() NOT NULL,
    responded_at timestamp with time zone,
    left_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    revenue_share_pct numeric(5,2) DEFAULT 0 NOT NULL
);

CREATE TABLE public.fleet_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    fleet_owner_id uuid NOT NULL,
    user_id uuid NOT NULL,
    grants text[] DEFAULT '{}'::text[] NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    invited_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.fleet_owners (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    company_name text NOT NULL,
    gstin text,
    pan text,
    contact_phone text,
    billing_address text,
    city text,
    state text,
    monthly_overhead_inr numeric(12,2) DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.freight_cities (
    city text NOT NULL,
    lat numeric(9,6) NOT NULL,
    lng numeric(9,6) NOT NULL
);

CREATE TABLE public.freight_invoices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    invoice_number text NOT NULL,
    series_id uuid NOT NULL,
    financial_year text NOT NULL,
    supplier_user_id uuid NOT NULL,
    supplier_legal_name text NOT NULL,
    supplier_gstin text,
    supplier_address text,
    billed_to_name text NOT NULL,
    billed_to_gstin text,
    billed_to_address text,
    billed_to_state text,
    billed_to_state_code text,
    shipped_to_name text,
    shipped_to_gstin text,
    shipped_to_address text,
    shipped_to_state text,
    shipped_to_state_code text,
    place_of_supply_state text,
    place_of_supply_code text,
    reverse_charge boolean DEFAULT false NOT NULL,
    taxable_value_inr numeric(14,2) NOT NULL,
    cgst_inr numeric(14,2) DEFAULT 0 NOT NULL,
    sgst_inr numeric(14,2) DEFAULT 0 NOT NULL,
    utgst_inr numeric(14,2) DEFAULT 0 NOT NULL,
    igst_inr numeric(14,2) DEFAULT 0 NOT NULL,
    cess_inr numeric(14,2) DEFAULT 0 NOT NULL,
    exempt_value_inr numeric(14,2) DEFAULT 0 NOT NULL,
    tcs_inr numeric(14,2) DEFAULT 0 NOT NULL,
    round_off_inr numeric(14,2) DEFAULT 0 NOT NULL,
    consignment_value_inr numeric(14,2) GENERATED ALWAYS AS (((((((taxable_value_inr + cgst_inr) + sgst_inr) + utgst_inr) + igst_inr) + cess_inr) - exempt_value_inr)) STORED,
    grand_total_inr numeric(14,2) NOT NULL,
    lr_number text,
    eway_bill_number text,
    irn text,
    ack_no text,
    ack_date timestamp with time zone,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.freight_lane_rates (
    origin_city text NOT NULL,
    dest_city text NOT NULL,
    distance_km integer NOT NULL,
    nh text,
    mxl_inr integer,
    inr_per_km numeric(8,2),
    ds_ratio numeric(6,3),
    source text DEFAULT 'FR8'::text
);

CREATE TABLE public.freight_market_rate_by_class (
    vehicle_class text NOT NULL,
    inr_per_km numeric(8,2) NOT NULL,
    source text
);

CREATE TABLE public.fuel_estimates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid,
    distance_km double precision NOT NULL,
    mileage_kmpl double precision NOT NULL,
    litres double precision NOT NULL,
    diesel_price double precision NOT NULL,
    cost_inr double precision NOT NULL,
    vehicle_class text,
    laden boolean,
    model_version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.geofence_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    geofence_id uuid,
    kind text NOT NULL,
    name text,
    event text NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    dwell_seconds integer,
    driver_id uuid,
    vehicle_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.geofences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    fleet_owner_id uuid,
    name text NOT NULL,
    kind text NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    radius_m integer NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.kyc_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    doc_type text NOT NULL,
    storage_path text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    rejection_reason text,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.location_history (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    booking_id uuid NOT NULL,
    driver_id uuid,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    heading double precision,
    speed_kmh double precision,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    accuracy_m double precision,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    vehicle_id uuid
);

CREATE TABLE public.lorry_receipts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    lr_number text NOT NULL,
    series_id uuid NOT NULL,
    financial_year text NOT NULL,
    issuer_kind document_issuer_kind NOT NULL,
    issuer_id uuid NOT NULL,
    issuer_legal_name text NOT NULL,
    issuer_transporter_id text,
    issuer_pan text,
    issuer_address text,
    consignor_name text NOT NULL,
    consignor_gstin text,
    consignor_pan text,
    consignor_address text,
    consignee_name text NOT NULL,
    consignee_gstin text,
    consignee_address text,
    origin_place text NOT NULL,
    destination_place text NOT NULL,
    delivery_address text,
    vehicle_number text,
    articles_count integer,
    actual_weight_kg numeric(12,3) NOT NULL,
    charged_weight_kg numeric(12,3) NOT NULL,
    rate_inr numeric(12,2),
    rate_type text,
    said_to_contain text NOT NULL,
    sac_code text DEFAULT '996511'::text NOT NULL,
    freight_charge_inr numeric(12,2) DEFAULT 0 NOT NULL,
    stationary_charge_inr numeric(12,2) DEFAULT 0 NOT NULL,
    handling_charge_inr numeric(12,2) DEFAULT 0 NOT NULL,
    other_charge_inr numeric(12,2) DEFAULT 0 NOT NULL,
    total_charge_inr numeric(12,2) GENERATED ALWAYS AS ((((freight_charge_inr + stationary_charge_inr) + handling_charge_inr) + other_charge_inr)) STORED,
    freight_term freight_term NOT NULL,
    delivery_mode delivery_mode,
    loading_by text,
    unloading_by text,
    place_of_supply_state text,
    place_of_supply_code text,
    reverse_charge boolean DEFAULT true NOT NULL,
    carriage_risk text DEFAULT 'owners_risk'::text NOT NULL,
    invoice_number text,
    invoice_value_inr numeric(14,2),
    eway_bill_number text,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    sender_id uuid NOT NULL,
    content text,
    message_type text DEFAULT 'text'::text NOT NULL,
    attachment_url text,
    is_read boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.negotiations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    quote_id uuid NOT NULL,
    booking_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    actor_role text NOT NULL,
    amount numeric NOT NULL,
    message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.notification_outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_type text NOT NULL,
    recipient_email text NOT NULL,
    recipient_user_id uuid,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    dedupe_key text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    locked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone
);

CREATE TABLE public.notification_preferences (
    user_id uuid NOT NULL,
    email_marketplace boolean DEFAULT true NOT NULL,
    email_trip_updates boolean DEFAULT true NOT NULL,
    email_digests boolean DEFAULT true NOT NULL,
    unsubscribe_token text DEFAULT replace(((gen_random_uuid())::text || (gen_random_uuid())::text), '-'::text, ''::text) NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.notifications (
    id uuid DEFAULT uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    type notification_type DEFAULT 'general'::notification_type,
    data jsonb,
    is_read boolean DEFAULT false,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.ops_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    action text NOT NULL,
    actor_user_id uuid NOT NULL,
    from_status text,
    to_status text,
    from_driver_id uuid,
    to_driver_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    acted_for_fleet_owner_id uuid
);

CREATE TABLE public.payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    payer_id uuid,
    payee_id uuid,
    amount numeric(12,2) NOT NULL,
    platform_fee numeric(12,2) DEFAULT 0,
    tds_amount numeric(12,2) DEFAULT 0,
    net_amount numeric(12,2),
    payment_method text,
    gateway_txn_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    settled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    mode text,
    reference text,
    recorded_by uuid
);

CREATE TABLE public.payouts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    driver_id uuid,
    amount numeric(12,2) NOT NULL,
    mode text,
    status text DEFAULT 'pending'::text NOT NULL,
    recorded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    fleet_owner_id uuid,
    payee_type text DEFAULT 'driver'::text NOT NULL
);

CREATE TABLE public.persona_acknowledgements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    version text NOT NULL,
    statement text NOT NULL,
    acknowledged_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.pmo_activity (
    id text NOT NULL,
    project_id text NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    user_email text,
    text text DEFAULT ''::text NOT NULL
);

CREATE TABLE public.pmo_attachments (
    id text NOT NULL,
    project_id text NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    filename text DEFAULT ''::text NOT NULL,
    mime text DEFAULT ''::text NOT NULL,
    size_bytes integer DEFAULT 0 NOT NULL,
    storage_path text NOT NULL,
    uploaded_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.pmo_blockers (
    id text NOT NULL,
    project_id text NOT NULL,
    ref text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    why text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'todo'::text NOT NULL
);

CREATE TABLE public.pmo_docs (
    id text NOT NULL,
    project_id text NOT NULL,
    ref text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    milestone text,
    item_refs jsonb,
    anvaya_note_id text
);

CREATE TABLE public.pmo_items (
    id text NOT NULL,
    project_id text NOT NULL,
    ref text NOT NULL,
    svc text DEFAULT 'general'::text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    week integer DEFAULT 0 NOT NULL,
    pri text DEFAULT 'P1'::text NOT NULL,
    milestone text,
    status text DEFAULT 'todo'::text NOT NULL,
    assignee_email text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sync jsonb,
    autotrack boolean DEFAULT true NOT NULL,
    anvaya_note_id text
);

CREATE TABLE public.pmo_members (
    project_id text NOT NULL,
    email text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.pmo_milestones (
    id text NOT NULL,
    project_id text NOT NULL,
    ref text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    descr text DEFAULT ''::text NOT NULL
);

CREATE TABLE public.pmo_projects (
    id text NOT NULL,
    key text DEFAULT ''::text NOT NULL,
    name text NOT NULL,
    tagline text DEFAULT ''::text NOT NULL,
    owner_email text DEFAULT ''::text NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.pmo_services (
    id text NOT NULL,
    project_id text NOT NULL,
    name text NOT NULL,
    host text DEFAULT ''::text NOT NULL,
    probe boolean DEFAULT false NOT NULL,
    baked text DEFAULT 'absent'::text NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    repo text,
    sync jsonb
);

CREATE TABLE public.pmo_users (
    email text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    hue integer DEFAULT 210 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.pod_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    evidence_id uuid,
    action text NOT NULL,
    actor_user_id uuid,
    actor_role text,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.pod_discrepancies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    expected_quantity numeric,
    actual_quantity numeric NOT NULL,
    delta numeric,
    quantity_unit text,
    reason text NOT NULL,
    evidence_id uuid,
    driver_ack_at timestamp with time zone DEFAULT now() NOT NULL,
    driver_id uuid,
    consignee_ack_at timestamp with time zone,
    consignee_ack_via text,
    consignee_user_id uuid,
    booking_date date,
    delivery_date timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.pod_evidence (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    driver_id uuid,
    sha256_original text NOT NULL,
    sha256_received text,
    capture_method text DEFAULT 'camera'::text NOT NULL,
    captured_at_server timestamp with time zone DEFAULT now() NOT NULL,
    captured_at_device timestamp with time zone,
    clock_skew_seconds integer,
    lat double precision,
    lng double precision,
    gps_accuracy_m double precision,
    gps_source text,
    mock_location_detected boolean DEFAULT false NOT NULL,
    geofence_distance_m double precision,
    geofence_result text DEFAULT 'unknown'::text NOT NULL,
    device_id text,
    os_version text,
    app_version text,
    lr_number text,
    exif_raw jsonb,
    original_bytes_uri text,
    storage_status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    kind text
);

CREATE TABLE public.pod_receipts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    receiver_email text NOT NULL,
    verified_via text DEFAULT 'receiver_otp'::text NOT NULL,
    verified_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.pod_state (
    booking_id uuid NOT NULL,
    pod_strength text NOT NULL,
    confirmed_at timestamp with time zone,
    confirmed_via text,
    asserted_at timestamp with time zone,
    asserted_by_driver_id uuid,
    assert_reason text,
    closed_by_ops_at timestamp with time zone,
    closed_by_ops_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    fleet_review_status text,
    fleet_reviewed_by uuid,
    fleet_reviewed_at timestamp with time zone,
    fleet_review_note text
);

CREATE TABLE public.price_quotes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shipper_id uuid NOT NULL,
    source_lat numeric(9,6) NOT NULL,
    source_lng numeric(9,6) NOT NULL,
    dest_lat numeric(9,6) NOT NULL,
    dest_lng numeric(9,6) NOT NULL,
    distance_km numeric(10,2) NOT NULL,
    vehicle_type text NOT NULL,
    vehicle_class text NOT NULL,
    load_type text NOT NULL,
    weight_kg numeric(12,2) NOT NULL,
    breakdown_json jsonb NOT NULL,
    quoted_price numeric(12,2) NOT NULL,
    currency text DEFAULT 'INR'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    consumed_by_booking_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.quotes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    driver_id uuid,
    amount numeric NOT NULL,
    message text,
    status text DEFAULT 'submitted'::text NOT NULL,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    fleet_owner_id uuid
);

CREATE TABLE public.route_alerts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    type text NOT NULL,
    message text,
    lat double precision,
    lng double precision,
    acknowledged boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    severity text DEFAULT 'warning'::text NOT NULL,
    resolved_at timestamp with time zone,
    driver_id uuid,
    vehicle_id uuid,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE TABLE public.saved_addresses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    label text,
    place_id text,
    formatted_address text NOT NULL,
    lat numeric(10,8) NOT NULL,
    lng numeric(11,8) NOT NULL,
    gate_lat numeric(10,8),
    gate_lng numeric(11,8),
    pincode text,
    state_code text,
    use_count integer DEFAULT 0 NOT NULL,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.saved_lanes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    origin_city character varying(100),
    origin_lat numeric(10,8),
    origin_lng numeric(11,8),
    origin_radius_km integer DEFAULT 50,
    destination_city character varying(100),
    dest_lat numeric(10,8),
    dest_lng numeric(11,8),
    dest_radius_km integer DEFAULT 50,
    notify_enabled boolean DEFAULT true NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.support_tickets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    booking_id uuid,
    category text NOT NULL,
    subject text NOT NULL,
    description text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    priority text DEFAULT 'medium'::text NOT NULL,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.trip_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    trip_id uuid NOT NULL,
    booking_id uuid NOT NULL,
    doc_type text NOT NULL,
    storage_path text NOT NULL,
    metadata jsonb,
    uploaded_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.trip_economics (
    booking_id uuid NOT NULL,
    fleet_owner_id uuid,
    vehicle_id uuid,
    driver_id uuid,
    revenue_inr numeric(12,2) DEFAULT 0 NOT NULL,
    fuel_cost_est_inr numeric(12,2) DEFAULT 0 NOT NULL,
    def_cost_est_inr numeric(12,2) DEFAULT 0 NOT NULL,
    engine_oil_cost_inr numeric(12,2) DEFAULT 0 NOT NULL,
    gear_oil_cost_inr numeric(12,2) DEFAULT 0 NOT NULL,
    service_cost_inr numeric(12,2) DEFAULT 0 NOT NULL,
    tyre_cost_inr numeric(12,2) DEFAULT 0 NOT NULL,
    driver_wage_alloc_inr numeric(12,2) DEFAULT 0 NOT NULL,
    fuel_cost_actual_inr numeric(12,2),
    toll_cost_inr numeric(12,2) DEFAULT 0 NOT NULL,
    other_cost_inr numeric(12,2) DEFAULT 0 NOT NULL,
    running_cost_inr numeric(12,2) DEFAULT 0 NOT NULL,
    net_profit_inr numeric(12,2) DEFAULT 0 NOT NULL,
    distance_km_quoted numeric(10,2),
    distance_km_actual numeric(10,2),
    laden_weight_kg numeric(10,2),
    capacity_kg numeric(10,2),
    volume_used_cuft numeric(10,2),
    capacity_cuft numeric(10,2),
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    model_version text DEFAULT 'fleet-pnl-v1'::text NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    distance_km_planned numeric(10,2),
    distance_basis text
);

CREATE TABLE public.trip_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    trip_id uuid NOT NULL,
    event_type text NOT NULL,
    latitude numeric(10,8),
    longitude numeric(11,8),
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.trip_expenses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    trip_id uuid,
    category text NOT NULL,
    amount numeric(10,2) NOT NULL,
    description text,
    receipt_path text,
    expense_date date DEFAULT CURRENT_DATE NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    vehicle_id uuid,
    booking_id uuid,
    litres numeric(8,2),
    odometer_km integer,
    rate_per_litre numeric(8,2),
    verified_by uuid,
    verified_at timestamp with time zone,
    category_code text
);

CREATE TABLE public.trip_locations (
    id uuid DEFAULT uuid_generate_v4() NOT NULL,
    trip_id uuid NOT NULL,
    booking_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    latitude numeric(10,8) NOT NULL,
    longitude numeric(11,8) NOT NULL,
    speed_kmph numeric(5,2),
    accuracy_meters numeric(5,2),
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.trip_routes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    polyline text NOT NULL,
    distance_m integer NOT NULL,
    static_duration_s integer NOT NULL,
    ne_lat double precision NOT NULL,
    ne_lng double precision NOT NULL,
    sw_lat double precision NOT NULL,
    sw_lng double precision NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.trip_telemetry (
    booking_id uuid NOT NULL,
    driver_id uuid,
    vehicle_id uuid,
    point_count integer DEFAULT 0 NOT NULL,
    distance_m double precision DEFAULT 0 NOT NULL,
    moving_seconds integer DEFAULT 0 NOT NULL,
    idle_seconds integer DEFAULT 0 NOT NULL,
    night_seconds integer DEFAULT 0 NOT NULL,
    max_speed_kmh double precision DEFAULT 0 NOT NULL,
    speed_sum_kmh_s double precision DEFAULT 0 NOT NULL,
    stop_count integer DEFAULT 0 NOT NULL,
    speeding_count integer DEFAULT 0 NOT NULL,
    max_deviation_m double precision DEFAULT 0 NOT NULL,
    first_fix_at timestamp with time zone,
    last_fix_at timestamp with time zone,
    last_lat double precision,
    last_lng double precision,
    stopped_since timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.trips (
    id uuid DEFAULT uuid_generate_v4() NOT NULL,
    booking_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    start_time timestamp with time zone,
    end_time timestamp with time zone,
    status trip_status DEFAULT 'active'::trip_status,
    distance_km numeric(10,2),
    duration_minutes integer,
    average_speed_kmph numeric(5,2),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    vehicle_id uuid
);

CREATE TABLE public.user_kyc (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    role text,
    kyc_level text DEFAULT 'L0'::text NOT NULL,
    verifications jsonb DEFAULT '{}'::jsonb NOT NULL,
    aadhaar_hash text,
    aadhaar_last4 character varying(4),
    pan_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.user_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    preferred_language character varying(10) DEFAULT 'hi'::character varying,
    notify_new_loads boolean DEFAULT true NOT NULL,
    notify_booking_updates boolean DEFAULT true NOT NULL,
    notify_payments boolean DEFAULT true NOT NULL,
    notify_documents boolean DEFAULT true NOT NULL,
    notify_promotions boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.users (
    id uuid DEFAULT uuid_generate_v4() NOT NULL,
    auth_id uuid,
    phone_number text,
    role user_role DEFAULT 'shipper'::user_role NOT NULL,
    full_name text,
    email text,
    avatar_url text,
    kyc_status kyc_status_enum DEFAULT 'pending'::kyc_status_enum,
    kyc_verified_at timestamp with time zone,
    address text,
    city text,
    state text,
    pincode text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    google_sub character varying(255),
    password_hash text,
    email_verified boolean DEFAULT false NOT NULL,
    primary_persona user_role GENERATED ALWAYS AS (role) STORED,
    gstin text,
    claimed_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.vehicle_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    fleet_owner_id uuid NOT NULL,
    booking_id uuid NOT NULL,
    vehicle_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    assigned_by uuid NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    released_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.vehicle_cost_norms (
    model_category text NOT NULL,
    super_category text NOT NULL,
    vehicle_class text NOT NULL,
    kms_per_year integer NOT NULL,
    payload_tons_typical numeric(6,2),
    volume_cuft_typical numeric(8,2),
    kmpl_bs6 numeric(6,2),
    kmpl_bs4 numeric(6,2),
    def_pct_bs6 numeric(6,4) DEFAULT 0 NOT NULL,
    def_pct_bs4 numeric(6,4) DEFAULT 0 NOT NULL,
    eng_oil_km_bs6ph2 integer,
    eng_oil_km_bs6 integer,
    eng_oil_km_bs4 integer,
    eng_oil_km_old integer,
    eng_oil_l_bs6ph2 numeric(6,2),
    eng_oil_l_bs6 numeric(6,2),
    eng_oil_l_bs4 numeric(6,2),
    eng_oil_l_old numeric(6,2),
    gear_oil_km_bs6ph2 integer,
    gear_oil_km_bs6 integer,
    gear_oil_km_bs4 integer,
    gear_oil_km_old integer,
    gear_oil_l_bs6ph2 numeric(6,2),
    gear_oil_l_bs6 numeric(6,2),
    gear_oil_l_bs4 numeric(6,2),
    gear_oil_l_old numeric(6,2),
    wage_weight numeric(4,2) DEFAULT 1.0 NOT NULL,
    tyre_cost_per_km numeric(8,4) DEFAULT 0 NOT NULL,
    source text DEFAULT 'CV_Parc_Tables.xlsx'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.vehicle_finance (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vehicle_id uuid NOT NULL,
    lender text,
    loan_account_no text,
    principal_inr numeric(12,2),
    emi_amount_inr numeric(12,2) NOT NULL,
    emi_day_of_month integer,
    tenure_months integer,
    interest_rate_pct numeric(5,2),
    start_date date,
    end_date date,
    outstanding_inr numeric(12,2),
    insurance_annual_inr numeric(12,2) DEFAULT 0 NOT NULL,
    permit_annual_inr numeric(12,2) DEFAULT 0 NOT NULL,
    fitness_annual_inr numeric(12,2) DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.vehicle_lanes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vehicle_id uuid NOT NULL,
    origin_city text NOT NULL,
    destination_city text NOT NULL,
    origin_lat numeric,
    origin_lng numeric,
    dest_lat numeric,
    dest_lng numeric,
    typical_distance_km numeric(10,2),
    is_primary boolean DEFAULT false NOT NULL,
    trips_observed integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.vehicle_permits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vehicle_id uuid NOT NULL,
    permit_type text DEFAULT 'national'::text NOT NULL,
    allowed_states text[] DEFAULT '{}'::text[] NOT NULL,
    permit_number text,
    issued_on date,
    expiry_date date,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.vehicle_service_cost_by_age (
    super_category text NOT NULL,
    age_years integer NOT NULL,
    annual_cost_inr numeric(12,2) NOT NULL,
    source text DEFAULT 'CV_Parc_Tables.xlsx'::text NOT NULL
);

CREATE TABLE public.vehicles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid,
    rc_number character varying(20) NOT NULL,
    rc_storage_path text,
    vehicle_photos text[] DEFAULT '{}'::text[],
    capacity_tons numeric(6,2),
    body_type text,
    axle_config text,
    maker_model character varying(100),
    fuel_type character varying(20),
    rc_status text DEFAULT 'pending'::text NOT NULL,
    rc_expiry date,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    fleet_owner_id uuid,
    model_category text,
    emission_norm text,
    manufacture_year integer,
    volume_cuft numeric(10,2),
    current_odometer_km integer
);


-- =====================================================================================
-- 4. PRIMARY KEY / UNIQUE CONSTRAINTS
-- =====================================================================================

ALTER TABLE ONLY public.bank_accounts ADD CONSTRAINT bank_accounts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.booking_responses ADD CONSTRAINT booking_responses_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.booking_responses ADD CONSTRAINT booking_responses_booking_id_driver_id_key UNIQUE (booking_id, driver_id);
ALTER TABLE ONLY public.bookings ADD CONSTRAINT bookings_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.diesel_prices ADD CONSTRAINT diesel_prices_pkey PRIMARY KEY (state_code, effective_from);
ALTER TABLE ONLY public.dispatch_tracker_status ADD CONSTRAINT dispatch_tracker_status_pkey PRIMARY KEY (item_id);
ALTER TABLE ONLY public.document_extractions ADD CONSTRAINT document_extractions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.document_series ADD CONSTRAINT document_series_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.document_series ADD CONSTRAINT document_series_scope_key UNIQUE (series_kind, issuer_kind, issuer_id, financial_year);
ALTER TABLE ONLY public.driver_insurance ADD CONSTRAINT driver_insurance_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.driver_insurance ADD CONSTRAINT driver_insurance_vehicle_id_policy_number_key UNIQUE (vehicle_id, policy_number);
ALTER TABLE ONLY public.driver_licenses ADD CONSTRAINT driver_licenses_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.driver_licenses ADD CONSTRAINT driver_licenses_dl_number_key UNIQUE (dl_number);
ALTER TABLE ONLY public.driver_licenses ADD CONSTRAINT driver_licenses_driver_id_key UNIQUE (driver_id);
ALTER TABLE ONLY public.driver_reviews ADD CONSTRAINT driver_reviews_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.driver_reviews ADD CONSTRAINT driver_reviews_booking_id_key UNIQUE (booking_id);
ALTER TABLE ONLY public.drivers ADD CONSTRAINT drivers_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.drivers ADD CONSTRAINT drivers_license_number_key UNIQUE (license_number);
ALTER TABLE ONLY public.drivers ADD CONSTRAINT drivers_truck_number_key UNIQUE (truck_number);
ALTER TABLE ONLY public.drivers ADD CONSTRAINT drivers_user_id_key UNIQUE (user_id);
ALTER TABLE ONLY public.drivers ADD CONSTRAINT drivers_vehicle_registration_number_key UNIQUE (vehicle_registration_number);
ALTER TABLE ONLY public.eway_bill_records ADD CONSTRAINT eway_bill_records_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.eway_bill_records ADD CONSTRAINT eway_bill_records_booking_number_key UNIQUE (booking_id, ewb_number);
ALTER TABLE ONLY public.eway_bills ADD CONSTRAINT eway_bills_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.eway_bills ADD CONSTRAINT eway_bills_booking_id_key UNIQUE (booking_id);
ALTER TABLE ONLY public.eway_bills ADD CONSTRAINT eway_bills_ewb_number_key UNIQUE (ewb_number);
ALTER TABLE ONLY public.fleet_cost_settings ADD CONSTRAINT fleet_cost_settings_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.fleet_cost_settings ADD CONSTRAINT fleet_cost_settings_fleet_owner_id_key UNIQUE (fleet_owner_id);
ALTER TABLE ONLY public.fleet_drivers ADD CONSTRAINT fleet_drivers_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.fleet_members ADD CONSTRAINT fleet_members_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.fleet_members ADD CONSTRAINT fleet_members_fleet_owner_id_user_id_key UNIQUE (fleet_owner_id, user_id);
ALTER TABLE ONLY public.fleet_owners ADD CONSTRAINT fleet_owners_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.fleet_owners ADD CONSTRAINT fleet_owners_user_id_key UNIQUE (user_id);
ALTER TABLE ONLY public.freight_cities ADD CONSTRAINT freight_cities_pkey PRIMARY KEY (city);
ALTER TABLE ONLY public.freight_invoices ADD CONSTRAINT freight_invoices_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.freight_invoices ADD CONSTRAINT freight_invoices_booking_id_key UNIQUE (booking_id);
ALTER TABLE ONLY public.freight_lane_rates ADD CONSTRAINT freight_lane_rates_pkey PRIMARY KEY (origin_city, dest_city);
ALTER TABLE ONLY public.freight_market_rate_by_class ADD CONSTRAINT freight_market_rate_by_class_pkey PRIMARY KEY (vehicle_class);
ALTER TABLE ONLY public.fuel_estimates ADD CONSTRAINT fuel_estimates_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.geofence_events ADD CONSTRAINT geofence_events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.geofences ADD CONSTRAINT geofences_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.kyc_documents ADD CONSTRAINT kyc_documents_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.location_history ADD CONSTRAINT location_history_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.lorry_receipts ADD CONSTRAINT lorry_receipts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.lorry_receipts ADD CONSTRAINT lorry_receipts_booking_id_key UNIQUE (booking_id);
ALTER TABLE ONLY public.messages ADD CONSTRAINT messages_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.negotiations ADD CONSTRAINT negotiations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.notification_outbox ADD CONSTRAINT notification_outbox_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.notification_preferences ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (user_id);
ALTER TABLE ONLY public.notification_preferences ADD CONSTRAINT notification_preferences_unsubscribe_token_key UNIQUE (unsubscribe_token);
ALTER TABLE ONLY public.notifications ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ops_overrides ADD CONSTRAINT ops_overrides_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.payments ADD CONSTRAINT payments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.payouts ADD CONSTRAINT payouts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.payouts ADD CONSTRAINT payouts_one_per_payee UNIQUE (booking_id, payee_type);
ALTER TABLE ONLY public.persona_acknowledgements ADD CONSTRAINT persona_acknowledgements_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.pmo_activity ADD CONSTRAINT pmo_activity_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.pmo_attachments ADD CONSTRAINT pmo_attachments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.pmo_blockers ADD CONSTRAINT pmo_blockers_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.pmo_docs ADD CONSTRAINT pmo_docs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.pmo_items ADD CONSTRAINT pmo_items_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.pmo_members ADD CONSTRAINT pmo_members_pkey PRIMARY KEY (project_id, email);
ALTER TABLE ONLY public.pmo_milestones ADD CONSTRAINT pmo_milestones_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.pmo_projects ADD CONSTRAINT pmo_projects_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.pmo_services ADD CONSTRAINT pmo_services_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.pmo_users ADD CONSTRAINT pmo_users_pkey PRIMARY KEY (email);
ALTER TABLE ONLY public.pod_audit_log ADD CONSTRAINT pod_audit_log_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.pod_discrepancies ADD CONSTRAINT pod_discrepancies_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.pod_discrepancies ADD CONSTRAINT pod_discrepancies_booking_id_key UNIQUE (booking_id);
ALTER TABLE ONLY public.pod_evidence ADD CONSTRAINT pod_evidence_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.pod_receipts ADD CONSTRAINT pod_receipts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.pod_receipts ADD CONSTRAINT pod_receipts_booking_id_key UNIQUE (booking_id);
ALTER TABLE ONLY public.pod_state ADD CONSTRAINT pod_state_pkey PRIMARY KEY (booking_id);
ALTER TABLE ONLY public.price_quotes ADD CONSTRAINT price_quotes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.quotes ADD CONSTRAINT quotes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.quotes ADD CONSTRAINT quotes_booking_id_driver_id_key UNIQUE (booking_id, driver_id);
ALTER TABLE ONLY public.route_alerts ADD CONSTRAINT route_alerts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.saved_addresses ADD CONSTRAINT saved_addresses_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.saved_lanes ADD CONSTRAINT saved_lanes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.support_tickets ADD CONSTRAINT support_tickets_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.trip_documents ADD CONSTRAINT trip_documents_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.trip_economics ADD CONSTRAINT trip_economics_pkey PRIMARY KEY (booking_id);
ALTER TABLE ONLY public.trip_events ADD CONSTRAINT trip_events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.trip_expenses ADD CONSTRAINT trip_expenses_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.trip_locations ADD CONSTRAINT trip_locations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.trip_routes ADD CONSTRAINT trip_routes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.trip_routes ADD CONSTRAINT trip_routes_booking_id_key UNIQUE (booking_id);
ALTER TABLE ONLY public.trip_telemetry ADD CONSTRAINT trip_telemetry_pkey PRIMARY KEY (booking_id);
ALTER TABLE ONLY public.trips ADD CONSTRAINT trips_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.trips ADD CONSTRAINT trips_booking_id_key UNIQUE (booking_id);
ALTER TABLE ONLY public.user_kyc ADD CONSTRAINT user_kyc_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.user_kyc ADD CONSTRAINT user_kyc_user_id_key UNIQUE (user_id);
ALTER TABLE ONLY public.user_settings ADD CONSTRAINT user_settings_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.user_settings ADD CONSTRAINT user_settings_user_id_key UNIQUE (user_id);
ALTER TABLE ONLY public.users ADD CONSTRAINT users_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.users ADD CONSTRAINT users_auth_id_key UNIQUE (auth_id);
ALTER TABLE ONLY public.users ADD CONSTRAINT users_google_sub_key UNIQUE (google_sub);
ALTER TABLE ONLY public.users ADD CONSTRAINT users_phone_number_key UNIQUE (phone_number);
ALTER TABLE ONLY public.vehicle_assignments ADD CONSTRAINT vehicle_assignments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.vehicle_cost_norms ADD CONSTRAINT vehicle_cost_norms_pkey PRIMARY KEY (model_category);
ALTER TABLE ONLY public.vehicle_finance ADD CONSTRAINT vehicle_finance_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.vehicle_finance ADD CONSTRAINT vehicle_finance_vehicle_id_key UNIQUE (vehicle_id);
ALTER TABLE ONLY public.vehicle_lanes ADD CONSTRAINT vehicle_lanes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.vehicle_permits ADD CONSTRAINT vehicle_permits_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.vehicle_service_cost_by_age ADD CONSTRAINT vehicle_service_cost_by_age_pkey PRIMARY KEY (super_category, age_years);
ALTER TABLE ONLY public.vehicles ADD CONSTRAINT vehicles_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.vehicles ADD CONSTRAINT vehicles_rc_number_key UNIQUE (rc_number);


-- =====================================================================================
-- 5. CHECK CONSTRAINTS
-- =====================================================================================

ALTER TABLE ONLY public.bank_accounts ADD CONSTRAINT bank_accounts_verification_status_check CHECK ((verification_status = ANY (ARRAY['pending'::text, 'verified'::text, 'rejected'::text])));
ALTER TABLE ONLY public.booking_responses ADD CONSTRAINT booking_responses_action_check CHECK ((action = ANY (ARRAY['accepted'::text, 'declined'::text, 'reported'::text])));
ALTER TABLE ONLY public.bookings ADD CONSTRAINT bookings_dest_state_code_format CHECK (((dest_state_code IS NULL) OR (dest_state_code ~ '^[0-9]{2}$'::text))) NOT VALID;
ALTER TABLE ONLY public.bookings ADD CONSTRAINT bookings_pod_expected_quantity_check CHECK (((pod_expected_quantity IS NULL) OR (pod_expected_quantity >= (0)::numeric)));
ALTER TABLE ONLY public.bookings ADD CONSTRAINT bookings_source_state_code_format CHECK (((source_state_code IS NULL) OR (source_state_code ~ '^[0-9]{2}$'::text))) NOT VALID;
ALTER TABLE ONLY public.bookings ADD CONSTRAINT valid_latlng_dest CHECK (((dest_lat >= ('-90'::integer)::numeric) AND (dest_lat <= (90)::numeric) AND (dest_lng >= ('-180'::integer)::numeric) AND (dest_lng <= (180)::numeric)));
ALTER TABLE ONLY public.bookings ADD CONSTRAINT valid_latlng_source CHECK (((source_lat >= ('-90'::integer)::numeric) AND (source_lat <= (90)::numeric) AND (source_lng >= ('-180'::integer)::numeric) AND (source_lng <= (180)::numeric)));
ALTER TABLE ONLY public.bookings ADD CONSTRAINT valid_price CHECK ((quoted_price > (0)::numeric));
ALTER TABLE ONLY public.bookings ADD CONSTRAINT valid_weight CHECK ((weight_kg > (0)::numeric));
ALTER TABLE ONLY public.diesel_prices ADD CONSTRAINT diesel_prices_price_inr_check CHECK ((price_inr > (0)::numeric));
ALTER TABLE ONLY public.diesel_prices ADD CONSTRAINT diesel_prices_state_code_check CHECK ((state_code ~ '^[0-9]{2}$'::text));
ALTER TABLE ONLY public.dispatch_tracker_status ADD CONSTRAINT dispatch_tracker_status_status_check CHECK ((status = ANY (ARRAY['todo'::text, 'doing'::text, 'blocked'::text, 'done'::text])));
ALTER TABLE ONLY public.document_extractions ADD CONSTRAINT document_extractions_kind_check CHECK ((kind = ANY (ARRAY['eway_qr'::text, 'einvoice_qr'::text, 'ocr'::text, 'unknown'::text])));
ALTER TABLE ONLY public.document_extractions ADD CONSTRAINT document_extractions_source_check CHECK ((source = ANY (ARRAY['qr'::text, 'ocr'::text])));
ALTER TABLE ONLY public.document_series ADD CONSTRAINT document_series_financial_year_check CHECK ((financial_year ~ '^[0-9]{4}-[0-9]{2}$'::text));
ALTER TABLE ONLY public.document_series ADD CONSTRAINT document_series_next_number_check CHECK ((next_number >= 1));
ALTER TABLE ONLY public.document_series ADD CONSTRAINT document_series_prefix_check CHECK ((prefix ~ '^[A-Za-z0-9-]{1,2}$'::text));
ALTER TABLE ONLY public.driver_insurance ADD CONSTRAINT driver_insurance_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'verified'::text, 'rejected'::text])));
ALTER TABLE ONLY public.driver_licenses ADD CONSTRAINT driver_licenses_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'verified'::text, 'rejected'::text])));
ALTER TABLE ONLY public.driver_reviews ADD CONSTRAINT driver_reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5)));
ALTER TABLE ONLY public.drivers ADD CONSTRAINT drivers_verification_badge_check CHECK ((verification_badge = ANY (ARRAY['pending'::text, 'verified'::text, 'premium'::text])));
ALTER TABLE ONLY public.drivers ADD CONSTRAINT valid_capacity CHECK (((truck_capacity_kg IS NULL) OR (truck_capacity_kg > 0)));
ALTER TABLE ONLY public.drivers ADD CONSTRAINT valid_rating CHECK (((average_rating >= (0)::numeric) AND (average_rating <= (5)::numeric)));
ALTER TABLE ONLY public.eway_bill_records ADD CONSTRAINT eway_bill_records_consignment_value_inr_check CHECK (((consignment_value_inr IS NULL) OR (consignment_value_inr >= (0)::numeric)));
ALTER TABLE ONLY public.eway_bill_records ADD CONSTRAINT eway_bill_records_document_number_check CHECK (((document_number IS NULL) OR (document_number ~ '^[A-Za-z0-9/-]{1,16}$'::text)));
ALTER TABLE ONLY public.eway_bill_records ADD CONSTRAINT eway_bill_records_ewb_number_check CHECK ((ewb_number ~ '^[0-9]{12}$'::text));
ALTER TABLE ONLY public.eway_bill_records ADD CONSTRAINT eway_bill_status_change_is_dated CHECK (((status = 'active'::ewb_status) OR (status_changed_at IS NOT NULL)));
ALTER TABLE ONLY public.eway_bill_records ADD CONSTRAINT eway_bill_valid_upto_after_generation CHECK ((valid_upto > generated_at));
ALTER TABLE ONLY public.eway_bills ADD CONSTRAINT valid_distance CHECK ((trans_distance_km > 0));
ALTER TABLE ONLY public.eway_bills ADD CONSTRAINT valid_doc_number CHECK (((doc_number IS NOT NULL) AND (doc_number <> ''::text)));
ALTER TABLE ONLY public.eway_bills ADD CONSTRAINT valid_gstin CHECK ((from_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'::text));
ALTER TABLE ONLY public.fleet_cost_settings ADD CONSTRAINT fleet_cost_settings_def_price_inr_check CHECK ((def_price_inr > (0)::numeric));
ALTER TABLE ONLY public.fleet_cost_settings ADD CONSTRAINT fleet_cost_settings_diesel_price_inr_check CHECK ((diesel_price_inr > (0)::numeric));
ALTER TABLE ONLY public.fleet_cost_settings ADD CONSTRAINT fleet_cost_settings_engine_oil_price_inr_check CHECK ((engine_oil_price_inr > (0)::numeric));
ALTER TABLE ONLY public.fleet_cost_settings ADD CONSTRAINT fleet_cost_settings_gear_oil_price_inr_check CHECK ((gear_oil_price_inr > (0)::numeric));
ALTER TABLE ONLY public.fleet_drivers ADD CONSTRAINT fleet_drivers_monthly_salary_inr_check CHECK ((monthly_salary_inr >= (0)::numeric));
ALTER TABLE ONLY public.fleet_drivers ADD CONSTRAINT fleet_drivers_revenue_share_pct_check CHECK (((revenue_share_pct >= (0)::numeric) AND (revenue_share_pct <= (100)::numeric)));
ALTER TABLE ONLY public.fleet_drivers ADD CONSTRAINT fleet_drivers_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'rejected'::text, 'suspended'::text, 'left'::text])));
ALTER TABLE ONLY public.fleet_members ADD CONSTRAINT fleet_members_grants_check CHECK ((grants <@ ARRAY['dispatch'::text, 'bid'::text, 'settle'::text, 'documents'::text, 'manage_drivers'::text, 'manage_assets'::text, 'view_analytics'::text, 'admin'::text]));
ALTER TABLE ONLY public.fleet_members ADD CONSTRAINT fleet_members_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'revoked'::text])));
ALTER TABLE ONLY public.fleet_owners ADD CONSTRAINT fleet_owners_gstin_format CHECK (((gstin IS NULL) OR (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{2}[0-9A-Z]$'::text)));
ALTER TABLE ONLY public.fleet_owners ADD CONSTRAINT fleet_owners_monthly_overhead_inr_check CHECK ((monthly_overhead_inr >= (0)::numeric));
ALTER TABLE ONLY public.fleet_owners ADD CONSTRAINT fleet_owners_pan_format CHECK (((pan IS NULL) OR (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'::text))) NOT VALID;
ALTER TABLE ONLY public.freight_invoices ADD CONSTRAINT freight_invoices_billed_to_state_code_check CHECK (((billed_to_state_code IS NULL) OR (billed_to_state_code ~ '^[0-9]{2}$'::text)));
ALTER TABLE ONLY public.freight_invoices ADD CONSTRAINT freight_invoices_cess_inr_check CHECK ((cess_inr >= (0)::numeric));
ALTER TABLE ONLY public.freight_invoices ADD CONSTRAINT freight_invoices_cgst_inr_check CHECK ((cgst_inr >= (0)::numeric));
ALTER TABLE ONLY public.freight_invoices ADD CONSTRAINT freight_invoices_eway_bill_number_check CHECK (((eway_bill_number IS NULL) OR (eway_bill_number ~ '^[0-9]{12}$'::text)));
ALTER TABLE ONLY public.freight_invoices ADD CONSTRAINT freight_invoices_exempt_value_inr_check CHECK ((exempt_value_inr >= (0)::numeric));
ALTER TABLE ONLY public.freight_invoices ADD CONSTRAINT freight_invoices_financial_year_check CHECK ((financial_year ~ '^[0-9]{4}-[0-9]{2}$'::text));
ALTER TABLE ONLY public.freight_invoices ADD CONSTRAINT freight_invoices_grand_total_inr_check CHECK ((grand_total_inr >= (0)::numeric));
ALTER TABLE ONLY public.freight_invoices ADD CONSTRAINT freight_invoices_igst_inr_check CHECK ((igst_inr >= (0)::numeric));
ALTER TABLE ONLY public.freight_invoices ADD CONSTRAINT freight_invoices_invoice_number_check CHECK ((invoice_number ~ '^[A-Za-z0-9/-]{1,16}$'::text));
ALTER TABLE ONLY public.freight_invoices ADD CONSTRAINT freight_invoices_irn_check CHECK (((irn IS NULL) OR (irn ~ '^[0-9a-fA-F]{64}$'::text)));
ALTER TABLE ONLY public.freight_invoices ADD CONSTRAINT freight_invoices_lr_number_check CHECK (((lr_number IS NULL) OR (lr_number ~ '^[A-Za-z0-9/-]{1,16}$'::text)));
ALTER TABLE ONLY public.freight_invoices ADD CONSTRAINT freight_invoices_place_of_supply_code_check CHECK (((place_of_supply_code IS NULL) OR (place_of_supply_code ~ '^[0-9]{2}$'::text)));
ALTER TABLE ONLY public.freight_invoices ADD CONSTRAINT freight_invoices_sgst_inr_check CHECK ((sgst_inr >= (0)::numeric));
ALTER TABLE ONLY public.freight_invoices ADD CONSTRAINT freight_invoices_shipped_to_state_code_check CHECK (((shipped_to_state_code IS NULL) OR (shipped_to_state_code ~ '^[0-9]{2}$'::text)));
ALTER TABLE ONLY public.freight_invoices ADD CONSTRAINT freight_invoices_taxable_value_inr_check CHECK ((taxable_value_inr >= (0)::numeric));
ALTER TABLE ONLY public.freight_invoices ADD CONSTRAINT freight_invoices_tcs_inr_check CHECK ((tcs_inr >= (0)::numeric));
ALTER TABLE ONLY public.freight_invoices ADD CONSTRAINT freight_invoices_utgst_inr_check CHECK ((utgst_inr >= (0)::numeric));
ALTER TABLE ONLY public.geofence_events ADD CONSTRAINT geofence_events_dwell_seconds_check CHECK (((dwell_seconds IS NULL) OR (dwell_seconds >= 0)));
ALTER TABLE ONLY public.geofence_events ADD CONSTRAINT geofence_events_event_check CHECK ((event = ANY (ARRAY['enter'::text, 'exit'::text])));
ALTER TABLE ONLY public.geofence_events ADD CONSTRAINT geofence_events_kind_check CHECK ((kind = ANY (ARRAY['pickup'::text, 'drop'::text, 'depot'::text, 'warehouse'::text, 'checkpoint'::text, 'custom'::text])));
ALTER TABLE ONLY public.geofence_events ADD CONSTRAINT geofence_events_lat_check CHECK (((lat >= ('-90'::integer)::double precision) AND (lat <= (90)::double precision)));
ALTER TABLE ONLY public.geofence_events ADD CONSTRAINT geofence_events_lng_check CHECK (((lng >= ('-180'::integer)::double precision) AND (lng <= (180)::double precision)));
ALTER TABLE ONLY public.geofences ADD CONSTRAINT geofences_kind_check CHECK ((kind = ANY (ARRAY['depot'::text, 'warehouse'::text, 'checkpoint'::text, 'custom'::text])));
ALTER TABLE ONLY public.geofences ADD CONSTRAINT geofences_lat_check CHECK (((lat >= ('-90'::integer)::double precision) AND (lat <= (90)::double precision)));
ALTER TABLE ONLY public.geofences ADD CONSTRAINT geofences_lng_check CHECK (((lng >= ('-180'::integer)::double precision) AND (lng <= (180)::double precision)));
ALTER TABLE ONLY public.geofences ADD CONSTRAINT geofences_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 120)));
ALTER TABLE ONLY public.geofences ADD CONSTRAINT geofences_radius_m_check CHECK (((radius_m >= 50) AND (radius_m <= 50000)));
ALTER TABLE ONLY public.kyc_documents ADD CONSTRAINT kyc_documents_doc_type_check CHECK ((doc_type = ANY (ARRAY['aadhaar'::text, 'pan'::text, 'license'::text, 'rc'::text, 'permit'::text])));
ALTER TABLE ONLY public.kyc_documents ADD CONSTRAINT kyc_documents_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])));
ALTER TABLE ONLY public.lorry_receipts ADD CONSTRAINT lorry_receipts_actual_weight_kg_check CHECK ((actual_weight_kg > (0)::numeric));
ALTER TABLE ONLY public.lorry_receipts ADD CONSTRAINT lorry_receipts_articles_count_check CHECK (((articles_count IS NULL) OR (articles_count > 0)));
ALTER TABLE ONLY public.lorry_receipts ADD CONSTRAINT lorry_receipts_carriage_risk_check CHECK ((carriage_risk = ANY (ARRAY['owners_risk'::text, 'carriers_risk'::text])));
ALTER TABLE ONLY public.lorry_receipts ADD CONSTRAINT lorry_receipts_charged_ge_actual CHECK ((charged_weight_kg >= actual_weight_kg));
ALTER TABLE ONLY public.lorry_receipts ADD CONSTRAINT lorry_receipts_charged_weight_kg_check CHECK ((charged_weight_kg > (0)::numeric));
ALTER TABLE ONLY public.lorry_receipts ADD CONSTRAINT lorry_receipts_eway_bill_number_check CHECK (((eway_bill_number IS NULL) OR (eway_bill_number ~ '^[0-9]{12}$'::text)));
ALTER TABLE ONLY public.lorry_receipts ADD CONSTRAINT lorry_receipts_financial_year_check CHECK ((financial_year ~ '^[0-9]{4}-[0-9]{2}$'::text));
ALTER TABLE ONLY public.lorry_receipts ADD CONSTRAINT lorry_receipts_freight_charge_inr_check CHECK ((freight_charge_inr >= (0)::numeric));
ALTER TABLE ONLY public.lorry_receipts ADD CONSTRAINT lorry_receipts_handling_charge_inr_check CHECK ((handling_charge_inr >= (0)::numeric));
ALTER TABLE ONLY public.lorry_receipts ADD CONSTRAINT lorry_receipts_invoice_number_check CHECK (((invoice_number IS NULL) OR (invoice_number ~ '^[A-Za-z0-9/-]{1,16}$'::text)));
ALTER TABLE ONLY public.lorry_receipts ADD CONSTRAINT lorry_receipts_invoice_value_inr_check CHECK (((invoice_value_inr IS NULL) OR (invoice_value_inr >= (0)::numeric)));
ALTER TABLE ONLY public.lorry_receipts ADD CONSTRAINT lorry_receipts_issuer_kind_check CHECK ((issuer_kind = ANY (ARRAY['fleet_owner'::document_issuer_kind, 'driver'::document_issuer_kind])));
ALTER TABLE ONLY public.lorry_receipts ADD CONSTRAINT lorry_receipts_loading_by_check CHECK (((loading_by IS NULL) OR (loading_by = ANY (ARRAY['consignor'::text, 'consignee'::text]))));
ALTER TABLE ONLY public.lorry_receipts ADD CONSTRAINT lorry_receipts_lr_number_check CHECK ((lr_number ~ '^[A-Za-z0-9/-]{1,16}$'::text));
ALTER TABLE ONLY public.lorry_receipts ADD CONSTRAINT lorry_receipts_other_charge_inr_check CHECK ((other_charge_inr >= (0)::numeric));
ALTER TABLE ONLY public.lorry_receipts ADD CONSTRAINT lorry_receipts_place_of_supply_code_check CHECK (((place_of_supply_code IS NULL) OR (place_of_supply_code ~ '^[0-9]{2}$'::text)));
ALTER TABLE ONLY public.lorry_receipts ADD CONSTRAINT lorry_receipts_rate_inr_check CHECK (((rate_inr IS NULL) OR (rate_inr >= (0)::numeric)));
ALTER TABLE ONLY public.lorry_receipts ADD CONSTRAINT lorry_receipts_stationary_charge_inr_check CHECK ((stationary_charge_inr >= (0)::numeric));
ALTER TABLE ONLY public.lorry_receipts ADD CONSTRAINT lorry_receipts_unloading_by_check CHECK (((unloading_by IS NULL) OR (unloading_by = ANY (ARRAY['consignor'::text, 'consignee'::text]))));
ALTER TABLE ONLY public.messages ADD CONSTRAINT messages_message_type_check CHECK ((message_type = ANY (ARRAY['text'::text, 'image'::text, 'location'::text, 'system'::text])));
ALTER TABLE ONLY public.negotiations ADD CONSTRAINT negotiations_actor_role_check CHECK ((actor_role = ANY (ARRAY['shipper'::text, 'driver'::text, 'fleet_owner'::text])));
ALTER TABLE ONLY public.notification_outbox ADD CONSTRAINT notification_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'skipped'::text])));
ALTER TABLE ONLY public.notifications ADD CONSTRAINT valid_body CHECK (((body IS NOT NULL) AND (body <> ''::text)));
ALTER TABLE ONLY public.ops_overrides ADD CONSTRAINT ops_overrides_action_check CHECK ((action = ANY (ARRAY['force_complete'::text, 'reassign'::text])));
ALTER TABLE ONLY public.payments ADD CONSTRAINT payments_amount_check CHECK ((amount > (0)::numeric));
ALTER TABLE ONLY public.payments ADD CONSTRAINT payments_net_amount_check CHECK ((net_amount >= (0)::numeric));
ALTER TABLE ONLY public.payments ADD CONSTRAINT payments_payment_method_check CHECK ((payment_method = ANY (ARRAY['razorpay'::text, 'upi'::text, 'bank_transfer'::text, 'cash'::text])));
ALTER TABLE ONLY public.payments ADD CONSTRAINT payments_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'captured'::text, 'settled'::text, 'failed'::text, 'refunded'::text])));
ALTER TABLE ONLY public.payouts ADD CONSTRAINT payouts_mode_check CHECK ((mode = ANY (ARRAY['cash'::text, 'upi'::text, 'direct'::text])));
ALTER TABLE ONLY public.payouts ADD CONSTRAINT payouts_payee_matches_type CHECK ((((payee_type = 'driver'::text) AND (driver_id IS NOT NULL)) OR ((payee_type = 'fleet_owner'::text) AND (fleet_owner_id IS NOT NULL))));
ALTER TABLE ONLY public.payouts ADD CONSTRAINT payouts_payee_type_check CHECK ((payee_type = ANY (ARRAY['driver'::text, 'fleet_owner'::text])));
ALTER TABLE ONLY public.payouts ADD CONSTRAINT payouts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'recorded'::text])));
ALTER TABLE ONLY public.pod_audit_log ADD CONSTRAINT pod_audit_log_action_check CHECK ((action = ANY (ARRAY['evidence_captured'::text, 'evidence_access'::text, 'evidence_export'::text, 'modify_attempt'::text, 'discrepancy_logged'::text, 'otp_gate_pass'::text, 'otp_gate_block'::text, 'otp_gate_degraded'::text, 'delivery_asserted'::text, 'pod_confirmed'::text, 'consignee_ack'::text, 'ops_closed'::text, 'evidence_approved'::text, 'evidence_rejected'::text])));
ALTER TABLE ONLY public.pod_discrepancies ADD CONSTRAINT pod_discrepancies_actual_quantity_check CHECK ((actual_quantity >= (0)::numeric));
ALTER TABLE ONLY public.pod_discrepancies ADD CONSTRAINT pod_discrepancies_reason_check CHECK ((reason = ANY (ARRAY['shortage'::text, 'damage'::text, 'wrong_goods'::text, 'refusal'::text, 'partial_acceptance'::text])));
ALTER TABLE ONLY public.pod_evidence ADD CONSTRAINT pod_evidence_capture_method_check CHECK ((capture_method = 'camera'::text));
ALTER TABLE ONLY public.pod_evidence ADD CONSTRAINT pod_evidence_geofence_distance_m_check CHECK (((geofence_distance_m IS NULL) OR (geofence_distance_m >= (0)::double precision)));
ALTER TABLE ONLY public.pod_evidence ADD CONSTRAINT pod_evidence_geofence_result_check CHECK ((geofence_result = ANY (ARRAY['inside'::text, 'outside'::text, 'unknown'::text])));
ALTER TABLE ONLY public.pod_evidence ADD CONSTRAINT pod_evidence_gps_accuracy_m_check CHECK (((gps_accuracy_m IS NULL) OR (gps_accuracy_m >= (0)::double precision)));
ALTER TABLE ONLY public.pod_evidence ADD CONSTRAINT pod_evidence_kind_check CHECK (((kind IS NULL) OR (kind = ANY (ARRAY['signed_invoice'::text, 'vehicle'::text, 'goods'::text, 'other'::text]))));
ALTER TABLE ONLY public.pod_evidence ADD CONSTRAINT pod_evidence_lat_check CHECK (((lat IS NULL) OR ((lat >= ('-90'::integer)::double precision) AND (lat <= (90)::double precision))));
ALTER TABLE ONLY public.pod_evidence ADD CONSTRAINT pod_evidence_lng_check CHECK (((lng IS NULL) OR ((lng >= ('-180'::integer)::double precision) AND (lng <= (180)::double precision))));
ALTER TABLE ONLY public.pod_evidence ADD CONSTRAINT pod_evidence_sha256_original_check CHECK ((sha256_original ~ '^[0-9a-f]{64}$'::text));
ALTER TABLE ONLY public.pod_evidence ADD CONSTRAINT pod_evidence_sha256_received_check CHECK (((sha256_received IS NULL) OR (sha256_received ~ '^[0-9a-f]{64}$'::text)));
ALTER TABLE ONLY public.pod_evidence ADD CONSTRAINT pod_evidence_storage_status_check CHECK ((storage_status = ANY (ARRAY['pending'::text, 'stored'::text, 'no_op'::text, 'failed'::text])));
ALTER TABLE ONLY public.pod_state ADD CONSTRAINT pod_state_assert_reason_check CHECK (((assert_reason IS NULL) OR (assert_reason = ANY (ARRAY['no_smartphone'::text, 'night_delivery'::text, 'warehouse_handoff'::text, 'receiver_refused_confirm'::text, 'no_receiver_present'::text, 'other'::text]))));
ALTER TABLE ONLY public.pod_state ADD CONSTRAINT pod_state_fleet_review_status_check CHECK (((fleet_review_status IS NULL) OR (fleet_review_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text]))));
ALTER TABLE ONLY public.pod_state ADD CONSTRAINT pod_state_pod_strength_check CHECK ((pod_strength = ANY (ARRAY['confirmed'::text, 'asserted'::text])));
ALTER TABLE ONLY public.price_quotes ADD CONSTRAINT price_quotes_distance_km_check CHECK ((distance_km > (0)::numeric));
ALTER TABLE ONLY public.price_quotes ADD CONSTRAINT price_quotes_quoted_price_check CHECK ((quoted_price > (0)::numeric));
ALTER TABLE ONLY public.price_quotes ADD CONSTRAINT price_quotes_weight_kg_check CHECK ((weight_kg > (0)::numeric));
ALTER TABLE ONLY public.quotes ADD CONSTRAINT quotes_amount_check CHECK ((amount > (0)::numeric));
ALTER TABLE ONLY public.quotes ADD CONSTRAINT quotes_exactly_one_bidder CHECK ((num_nonnulls(driver_id, fleet_owner_id) = 1));
ALTER TABLE ONLY public.route_alerts ADD CONSTRAINT route_alerts_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text])));
ALTER TABLE ONLY public.route_alerts ADD CONSTRAINT route_alerts_type_check CHECK ((type = ANY (ARRAY['off_route'::text, 'idle'::text, 'near_drop'::text, 'speeding'::text, 'night_driving'::text, 'geofence_dwell'::text, 'no_signal'::text])));
ALTER TABLE ONLY public.saved_addresses ADD CONSTRAINT saved_addresses_state_code_check CHECK (((state_code IS NULL) OR (state_code ~ '^[0-9]{2}$'::text)));
ALTER TABLE ONLY public.support_tickets ADD CONSTRAINT support_tickets_category_check CHECK ((category = ANY (ARRAY['payment_dispute'::text, 'booking_issue'::text, 'document_help'::text, 'app_bug'::text, 'other'::text])));
ALTER TABLE ONLY public.support_tickets ADD CONSTRAINT support_tickets_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text])));
ALTER TABLE ONLY public.support_tickets ADD CONSTRAINT support_tickets_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'resolved'::text, 'closed'::text])));
ALTER TABLE ONLY public.trip_documents ADD CONSTRAINT trip_documents_doc_type_check CHECK ((doc_type = ANY (ARRAY['eway_bill_photo'::text, 'lr_copy'::text, 'weighbridge_slip'::text, 'pod_photo'::text, 'pod_signature'::text, 'other'::text])));
ALTER TABLE ONLY public.trip_economics ADD CONSTRAINT trip_economics_distance_basis_check CHECK (((distance_basis IS NULL) OR (distance_basis = ANY (ARRAY['measured'::text, 'routed'::text, 'estimated'::text]))));
ALTER TABLE ONLY public.trip_events ADD CONSTRAINT trip_events_event_type_check CHECK ((event_type = ANY (ARRAY['arrived_pickup'::text, 'loading'::text, 'loaded'::text, 'in_transit'::text, 'arrived_delivery'::text, 'delivered'::text, 'cancelled'::text])));
ALTER TABLE ONLY public.trip_expenses ADD CONSTRAINT trip_expenses_amount_check CHECK ((amount > (0)::numeric));
ALTER TABLE ONLY public.trip_expenses ADD CONSTRAINT trip_expenses_category_check CHECK ((category = ANY (ARRAY['fuel'::text, 'toll'::text, 'food'::text, 'maintenance'::text, 'parking'::text, 'other'::text])));
ALTER TABLE ONLY public.trip_expenses ADD CONSTRAINT trip_expenses_category_code_check CHECK (((category_code IS NULL) OR (category_code = ANY (ARRAY['fuel'::text, 'def'::text, 'toll'::text, 'tyre'::text, 'repair'::text, 'parking'::text, 'weighbridge'::text, 'fine'::text, 'loading_unloading'::text, 'driver_allowance'::text, 'permit'::text, 'other'::text]))));
ALTER TABLE ONLY public.trip_expenses ADD CONSTRAINT trip_expenses_litres_check CHECK (((litres IS NULL) OR (litres > (0)::numeric)));
ALTER TABLE ONLY public.trip_expenses ADD CONSTRAINT trip_expenses_odometer_km_check CHECK (((odometer_km IS NULL) OR (odometer_km >= 0)));
ALTER TABLE ONLY public.trip_locations ADD CONSTRAINT valid_latlng CHECK (((latitude >= ('-90'::integer)::numeric) AND (latitude <= (90)::numeric) AND (longitude >= ('-180'::integer)::numeric) AND (longitude <= (180)::numeric)));
ALTER TABLE ONLY public.trip_telemetry ADD CONSTRAINT trip_telemetry_distance_m_check CHECK ((distance_m >= (0)::double precision));
ALTER TABLE ONLY public.trip_telemetry ADD CONSTRAINT trip_telemetry_idle_seconds_check CHECK ((idle_seconds >= 0));
ALTER TABLE ONLY public.trip_telemetry ADD CONSTRAINT trip_telemetry_last_lat_check CHECK (((last_lat IS NULL) OR ((last_lat >= ('-90'::integer)::double precision) AND (last_lat <= (90)::double precision))));
ALTER TABLE ONLY public.trip_telemetry ADD CONSTRAINT trip_telemetry_last_lng_check CHECK (((last_lng IS NULL) OR ((last_lng >= ('-180'::integer)::double precision) AND (last_lng <= (180)::double precision))));
ALTER TABLE ONLY public.trip_telemetry ADD CONSTRAINT trip_telemetry_max_deviation_m_check CHECK ((max_deviation_m >= (0)::double precision));
ALTER TABLE ONLY public.trip_telemetry ADD CONSTRAINT trip_telemetry_max_speed_kmh_check CHECK ((max_speed_kmh >= (0)::double precision));
ALTER TABLE ONLY public.trip_telemetry ADD CONSTRAINT trip_telemetry_moving_seconds_check CHECK ((moving_seconds >= 0));
ALTER TABLE ONLY public.trip_telemetry ADD CONSTRAINT trip_telemetry_night_seconds_check CHECK ((night_seconds >= 0));
ALTER TABLE ONLY public.trip_telemetry ADD CONSTRAINT trip_telemetry_point_count_check CHECK ((point_count >= 0));
ALTER TABLE ONLY public.trip_telemetry ADD CONSTRAINT trip_telemetry_speed_sum_kmh_s_check CHECK ((speed_sum_kmh_s >= (0)::double precision));
ALTER TABLE ONLY public.trip_telemetry ADD CONSTRAINT trip_telemetry_speeding_count_check CHECK ((speeding_count >= 0));
ALTER TABLE ONLY public.trip_telemetry ADD CONSTRAINT trip_telemetry_stop_count_check CHECK ((stop_count >= 0));
ALTER TABLE ONLY public.trips ADD CONSTRAINT trip_end_after_start CHECK (((end_time IS NULL) OR (end_time >= start_time)));
ALTER TABLE ONLY public.trips ADD CONSTRAINT valid_distance CHECK (((distance_km IS NULL) OR (distance_km >= (0)::numeric)));
ALTER TABLE ONLY public.trips ADD CONSTRAINT valid_speed CHECK (((average_speed_kmph IS NULL) OR (average_speed_kmph >= (0)::numeric)));
ALTER TABLE ONLY public.user_kyc ADD CONSTRAINT user_kyc_kyc_level_check CHECK ((kyc_level = ANY (ARRAY['L0'::text, 'L1'::text, 'L2'::text, 'L3'::text])));
ALTER TABLE ONLY public.users ADD CONSTRAINT users_gstin_format CHECK (((gstin IS NULL) OR (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{2}[0-9A-Z]$'::text)));
ALTER TABLE ONLY public.users ADD CONSTRAINT valid_email CHECK (((email IS NULL) OR (email ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}$'::text)));
ALTER TABLE ONLY public.users ADD CONSTRAINT valid_phone CHECK ((phone_number ~ '^\+?[0-9]{10,15}$'::text));
ALTER TABLE ONLY public.vehicle_cost_norms ADD CONSTRAINT vehicle_cost_norms_kmpl_bs4_check CHECK (((kmpl_bs4 IS NULL) OR (kmpl_bs4 > (0)::numeric)));
ALTER TABLE ONLY public.vehicle_cost_norms ADD CONSTRAINT vehicle_cost_norms_kmpl_bs6_check CHECK (((kmpl_bs6 IS NULL) OR (kmpl_bs6 > (0)::numeric)));
ALTER TABLE ONLY public.vehicle_cost_norms ADD CONSTRAINT vehicle_cost_norms_kms_per_year_check CHECK ((kms_per_year > 0));
ALTER TABLE ONLY public.vehicle_cost_norms ADD CONSTRAINT vehicle_cost_norms_vehicle_class_check CHECK ((vehicle_class = ANY (ARRAY['SCV'::text, 'LCV'::text, 'MCV'::text, 'HCV'::text])));
ALTER TABLE ONLY public.vehicle_cost_norms ADD CONSTRAINT vehicle_cost_norms_wage_weight_check CHECK ((wage_weight > (0)::numeric));
ALTER TABLE ONLY public.vehicle_finance ADD CONSTRAINT vehicle_finance_emi_amount_inr_check CHECK ((emi_amount_inr >= (0)::numeric));
ALTER TABLE ONLY public.vehicle_finance ADD CONSTRAINT vehicle_finance_emi_day_of_month_check CHECK (((emi_day_of_month >= 1) AND (emi_day_of_month <= 31)));
ALTER TABLE ONLY public.vehicle_finance ADD CONSTRAINT vehicle_finance_fitness_annual_inr_check CHECK ((fitness_annual_inr >= (0)::numeric));
ALTER TABLE ONLY public.vehicle_finance ADD CONSTRAINT vehicle_finance_insurance_annual_inr_check CHECK ((insurance_annual_inr >= (0)::numeric));
ALTER TABLE ONLY public.vehicle_finance ADD CONSTRAINT vehicle_finance_outstanding_inr_check CHECK (((outstanding_inr IS NULL) OR (outstanding_inr >= (0)::numeric)));
ALTER TABLE ONLY public.vehicle_finance ADD CONSTRAINT vehicle_finance_permit_annual_inr_check CHECK ((permit_annual_inr >= (0)::numeric));
ALTER TABLE ONLY public.vehicle_finance ADD CONSTRAINT vehicle_finance_principal_inr_check CHECK (((principal_inr IS NULL) OR (principal_inr > (0)::numeric)));
ALTER TABLE ONLY public.vehicle_finance ADD CONSTRAINT vehicle_finance_tenure_months_check CHECK (((tenure_months IS NULL) OR (tenure_months > 0)));
ALTER TABLE ONLY public.vehicle_lanes ADD CONSTRAINT vehicle_lanes_typical_distance_km_check CHECK (((typical_distance_km IS NULL) OR (typical_distance_km > (0)::numeric)));
ALTER TABLE ONLY public.vehicle_permits ADD CONSTRAINT vehicle_permits_permit_type_check CHECK ((permit_type = ANY (ARRAY['national'::text, 'state'::text, 'contract_carriage'::text, 'goods'::text])));
ALTER TABLE ONLY public.vehicle_service_cost_by_age ADD CONSTRAINT vehicle_service_cost_by_age_age_years_check CHECK (((age_years >= 1) AND (age_years <= 10)));
ALTER TABLE ONLY public.vehicle_service_cost_by_age ADD CONSTRAINT vehicle_service_cost_by_age_annual_cost_inr_check CHECK ((annual_cost_inr >= (0)::numeric));
ALTER TABLE ONLY public.vehicles ADD CONSTRAINT vehicles_axle_config_check CHECK ((axle_config = ANY (ARRAY['4x2'::text, '6x2'::text, '6x4'::text, '8x4'::text, '10x2'::text])));
ALTER TABLE ONLY public.vehicles ADD CONSTRAINT vehicles_body_type_check CHECK ((body_type = ANY (ARRAY['open'::text, 'closed'::text, 'container'::text, 'flatbed'::text, 'tanker'::text, 'refrigerated'::text])));
ALTER TABLE ONLY public.vehicles ADD CONSTRAINT vehicles_current_odometer_km_check CHECK (((current_odometer_km IS NULL) OR (current_odometer_km >= 0)));
ALTER TABLE ONLY public.vehicles ADD CONSTRAINT vehicles_emission_norm_check CHECK (((emission_norm IS NULL) OR (emission_norm = ANY (ARRAY['BS4'::text, 'BS6'::text, 'BS6_PH2'::text]))));
ALTER TABLE ONLY public.vehicles ADD CONSTRAINT vehicles_exactly_one_owner CHECK ((num_nonnulls(driver_id, fleet_owner_id) = 1));
ALTER TABLE ONLY public.vehicles ADD CONSTRAINT vehicles_manufacture_year_check CHECK (((manufacture_year IS NULL) OR ((manufacture_year >= 1990) AND (manufacture_year <= 2100))));
ALTER TABLE ONLY public.vehicles ADD CONSTRAINT vehicles_rc_status_check CHECK ((rc_status = ANY (ARRAY['pending'::text, 'verified'::text, 'rejected'::text])));
ALTER TABLE ONLY public.vehicles ADD CONSTRAINT vehicles_single_owner CHECK ((num_nonnulls(driver_id, fleet_owner_id) = 1)) NOT VALID;
ALTER TABLE ONLY public.vehicles ADD CONSTRAINT vehicles_volume_cuft_check CHECK (((volume_cuft IS NULL) OR (volume_cuft > (0)::numeric)));


-- =====================================================================================
-- 6. FOREIGN KEYS
-- =====================================================================================

ALTER TABLE ONLY public.bank_accounts ADD CONSTRAINT bank_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.booking_responses ADD CONSTRAINT booking_responses_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.booking_responses ADD CONSTRAINT booking_responses_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.bookings ADD CONSTRAINT bookings_consignee_user_id_fkey FOREIGN KEY (consignee_user_id) REFERENCES users(id);
ALTER TABLE ONLY public.bookings ADD CONSTRAINT bookings_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.bookings ADD CONSTRAINT bookings_fleet_owner_id_fkey FOREIGN KEY (fleet_owner_id) REFERENCES fleet_owners(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.bookings ADD CONSTRAINT bookings_shipper_id_fkey FOREIGN KEY (shipper_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.bookings ADD CONSTRAINT bookings_target_driver_id_fkey FOREIGN KEY (target_driver_id) REFERENCES drivers(id);
ALTER TABLE ONLY public.bookings ADD CONSTRAINT bookings_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.document_extractions ADD CONSTRAINT document_extractions_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.document_extractions ADD CONSTRAINT document_extractions_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);
ALTER TABLE ONLY public.driver_insurance ADD CONSTRAINT driver_insurance_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.driver_insurance ADD CONSTRAINT driver_insurance_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.driver_licenses ADD CONSTRAINT driver_licenses_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.driver_reviews ADD CONSTRAINT driver_reviews_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id);
ALTER TABLE ONLY public.driver_reviews ADD CONSTRAINT driver_reviews_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.driver_reviews ADD CONSTRAINT driver_reviews_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES users(id);
ALTER TABLE ONLY public.drivers ADD CONSTRAINT drivers_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.eway_bill_records ADD CONSTRAINT eway_bill_records_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.eway_bill_records ADD CONSTRAINT eway_bill_records_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.eway_bill_records ADD CONSTRAINT eway_bill_records_status_changed_by_fkey FOREIGN KEY (status_changed_by) REFERENCES users(id);
ALTER TABLE ONLY public.eway_bills ADD CONSTRAINT eway_bills_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.fleet_cost_settings ADD CONSTRAINT fleet_cost_settings_fleet_owner_id_fkey FOREIGN KEY (fleet_owner_id) REFERENCES fleet_owners(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.fleet_drivers ADD CONSTRAINT fleet_drivers_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.fleet_drivers ADD CONSTRAINT fleet_drivers_fleet_owner_id_fkey FOREIGN KEY (fleet_owner_id) REFERENCES fleet_owners(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.fleet_drivers ADD CONSTRAINT fleet_drivers_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES users(id);
ALTER TABLE ONLY public.fleet_members ADD CONSTRAINT fleet_members_fleet_owner_id_fkey FOREIGN KEY (fleet_owner_id) REFERENCES fleet_owners(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.fleet_members ADD CONSTRAINT fleet_members_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES users(id);
ALTER TABLE ONLY public.fleet_members ADD CONSTRAINT fleet_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.fleet_owners ADD CONSTRAINT fleet_owners_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.freight_invoices ADD CONSTRAINT freight_invoices_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.freight_invoices ADD CONSTRAINT freight_invoices_series_id_fkey FOREIGN KEY (series_id) REFERENCES document_series(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.freight_invoices ADD CONSTRAINT freight_invoices_supplier_user_id_fkey FOREIGN KEY (supplier_user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.fuel_estimates ADD CONSTRAINT fuel_estimates_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.geofence_events ADD CONSTRAINT geofence_events_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.geofence_events ADD CONSTRAINT geofence_events_geofence_id_fkey FOREIGN KEY (geofence_id) REFERENCES geofences(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.geofence_events ADD CONSTRAINT geofence_events_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.geofences ADD CONSTRAINT geofences_fleet_owner_id_fkey FOREIGN KEY (fleet_owner_id) REFERENCES fleet_owners(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.kyc_documents ADD CONSTRAINT kyc_documents_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.location_history ADD CONSTRAINT location_history_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.location_history ADD CONSTRAINT location_history_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.lorry_receipts ADD CONSTRAINT lorry_receipts_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.lorry_receipts ADD CONSTRAINT lorry_receipts_series_id_fkey FOREIGN KEY (series_id) REFERENCES document_series(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.messages ADD CONSTRAINT messages_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.messages ADD CONSTRAINT messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES users(id);
ALTER TABLE ONLY public.negotiations ADD CONSTRAINT negotiations_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(id);
ALTER TABLE ONLY public.negotiations ADD CONSTRAINT negotiations_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id);
ALTER TABLE ONLY public.negotiations ADD CONSTRAINT negotiations_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.notification_outbox ADD CONSTRAINT notification_outbox_recipient_user_id_fkey FOREIGN KEY (recipient_user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.notification_preferences ADD CONSTRAINT notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.notifications ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.ops_overrides ADD CONSTRAINT ops_overrides_acted_for_fleet_owner_id_fkey FOREIGN KEY (acted_for_fleet_owner_id) REFERENCES fleet_owners(id);
ALTER TABLE ONLY public.ops_overrides ADD CONSTRAINT ops_overrides_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES users(id);
ALTER TABLE ONLY public.ops_overrides ADD CONSTRAINT ops_overrides_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.ops_overrides ADD CONSTRAINT ops_overrides_from_driver_id_fkey FOREIGN KEY (from_driver_id) REFERENCES drivers(id);
ALTER TABLE ONLY public.ops_overrides ADD CONSTRAINT ops_overrides_to_driver_id_fkey FOREIGN KEY (to_driver_id) REFERENCES drivers(id);
ALTER TABLE ONLY public.payments ADD CONSTRAINT payments_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id);
ALTER TABLE ONLY public.payments ADD CONSTRAINT payments_payee_id_fkey FOREIGN KEY (payee_id) REFERENCES users(id);
ALTER TABLE ONLY public.payments ADD CONSTRAINT payments_payer_id_fkey FOREIGN KEY (payer_id) REFERENCES users(id);
ALTER TABLE ONLY public.payments ADD CONSTRAINT payments_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES users(id);
ALTER TABLE ONLY public.payouts ADD CONSTRAINT payouts_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.payouts ADD CONSTRAINT payouts_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES drivers(id);
ALTER TABLE ONLY public.payouts ADD CONSTRAINT payouts_fleet_owner_id_fkey FOREIGN KEY (fleet_owner_id) REFERENCES fleet_owners(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.payouts ADD CONSTRAINT payouts_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES users(id);
ALTER TABLE ONLY public.persona_acknowledgements ADD CONSTRAINT persona_acknowledgements_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.pod_audit_log ADD CONSTRAINT pod_audit_log_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.pod_audit_log ADD CONSTRAINT pod_audit_log_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.pod_audit_log ADD CONSTRAINT pod_audit_log_evidence_id_fkey FOREIGN KEY (evidence_id) REFERENCES pod_evidence(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.pod_discrepancies ADD CONSTRAINT pod_discrepancies_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.pod_discrepancies ADD CONSTRAINT pod_discrepancies_consignee_user_id_fkey FOREIGN KEY (consignee_user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.pod_discrepancies ADD CONSTRAINT pod_discrepancies_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.pod_discrepancies ADD CONSTRAINT pod_discrepancies_evidence_id_fkey FOREIGN KEY (evidence_id) REFERENCES pod_evidence(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.pod_evidence ADD CONSTRAINT pod_evidence_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.pod_evidence ADD CONSTRAINT pod_evidence_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.pod_receipts ADD CONSTRAINT pod_receipts_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.pod_state ADD CONSTRAINT pod_state_asserted_by_driver_id_fkey FOREIGN KEY (asserted_by_driver_id) REFERENCES drivers(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.pod_state ADD CONSTRAINT pod_state_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.pod_state ADD CONSTRAINT pod_state_closed_by_ops_user_id_fkey FOREIGN KEY (closed_by_ops_user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.pod_state ADD CONSTRAINT pod_state_fleet_reviewed_by_fkey FOREIGN KEY (fleet_reviewed_by) REFERENCES users(id);
ALTER TABLE ONLY public.price_quotes ADD CONSTRAINT price_quotes_consumed_by_booking_id_fkey FOREIGN KEY (consumed_by_booking_id) REFERENCES bookings(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.price_quotes ADD CONSTRAINT price_quotes_shipper_id_fkey FOREIGN KEY (shipper_id) REFERENCES users(id);
ALTER TABLE ONLY public.quotes ADD CONSTRAINT quotes_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.quotes ADD CONSTRAINT quotes_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES drivers(id);
ALTER TABLE ONLY public.quotes ADD CONSTRAINT quotes_fleet_owner_id_fkey FOREIGN KEY (fleet_owner_id) REFERENCES fleet_owners(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.route_alerts ADD CONSTRAINT route_alerts_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.saved_addresses ADD CONSTRAINT saved_addresses_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.saved_lanes ADD CONSTRAINT saved_lanes_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.support_tickets ADD CONSTRAINT support_tickets_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id);
ALTER TABLE ONLY public.support_tickets ADD CONSTRAINT support_tickets_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.trip_documents ADD CONSTRAINT trip_documents_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.trip_documents ADD CONSTRAINT trip_documents_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.trip_documents ADD CONSTRAINT trip_documents_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES users(id);
ALTER TABLE ONLY public.trip_economics ADD CONSTRAINT trip_economics_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.trip_economics ADD CONSTRAINT trip_economics_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.trip_economics ADD CONSTRAINT trip_economics_fleet_owner_id_fkey FOREIGN KEY (fleet_owner_id) REFERENCES fleet_owners(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.trip_economics ADD CONSTRAINT trip_economics_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.trip_events ADD CONSTRAINT trip_events_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.trip_expenses ADD CONSTRAINT trip_expenses_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.trip_expenses ADD CONSTRAINT trip_expenses_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.trip_expenses ADD CONSTRAINT trip_expenses_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.trip_expenses ADD CONSTRAINT trip_expenses_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.trip_expenses ADD CONSTRAINT trip_expenses_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES users(id);
ALTER TABLE ONLY public.trip_locations ADD CONSTRAINT trip_locations_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.trip_locations ADD CONSTRAINT trip_locations_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.trip_locations ADD CONSTRAINT trip_locations_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.trip_routes ADD CONSTRAINT trip_routes_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.trip_telemetry ADD CONSTRAINT trip_telemetry_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.trip_telemetry ADD CONSTRAINT trip_telemetry_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.trips ADD CONSTRAINT trips_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.trips ADD CONSTRAINT trips_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.trips ADD CONSTRAINT trips_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.user_kyc ADD CONSTRAINT user_kyc_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.user_settings ADD CONSTRAINT user_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.users ADD CONSTRAINT users_auth_id_fkey FOREIGN KEY (auth_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.vehicle_assignments ADD CONSTRAINT vehicle_assignments_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES users(id);
ALTER TABLE ONLY public.vehicle_assignments ADD CONSTRAINT vehicle_assignments_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.vehicle_assignments ADD CONSTRAINT vehicle_assignments_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.vehicle_assignments ADD CONSTRAINT vehicle_assignments_fleet_owner_id_fkey FOREIGN KEY (fleet_owner_id) REFERENCES fleet_owners(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.vehicle_assignments ADD CONSTRAINT vehicle_assignments_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.vehicle_finance ADD CONSTRAINT vehicle_finance_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.vehicle_lanes ADD CONSTRAINT vehicle_lanes_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.vehicle_permits ADD CONSTRAINT vehicle_permits_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.vehicles ADD CONSTRAINT vehicles_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.vehicles ADD CONSTRAINT vehicles_fleet_owner_id_fkey FOREIGN KEY (fleet_owner_id) REFERENCES fleet_owners(id) ON DELETE RESTRICT;


-- =====================================================================================
-- 7. INDEXES (non-constraint)
-- =====================================================================================
-- Indexes that back a PK/UNIQUE constraint are created by the constraint (section 4) and
-- are not repeated here.

CREATE INDEX idx_bank_accounts_user_id ON public.bank_accounts USING btree (user_id);
CREATE INDEX idx_booking_responses_booking_id ON public.booking_responses USING btree (booking_id);
CREATE INDEX idx_booking_responses_driver_id ON public.booking_responses USING btree (driver_id);
CREATE INDEX bookings_consignee_user_idx ON public.bookings USING btree (consignee_user_id) WHERE (consignee_user_id IS NOT NULL);
CREATE INDEX bookings_fleet_owner_idx ON public.bookings USING btree (fleet_owner_id) WHERE (fleet_owner_id IS NOT NULL);
CREATE UNIQUE INDEX bookings_one_live_trip_per_driver ON public.bookings USING btree (driver_id) WHERE ((driver_id IS NOT NULL) AND (status <> ALL (ARRAY['completed'::booking_status, 'delivery_asserted'::booking_status, 'paid'::booking_status, 'cancelled'::booking_status])));
CREATE INDEX bookings_vehicle_idx ON public.bookings USING btree (vehicle_id) WHERE (vehicle_id IS NOT NULL);
CREATE INDEX idx_bookings_created_at ON public.bookings USING btree (created_at DESC);
CREATE INDEX idx_bookings_driver_id ON public.bookings USING btree (driver_id);
CREATE INDEX idx_bookings_pickup_date ON public.bookings USING btree (pickup_date);
CREATE INDEX idx_bookings_shipper_id ON public.bookings USING btree (shipper_id);
CREATE INDEX idx_bookings_shipper_status ON public.bookings USING btree (shipper_id, status);
CREATE INDEX idx_bookings_status ON public.bookings USING btree (status);
CREATE INDEX idx_bookings_status_driver ON public.bookings USING btree (status, driver_id);
CREATE INDEX document_extractions_booking_idx ON public.document_extractions USING btree (booking_id, created_at DESC);
CREATE INDEX idx_driver_insurance_driver_id ON public.driver_insurance USING btree (driver_id);
CREATE INDEX idx_driver_insurance_vehicle_id ON public.driver_insurance USING btree (vehicle_id);
CREATE INDEX idx_driver_reviews_driver_id ON public.driver_reviews USING btree (driver_id);
CREATE INDEX idx_drivers_created_at ON public.drivers USING btree (created_at DESC);
CREATE INDEX idx_drivers_is_available ON public.drivers USING btree (is_available);
CREATE INDEX idx_drivers_truck_number ON public.drivers USING btree (truck_number);
CREATE INDEX idx_drivers_user_id ON public.drivers USING btree (user_id);
CREATE INDEX eway_bill_records_booking_idx ON public.eway_bill_records USING btree (booking_id, generated_at DESC);
CREATE INDEX eway_bill_records_expiry_idx ON public.eway_bill_records USING btree (valid_upto) WHERE ((part_b_entered_at IS NOT NULL) AND (status = 'active'::ewb_status));
CREATE INDEX idx_eway_bills_booking_id ON public.eway_bills USING btree (booking_id);
CREATE INDEX idx_eway_bills_created_at ON public.eway_bills USING btree (created_at DESC);
CREATE INDEX idx_eway_bills_ewb_number ON public.eway_bills USING btree (ewb_number);
CREATE INDEX idx_eway_bills_status ON public.eway_bills USING btree (status);
CREATE UNIQUE INDEX fleet_cost_settings_one_global ON public.fleet_cost_settings USING btree (((fleet_owner_id IS NULL))) WHERE (fleet_owner_id IS NULL);
CREATE INDEX fleet_drivers_driver_idx ON public.fleet_drivers USING btree (driver_id, status);
CREATE UNIQUE INDEX fleet_drivers_one_live_per_driver ON public.fleet_drivers USING btree (driver_id) WHERE (status = ANY (ARRAY['pending'::text, 'active'::text]));
CREATE INDEX fleet_drivers_owner_idx ON public.fleet_drivers USING btree (fleet_owner_id, status);
CREATE INDEX fleet_members_fleet_idx ON public.fleet_members USING btree (fleet_owner_id, status);
CREATE INDEX fleet_members_user_idx ON public.fleet_members USING btree (user_id, status);
CREATE UNIQUE INDEX freight_invoices_number_idx ON public.freight_invoices USING btree (supplier_user_id, financial_year, invoice_number);
CREATE INDEX freight_invoices_series_idx ON public.freight_invoices USING btree (series_id, issued_at DESC);
CREATE INDEX idx_fuel_estimates_booking_id ON public.fuel_estimates USING btree (booking_id);
CREATE INDEX geofence_events_booking_idx ON public.geofence_events USING btree (booking_id, occurred_at DESC);
CREATE INDEX geofence_events_fence_idx ON public.geofence_events USING btree (geofence_id, occurred_at DESC) WHERE (geofence_id IS NOT NULL);
CREATE INDEX geofences_owner_active_idx ON public.geofences USING btree (fleet_owner_id, active) WHERE active;
CREATE INDEX idx_kyc_documents_user_id ON public.kyc_documents USING btree (user_id);
CREATE INDEX idx_location_history_booking_recorded ON public.location_history USING btree (booking_id, recorded_at DESC);
CREATE INDEX location_history_vehicle_idx ON public.location_history USING btree (vehicle_id, recorded_at DESC) WHERE (vehicle_id IS NOT NULL);
CREATE UNIQUE INDEX lorry_receipts_number_idx ON public.lorry_receipts USING btree (issuer_kind, issuer_id, financial_year, lr_number);
CREATE INDEX lorry_receipts_series_idx ON public.lorry_receipts USING btree (series_id, issued_at DESC);
CREATE INDEX idx_messages_booking_id ON public.messages USING btree (booking_id);
CREATE INDEX idx_messages_sender_id ON public.messages USING btree (sender_id);
CREATE UNIQUE INDEX notification_outbox_dedupe_key_idx ON public.notification_outbox USING btree (dedupe_key);
CREATE INDEX notification_outbox_due_idx ON public.notification_outbox USING btree (next_attempt_at, created_at) WHERE (status = ANY (ARRAY['pending'::text, 'sending'::text]));
CREATE INDEX notification_outbox_failed_idx ON public.notification_outbox USING btree (created_at DESC) WHERE (status = 'failed'::text);
CREATE INDEX notification_outbox_recipient_idx ON public.notification_outbox USING btree (recipient_user_id, created_at DESC) WHERE (recipient_user_id IS NOT NULL);
CREATE INDEX notification_preferences_token_idx ON public.notification_preferences USING btree (unsubscribe_token);
CREATE INDEX idx_notifications_created_at ON public.notifications USING btree (created_at DESC);
CREATE INDEX idx_notifications_is_read ON public.notifications USING btree (is_read);
CREATE INDEX idx_notifications_user_id ON public.notifications USING btree (user_id);
CREATE INDEX idx_notifications_user_read ON public.notifications USING btree (user_id, is_read);
CREATE INDEX ops_overrides_booking_idx ON public.ops_overrides USING btree (booking_id, created_at DESC);
CREATE INDEX idx_payments_booking_id ON public.payments USING btree (booking_id);
CREATE INDEX idx_payments_payee_id ON public.payments USING btree (payee_id);
CREATE INDEX idx_payments_status ON public.payments USING btree (status);
CREATE UNIQUE INDEX payments_booking_unique ON public.payments USING btree (booking_id);
CREATE INDEX payouts_booking_idx ON public.payouts USING btree (booking_id);
CREATE INDEX payouts_fleet_owner_idx ON public.payouts USING btree (fleet_owner_id) WHERE (fleet_owner_id IS NOT NULL);
CREATE INDEX persona_acknowledgements_user_idx ON public.persona_acknowledgements USING btree (user_id);
CREATE INDEX pmo_activity_project_ts_idx ON public.pmo_activity USING btree (project_id, ts DESC);
CREATE INDEX pmo_attachments_entity_idx ON public.pmo_attachments USING btree (project_id, entity_type, entity_id);
CREATE INDEX pmo_items_project_idx ON public.pmo_items USING btree (project_id);
CREATE INDEX pmo_members_email_idx ON public.pmo_members USING btree (email);
CREATE INDEX pod_audit_log_booking_idx ON public.pod_audit_log USING btree (booking_id, occurred_at DESC);
CREATE INDEX pod_audit_log_evidence_idx ON public.pod_audit_log USING btree (evidence_id, occurred_at DESC) WHERE (evidence_id IS NOT NULL);
CREATE INDEX pod_discrepancies_booking_idx ON public.pod_discrepancies USING btree (booking_id);
CREATE UNIQUE INDEX pod_evidence_booking_hash_uidx ON public.pod_evidence USING btree (booking_id, sha256_original);
CREATE INDEX pod_evidence_booking_idx ON public.pod_evidence USING btree (booking_id, created_at DESC);
CREATE INDEX pod_receipts_booking_idx ON public.pod_receipts USING btree (booking_id);
CREATE INDEX pod_state_fleet_pending_idx ON public.pod_state USING btree (booking_id) WHERE (fleet_review_status = 'pending'::text);
CREATE INDEX price_quotes_shipper_idx ON public.price_quotes USING btree (shipper_id);
CREATE INDEX quotes_fleet_owner_idx ON public.quotes USING btree (fleet_owner_id) WHERE (fleet_owner_id IS NOT NULL);
CREATE UNIQUE INDEX quotes_one_live_bid_per_fleet ON public.quotes USING btree (booking_id, fleet_owner_id) WHERE ((fleet_owner_id IS NOT NULL) AND (status = ANY (ARRAY['submitted'::text, 'countered'::text])));
CREATE INDEX idx_route_alerts_booking_id ON public.route_alerts USING btree (booking_id, created_at DESC);
CREATE INDEX route_alerts_open_idx ON public.route_alerts USING btree (booking_id, created_at DESC) WHERE (resolved_at IS NULL);
CREATE UNIQUE INDEX route_alerts_open_unique ON public.route_alerts USING btree (booking_id, type) WHERE (resolved_at IS NULL);
CREATE INDEX saved_addresses_user_idx ON public.saved_addresses USING btree (user_id, last_used_at DESC);
CREATE UNIQUE INDEX saved_addresses_user_place_uniq ON public.saved_addresses USING btree (user_id, place_id) WHERE (place_id IS NOT NULL);
CREATE INDEX idx_saved_lanes_driver_id ON public.saved_lanes USING btree (driver_id);
CREATE INDEX idx_support_tickets_status ON public.support_tickets USING btree (status);
CREATE INDEX idx_support_tickets_user_id ON public.support_tickets USING btree (user_id);
CREATE INDEX idx_trip_documents_booking_id ON public.trip_documents USING btree (booking_id);
CREATE INDEX idx_trip_documents_trip_id ON public.trip_documents USING btree (trip_id);
CREATE INDEX trip_economics_driver_idx ON public.trip_economics USING btree (driver_id, completed_at DESC);
CREATE INDEX trip_economics_fleet_idx ON public.trip_economics USING btree (fleet_owner_id, completed_at DESC);
CREATE INDEX trip_economics_vehicle_idx ON public.trip_economics USING btree (vehicle_id, completed_at DESC);
CREATE INDEX idx_trip_events_trip_id ON public.trip_events USING btree (trip_id);
CREATE INDEX idx_trip_expenses_driver_id ON public.trip_expenses USING btree (driver_id);
CREATE INDEX idx_trip_expenses_trip_id ON public.trip_expenses USING btree (trip_id);
CREATE INDEX trip_expenses_booking_idx ON public.trip_expenses USING btree (booking_id) WHERE (booking_id IS NOT NULL);
CREATE INDEX trip_expenses_vehicle_idx ON public.trip_expenses USING btree (vehicle_id, expense_date DESC) WHERE (vehicle_id IS NOT NULL);
CREATE INDEX idx_trip_locations_booking_id ON public.trip_locations USING btree (booking_id);
CREATE INDEX idx_trip_locations_created_at ON public.trip_locations USING btree (created_at DESC);
CREATE INDEX idx_trip_locations_driver_id ON public.trip_locations USING btree (driver_id);
CREATE INDEX idx_trip_locations_latlng ON public.trip_locations USING btree (latitude, longitude);
CREATE INDEX idx_trip_locations_trip_id ON public.trip_locations USING btree (trip_id);
CREATE INDEX idx_trip_routes_booking_id ON public.trip_routes USING btree (booking_id);
CREATE INDEX trip_telemetry_vehicle_idx ON public.trip_telemetry USING btree (vehicle_id, last_fix_at DESC) WHERE (vehicle_id IS NOT NULL);
CREATE INDEX idx_trips_booking_id ON public.trips USING btree (booking_id);
CREATE INDEX idx_trips_created_at ON public.trips USING btree (created_at DESC);
CREATE INDEX idx_trips_driver_id ON public.trips USING btree (driver_id);
CREATE INDEX idx_trips_driver_status ON public.trips USING btree (driver_id, status);
CREATE INDEX idx_trips_status ON public.trips USING btree (status);
CREATE INDEX trips_vehicle_idx ON public.trips USING btree (vehicle_id) WHERE (vehicle_id IS NOT NULL);
CREATE INDEX user_kyc_aadhaar_hash_idx ON public.user_kyc USING btree (aadhaar_hash) WHERE (aadhaar_hash IS NOT NULL);
CREATE INDEX user_kyc_pan_hash_idx ON public.user_kyc USING btree (pan_hash) WHERE (pan_hash IS NOT NULL);
CREATE INDEX idx_users_auth_id ON public.users USING btree (auth_id);
CREATE INDEX idx_users_created_at ON public.users USING btree (created_at DESC);
CREATE INDEX idx_users_google_sub ON public.users USING btree (google_sub) WHERE (google_sub IS NOT NULL);
CREATE INDEX idx_users_kyc_status ON public.users USING btree (kyc_status);
CREATE INDEX idx_users_phone_number ON public.users USING btree (phone_number);
CREATE INDEX idx_users_role ON public.users USING btree (role);
CREATE INDEX vehicle_assignments_driver_idx ON public.vehicle_assignments USING btree (driver_id, assigned_at DESC);
CREATE INDEX vehicle_assignments_fleet_idx ON public.vehicle_assignments USING btree (fleet_owner_id, assigned_at DESC);
CREATE UNIQUE INDEX vehicle_assignments_one_live_per_booking ON public.vehicle_assignments USING btree (booking_id) WHERE (released_at IS NULL);
CREATE UNIQUE INDEX vehicle_assignments_one_live_per_driver ON public.vehicle_assignments USING btree (driver_id) WHERE (released_at IS NULL);
CREATE UNIQUE INDEX vehicle_assignments_one_live_per_vehicle ON public.vehicle_assignments USING btree (vehicle_id) WHERE (released_at IS NULL);
CREATE INDEX vehicle_assignments_vehicle_idx ON public.vehicle_assignments USING btree (vehicle_id, assigned_at DESC);
CREATE UNIQUE INDEX vehicle_lanes_one_primary ON public.vehicle_lanes USING btree (vehicle_id) WHERE is_primary;
CREATE INDEX vehicle_lanes_vehicle_idx ON public.vehicle_lanes USING btree (vehicle_id);
CREATE INDEX vehicle_permits_vehicle_idx ON public.vehicle_permits USING btree (vehicle_id) WHERE is_active;
CREATE INDEX idx_vehicles_driver_id ON public.vehicles USING btree (driver_id);
CREATE INDEX vehicles_driver_owner_idx ON public.vehicles USING btree (driver_id) WHERE (driver_id IS NOT NULL);
CREATE INDEX vehicles_fleet_owner_idx ON public.vehicles USING btree (fleet_owner_id) WHERE (fleet_owner_id IS NOT NULL);


-- =====================================================================================
-- 8. FUNCTIONS
-- =====================================================================================

CREATE OR REPLACE FUNCTION public.accept_booking(p_booking_id uuid, p_driver_id uuid)
 RETURNS TABLE(success boolean, message text, booking_id uuid)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_booking_record public.bookings%ROWTYPE;
  v_driver_record public.drivers%ROWTYPE;
BEGIN
  -- Fetch booking
  SELECT * INTO v_booking_record
  FROM public.bookings
  WHERE id = p_booking_id AND status = 'pending';

  IF v_booking_record.id IS NULL THEN
    RETURN QUERY SELECT false, 'Booking not found or not pending', p_booking_id;
    RETURN;
  END IF;

  -- Fetch driver
  SELECT * INTO v_driver_record
  FROM public.drivers
  WHERE id = p_driver_id AND is_available = true;

  IF v_driver_record.id IS NULL THEN
    RETURN QUERY SELECT false, 'Driver not found or not available', p_booking_id;
    RETURN;
  END IF;

  -- Update booking
  UPDATE public.bookings
  SET
    driver_id = p_driver_id,
    status = 'accepted',
    updated_at = NOW()
  WHERE id = p_booking_id;

  RETURN QUERY SELECT true, 'Booking accepted successfully', p_booking_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.allocate_document_number(p_series_kind document_series_kind, p_issuer_kind document_issuer_kind, p_issuer_id uuid, p_financial_year text, p_prefix text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
declare
  v_serial bigint;
  v_prefix text;
  v_number text;
  v_budget bigint;
begin
  -- Create the counter for this (kind, issuer, year) if this is the first document of the year,
  -- SEEDED from the documents already present in the series rather than from 1.
  --
  -- The seed is the cheap half of the wedge fix. A counter that starts at 1 behind a backfilled
  -- document collides on its very first allocation, and on every allocation after it. Guarded by
  -- the existence check so the seeding scan runs once per owner per year rather than on every
  -- issue; ON CONFLICT DO NOTHING still covers the race, where a concurrent first issue wins and
  -- this statement waits for it and then does nothing. A select-then-insert without the ON CONFLICT
  -- would race into a unique violation here.
  if not exists (
    select 1 from public.document_series
     where series_kind    = p_series_kind
       and issuer_kind    = p_issuer_kind
       and issuer_id      = p_issuer_id
       and financial_year = p_financial_year
  ) then
    insert into public.document_series
      (series_kind, issuer_kind, issuer_id, financial_year, prefix, next_number)
    values
      (p_series_kind, p_issuer_kind, p_issuer_id, p_financial_year, p_prefix,
       public.next_free_document_serial(
         p_series_kind, p_issuer_kind, p_issuer_id, p_financial_year, p_prefix))
    on conflict on constraint document_series_scope_key do nothing;
  end if;

  -- THE serialisation point. The row-level lock this UPDATE takes is held until this transaction
  -- commits or aborts, so a concurrent allocation for the SAME owner blocks here and then reads the
  -- incremented value; an allocation for a DIFFERENT owner touches a different row and is unaffected.
  -- RETURNING sees post-update values, so `next_number - 1` is the serial just handed out.
  --
  -- Note the prefix comes from the STORED row, not from p_prefix: the format of a series in flight
  -- is frozen at its first document. Passing a different prefix later is ignored rather than
  -- silently splitting one year's numbering into two shapes.
  update public.document_series
     set next_number    = next_number + 1,
         last_issued_at = now()
   where series_kind    = p_series_kind
     and issuer_kind    = p_issuer_kind
     and issuer_id      = p_issuer_id
     and financial_year = p_financial_year
  returning next_number - 1, prefix into v_serial, v_prefix;

  if v_serial is null then
    -- Unreachable while the insert above is in place. If it ever happens, failing is the only safe
    -- move: issuing a document with no counter behind it means the next one collides with it.
    raise exception 'No document series for % / % / % / %',
      p_series_kind, p_issuer_kind, p_issuer_id, p_financial_year
      using errcode = 'internal_error';
  end if;

  v_number := coalesce(v_prefix || '/', '') || p_financial_year || '/' || v_serial::text;

  -- Rule 46(b), enforced before the number can reach a document.
  --
  -- 🔴 THIS IS A CEILING, NOT A HICCUP, and the comment here used to say otherwise — it claimed the
  -- series "simply refuses to advance until the owner's prefix is shortened", which is not a remedy
  -- because there is NO product path to shorten a prefix, and editing document_series.prefix by
  -- hand would break the frozen-format invariant the whole series depends on. What actually happens
  -- is: the transaction aborts, the increment rolls back so no number is burnt, and then the very
  -- next attempt allocates the same too-long serial and fails identically. The party is locked out
  -- until 1 April.
  --
  -- The real defence is upstream — prefixes are capped at 2 characters (see document_series.prefix),
  -- which buys 99,999 documents per owner per financial year instead of the 999 a 4-character
  -- prefix allowed, and 999 is a number an ordinary fleet reaches. This raise is what happens if
  -- that budget is somehow exhausted anyway, so it reports as program_limit_exceeded and names the
  -- remedy — a SECOND series, which Rule 46(b) expressly permits — instead of surfacing as an
  -- anonymous check_violation the service layer can only turn into a 500.
  if v_number !~ '^[A-Za-z0-9/-]{1,16}$' then
    v_budget := case
                  when v_prefix is null then (10 ^ (16 - (length(p_financial_year) + 1)))::bigint - 1
                  else (10 ^ (16 - (length(v_prefix) + 1) - (length(p_financial_year) + 1)))::bigint - 1
                end;
    raise exception
      'Document series % for % (financial year %) is exhausted: % numbers is its whole budget with prefix %, and serial % no longer fits the Rule 46(b) 16-character limit. Open a SECOND series — Rule 46(b) permits multiple — because this one cannot be renumbered or reshaped mid-year.',
      p_series_kind, p_issuer_id, p_financial_year, v_budget, coalesce(v_prefix, '(none)'), v_serial
      using errcode = 'program_limit_exceeded';
  end if;

  return v_number;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.complete_trip(p_trip_id uuid, p_distance_km numeric DEFAULT NULL::numeric)
 RETURNS TABLE(success boolean, message text)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_trip_record public.trips%ROWTYPE;
  v_duration_minutes INT;
BEGIN
  -- Fetch trip
  SELECT * INTO v_trip_record
  FROM public.trips
  WHERE id = p_trip_id AND status = 'active';

  IF v_trip_record.id IS NULL THEN
    RETURN QUERY SELECT false, 'Trip not found or not active';
    RETURN;
  END IF;

  -- Calculate duration
  v_duration_minutes := EXTRACT(EPOCH FROM (NOW() - v_trip_record.start_time)) / 60;

  -- Update trip
  UPDATE public.trips
  SET
    status = 'completed',
    end_time = NOW(),
    distance_km = COALESCE(p_distance_km, distance_km),
    duration_minutes = v_duration_minutes,
    updated_at = NOW()
  WHERE id = p_trip_id;

  -- Update booking status
  UPDATE public.bookings
  SET status = 'completed', updated_at = NOW()
  WHERE id = v_trip_record.booking_id;

  -- Update driver stats
  UPDATE public.drivers
  SET
    total_trips = total_trips + 1,
    total_distance_km = total_distance_km + COALESCE(p_distance_km, 0),
    updated_at = NOW()
  WHERE id = v_trip_record.driver_id;

  RETURN QUERY SELECT true, 'Trip completed successfully';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.handle_new_driver()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.role = 'driver' THEN
    INSERT INTO public.drivers (user_id)
    VALUES (NEW.id)
    ON CONFLICT (user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  INSERT INTO public.users (auth_id, phone_number, email, role, full_name)
  VALUES (
    NEW.id,
    NEW.phone,
    NEW.email,
    COALESCE((NEW.raw_user_meta_data->>'role')::public.user_role, 'shipper'),
    NEW.raw_user_meta_data->>'full_name'
  )
  ON CONFLICT (auth_id) DO NOTHING;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.handle_user_metadata_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF OLD.raw_user_meta_data IS DISTINCT FROM NEW.raw_user_meta_data THEN
    UPDATE public.users
    SET
      full_name = COALESCE(
        NULLIF(NEW.raw_user_meta_data->>'full_name', ''),
        full_name
      ),
      role = COALESCE(
        NULLIF(NEW.raw_user_meta_data->>'role', '')::public.user_role,
        role
      )
    WHERE auth_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.handle_user_role_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.role = 'driver' AND (OLD.role IS NULL OR OLD.role != 'driver') THEN
    INSERT INTO public.drivers (user_id)
    VALUES (NEW.id)
    ON CONFLICT (user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.indian_financial_year(p_at timestamp with time zone)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
AS $function$
declare
  v_local date;
  v_start integer;
begin
  v_local := (p_at at time zone 'Asia/Kolkata')::date;
  v_start := case when extract(month from v_local) >= 4
                  then extract(year from v_local)
                  else extract(year from v_local) - 1
             end;
  -- '2026-27'. The two-digit tail is modulo 100 and zero-padded, so 1999 renders '1999-00' rather
  -- than '1999-0' and the ^[0-9]{4}-[0-9]{2}$ constraint holds at the century boundary.
  return v_start::text || '-' || lpad(((v_start + 1) % 100)::text, 2, '0');
end;
$function$
;

CREATE OR REPLACE FUNCTION public.issue_freight_invoice(p_booking_id uuid, p_supplier_user_id uuid, p_prefix text, p_payload jsonb)
 RETURNS freight_invoices
 LANGUAGE plpgsql
AS $function$
declare
  v_row      public.freight_invoices;
  v_existing public.freight_invoices;
  v_fy       text;
  v_number   text;
  v_attempt  integer := 0;
begin
  select * into v_existing from public.freight_invoices where booking_id = p_booking_id;
  if found then
    return v_existing;
  end if;

  v_fy := public.indian_financial_year(now());

  -- Same bounded retry as issue_lorry_receipt, for the same reason: a booking collision returns the
  -- winner's document, a NUMBER collision heals the counter and goes round again. See the long note
  -- there and on sync_document_series_counter.
  loop
    v_attempt := v_attempt + 1;
    begin

      -- 'shipper' as the issuer kind, NOT 'fleet_owner'. The two series are independent by design: the
      -- carrier's LR count and the shipper's invoice count have nothing to do with each other, and
      -- sharing a counter would make one party's document volume visible in the other's numbering.
      v_number := public.allocate_document_number('invoice', 'shipper', p_supplier_user_id, v_fy, p_prefix);

      insert into public.freight_invoices (
        booking_id, invoice_number, series_id, financial_year,
        supplier_user_id, supplier_legal_name, supplier_gstin, supplier_address,
        billed_to_name, billed_to_gstin, billed_to_address, billed_to_state, billed_to_state_code,
        shipped_to_name, shipped_to_gstin, shipped_to_address, shipped_to_state, shipped_to_state_code,
        place_of_supply_state, place_of_supply_code, reverse_charge,
        taxable_value_inr, cgst_inr, sgst_inr, utgst_inr, igst_inr, cess_inr, exempt_value_inr,
        tcs_inr, round_off_inr, grand_total_inr,
        lr_number, eway_bill_number, irn, ack_no, ack_date
      )
      select
        p_booking_id, v_number, s.id, v_fy,
        p_supplier_user_id,
        p_payload ->> 'supplier_legal_name',
        p_payload ->> 'supplier_gstin',
        p_payload ->> 'supplier_address',
        p_payload ->> 'billed_to_name',
        p_payload ->> 'billed_to_gstin',
        p_payload ->> 'billed_to_address',
        p_payload ->> 'billed_to_state',
        p_payload ->> 'billed_to_state_code',
        p_payload ->> 'shipped_to_name',
        p_payload ->> 'shipped_to_gstin',
        p_payload ->> 'shipped_to_address',
        p_payload ->> 'shipped_to_state',
        p_payload ->> 'shipped_to_state_code',
        p_payload ->> 'place_of_supply_state',
        p_payload ->> 'place_of_supply_code',
        coalesce((p_payload ->> 'reverse_charge')::boolean, false),
        (p_payload ->> 'taxable_value_inr')::numeric,
        coalesce((p_payload ->> 'cgst_inr')::numeric,         0),
        coalesce((p_payload ->> 'sgst_inr')::numeric,         0),
        coalesce((p_payload ->> 'utgst_inr')::numeric,        0),
        coalesce((p_payload ->> 'igst_inr')::numeric,         0),
        coalesce((p_payload ->> 'cess_inr')::numeric,         0),
        coalesce((p_payload ->> 'exempt_value_inr')::numeric, 0),
        coalesce((p_payload ->> 'tcs_inr')::numeric,          0),
        coalesce((p_payload ->> 'round_off_inr')::numeric,    0),
        (p_payload ->> 'grand_total_inr')::numeric,
        p_payload ->> 'lr_number',
        p_payload ->> 'eway_bill_number',
        p_payload ->> 'irn',
        p_payload ->> 'ack_no',
        (p_payload ->> 'ack_date')::timestamptz
      from public.document_series s
      where s.series_kind    = 'invoice'
        and s.issuer_kind    = 'shipper'
        and s.issuer_id      = p_supplier_user_id
        and s.financial_year = v_fy
      returning * into v_row;

      if v_row.id is null then
        raise exception 'Freight invoice insert wrote no row for booking % (series shipper / %)',
          p_booking_id, v_fy
          using errcode = 'internal_error';
      end if;

      return v_row;

    exception
      when unique_violation then
        select * into v_existing from public.freight_invoices where booking_id = p_booking_id;
        if found then
          return v_existing;
        end if;

        if v_attempt >= 3 then
          raise;
        end if;
        perform public.sync_document_series_counter('invoice', 'shipper', p_supplier_user_id, v_fy);
    end;
  end loop;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.issue_lorry_receipt(p_booking_id uuid, p_issuer_kind document_issuer_kind, p_issuer_id uuid, p_prefix text, p_payload jsonb)
 RETURNS lorry_receipts
 LANGUAGE plpgsql
AS $function$
declare
  v_row      public.lorry_receipts;
  v_existing public.lorry_receipts;
  v_fy       text;
  v_number   text;
  v_attempt  integer := 0;
begin
  -- Already issued? Return it untouched. A document is never renumbered and never reissued with
  -- different contents — a retried request, a double-tapped button and a saga replay all have to
  -- converge on the ONE document the consignee is holding.
  select * into v_existing from public.lorry_receipts where booking_id = p_booking_id;
  if found then
    return v_existing;
  end if;

  v_fy := public.indian_financial_year(now());

  -- BOUNDED RETRY. There are exactly two ways the insert below can raise a unique violation, and
  -- they need opposite answers:
  --
  --   booking_id  — another request issued this booking's LR while we were working. Return theirs.
  --   lr_number   — the counter was behind a document that already exists (a backfill, an ops
  --                 script). Heal the counter and go round again. Re-raising here instead is what
  --                 made this a permanent 500: the handler's rollback also discards the counter
  --                 increment, so the next request allocates the identical colliding number.
  --
  -- Three attempts, because one heal moves the counter past EVERY number in the series. A second
  -- collision means something is writing documents concurrently outside the allocator, and spinning
  -- on that would hide it.
  loop
    v_attempt := v_attempt + 1;
    begin

      v_number := public.allocate_document_number('lr', p_issuer_kind, p_issuer_id, v_fy, p_prefix);

      insert into public.lorry_receipts (
        booking_id, lr_number, series_id, financial_year,
        issuer_kind, issuer_id, issuer_legal_name, issuer_transporter_id, issuer_pan, issuer_address,
        consignor_name, consignor_gstin, consignor_pan, consignor_address,
        consignee_name, consignee_gstin, consignee_address,
        origin_place, destination_place, delivery_address,
        vehicle_number, articles_count,
        actual_weight_kg, charged_weight_kg, rate_inr, rate_type, said_to_contain, sac_code,
        freight_charge_inr, stationary_charge_inr, handling_charge_inr, other_charge_inr,
        freight_term, delivery_mode, loading_by, unloading_by,
        place_of_supply_state, place_of_supply_code, reverse_charge, carriage_risk,
        invoice_number, invoice_value_inr, eway_bill_number
      )
      select
        p_booking_id, v_number, s.id, v_fy,
        p_issuer_kind, p_issuer_id,
        p_payload ->> 'issuer_legal_name',
        p_payload ->> 'issuer_transporter_id',
        p_payload ->> 'issuer_pan',
        p_payload ->> 'issuer_address',
        p_payload ->> 'consignor_name',
        p_payload ->> 'consignor_gstin',
        p_payload ->> 'consignor_pan',
        p_payload ->> 'consignor_address',
        p_payload ->> 'consignee_name',
        p_payload ->> 'consignee_gstin',
        p_payload ->> 'consignee_address',
        p_payload ->> 'origin_place',
        p_payload ->> 'destination_place',
        p_payload ->> 'delivery_address',
        p_payload ->> 'vehicle_number',
        (p_payload ->> 'articles_count')::integer,
        (p_payload ->> 'actual_weight_kg')::numeric,
        (p_payload ->> 'charged_weight_kg')::numeric,
        (p_payload ->> 'rate_inr')::numeric,
        p_payload ->> 'rate_type',
        p_payload ->> 'said_to_contain',
        coalesce(p_payload ->> 'sac_code', '996511'),
        coalesce((p_payload ->> 'freight_charge_inr')::numeric,    0),
        coalesce((p_payload ->> 'stationary_charge_inr')::numeric, 0),
        coalesce((p_payload ->> 'handling_charge_inr')::numeric,   0),
        coalesce((p_payload ->> 'other_charge_inr')::numeric,      0),
        (p_payload ->> 'freight_term')::public.freight_term,
        (p_payload ->> 'delivery_mode')::public.delivery_mode,
        p_payload ->> 'loading_by',
        p_payload ->> 'unloading_by',
        p_payload ->> 'place_of_supply_state',
        p_payload ->> 'place_of_supply_code',
        coalesce((p_payload ->> 'reverse_charge')::boolean, true),
        coalesce(p_payload ->> 'carriage_risk', 'owners_risk'),
        p_payload ->> 'invoice_number',
        (p_payload ->> 'invoice_value_inr')::numeric,
        p_payload ->> 'eway_bill_number'
      from public.document_series s
      where s.series_kind    = 'lr'
        and s.issuer_kind    = p_issuer_kind
        and s.issuer_id      = p_issuer_id
        and s.financial_year = v_fy
      returning * into v_row;

      -- The INSERT ... SELECT writes nothing if the series row is missing, which would silently return
      -- a null row and lose the allocated number. It cannot happen (the allocator just wrote that row in
      -- this transaction), so if it does, the series table has been tampered with mid-transaction and
      -- aborting is the only answer that keeps the numbering trustworthy.
      if v_row.id is null then
        raise exception 'Lorry receipt insert wrote no row for booking % (series % / %)',
          p_booking_id, p_issuer_kind, v_fy
          using errcode = 'internal_error';
      end if;

      return v_row;

    -- Catching HERE is what keeps the series gapless: the exception rolls this block's implicit
    -- subtransaction back, and the losing counter increment goes with it, so the number it
    -- allocated is handed to the next caller instead of vanishing.
    exception
      when unique_violation then
        -- The concurrent-first-issue case: two requests for the same booking, both past the
        -- existence check above, both allocating, one losing on lorry_receipts.booking_id. The
        -- loser returns the winner's document, which is what the client wanted anyway.
        select * into v_existing from public.lorry_receipts where booking_id = p_booking_id;
        if found then
          return v_existing;
        end if;

        -- Not the booking: the NUMBER collided. Heal the counter past what is already in the
        -- series and try again. Without this the series is wedged for the rest of the year.
        if v_attempt >= 3 then
          raise;
        end if;
        perform public.sync_document_series_counter('lr', p_issuer_kind, p_issuer_id, v_fy);
    end;
  end loop;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.next_free_document_serial(p_series_kind document_series_kind, p_issuer_kind document_issuer_kind, p_issuer_id uuid, p_financial_year text, p_prefix text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
AS $function$
declare
  v_pattern text;
  v_max     bigint;
begin
  v_pattern := '^' || coalesce(p_prefix || '/', '') || p_financial_year || '/[0-9]+$';

  if p_series_kind = 'lr' then
    select max((regexp_replace(lr_number, '^.*/', ''))::bigint)
      into v_max
      from public.lorry_receipts
     where issuer_kind    = p_issuer_kind
       and issuer_id      = p_issuer_id
       and financial_year = p_financial_year
       and lr_number ~ v_pattern;
  else
    -- freight_invoices has no issuer_kind: the supplier IS the shipper, keyed by supplier_user_id.
    select max((regexp_replace(invoice_number, '^.*/', ''))::bigint)
      into v_max
      from public.freight_invoices
     where supplier_user_id = p_issuer_id
       and financial_year   = p_financial_year
       and invoice_number ~ v_pattern;
  end if;

  return coalesce(v_max, 0) + 1;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.start_trip(p_booking_id uuid)
 RETURNS TABLE(success boolean, message text, trip_id uuid)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_trip_id UUID;
  v_booking_record public.bookings%ROWTYPE;
BEGIN
  -- Fetch booking
  SELECT * INTO v_booking_record
  FROM public.bookings
  WHERE id = p_booking_id AND status = 'accepted';

  IF v_booking_record.id IS NULL THEN
    RETURN QUERY SELECT false, 'Booking not found or not accepted', NULL::UUID;
    RETURN;
  END IF;

  -- Create trip
  INSERT INTO public.trips (booking_id, driver_id, status, start_time)
  VALUES (p_booking_id, v_booking_record.driver_id, 'active', NOW())
  RETURNING id INTO v_trip_id;

  -- Update booking status
  UPDATE public.bookings
  SET status = 'in_transit', updated_at = NOW()
  WHERE id = p_booking_id;

  RETURN QUERY SELECT true, 'Trip started successfully', v_trip_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.sync_document_series_counter(p_series_kind document_series_kind, p_issuer_kind document_issuer_kind, p_issuer_id uuid, p_financial_year text)
 RETURNS bigint
 LANGUAGE plpgsql
AS $function$
declare
  v_prefix text;
  v_free   bigint;
  v_next   bigint;
begin
  select prefix into v_prefix
    from public.document_series
   where series_kind    = p_series_kind
     and issuer_kind    = p_issuer_kind
     and issuer_id      = p_issuer_id
     and financial_year = p_financial_year;

  if not found then
    return null;
  end if;

  v_free := public.next_free_document_serial(
    p_series_kind, p_issuer_kind, p_issuer_id, p_financial_year, v_prefix);

  update public.document_series
     set next_number = greatest(next_number, v_free)
   where series_kind    = p_series_kind
     and issuer_kind    = p_issuer_kind
     and issuer_id      = p_issuer_id
     and financial_year = p_financial_year
  returning next_number into v_next;

  return v_next;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.update_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$
;


-- =====================================================================================
-- 9. TRIGGERS
-- =====================================================================================

CREATE TRIGGER bank_accounts_updated_at BEFORE UPDATE ON public.bank_accounts FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trigger_bookings_updated_at BEFORE UPDATE ON public.bookings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER driver_insurance_updated_at BEFORE UPDATE ON public.driver_insurance FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER driver_licenses_updated_at BEFORE UPDATE ON public.driver_licenses FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trigger_drivers_updated_at BEFORE UPDATE ON public.drivers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trigger_eway_bills_updated_at BEFORE UPDATE ON public.eway_bills FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER payments_updated_at BEFORE UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER support_tickets_updated_at BEFORE UPDATE ON public.support_tickets FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trip_routes_updated_at BEFORE UPDATE ON public.trip_routes FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trigger_trips_updated_at BEFORE UPDATE ON public.trips FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER user_settings_updated_at BEFORE UPDATE ON public.user_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER on_user_created_ensure_driver AFTER INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION handle_new_driver();
CREATE TRIGGER on_user_role_updated AFTER UPDATE OF role ON public.users FOR EACH ROW EXECUTE FUNCTION handle_user_role_update();
CREATE TRIGGER trigger_users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER vehicles_updated_at BEFORE UPDATE ON public.vehicles FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- =====================================================================================
-- 10. VIEWS
-- =====================================================================================

CREATE VIEW public.v_active_bookings_with_driver AS SELECT b.id,
    b.shipper_id,
    b.shipper_name,
    b.shipper_contact,
    b.source_address,
    b.destination_address,
    b.load_type,
    b.weight_kg,
    b.quoted_price,
    b.final_price,
    b.status,
    b.pickup_date,
    d.id AS driver_id,
    u.full_name AS driver_name,
    u.phone_number AS driver_phone,
    d.truck_number,
    d.truck_type,
    d.average_rating,
    b.created_at,
    b.updated_at
   FROM bookings b
     LEFT JOIN drivers d ON b.driver_id = d.id
     LEFT JOIN users u ON d.user_id = u.id
  WHERE b.status = ANY (ARRAY['pending'::booking_status, 'accepted'::booking_status, 'in_transit'::booking_status]);

CREATE VIEW public.v_trip_summary AS SELECT t.id,
    t.booking_id,
    t.driver_id,
    u.full_name AS driver_name,
    d.truck_number,
    b.shipper_name,
    b.source_address,
    b.destination_address,
    t.status,
    t.start_time,
    t.end_time,
    t.distance_km,
    t.duration_minutes,
    t.average_speed_kmph,
    count(DISTINCT tl.id) AS location_points,
    max(tl.created_at) AS last_location_update
   FROM trips t
     LEFT JOIN drivers d ON t.driver_id = d.id
     LEFT JOIN users u ON d.user_id = u.id
     LEFT JOIN bookings b ON t.booking_id = b.id
     LEFT JOIN trip_locations tl ON t.id = tl.trip_id
  GROUP BY t.id, t.booking_id, t.driver_id, u.full_name, d.truck_number, b.shipper_name, b.source_address, b.destination_address;


-- =====================================================================================
-- 11. ROW LEVEL SECURITY
-- =====================================================================================
-- Every table has RLS ENABLED. Tables with no policy below are reachable only by
-- service_role (which bypasses RLS); the `USING (true)` policies are the ones that expose
-- data to anon/authenticated, so read those carefully.

ALTER TABLE public.bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diesel_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispatch_tracker_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_extractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_insurance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eway_bill_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eway_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fleet_cost_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fleet_drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fleet_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fleet_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_cities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_lane_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_market_rate_by_class ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fuel_estimates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.geofence_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.geofences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kyc_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.location_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lorry_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.negotiations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ops_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.persona_acknowledgements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pmo_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pmo_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pmo_blockers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pmo_docs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pmo_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pmo_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pmo_milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pmo_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pmo_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pmo_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pod_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pod_discrepancies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pod_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pod_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pod_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.route_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_lanes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_economics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_telemetry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trips ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_kyc ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_cost_norms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_finance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_lanes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_permits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_service_cost_by_age ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;

-- Policies:
CREATE POLICY "Drivers can accept bookings" ON public.bookings AS PERMISSIVE FOR UPDATE TO public USING (((EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.auth_id = auth.uid()) AND (u.role = 'driver'::user_role)))) AND (status = 'pending'::booking_status))) WITH CHECK (((driver_id IN ( SELECT d.id
   FROM drivers d
  WHERE (d.user_id IN ( SELECT users.id
           FROM users
          WHERE (users.auth_id = auth.uid()))))) AND (status = 'accepted'::booking_status)));
CREATE POLICY "Drivers can view accepted bookings assigned to them" ON public.bookings AS PERMISSIVE FOR SELECT TO public USING (((driver_id IN ( SELECT d.id
   FROM drivers d
  WHERE (d.user_id IN ( SELECT users.id
           FROM users
          WHERE (users.auth_id = auth.uid()))))) AND (status = ANY (ARRAY['accepted'::booking_status, 'in_transit'::booking_status, 'completed'::booking_status]))));
CREATE POLICY "Drivers can view pending bookings" ON public.bookings AS PERMISSIVE FOR SELECT TO public USING (((EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.auth_id = auth.uid()) AND (u.role = 'driver'::user_role)))) AND (status = 'pending'::booking_status)));
CREATE POLICY "Shippers can insert bookings" ON public.bookings AS PERMISSIVE FOR INSERT TO public WITH CHECK ((shipper_id IN ( SELECT users.id
   FROM users
  WHERE (users.auth_id = auth.uid()))));
CREATE POLICY "Shippers can update own pending bookings" ON public.bookings AS PERMISSIVE FOR UPDATE TO public USING (((shipper_id IN ( SELECT users.id
   FROM users
  WHERE (users.auth_id = auth.uid()))) AND (status = 'pending'::booking_status)));
CREATE POLICY "Shippers can view own bookings" ON public.bookings AS PERMISSIVE FOR SELECT TO public USING ((shipper_id IN ( SELECT users.id
   FROM users
  WHERE (users.auth_id = auth.uid()))));
CREATE POLICY tracker_anon_delete ON public.dispatch_tracker_status AS PERMISSIVE FOR DELETE TO anon USING (true);
CREATE POLICY tracker_anon_insert ON public.dispatch_tracker_status AS PERMISSIVE FOR INSERT TO anon WITH CHECK ((status = ANY (ARRAY['todo'::text, 'doing'::text, 'blocked'::text, 'done'::text])));
CREATE POLICY tracker_anon_select ON public.dispatch_tracker_status AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY tracker_anon_update ON public.dispatch_tracker_status AS PERMISSIVE FOR UPDATE TO anon USING (true) WITH CHECK ((status = ANY (ARRAY['todo'::text, 'doing'::text, 'blocked'::text, 'done'::text])));
CREATE POLICY "Authenticated users can view all drivers" ON public.drivers AS PERMISSIVE FOR SELECT TO public USING ((auth.role() = 'authenticated'::text));
CREATE POLICY "Drivers can update own profile" ON public.drivers AS PERMISSIVE FOR UPDATE TO public USING ((user_id IN ( SELECT users.id
   FROM users
  WHERE (users.auth_id = auth.uid())))) WITH CHECK ((user_id IN ( SELECT users.id
   FROM users
  WHERE (users.auth_id = auth.uid()))));
CREATE POLICY "Drivers can view eway bills for accepted bookings" ON public.eway_bills AS PERMISSIVE FOR SELECT TO public USING ((booking_id IN ( SELECT bookings.id
   FROM bookings
  WHERE (bookings.driver_id IN ( SELECT d.id
           FROM drivers d
          WHERE (d.user_id IN ( SELECT users.id
                   FROM users
                  WHERE (users.auth_id = auth.uid()))))))));
CREATE POLICY "Shippers can create eway bills for own bookings" ON public.eway_bills AS PERMISSIVE FOR INSERT TO public WITH CHECK ((booking_id IN ( SELECT bookings.id
   FROM bookings
  WHERE (bookings.shipper_id IN ( SELECT users.id
           FROM users
          WHERE (users.auth_id = auth.uid()))))));
CREATE POLICY "Shippers can view eway bills for own bookings" ON public.eway_bills AS PERMISSIVE FOR SELECT TO public USING ((booking_id IN ( SELECT bookings.id
   FROM bookings
  WHERE (bookings.shipper_id IN ( SELECT users.id
           FROM users
          WHERE (users.auth_id = auth.uid()))))));
CREATE POLICY "Users can update own notifications" ON public.notifications AS PERMISSIVE FOR UPDATE TO public USING ((user_id IN ( SELECT users.id
   FROM users
  WHERE (users.auth_id = auth.uid())))) WITH CHECK ((user_id IN ( SELECT users.id
   FROM users
  WHERE (users.auth_id = auth.uid()))));
CREATE POLICY "Users can view own notifications" ON public.notifications AS PERMISSIVE FOR SELECT TO public USING ((user_id IN ( SELECT users.id
   FROM users
  WHERE (users.auth_id = auth.uid()))));
CREATE POLICY pmo_activity_anon_all ON public.pmo_activity AS PERMISSIVE FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY pmo_attachments_anon_all ON public.pmo_attachments AS PERMISSIVE FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY pmo_blockers_anon_all ON public.pmo_blockers AS PERMISSIVE FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY pmo_docs_anon_all ON public.pmo_docs AS PERMISSIVE FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY pmo_items_anon_all ON public.pmo_items AS PERMISSIVE FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY pmo_members_anon_all ON public.pmo_members AS PERMISSIVE FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY pmo_milestones_anon_all ON public.pmo_milestones AS PERMISSIVE FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY pmo_projects_anon_all ON public.pmo_projects AS PERMISSIVE FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY pmo_services_anon_all ON public.pmo_services AS PERMISSIVE FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY pmo_users_anon_all ON public.pmo_users AS PERMISSIVE FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Drivers can insert location data for own trips" ON public.trip_locations AS PERMISSIVE FOR INSERT TO public WITH CHECK ((driver_id IN ( SELECT d.id
   FROM drivers d
  WHERE (d.user_id IN ( SELECT users.id
           FROM users
          WHERE (users.auth_id = auth.uid()))))));
CREATE POLICY "Drivers can view own location history" ON public.trip_locations AS PERMISSIVE FOR SELECT TO public USING ((driver_id IN ( SELECT d.id
   FROM drivers d
  WHERE (d.user_id IN ( SELECT users.id
           FROM users
          WHERE (users.auth_id = auth.uid()))))));
CREATE POLICY "Shippers can view location history for own bookings" ON public.trip_locations AS PERMISSIVE FOR SELECT TO public USING ((booking_id IN ( SELECT bookings.id
   FROM bookings
  WHERE (bookings.shipper_id IN ( SELECT users.id
           FROM users
          WHERE (users.auth_id = auth.uid()))))));
CREATE POLICY "Drivers can manage own trips" ON public.trips AS PERMISSIVE FOR ALL TO public USING ((driver_id IN ( SELECT d.id
   FROM drivers d
  WHERE (d.user_id IN ( SELECT users.id
           FROM users
          WHERE (users.auth_id = auth.uid())))))) WITH CHECK ((driver_id IN ( SELECT d.id
   FROM drivers d
  WHERE (d.user_id IN ( SELECT users.id
           FROM users
          WHERE (users.auth_id = auth.uid()))))));
CREATE POLICY "Shippers can view trips for their bookings" ON public.trips AS PERMISSIVE FOR SELECT TO public USING ((booking_id IN ( SELECT bookings.id
   FROM bookings
  WHERE (bookings.shipper_id IN ( SELECT users.id
           FROM users
          WHERE (users.auth_id = auth.uid()))))));
CREATE POLICY "Users can update own profile" ON public.users AS PERMISSIVE FOR UPDATE TO public USING ((auth.uid() = auth_id)) WITH CHECK ((auth.uid() = auth_id));
CREATE POLICY "Users can view own profile" ON public.users AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = auth_id));


-- =====================================================================================
-- 12. COMMENTS
-- =====================================================================================

-- Table comments:
COMMENT ON TABLE public.bookings IS 'Freight bookings/orders from shippers';
COMMENT ON TABLE public.diesel_prices IS 'Per-state, effective-dated retail diesel price reference (GST state code). Seed values are approximate and owner/ops-refreshable — the point is the state VARIATION, not a live feed.';
COMMENT ON TABLE public.document_extractions IS 'QR-scan / OCR extractions that PREFILL the freight-documents form (never the source of truth — the issued LR/invoice/e-way row is). Separate table per INDIA_FREIGHT_COMPLIANCE.md; OCR runs on a derivative, never the POD original (§5.4).';
COMMENT ON TABLE public.document_series IS 'Per-owner, per-financial-year gapless counters for LR and invoice numbers (Rule 46(b)). NEVER a platform-wide counter — that is the fact that flips the GTA analysis (INDIA_FREIGHT_COMPLIANCE section 3.3 / 1.3). Incremented only inside allocate_document_number().';
COMMENT ON TABLE public.drivers IS 'Driver-specific information and truck details';
COMMENT ON TABLE public.eway_bill_records IS 'Externally generated e-way bills, RECORDED not generated (D-17). valid_upto is copied from the portal and never recomputed — the midnight rule (section 4.4) makes any local recomputation wrong by up to a day in the dangerous direction. Several rows per booking are expected; status is what distinguishes the bill that is live from the one it replaced.';
COMMENT ON TABLE public.eway_bills IS 'GST e-way bills for shipments';
COMMENT ON TABLE public.fleet_drivers IS 'Fleet <-> existing-driver affiliation. Owner invites (pending), driver accepts (active).';
COMMENT ON TABLE public.fleet_members IS 'Delegated fleet-staff access (D-1/§7 seam). A users.id granted specific ACTION grants on a fleet_owners.id — never a role. Owner authority stays via fleet_owners.user_id; this is for non-owner delegates. Grants looked up per request.';
COMMENT ON TABLE public.fleet_owners IS 'Fleet-owner party. Owns vehicles + employs drivers; never drives, never owns a drivers row.';
COMMENT ON TABLE public.freight_invoices IS 'Shipper tax invoice. Numbered per SHIPPER per FY (a separate series from the carrier LR). consignment_value_inr is generated from the Rule 138 Explanation 2 formula and INCLUDES GST.';
COMMENT ON TABLE public.geofence_events IS 'Geofence enter/exit log. dwell_seconds is set on the exit row; an enter with no exit is an open stay. WRITE owner = bt-tracking-service evaluator.';
COMMENT ON TABLE public.geofences IS 'Fleet-defined circular geofences. Pickup/drop are implicit (derived from bookings), not rows here. WRITE owner = bt-tracking-service.';
COMMENT ON TABLE public.lorry_receipts IS 'Consignment note / lorry receipt. ISSUED BY THE CARRIER, never by the platform (red line 1). Numbering is per fleet owner per FY via document_series. Field set from INDIA_FREIGHT_COMPLIANCE.md sections 3.2 and 11.2.';
COMMENT ON TABLE public.notification_outbox IS 'Durable queue + delivery audit for async transactional email. Drained by bt-booking-service''s dispatcher. Synchronous auth/POD OTPs do NOT pass through here.';
COMMENT ON TABLE public.notification_preferences IS 'Per-user email opt-out by category. A missing row means "all defaults on" — the dispatcher never requires a row to exist.';
COMMENT ON TABLE public.notifications IS 'Push notifications for users';
COMMENT ON TABLE public.payouts IS 'Payout records, one row per PAYEE per booking. Solo trip -> the driver. Fleet trip -> the fleet owner, plus the driver when fleet_drivers.revenue_share_pct > 0 (D-7). Pilot: recorded, not transferred — the Razorpay Route disbursement (D-12) is a separate, currently inert path.';
COMMENT ON TABLE public.persona_acknowledgements IS 'Recorded self-declarations behind D-31 (KYC prompts, never gates). One row per signed acknowledgement, storing the exact versioned TEXT served (not a boolean), so the declaration is a provable artifact. Read by GET /me/completeness to flip an item to ''declared''; never gates a capability. Canonical kind->version->statement map: bt-auth-service/src/lib/acknowledgements.ts.';
COMMENT ON TABLE public.pod_audit_log IS 'Append-only POD access/export/modification trail (§5.4 rule 5). INSERT-only by construction; retained as long as the evidence. WRITE owner = bt-booking-service.';
COMMENT ON TABLE public.pod_discrepancies IS 'Structured delivery discrepancy (§5.7): server-held expected vs driver actual, typed reason, mandatory photo when delta<>0, dual NAMED driver+consignee acknowledgement (consignee_user_id NULL for an unclaimed receiver), and snapshotted 180-day (booking) / 7-day (delivery) claim-clock anchors.';
COMMENT ON TABLE public.pod_evidence IS 'POD capture evidence (camera-only, on-device SHA-256, server-authoritative time). One row per photo; (booking_id, sha256_original) is the idempotency key. WRITE owner = bt-booking-service. Originals live in WORM object storage, never re-encoded (IT Act s.7(b)).';
COMMENT ON TABLE public.pod_state IS 'Per-booking POD proof-strength ledger. pod_strength=confirmed (receiver OTP) vs asserted (evidence only, receiver absent). Written by bt-booking-service; an asserted trip closed by ops stays asserted — never upgraded.';
COMMENT ON TABLE public.price_quotes IS 'Shipper price-lock: quote SHOWN == price CHARGED (PRD 5.4). Priced route + derived distance + cargo bound to the booking at create time. Written by bt-pricing-service. consumed_at stamped once when a booking locks this quote (immutable replay guard). NOT the driver-auction quotes table.';
COMMENT ON TABLE public.saved_addresses IS 'A user''s reused pickup/drop points (D-020). Reduces the post-load form to a pick, not a re-typed address + re-dragged pin.';
COMMENT ON TABLE public.trip_economics IS 'Per-trip P&L roll-up, written once at completed->paid. The ONLY table fleet analytics reads.';
COMMENT ON TABLE public.trip_locations IS 'Real-time location history for active trips';
COMMENT ON TABLE public.trip_telemetry IS 'Per-trip rollup maintained incrementally by the bt-tracking-service evaluator. distance_m is DRIVEN distance (haversine over breadcrumbs), not the planned trip_routes.distance_m.';
COMMENT ON TABLE public.trips IS 'Active trip management for driver shipments';
COMMENT ON TABLE public.user_kyc IS 'Per-user KYC verification record (D-4). Stores document verification STATUS + a reference key, never a full ID number: Aadhaar/PAN keep only a SHA-256 hash (dedup) + last-4. KYC does not gate use (D-5/D-31).';
COMMENT ON TABLE public.users IS 'User profiles for shippers, drivers, and admins';
COMMENT ON TABLE public.vehicle_assignments IS 'Per-trip driver<->truck pairing. For fleet drivers this IS their truck history; they own no vehicle.';
COMMENT ON TABLE public.vehicle_cost_norms IS 'Per-model-category running-cost norms from the founder CV parc workbook. Reference data.';
COMMENT ON TABLE public.vehicle_finance IS 'Owner-entered EMI + fixed annual carrying costs per truck. Drives the "cleared its EMI?" score.';

-- Column comments:
COMMENT ON COLUMN public.bookings.quoted_price IS 'Price quoted to shipper in INR';
COMMENT ON COLUMN public.bookings.final_price IS 'Final price after acceptance/negotiation';
COMMENT ON COLUMN public.bookings.status IS 'Booking lifecycle status';
COMMENT ON COLUMN public.bookings.receiver_email IS 'SUPERSEDED by bookings.consignee_user_id (migration 0026 / D-22). Still the address the receiver-OTP POD code is emailed to, so it is still written on create — do not drop it until the POD flow sends to the consignee''s phone (D-26).';
COMMENT ON COLUMN public.bookings.award_path IS 'How the carrier was chosen. direct_attach = the shipper and the carrier are the same human, so the auction was skipped (D-10). The trip is otherwise identical and still gets LR, invoice, POD and settlement.';
COMMENT ON COLUMN public.bookings.consignee_user_id IS 'The receiving party (D-22), a shipper-KIND users row that may be UNCLAIMED (no credential). Matched by phone against users_phone_number_key at posting time, so an existing party is linked rather than duplicated. NULL on the 672 legacy bookings that predate the model. SUPERSEDES bookings.receiver_email, which is kept and still populated until POD is re-pointed at the consignee phone (D-26); dropping it is a later migration.';
COMMENT ON COLUMN public.bookings.pod_expected_quantity IS 'Server-held expected delivery quantity for POD discrepancy reconciliation. Set by shipper/ops only — NEVER the driver (§5.7). NULL on pre-0025 bookings.';
COMMENT ON COLUMN public.bookings.source_place_id IS 'Google place_id of the picked pickup address (D-020). NULL for hand-typed legacy bookings.';
COMMENT ON COLUMN public.bookings.source_pincode IS 'PIN code of the pickup, from place details — feeds e-way Part A fromPincode.';
COMMENT ON COLUMN public.bookings.source_state_code IS 'GST 2-digit state code of the pickup, from place details — feeds e-way Part A actFromStateCode.';
COMMENT ON COLUMN public.bookings.source_gate_lat IS 'The exact-gate pin the user DRAGGED for pickup. Distance uses source_lat/lng (the address pin); a gate pin is for geofencing/navigation. NULL = address pin is the gate.';
COMMENT ON COLUMN public.bookings.dest_gate_lat IS 'The exact-gate pin the user DRAGGED for drop. The POD geofence measures against this when present, else dest_lat/lng.';
COMMENT ON COLUMN public.drivers.truck_capacity_kg IS 'Maximum load capacity in kilograms';
COMMENT ON COLUMN public.drivers.average_rating IS 'Driver rating out of 5.0';
COMMENT ON COLUMN public.eway_bill_records.status IS 'What a PERSON did to the bill on the portal (section 4.5: cancel within 24h, reject within 72h). Never ''expired'' — expiry is derived from valid_upto and the current time, and a stored expiry flag is wrong from the next midnight onwards.';
COMMENT ON COLUMN public.eway_bill_records.status_changed_by IS 'users.id of whoever filed the cancel/reject (audit; null on rows predating 0032)';
COMMENT ON COLUMN public.eway_bills.ewb_number IS 'E-way bill unique number';
COMMENT ON COLUMN public.eway_bills.item_list IS 'JSON array of items in shipment with GST details';
COMMENT ON COLUMN public.eway_bills.status IS 'Current status of the e-way bill';
COMMENT ON COLUMN public.fleet_drivers.revenue_share_pct IS 'Share of trip freight paid to the DRIVER on fleet-won bookings, 0-100. 0 = salaried (owner keeps freight, pays via monthly_salary_inr) and is the pre-existing behaviour. Set by the fleet owner. Consumed by resolvePayees() in bt-payment-service.';
COMMENT ON COLUMN public.freight_invoices.consignment_value_inr IS 'Rule 138 Explanation 2: taxable value + CGST + SGST + UTGST + IGST + cess - exempt component. GST-INCLUSIVE. Any e-way bill threshold check on the pre-tax value is simply wrong (section 4.1).';
COMMENT ON COLUMN public.lorry_receipts.charged_weight_kg IS 'max(actual, volumetric) — the weight the freight is billed on. Distinct from actual_weight_kg by design; a single weight column cannot reproduce a real freight bill (section 11.2).';
COMMENT ON COLUMN public.negotiations.actor_role IS 'Who made this offer: shipper | driver | fleet_owner. fleet_owner added in migration 0020 — a fleet is a first-class bidder (quotes.fleet_owner_id, migration 0016) and its entries were being silently rejected before that.';
COMMENT ON COLUMN public.notifications.type IS 'Type of notification for routing and categorization';
COMMENT ON COLUMN public.notifications.data IS 'Additional metadata (e.g., booking_id, trip_id)';
COMMENT ON COLUMN public.ops_overrides.acted_for_fleet_owner_id IS 'The fleet this override was performed on behalf of (D-1/§7 delegation audit). NULL on rows predating migration 0036 or actions with no fleet context.';
COMMENT ON COLUMN public.persona_acknowledgements.kind IS 'The acknowledgement kind, e.g. ''gst_under_threshold''. Constrained to the server-owned registry in code, not by a DB check — the valid set changes with the code that serves the text, not with a migration.';
COMMENT ON COLUMN public.persona_acknowledgements.statement IS 'The exact wording the user agreed to, stored verbatim. A boolean proves nothing later; this is the artifact.';
COMMENT ON COLUMN public.pod_evidence.kind IS 'Which delivery shot this row is: signed_invoice (the signed customer invoice/LR copy), vehicle (the truck at the drop), goods, or other. NULL on legacy/generic captures. The app requires signed_invoice + vehicle at delivery; the DB records the discriminator.';
COMMENT ON COLUMN public.pod_state.fleet_review_status IS 'The fleet owner''s review of the delivery evidence: pending (awaiting review, stamped when the driver asserts/completes), approved, or rejected. NULL when no evidence review applies. Distinct from pod_strength (confirmed/asserted) and from the ops close — this is the carrier verifying its own driver''s proof.';
COMMENT ON COLUMN public.route_alerts.resolved_at IS 'NULL = still firing. Set by the evaluator when the condition clears; route_alerts_open_unique allows exactly one open row per (booking, type).';
COMMENT ON COLUMN public.trip_economics.distance_km_planned IS 'Real road distance from bt-tracking-service (trip_routes.distance_m / on-demand Routes call). NULL when tracking had no cached route and was unreachable at roll-up.';
COMMENT ON COLUMN public.trip_economics.distance_basis IS 'Which distance drove this row: measured = GPS breadcrumb trail (driven), routed = real road distance from tracking, estimated = the sold/price-lock distance (last resort). Replaces the dropped haversine x 1.3 fabrication.';
COMMENT ON COLUMN public.trip_expenses.category_code IS 'Controlled expense category (source of truth: bt-fleet-service/src/lib/expense-categories.ts). Free-text `category` is kept for display and legacy rows; the pilferage classifier keys off category_code when present.';
COMMENT ON COLUMN public.trip_locations.speed_kmph IS 'Speed at the time of location capture';
COMMENT ON COLUMN public.trip_locations.accuracy_meters IS 'GPS accuracy in meters';
COMMENT ON COLUMN public.trips.status IS 'Current trip status (active, completed, cancelled)';
COMMENT ON COLUMN public.trips.distance_km IS 'Total distance traveled in kilometers';
COMMENT ON COLUMN public.users.auth_id IS 'Foreign key to Supabase auth.users table';
COMMENT ON COLUMN public.users.kyc_status IS 'Know Your Customer verification status';
COMMENT ON COLUMN public.users.primary_persona IS 'Mirror of users.role under its post-unification name: the DEFAULT surface and the destination for emailed links. NOT an authorization axis - capability is computed from owned assets and fleet relationships (@bharattruck/shared/personas). See docs/ARCHITECTURE_UNIFIED_IDENTITY.md.';
COMMENT ON COLUMN public.users.gstin IS 'GSTIN of this party, 15 chars, uppercase, format-checked. NULL = unregistered, which renders as ''URP'' on an LR / e-way bill — the literal ''URP'' is never stored. First two digits are the GST state code and drive the intra- vs inter-state supply decision on an invoice.';
COMMENT ON COLUMN public.users.claimed_at IS 'When this human first authenticated. NULL = an UNCLAIMED party record created by someone else while posting a load — no credential, cannot be logged into, only claimed (phone OTP -> set password, which is when this is stamped). Defaults to now() so every ordinary signup path is correct without knowing about this column; only the consignee upsert passes an explicit NULL.';

-- Function comments:
COMMENT ON FUNCTION public.allocate_document_number(p_series_kind document_series_kind, p_issuer_kind document_issuer_kind, p_issuer_id uuid, p_financial_year text, p_prefix text) IS 'Allocates the next gapless serial for one owner and financial year. MUST be called inside the same transaction that persists the document row — see the note on document_series. A new counter is SEEDED from the documents already in the series so a backfill cannot lock it.';
COMMENT ON FUNCTION public.indian_financial_year(p_at timestamp with time zone) IS 'Indian financial year label (1 April - 31 March) evaluated in Asia/Kolkata, e.g. 2026-27.';
COMMENT ON FUNCTION public.issue_freight_invoice(p_booking_id uuid, p_supplier_user_id uuid, p_prefix text, p_payload jsonb) IS 'Allocates an invoice number on the SHIPPER''s own per-FY series and persists the tax invoice in ONE transaction. Idempotent per booking.';
COMMENT ON FUNCTION public.issue_lorry_receipt(p_booking_id uuid, p_issuer_kind document_issuer_kind, p_issuer_id uuid, p_prefix text, p_payload jsonb) IS 'Allocates an LR number and persists the consignment note in ONE transaction. Idempotent per booking: an already-issued LR is returned unchanged, never renumbered.';
COMMENT ON FUNCTION public.next_free_document_serial(p_series_kind document_series_kind, p_issuer_kind document_issuer_kind, p_issuer_id uuid, p_financial_year text, p_prefix text) IS 'First serial that cannot collide with a document already in this series. Counts only numbers in the shape this allocator generates, so a differently-shaped backfilled number does not skip serials.';
COMMENT ON FUNCTION public.sync_document_series_counter(p_series_kind document_series_kind, p_issuer_kind document_issuer_kind, p_issuer_id uuid, p_financial_year text) IS 'Advances a series counter past every document already issued in it. Called from the issue_* unique-violation handlers so a counter that has fallen behind self-heals instead of locking the party out for the rest of the financial year. Never decrements.';


-- =====================================================================================
-- 13. GRANTS
-- =====================================================================================
-- This section records reality, including the parts of it that are findings rather than
-- decisions. Nothing here has been tidied up.
--
-- TABLES. Every one of the 77 relations in `public` (75 tables + 2 views) grants the full
-- set — SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER — to `anon`,
-- `authenticated` and `service_role`. There is not a single exception, so rather than
-- one identical GRANT per relation:
--
--   GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
--
-- That is the Supabase default-privilege posture for `public`, not something this project
-- chose per table. It is why RLS (section 11) is doing all the load-bearing work, and why
-- the RLS-enabled-but-policy-less tables are safe while the `USING (true)` ones are not.

GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;

-- FUNCTIONS. These are NOT uniform, and the differences are deliberate.
--
-- (a) The four trigger functions have EXECUTE revoked from PUBLIC and are executable only
--     by `postgres` and `service_role`. They are SECURITY DEFINER, so this matters.
REVOKE ALL ON FUNCTION public.handle_new_driver() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.handle_user_metadata_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.handle_user_role_update() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.handle_new_driver() TO service_role;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;
GRANT EXECUTE ON FUNCTION public.handle_user_metadata_update() TO service_role;
GRANT EXECUTE ON FUNCTION public.handle_user_role_update() TO service_role;

-- (b) The five document-numbering functions are now EXECUTE-revoked from PUBLIC AND from
--     `anon`/`authenticated` — only `postgres` and `service_role` can call them. This is
--     the fix the 2026-08-07 baseline flagged as an open finding: migration
--     0027_document_function_acls.sql (which strips the anon/authenticated grants that
--     `issue_lorry_receipt` and `issue_freight_invoice` — which burn a number off a legally
--     gapless series — used to carry) HAS been applied. The exposure is closed.
REVOKE ALL ON FUNCTION public.allocate_document_number(document_series_kind, document_issuer_kind, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.next_free_document_serial(document_series_kind, document_issuer_kind, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_document_series_counter(document_series_kind, document_issuer_kind, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.issue_lorry_receipt(uuid, document_issuer_kind, uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.issue_freight_invoice(uuid, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.allocate_document_number(document_series_kind, document_issuer_kind, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.next_free_document_serial(document_series_kind, document_issuer_kind, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.sync_document_series_counter(document_series_kind, document_issuer_kind, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.issue_lorry_receipt(uuid, document_issuer_kind, uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.issue_freight_invoice(uuid, uuid, text, jsonb) TO service_role;

-- (c) The remaining six functions keep the PostgreSQL default (EXECUTE to PUBLIC) plus
--     the Supabase default explicit grants.
GRANT EXECUTE ON FUNCTION public.accept_booking(uuid, uuid) TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_trip(uuid, numeric) TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.start_trip(uuid) TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.indian_financial_year(timestamp with time zone) TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_updated_at() TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_updated_at_column() TO PUBLIC, anon, authenticated, service_role;

-- =====================================================================================
-- END OF BASELINE
-- =====================================================================================
