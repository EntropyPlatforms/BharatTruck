# fix/one-truck-fleet-bid

**Branch:** `fix/one-truck-fleet-bid`
**Started:** 2026-08-12
**Status:** in progress

## Problem

Placing a bid from bt-app Auctions fails with `FORBIDDEN` for a one-truck fleet /
distributor (live: `deepak@bharattruck.in`). They have `carry` + `fleet_owner_id`
but not `operate` (operate needs 2+ trucks OR a held driver). `bidderFromSnapshot`
gated fleet bids on `operate` alone, so the auction board listed loads they could
not bid on.

## Fix

Gate fleet bidding on `carry || operate` in `bt-booking-service/src/lib/fleet.ts`
`bidderFromSnapshot`. Unit test pins the Deepak case.

## Done when

- [ ] One-truck fleet can `POST /bookings/:id/quotes` 201
- [ ] PR merged, booking-service redeployed
