-- 0043_whatsapp.sql
--
-- The WhatsApp bot (bt-booking-service src/lib/whatsapp). Two tables, service-role only
-- (RLS on, no policies) like every table here — see supabase/migrations/README.md.
--
-- whatsapp_contacts: one row per WhatsApp number that has messaged the bot. It records the
--   opt-in WhatsApp requires before we send alerts (set when the person's first menu tells
--   them alerts will come here), STOP (opted_out_at) and the person's last message — the
--   start of the 24-hour window in which we may send free-form text. user_id is the account
--   the number matched at its last message, kept for support; the bot re-matches every time.
--
-- whatsapp_outbox: alerts waiting to go out, drained by POST /internal/whatsapp/dispatch.
--   dedupe_key makes "the same alert episode" one message however often the sweep runs.
--
-- Additive and forward-safe: nothing existing changes. Before this is applied the bot still
-- answers messages; it just cannot record opt-ins or queue alerts, and the dispatch route
-- answers 503 WHATSAPP_NOT_MIGRATED.

create table if not exists public.whatsapp_contacts (
  wa_id             text primary key check (wa_id ~ '^[0-9]{8,15}$'),
  user_id           uuid references public.users(id) on delete set null,
  alerts_opt_in_at  timestamptz,
  opted_out_at      timestamptz,
  last_inbound_at   timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists whatsapp_contacts_user_idx on public.whatsapp_contacts (user_id);

alter table public.whatsapp_contacts enable row level security;

create table if not exists public.whatsapp_outbox (
  id                   uuid primary key default gen_random_uuid(),
  wa_id                text not null check (wa_id ~ '^[0-9]{8,15}$'),
  user_id              uuid references public.users(id) on delete cascade,
  kind                 text not null,
  body_text            text not null,
  template_params      jsonb not null default '[]'::jsonb,
  dedupe_key           text not null unique,
  status               text not null default 'pending'
                         check (status in ('pending', 'sending', 'sent', 'skipped', 'failed')),
  attempts             integer not null default 0,
  max_attempts         integer not null default 5,
  next_attempt_at      timestamptz not null default now(),
  last_error           text,
  provider_message_id  text,
  created_at           timestamptz not null default now(),
  sent_at              timestamptz
);

-- The drain's only read: due rows that are not finished. Partial, so sent history never slows it.
create index if not exists whatsapp_outbox_due_idx
  on public.whatsapp_outbox (next_attempt_at)
  where status in ('pending', 'sending');

alter table public.whatsapp_outbox enable row level security;
