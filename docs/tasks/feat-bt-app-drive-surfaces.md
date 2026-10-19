# feat/bt-app-drive-surfaces — graft the DRIVE surfaces into bt-app (Phase 3)

> Active-branch task file (per CLAUDE.md / BIBLE §0.4). Delete on merge.

Phase 3 of `docs/UNIFIED_APP_PLAN.md`: graft the `drive` surfaces from `driver/` into the
unified app `bt-app`, gated on the `drive` capability. No backend, gateway, or Phase 2
ship-surface changes. **Acceptance bar: NO BLANK SCREENS — every fetch renders
Loading / Empty / Error.**

## What landed

- **My Trips** — `bt-app/src/app/(app)/my-trips/page.tsx` (replaces the ComingSoon
  placeholder). Reuses `listBookings()` (Phase 2) and filters to trips the viewer is the
  `driver`/`carrier` on, in a drivable status (`accepted | in_transit | completed |
  delivery_asserted`). Row: route, status, pickup date, "needs delivery code to close"
  hint while `in_transit`. States: Loading / Empty ("No trips assigned yet") / Error+retry.
- **Trip detail / Navigate** — `bt-app/src/app/(app)/my-trips/[id]/page.tsx`. Summary +
  status stepper; status-driven action section:
  - `accepted` → Start Trip (confirm + submitting state) + Navigate-to-pickup deep-link.
  - `in_transit` → live GPS push (~10s `watchPosition → pushLocation`, guarded for
    denied/unsupported), route map (`LiveTrackMap`, degrades to guard note), Navigate-to-drop
    deep-link, receiver-OTP POD flow (handles "no receiver contact"), and Trip Insights.
  - `delivery_asserted / completed / paid / cancelled` → plain status cards.
  - not the caller's to drive → read-only note.
- **Trip Insights** — `bt-app/src/components/trip-insights.tsx` (ported, light restyle):
  alerts (60s quiet poll), fuel (on mount + edit), pumps (on-demand). Each card owns its
  loading/empty/error; a failed insight shows a note, never blanks the page.
- **API** — added to `bt-app/src/lib/api.ts`: `startTrip`, `getPodContext`,
  `requestPodOtp`, `pushLocation`, `getRoute`, `getPumps`, `getFuel`, `getTripAlerts`,
  `getTripAlertsQuiet`. Types added to `bt-app/src/lib/types.ts`: `LocationUpdate`,
  `PodContext`, `RequestOtpResult`, `RouteData`, `PetrolPump`, `PumpsData`, `FuelData`,
  `TripAlert`, `AlertsData`. `listBookings/getBooking/getTrack/getBookingLocation` reused.
- **Nav deep-link** — `buildNavDeepLink()` added to `bt-app/src/lib/maps.ts` (universal
  `https://www.google.com/maps/dir/?api=1` handoff; locked Maps model, no in-app turn-by-turn).
- **Wake lock** — `bt-app/src/lib/use-wake-lock.ts`, used ONLY in the `in_transit` branch
  of the trip page (scoped to the active trip, released on unmount). Nothing app-wide.
- `nav.ts`: dropped `placeholder: true` from `/my-trips` (now real). `coming-soon.tsx`
  removed (last consumer gone; no placeholders remain).

## Scope guarantees

- No backend / gateway change. bt-app calls the gateway via `NEXT_PUBLIC_API_URL`
  (`/api/bookings`, `/api/location`, `/api/tracking`, `/api/cargo` — all already routed).
- No app-wide service worker; no app-wide wake lock. Driver-runtime concerns (GPS watch,
  wake lock) mount only with an active in-transit trip.
- Phase 2 ship surfaces and the fleet console surfaces untouched.

## Verify live (demo-driver has assigned trips)

- My Trips lists demo-driver's assigned trips; an account with none shows the Empty CTA.
- Open an `accepted` trip → Start Trip flips it to `in_transit`.
- `in_transit` trip → GPS banner (on desktop: the "unavailable on this device" guard, not
  blank), map draws pickup/drop, Navigate opens Google Maps, "Mark as delivered" →
  receiver-email confirm → awaiting state; insights cards each render their own state.
