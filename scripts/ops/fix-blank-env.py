#!/usr/bin/env python3
"""Repair Cloud Run env by copying values from services that already have them.

Two problems this fixes, in one pass per service:

1. Blank secrets. An earlier env-copy used a shell-quoted `'$1'` reader; zsh took
   it literally, so every secret was written as an empty string. Cloud Run
   serialises those as a key with NO `value` field -- `{"name":"JWT_SECRET"}` --
   which reads as "key is present" unless you check the value length. That left
   bt-payment-service and bt-cargo-ledger down. See issues #5, #6, #7.

2. Missing SMTP config on bt-cargo-ledger. POD OTP mail moved from an
   unprovisioned Resend key to SMTP (PR #8), reusing bt-auth-service's env
   contract. Without these vars the sender silently falls back to console
   logging, so OTPs land in Cloud Run stdout and never reach the receiver.

Immune to the bug that caused (1): never builds a shell string, passes argv
lists to subprocess directly, refuses to run if a source value is empty, and
picks a delimiter provably absent from every value (`@` is unsafe -- REDIS_URL
is `rediss://default:PASSWORD@host`).

Usage:
    python3 scripts/ops/fix-blank-env.py cargo-ledger --dry-run
    python3 scripts/ops/fix-blank-env.py cargo-ledger
    python3 scripts/ops/fix-blank-env.py both

Secrets are never printed; only key names and value lengths.
"""
import argparse
import json
import subprocess
import sys

REGION = "asia-south1"

# Each target lists (source_service, keys) groups plus any literal values.
# Verified against src/ on 2026-07-20 -- only keys the service actually reads.
TARGETS = {
    "payment": {
        "service": "bt-payment-service",
        "groups": [
            ("bt-booking-service",
             ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "JWT_SECRET", "INTERNAL_SERVICE_SECRET"]),
        ],
        "literals": {},
    },
    "cargo-ledger": {
        "service": "bt-cargo-ledger",
        "groups": [
            # REDIS_URL is the hard blocker: lib/redis.ts throws at module load.
            ("bt-booking-service",
             ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "REDIS_URL", "INTERNAL_SERVICE_SECRET"]),
            # Same mail transport bt-auth-service already uses in production.
            ("bt-auth-service",
             ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"]),
        ],
        # Explicit: without this the sender stays in console-log mode even with
        # credentials present (see defaultEmailSender in src/lib/email.ts).
        "literals": {"EMAIL_DEV_MODE": "false"},
    },
    # Verified against bt-fleet-service/src on 2026-07-26. All five are read lazily,
    # which is why a blank one does NOT stop the container or fail /health -- the
    # service boots green and every data route 500s. That is exactly the failure
    # mode this script exists to repair.
    #   JWT_SECRET             plugins/auth.ts   -> unset means EVERY request 401s
    #   SUPABASE_URL/KEY       lib/supabase.ts   -> client built on first query
    #   REDIS_URL              lib/redis.ts      -> only GET /fleet/live + roster writes
    #   INTERNAL_SERVICE_SECRET plugins/internal-auth.ts -> /internal/* fails CLOSED (503)
    # REDIS_URL must come from booking: bt-booking-service is the sole writer of
    # loc:driver:{id}, and fleet only reads those keys.
    "fleet": {
        "service": "bt-fleet-service",
        "groups": [
            ("bt-booking-service",
             ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "JWT_SECRET",
              "INTERNAL_SERVICE_SECRET", "REDIS_URL"]),
        ],
        "literals": {},
    },
    # bt-booking-service hosts the notification outbox dispatcher for the whole
    # platform (migration 021). It needs the SAME mail transport bt-auth-service
    # already sends login OTPs through -- one mail config to operate, not two --
    # so the SMTP set is COPIED from there rather than re-entered by hand.
    #
    # Until these land the dispatcher deliberately REFUSES to run: with no
    # SMTP_USER it would resolve to ConsoleEmailSender, claim every queued row,
    # "send" it to stdout and mark it sent, silently destroying mail nobody
    # received. POST /internal/notifications/dispatch returns 503
    # EMAIL_NOT_CONFIGURED instead, and rows stay 'pending' until this runs.
    #
    # The app base URLs (SHIPPER_APP_BASE_URL / DRIVER_APP_BASE_URL /
    # NOTIFICATIONS_PUBLIC_BASE_URL) are deliberately NOT here: they are
    # per-environment Cloud Run hostnames, not secrets shared between services,
    # and baking prod URLs into a repo script would go stale.
    "booking": {
        "service": "bt-booking-service",
        "groups": [
            ("bt-auth-service",
             ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"]),
        ],
        # Explicit: with credentials present but EMAIL_DEV_MODE=true, smtpConfigured()
        # still reports false and the dispatcher stays blocked.
        "literals": {"EMAIL_DEV_MODE": "false"},
    },
}


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def env_of(service):
    r = run(["gcloud", "run", "services", "describe", service,
             "--region", REGION, "--format", "json"])
    if r.returncode != 0:
        sys.exit(f"ABORT: could not read {service}:\n{r.stderr}")
    spec = json.loads(r.stdout)["spec"]["template"]["spec"]["containers"][0]
    return {e["name"]: e.get("value", "") for e in spec.get("env", [])}


def pick_delimiter(values):
    """gcloud's ^X^ syntax needs a char absent from every value."""
    for candidate in "#%!~|+":
        if not any(candidate in v for v in values):
            return candidate
    sys.exit("ABORT: no safe delimiter found; set these vars one at a time.")


def fix(target, dry_run):
    cfg = TARGETS[target]
    service = cfg["service"]
    print(f"\n=== {service} ===")

    resolved = dict(cfg["literals"])
    for src_service, keys in cfg["groups"]:
        src_env = env_of(src_service)
        missing = [k for k in keys if not src_env.get(k)]
        if missing:
            print(f"  ABORT: {src_service} has no value for {missing} -- cannot copy.")
            return 2
        for k in keys:
            resolved[k] = src_env[k]
        print(f"  from {src_service}: {', '.join(keys)}")

    dst_env = env_of(service)
    print()
    for k, v in resolved.items():
        was = dst_env.get(k)
        state = "blank" if not was else ("unchanged" if was == v else f"differs (len={len(was)})")
        print(f"  {k:28} {state:22} -> len={len(v)}")

    if all(dst_env.get(k) == v for k, v in resolved.items()):
        print("  Nothing to do -- already correct.")
        return 0

    delim = pick_delimiter(list(resolved.values()))
    payload = f"^{delim}^" + delim.join(f"{k}={v}" for k, v in resolved.items())

    if dry_run:
        print(f"\n  DRY RUN -- delimiter {delim!r}, payload {len(payload)} bytes, not applied.")
        return 0

    print(f"\n  Updating {service} ...")
    r = run(["gcloud", "run", "services", "update", service,
             "--region", REGION, "--update-env-vars", payload])

    def scrub(s):
        for v in resolved.values():
            if v and len(v) > 6:
                s = s.replace(v, "<redacted>")
        return s

    print(scrub(r.stdout).strip())
    if r.returncode != 0:
        print(scrub(r.stderr).strip(), file=sys.stderr)
    return r.returncode


def main():
    p = argparse.ArgumentParser()
    p.add_argument("target", choices=[*TARGETS, "both"])
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args()

    targets = list(TARGETS) if a.target == "both" else [a.target]
    rc = 0
    for t in targets:
        rc |= fix(t, a.dry_run)

    if rc == 0 and not a.dry_run:
        print("\nDone. Verify each service goes ready:")
        for t in targets:
            print(f"  gcloud run services describe {TARGETS[t]['service']} --region {REGION} "
                  "--format='value(status.conditions[0].status)'")
    return rc


if __name__ == "__main__":
    sys.exit(main())
