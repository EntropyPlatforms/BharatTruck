# The Unified App — one front door for every logistics persona

> **Status:** design report, 2026-08-06. The build follows this; deviations get a dated note here.
> Companion to `ARCHITECTURE_UNIFIED_IDENTITY.md` (the locked identity model this app renders).
>
> **Who this is for:** the founder asked for one app combining shipper, individual driver and fleet
> operator, where a driver who adds a truck becomes a fleet owner who can still drive, an original
> fleet owner never drives, and a shipper who also runs trucks is a distributor. This document is the
> mental model for that, and the plan to build it.

---

## 0. The mental model (read this first — it dissolves the confusion)

The trap is thinking *"3 personas × every feature = too many combinations to hold in my head."* That
model is wrong, and it is why it feels impossible.

**Stop thinking in personas. There are only four CAPABILITIES, and they are computed — not chosen —
from what a person OWNS and who they are CONNECTED to.**

| Capability | Turns on when | Unlocks |
|---|---|---|
| `ship` | always | post loads, track your shipments |
| `drive` | you have a driver profile | trips to drive, navigation, fuel/pumps, POD capture |
| `carry` | you own **≥1 truck** | the marketplace: bid, self-assign work |
| `operate` | you own **≥2 trucks** OR employ **≥1 driver** | fleet: trucks, drivers, assignment, utilisation, fuel, P&L |

**Every "persona" you named is just a subset of these four flags:**

| What you call them | Capabilities | Note |
|---|---|---|
| Shipper | `ship` | |
| Individual driver | `ship` `drive` `carry` | owns his own truck |
| Fleet owner (doesn't drive) | `ship` `carry` `operate` | **no `drive`** — never had a driver profile |
| Distributor | `ship` `carry` `operate` | a fleet owner who also posts loads |
| Owner-driver in a fleet | `ship` `drive` `carry` | affiliation is a *relationship*, not a capability |

**Your specific rules are not special cases — they fall out of the one rule:**

- *"A driver adds another vehicle → he's promoted to fleet owner who can drive his own truck."*
  Nothing is "promoted." He owned 1 truck (`carry`); he now owns 2, so `operate` **becomes true**.
  He still has `drive` and `carry`. The fleet surfaces simply appear. The app took the shape of his
  business because a fact about his business changed.
- *"An original fleet owner doesn't drive."* He has `operate` + `carry` but **never had a driver
  profile**, so `drive` is never true, so the drive surfaces never appear. Not a rule you enforce —
  a surface that's simply never revealed.

> **This is the whole unlock:** you never enumerate combinations. Each *surface* asks one question —
> *"do I have capability X?"* — and shows or hides itself. A surface does not care what your other
> capabilities are. So the complexity is **the number of surfaces (~18)**, not 2⁴ combinations. There
> is no explosion. There never was.

### The second mechanism: the object supplies the context

The other thing that feels confusing — *"when I open a booking, am I the shipper or the carrier?"* —
has a clean answer: **the object tells you.** We already ship `relationToBooking(booking, me)` which
returns `shipper | carrier | driver | observer`. Open a load you posted → shipper view. Open a load
you won → carrier view. **Same screen, different truth, resolved per object.** No mode, no switch.

So the entire "how do we avoid a persona switcher" is two mechanisms working together:

1. **Navigation is capability-gated** — what you *can* do (from your flags).
2. **Each object is relationship-resolved** — what you *are* to *this* thing (from `relationToBooking`).

Both already exist in `@bharattruck/shared/personas`. The app renders them; it invents nothing.

---

## 1. The home surface — "what needs me right now?"

One home. A single action feed where **each item carries its own persona tag** and renders in its own
idiom:

```
┌─────────────────────────────────────────────────────┐
│  Needs you                                          │
├─────────────────────────────────────────────────────┤
│  🟠  3 bids on Mumbai → Nagpur          [as shipper] │  you posted this
│  🟢  Trip to Pune starts tomorrow        [as driver] │  you're driving this
│  🔵  Ravi accepted your fleet invite     [as fleet]  │  you employ him
│  🟡  Delivery code needed — Surat load   [as shipper] │  consignee hasn't confirmed
│  🟢  E-way bill expires in 6 hours       [as driver] │  the load you're moving
└─────────────────────────────────────────────────────┘
```

**The property that makes this safe to ship:** for a single-capability user, the feed contains one
kind of thing, and the app is indistinguishable from today's single-purpose app. It degrades
gracefully to what exists and gets richer as the person's business does. A brand-new shipper never
sees a truck, a driver tab, or a fleet number — because those surfaces have no capability to reveal
them.

---

## 2. Every feature you listed, mapped to a surface and a gate

This is the "everything everything everything" — and it is finite. ~18 surfaces, each with **one**
capability gate. No surface combines gates.

| Surface | Gate | Serves |
|---|---|---|
| **Home** — action feed | always | everyone |
| **Post a Load** — booking create, pricing (advisory), quote-lock | `ship` | shipper, distributor |
| **My Loads** — posted loads, live shipment map, receiver-side POD, documents (invoice, e-way bill record) | `ship` | shipper, distributor |
| **Find Work** — marketplace, bid, self-assign | `carry` | solo driver, distributor-with-trucks |
| **My Bids** — quotes placed, negotiation | `carry` | anyone who bids |
| **My Trips** — won/assigned trips to drive | `drive` | driver, owner-driver |
| **Navigate** — live trip, deep-link nav, pumps, fuel estimate, route alerts | `drive` | anyone driving |
| **POD capture** — camera, geofenced OTP, discrepancy | `drive` | driver |
| **Trucks** — vehicles, RC, insurance | `operate` | fleet owner, distributor |
| **Drivers** — roster, invite, salary/share | `operate` | fleet owner |
| **Assign** — pair truck + driver to a won load | `operate` | fleet owner |
| **Live Fleet map** — every truck at once, colour-coded | `operate` | fleet owner |
| **Utilisation** — per-truck analytics | `operate` | fleet owner |
| **Fuel** — per-truck fuel/DEF/mileage | `operate` | fleet owner |
| **P&L** — per-asset economics | `operate` | fleet owner |
| **Geofences** — zones | `operate` (fleet-wide) · `ship` (per shipment) | both, resolved by context |
| **Documents** — LR, e-way bill, invoice | resolved **per booking** (carrier issues LR, shipper issues invoice) | context |
| **Settings** — profile, KYC, bank, one identity | always | everyone |

**Notice:** GPS, geofencing, live maps, fuel management, utilisation, drivers, trucks, the booking
flow, POD, documents — every single thing you listed is in that table, each under exactly one gate.
The fleet console **already builds rows 9–16** (Trucks…Geofences). The unified app is the fleet
console **plus** the `ship` surfaces **plus** the `drive` surfaces **plus** the capability gating.

---

## 3. The emergence moments (your "promotion", made concrete)

These are the growth loop. Each is a call-to-action at the instant a fact becomes true — never a
settings toggle:

| Trigger (a fact becomes true) | The moment the user sees |
|---|---|
| Driver adds a **2nd truck** | *"You now run 2 trucks. Assign a driver to the second?"* → **Trucks / Drivers / Assign / Utilisation / Fuel / P&L appear** |
| Anyone **invites a driver** | *"You're managing a fleet now."* → same fleet surfaces unlock |
| Anyone **posts a first load** | the **My Loads** tab appears (Post-a-Load was always there) |
| Owner-driver **joins a fleet** | keeps Find Work + My Trips; nothing removed (affiliation adds a work source) |
| A driver's fleet **assigns them a trip** | the trip appears in **My Trips**; they never bid for it |

Your headline case, end to end: *Ramesh drives his own truck (`ship drive carry`). He buys a second
truck. `operate` flips true. The app says "you're running a fleet now — assign a driver to truck 2?"
He invites his cousin. Now Ramesh has **My Trips** (he still drives truck 1) **and** the full fleet
console (he manages truck 2). One login. Nothing was switched.*

---

## 4. The distributor (your hardest case), walked through

A distributor is `ship` + `carry` + `operate` — they post loads **and** run trucks. The fear is
"which mode are they in?" The answer is: **never a mode.**

- They open **Post a Load** (gated `ship`) and post Mumbai → Delhi.
- It appears in their feed tagged **[as shipper]** — 3 carriers bid.
- One of the bids is **their own fleet**. `relationToBooking` returns `shipper` for the load they
  posted (whoever pays sees the paying side), so they see the shipper view and award it — to
  themselves if they choose, which is **direct-attach** (D-10): the auction is skipped, the trip is
  still real, still gets an LR, an invoice with real freight, a POD.
- The same trip now appears in their feed a second time tagged **[as fleet]** — "assign a truck."
- They assign truck 4 + driver Suresh from their fleet console surfaces.
- Suresh (a `drive`-only employee) sees it in **My Trips**, drives it, captures POD — and the money is
  masked from him because he owns no truck (server-enforced, `isEmployedDriver`).

Every step used a different capability's surface, and the distributor never told the app who they
were. The **objects** did.

---

## 5. The build

### 5.1 Strategy: fork the fleet console, layer two personas on top

The fleet console is Next 16 / React 19 / Tailwind 4 / `@vis.gl/react-google-maps`, with an `(app)`
route group and these surfaces already built: `dashboard, map, vehicles, drivers, auctions, trips,
analytics(utilisation), fuel, settings`. That is the **entire `operate` + `carry` half** of the
unified app, working and deployed.

So the build is not "a third app from scratch." It is:

```
bt-app/  (new)  =  fleet/ scaffold  (operate + carry surfaces, already built)
                +  ship surfaces     (Post a Load, My Loads, shipment map, receiver POD)
                +  drive surfaces     (My Trips, Navigate, POD capture)
                +  capability-gated nav  (the shell reveals surfaces from /auth/me flags)
                +  the home action feed
```

The `ship` surfaces come from `shipper/`; the `drive` surfaces from `driver/`. This is a **graft**,
not a rewrite — the components exist, they get moved under one shell and gated.

> The live-track map is COPIED per app by frozen decision (Maps D-008), so the unified app copies
> `<LiveTrackMap/>` too — consistent with the rule, not a violation of it.

### 5.2 The one backend prerequisite

The nav shell needs to know a user's capabilities in one call. Today that requires three lookups
(drivers, fleet_owners, vehicles). **We already have the resolver** — `resolvePersonas()` in
`@bharattruck/shared/personas` returns the full `PersonaSnapshot` (capabilities, driver_id,
fleet_owner_id, owned_vehicle_count, sees_commercials). It needs to be exposed as
**`GET /auth/me` → { user, capabilities }`**.

That is the critical-path dependency, and it is small — but it has a wrinkle: `bt-auth-service` is not
yet on `@bharattruck/shared`, so wiring it there is a **build change** (Dockerfile, CI path filter,
`.npmrc`), which is its own small PR. **This lands first.** Alternative if we want to unblock the app
sooner: expose the same snapshot from `bt-booking-service` (already on shared) as
`GET /me/capabilities`, and point the app there. Either works; the auth-service home is the tidier
long-term address.

*No migration.* Capability resolution reads existing tables (0022 is applied).

### 5.3 New Cloud Run service + CI/CD (same format as the fleet console)

Everything mirrors how `fleet/ → bt-fleet-console` already works:

| Piece | What to add |
|---|---|
| **Dir** | `bt-app/` (proposed; Cloud Run service `bt-app`) — fork of `fleet/`'s scaffold + Dockerfile |
| **CI** (`.github/workflows/ci.yml`) | path filter `bt-app: ['bt-app/**', '.github/workflows/ci.yml']` |
| **CD** (`.github/workflows/deploy.yml`) | one row in the app matrix: `{ service: bt-app, maps: true, google: true }` — same `--build-arg` bake of `NEXT_PUBLIC_*`, same SHA-tagged revision |
| **Cloud Run** | auto-created on first deploy with `--allow-unauthenticated` (the deploy job already does this; note the "new service ships empty env" trap does **not** bite an app — its config is baked at build) |
| **Gateway** | **no change.** Apps are not behind the gateway; they call it via `NEXT_PUBLIC_API_URL`. |
| **Env** | reuses the existing repo vars/secrets: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY`, `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID`, `NEXT_PUBLIC_GOOGLE_CLIENT_ID`. Nothing new to provision. |

**No credential blockers for the app itself** — it inherits the maps/auth config the other apps
already use.

### 5.4 Ships ALONGSIDE the three apps, not instead of them

`bt-app` is the 4th deployment. `bt-driver`, `bt-shipper`, `bt-fleet-console` keep running untouched.
Nothing that works today breaks. Once `bt-app` is proven on the pilot, the three focused apps can be
retired (or kept as narrow entry points). This de-risks a large frontend change to zero regression on
the live stack.

### 5.5 Phasing (so it lands incrementally, green at every step)

| Phase | Deliverable | Demoable result |
|---|---|---|
| **0 — prerequisite** | `GET /auth/me` returns capabilities (own PR) | any client can read a user's flags |
| **1 — skeleton** | `bt-app/` forked from fleet, login, capability-gated nav shell, home feed, the `operate`/`carry` surfaces working, **deployed to Cloud Run + CI/CD** | a fleet owner logs into the new app and sees exactly today's fleet console, at a new URL |
| **2 — graft `ship`** | Post a Load, My Loads, shipment map, receiver POD | a distributor posts a load and runs a truck in one app |
| **3 — graft `drive`** | My Trips, Navigate, POD capture | an owner-driver drives and manages in one app |
| **4 — emergence + polish** | the CTAs of §3, the object-resolved document surfaces, cross-persona feed | Ramesh's promotion story works live |

Each phase is a PR, green CI, merged, deployed. Phase 1 is the walking skeleton — a real app at a real
URL doing real work — before any grafting.

---

## 6. Risks and what is explicitly deferred

- **`/auth/me` capabilities is the gate.** Nothing in the app's nav works without it. It is small but
  it blocks Phase 1, so it is Phase 0. (Deferred alternative: read it from `bt-booking-service`.)
- **Commercial masking is server-side and must stay there.** The app renders what the API returns; an
  employed driver's money is already stripped by `isEmployedDriver` before it reaches any client. The
  unified app must **not** re-implement that rule — if it ever computes visibility client-side, that
  is a leak.
- **This is a large frontend against a 31 Aug deadline.** The graft strategy (fleet is 60% done) is
  what makes it tractable; the phasing keeps it shippable at each step rather than big-bang.
- **Deferred:** retiring the three focused apps (post-pilot), typed-KYC-across-personas surfacing
  (D-4, needs the backend), and any persona the app can't yet compute (none — all four capabilities
  resolve today).

---

## 7. The one naming decision for you

Proposed: dir `bt-app/`, Cloud Run service `bt-app`, URL `bt-app-…run.app`. If you'd rather it be the
canonical BharatTruck front door with a cleaner name (e.g. service `bt-web` or a custom domain), say
so — it only changes the matrix row and the Dockerfile default, and it is cheapest to pick now.
