-- migration 021: transactional email — durable outbox + per-user preferences.
--
-- WHY AN OUTBOX AND NOT INLINE sendMail():
--   Before this, the only email in the platform was three inline nodemailer calls in
--   bt-auth-service and one in bt-cargo-ledger. That works for a code a user is actively
--   waiting for, and NOT for anything else: an SMTP timeout while awarding an auction
--   would either fail the award or lose the notification silently, and there was no record
--   anywhere of what had actually been delivered. Every async notification now becomes a
--   row here first (cheap, local, in the same DB as the domain write), and a dispatcher
--   drains it with retries. Producers never block on SMTP and never fail a business
--   operation because a mail server was slow.
--
-- WHAT IS DELIBERATELY *NOT* IN THIS TABLE:
--   Login OTPs, magic links, password-reset links and the POD receiver OTP stay SYNCHRONOUS
--   inline sends. A user is sitting on a login/POD screen waiting for that code — routing it
--   through a polled queue would add the poll interval to every login. The split is by
--   "is a human blocked on this arriving right now", not by message type.

-- ---------------------------------------------------------------
-- (1) notification_outbox — the queue + the delivery audit trail.
--
-- It is both: a row is never deleted on success, it flips to 'sent'. "Did the shipper
-- actually get told they won?" has to be answerable months later, and Cloud Run stdout
-- is not an answer (that is exactly how the POD OTP shipped looking green while being
-- undeliverable — see docs/tasks/feat-pod-email-smtp.md).
-- ---------------------------------------------------------------
create table if not exists public.notification_outbox (
  id                uuid primary key default gen_random_uuid(),

  -- Event name from the shared catalogue (@bharattruck/shared/notifications).
  -- Free text rather than an enum ON PURPOSE: adding a notification type must not
  -- require a migration + a deploy ordering dance, and an unknown event_type is
  -- already handled safely by the dispatcher (parked as 'failed', never retried
  -- forever, never crashes the drain loop).
  event_type        text not null,

  -- Recipient. recipient_email is the delivery address and is the ONLY required one:
  -- a consignee/receiver has no BharatTruck account at all (PRD §1.4 "Receiver — no
  -- account, email only"), so recipient_user_id is nullable by design. When it IS set,
  -- the dispatcher can honour that user's notification_preferences.
  recipient_email   text not null,
  recipient_user_id uuid references public.users(id) on delete set null,

  -- Everything the template needs to render, captured AT EMIT TIME. Deliberately a
  -- snapshot, not ids to re-read at send time: a "you won this load at Rs.36,483"
  -- email must say what was true when it was sent, even if the booking is later
  -- edited or cancelled. Keeps the dispatcher free of domain queries too.
  payload           jsonb not null default '{}'::jsonb,

  -- Idempotency. The natural key of the event, e.g. 'quote_awarded:<quote_id>' or
  -- 'trip_completed:<booking_id>:shipper'. A retried HTTP request, a saga replay or a
  -- double-clicked button re-inserts the same key and is absorbed by the unique index
  -- below instead of emailing the user twice. Producers MUST include the recipient
  -- role in the key when one event mails several people.
  dedupe_key        text not null,

  status            text not null default 'pending'
                      check (status in ('pending','sending','sent','failed','skipped')),

  -- Retry bookkeeping. next_attempt_at drives the exponential backoff; a row is only
  -- eligible when next_attempt_at <= now(). 'skipped' is a real outcome, not an error:
  -- the recipient opted out, or had no email address on file.
  attempts          int not null default 0,
  max_attempts      int not null default 5,
  next_attempt_at   timestamptz not null default now(),
  last_error        text,

  -- Set while a dispatcher holds the row, so two concurrent drains (or a Cloud Scheduler
  -- tick overlapping an in-process interval) cannot both send the same email. Rows stuck
  -- in 'sending' past the lease are reclaimed — see the reclaim query in dispatcher.ts.
  locked_at         timestamptz,

  created_at        timestamptz not null default now(),
  sent_at           timestamptz
);

-- The idempotency guard. A second insert of the same logical event is rejected here and
-- the producer treats the resulting unique violation as success (already queued).
create unique index if not exists notification_outbox_dedupe_key_idx
  on public.notification_outbox (dedupe_key);

-- The dispatcher's claim query: pending/failed-but-retryable rows that are due now,
-- oldest first. Partial so the index stays small as 'sent' rows accumulate — those are
-- the overwhelming majority over time and are never scanned by the drain loop.
create index if not exists notification_outbox_due_idx
  on public.notification_outbox (next_attempt_at, created_at)
  where status in ('pending','sending');

-- Ops/debug: "what did we send this user?" and "what is failing right now?"
create index if not exists notification_outbox_recipient_idx
  on public.notification_outbox (recipient_user_id, created_at desc)
  where recipient_user_id is not null;

create index if not exists notification_outbox_failed_idx
  on public.notification_outbox (created_at desc)
  where status = 'failed';

comment on table public.notification_outbox is
  'Durable queue + delivery audit for async transactional email. Drained by bt-booking-service''s dispatcher. Synchronous auth/POD OTPs do NOT pass through here.';

-- ---------------------------------------------------------------
-- (2) notification_preferences — per-user opt-out + the unsubscribe token.
--
-- Split by CATEGORY, not by event: a user who mutes marketplace chatter must still
-- receive the receipt for money they paid. The dispatcher maps each event to a category
-- and only consults this table for categories that are legitimately optional.
-- 'transactional' has no column here at all — by construction it cannot be turned off.
-- ---------------------------------------------------------------
create table if not exists public.notification_preferences (
  user_id            uuid primary key references public.users(id) on delete cascade,

  -- Marketplace activity: new matching load, new quote, counter-offer, outbid/lost.
  -- The highest-volume category and the one a busy fleet owner will want to mute first.
  email_marketplace  boolean not null default true,

  -- Trip lifecycle progress: accepted, started, checkpoint, arriving soon.
  -- (Delivery-confirmed is transactional and always sends.)
  email_trip_updates boolean not null default true,

  -- Periodic roll-ups: weekly fleet P&L, shipper statements, ops digests.
  email_digests      boolean not null default true,

  -- Random per user, used by the public one-click unsubscribe link. It is a bearer
  -- token in a URL, so it grants exactly one capability: toggling this row's flags.
  -- gen_random_uuid() twice = 256 bits, unguessable, and rotatable without touching
  -- the user's identity.
  unsubscribe_token  text not null unique
                       default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),

  updated_at         timestamptz not null default now()
);

create index if not exists notification_preferences_token_idx
  on public.notification_preferences (unsubscribe_token);

comment on table public.notification_preferences is
  'Per-user email opt-out by category. A missing row means "all defaults on" — the dispatcher never requires a row to exist.';

-- ---------------------------------------------------------------
-- (3) RLS — service-role only, matching ops_overrides (migration 012).
-- No public policies: every read/write goes through a service with the service-role key.
-- The unsubscribe endpoint is public but is served BY a service, not by PostgREST.
-- ---------------------------------------------------------------
alter table public.notification_outbox      enable row level security;
alter table public.notification_preferences enable row level security;
