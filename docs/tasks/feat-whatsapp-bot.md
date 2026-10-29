# feat/whatsapp-bot

**Started** 2026-10-22 · **Owner** Claude session · **Surface** `bt-booking-service` (`src/lib/whatsapp`,
`/whatsapp/webhook`, `/internal/whatsapp/dispatch`), `bt-gateway`, migration 0043

## Why

People already live on WhatsApp; drivers especially. The bot gives them a way in without opening the
app first, and gets critical alerts to them when the app is closed. Decided 2026-10-20 (the
"WhatsApp bot for KYC" note): WhatsApp for the conversation, the app for identity — the bot does
not collect KYC documents.

## What the bot does

- **Anyone can start.** A number matching an account's saved phone (`users.phone_number`, unique) is
  that account — the same trust as the app's phone sign-in. An unclaimed receiver record
  (`claimed_at` null) is never matched; it is reached only through its claim link (D-22/D-35).
- **Newcomers** get a welcome and three buttons: Ship a load, I have trucks (both link to the app),
  Talk to us.
- **Matched people** get a menu: My alerts (their open alerts, most urgent first, each linking to the
  page that fixes it — the same mapping as the Home feed), My trips (live trips, no prices, no phone
  numbers), Help.
- **Alerts on WhatsApp.** The alert sweep queues every critical alert it emails for people who have
  opted in on WhatsApp; `/internal/whatsapp/dispatch` sends them — text inside the 24-hour window,
  the approved template outside it, skipped without one.
- **Opt-in** is recorded on a matched person's first menu, which tells them alerts will come there;
  STOP / START switch it off and on.
- **Never collects documents**; photos and files get a refusal and the app link.

## Decisions

- **Lives in bt-booking-service**, next to the alerts, the outbox pattern and the trips. The
  webhook is public and gated by Meta's `X-Hub-Signature-256` on the raw body (its route scope keeps
  the raw bytes); everything else about it is the existing service.
- **All-or-nothing config** (four `WHATSAPP_*` settings), like the SMS seam: half-configured means off
  (503), never half-working.
- **Its own outbox and its own dispatch job.** The email outbox requires an email address, and the
  email drain answers 503 whenever SMTP is unset — WhatsApp must not depend on either.
- **Answered once, rate-limited.** Meta retries deliveries: message ids are de-duplicated in Redis
  (48 h); 20 messages a minute per number. Redis is loaded lazily; if it is down, both checks let the
  message through rather than going silent.
- **Degrades before 0043**: the bot still answers; opt-ins and alert queueing are skipped; the
  dispatch route answers 503 `WHATSAPP_NOT_MIGRATED`.
- **Money**: trip lines select no price columns at all. Alert lines carry only what that person's
  alert already says, and a hired driver's alerts never name an amount (alerts/rules.ts).

## Not in this PR

Sign-in codes over WhatsApp (needs a phone sign-in screen in the app), creating accounts inside
WhatsApp, KYC reminders as their own messages, Hindi, and a staff inbox for "Talk to us".

## Verification

| Check | Result |
|---|---|
| `tsc --noEmit` (bt-booking-service) | clean |
| `whatsapp-bot.unit` | 49 / 49 — signature, parsing, phones, links, every reply, payloads, config, guard |
| `whatsapp-webhook.e2e` | 54 / 54 — real route with signed payloads, matching, menus, opt-in, STOP/START, duplicates, rate limit, degradation, alert queue, dispatch (window, template, retry, STOP), sweep → WhatsApp |
| Rest of bt-booking-service | unchanged; the same 5 files fail on Windows only (path, Redis, line endings) |

Nothing is deployed, migrated or configured. Turning it on is the runbook in `docs/BIBLE.md §7.1`.
