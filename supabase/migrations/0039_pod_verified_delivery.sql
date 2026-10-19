-- migration 0039: verified delivery evidence — typed POD photos + a fleet-owner review decision.
--
-- WHY THIS EXISTS
-- At delivery the driver now uploads TWO specific, geotagged photos — the signed customer
-- invoice/LR copy and a photo of the vehicle at the drop — and the fleet owner reviews them on
-- their dashboard and APPROVES or REJECTS the delivery. The 0025 pod_evidence spine already
-- captures camera-only photos with on-device SHA-256, a GPS fix and a geofence verdict; this
-- migration adds the two things that spine could not express:
--
--   1. pod_evidence.kind — which of the required shots a row is. Untyped today (0025 comment
--      anticipated "the goods, the stamped LR, a damaged carton" but stored no discriminator),
--      so a signed-invoice shot and a vehicle shot cannot be told apart. Nullable: every legacy
--      row (and any generic capture) stays valid with a null kind.
--   2. pod_state.fleet_review_* — the fleet owner's approve/reject decision on a delivery's
--      evidence, who made it, when, and an optional note. This is a NEW verification actor: today
--      the receiver OTP confirms and ops merely closes; the carrier was never in the loop. The
--      decision hangs off the existing per-booking pod_state ledger, not a new table.
--
-- pod_audit_log gains the two review actions so an approve/reject lands on the same append-only
-- trail as every other POD action (§5.4 rule 5).
--
-- Forward-only, idempotent; baseline regenerated from prod after apply.

-- 1. Typed evidence. Nullable so legacy/generic rows are untouched; the app requires the two
--    named kinds at delivery, the DB just records which is which.
alter table public.pod_evidence add column if not exists kind text;
alter table public.pod_evidence drop constraint if exists pod_evidence_kind_check;
alter table public.pod_evidence add constraint pod_evidence_kind_check
  check (kind is null or kind = any (array['signed_invoice'::text, 'vehicle'::text, 'goods'::text, 'other'::text]));

comment on column public.pod_evidence.kind is
  'Which delivery shot this row is: signed_invoice (the signed customer invoice/LR copy), vehicle (the truck at the drop), goods, or other. NULL on legacy/generic captures. The app requires signed_invoice + vehicle at delivery; the DB records the discriminator.';

-- 2. Fleet-owner review decision on the delivery's evidence. All nullable — a delivery with no
--    review yet simply has nulls; 'pending' is stamped when the driver asserts/completes.
alter table public.pod_state add column if not exists fleet_review_status text;
alter table public.pod_state add column if not exists fleet_reviewed_by uuid references public.users(id);
alter table public.pod_state add column if not exists fleet_reviewed_at timestamptz;
alter table public.pod_state add column if not exists fleet_review_note text;
alter table public.pod_state drop constraint if exists pod_state_fleet_review_status_check;
alter table public.pod_state add constraint pod_state_fleet_review_status_check
  check (fleet_review_status is null or fleet_review_status = any (array['pending'::text, 'approved'::text, 'rejected'::text]));

comment on column public.pod_state.fleet_review_status is
  'The fleet owner''s review of the delivery evidence: pending (awaiting review, stamped when the driver asserts/completes), approved, or rejected. NULL when no evidence review applies. Distinct from pod_strength (confirmed/asserted) and from the ops close — this is the carrier verifying its own driver''s proof.';

-- The fleet dashboard queue: deliveries awaiting this owner's review. Partial index keeps it to
-- the open rows only.
create index if not exists pod_state_fleet_pending_idx
  on public.pod_state (booking_id) where fleet_review_status = 'pending';

-- 3. Audit actions for the review decision, on the same append-only trail as every POD action.
alter table public.pod_audit_log drop constraint if exists pod_audit_log_action_check;
alter table public.pod_audit_log add constraint pod_audit_log_action_check
  check (action = any (array[
    'evidence_captured'::text, 'evidence_access'::text, 'evidence_export'::text, 'modify_attempt'::text,
    'discrepancy_logged'::text, 'otp_gate_pass'::text, 'otp_gate_block'::text, 'otp_gate_degraded'::text,
    'delivery_asserted'::text, 'pod_confirmed'::text, 'consignee_ack'::text, 'ops_closed'::text,
    'evidence_approved'::text, 'evidence_rejected'::text
  ]));

-- RLS is already enabled on pod_evidence / pod_state / pod_audit_log (0025 / 0033). Adding columns
-- and constraints does not change that; service_role bypasses, anon/authenticated stay denied.
