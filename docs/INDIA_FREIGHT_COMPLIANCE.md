# India Freight Compliance — e-Way Bills, LR/Consignment Notes, POD

> **Status:** research reference, compiled 2026-08-03. **Not legal advice.** Several conclusions here
> are genuinely contested and are flagged as such. Get a written opinion from Indian indirect-tax
> counsel before shipping the document layer, and again before changing the commercial model.
>
> **Why this file exists:** the compliance layer (e-way bill, LR, POD) is the one part of BharatTruck
> where being wrong is a tax-and-liability event rather than a bug. This is the distilled, sourced
> version of six research passes so nobody has to re-derive it.

---

## §0 — How to use this document

### 0.1 Confidence key

| Mark | Meaning |
|---|---|
| ✅ | Verified against a primary source (bare act, gazette notification, CBIC/NIC official page) |
| ⚠️ | Commentary-sourced, or primary source found but position is contestable — verify before relying |
| ❓ | Genuinely unsettled, or sources materially conflict. Do not build load-bearing logic on it |

### 0.2 Stale-source traps — read before searching anything yourself

The single biggest hazard in this area is that **the most authoritative-looking sources are stale**,
including the government's own. Verified traps:

| Trap | Reality |
|---|---|
| **NIC's own `docs.ewaybillgst.gov.in/Documents/ewbrules.pdf`** serves the **2017** rules — clauses (a)–(d) only, and the superseded **154-item** Annexure | ✅ Current Annexure has **8 entries**. Use the CBIC repository, never the EWB portal's PDF |
| CBIC's own 2019 e-way bill FAQ PDF says validity is 1 day / **100 km** | ✅ It is **200 km** since 01.01.2021 (Notif. 94/2020-CT) |
| Major portals (incl. ClearTax) still list the **₹1,500 / ₹750** small-consignment GTA exemptions | ✅ **Withdrawn** w.e.f. 18.07.2022 (Notif. 04/2022-CT(R)) |
| Commentary says the GTA forward-charge election (Annexure V) is due **15 March** and must be re-filed annually | ✅ Window is **1 Jan – 31 Mar of the preceding FY**, and the election is **deemed continuing** (Notif. 06/2023-CT(R), 27.07.2023) |
| Commentary says GTA can elect **12%** with ITC | ✅ 12% is **gone** since 22.09.2025. It is now **5% no ITC** or **18% with ITC** |
| Sources say West Bengal's intra-state threshold dropped to ₹50,000 in Dec 2023 | ❓ **Contested.** One pass found Notif. 02/2023 was put in abeyance and the change actually landed **01.06.2026**; another could not confirm. **Verify before use** |

> **The West Bengal case is the reason §4.2 mandates an effective-dated threshold table.** Two careful
> research passes reached different conclusions about one state's threshold on one date. Never
> hard-code a threshold from a blog post — including from this document.

### 0.3 Fetching primary sources (access notes)

- `taxinformation.cbic.gov.in` — serves a **broken TLS chain**. `curl -k` works; most fetchers fail.
- `docs.ewaybillgst.gov.in` — returns **403** to plain fetchers; works with a browser `User-Agent`.
- `cbic-gst.gov.in` PDF links from 2018 are broadly **404**. Use the Wayback Machine.

---

## §1 — Where BharatTruck stands legally

### 1.1 The one line that must not be crossed

**Issuing a consignment note in your own name is the single act that converts a transport arrangement
into a "goods transport agency" (GTA) supply under GST.** ✅

Not owning trucks does not protect you. Not driving does not protect you. Not touching the goods does
not protect you.

> **Notification 12/2017-CT(Rate), para 2(ze):** *"'goods transport agency' means any person who
> provides service in relation to transport of goods by road **and issues consignment note, by
> whatever name called**"* ✅

Two cumulative conditions: (a) provision of road-transport service, (b) issuance of a consignment note.

### 1.2 The two rulings that define the line — and they are about platforms

| Case | Facts | Held |
|---|---|---|
| **Flipkart India** — WB AAR **09.12.2025**; TN AAR **TN/3/ARA/2026, 09.01.2026** | E-commerce platform. Owned **no goods**. Movement executed by **third-party transporters**. **Single consignment note in its own name.** Bore transit liability and insurance. | **GTA.** ⚠️ |
| **A V Cargo Migrators LLP** — TN AAR | Online portal connecting vehicle owners/drivers with customers needing transport. | **ECO, not GTA.** GST on commission; TCS under s.52. ⚠️ |

**The distinguishing facts in A V Cargo: it did not issue consignment notes, and it did not assume
responsibility for the goods in transit.** That gap is exactly where BharatTruck must sit.

> Founder decision Q15 — *"LR number belongs to the Fleet owner"* — is the **right structure and is
> well supported**. The risk is not the design. The risk is **divergence between the paper and the
> commercial substance.**

### 1.3 The three red lines

Crossing any of these moves BharatTruck from the A V Cargo side to the Flipkart side.

**1. Never be the named issuer or carrier.**
The issuer block on every rendered LR carries the **fleet owner's** legal name, GSTIN and address.
Platform branding goes in a footer at most (*"generated using BharatTruck"*), never in the issuer
block. **Never a platform-wide LR series** — see §3.3.

**2. Never assume cargo liability.**
The moment the ToS, an insurance product, the claims process, or marketing copy says BharatTruck is
responsible for the goods, that supplies the exact fact the Flipkart AARs relied on. Route claims to
the carrier's liability under Carriage by Road Act **s.10/s.11**. Do not indemnify shippers for cargo
loss.

**3. Never contract as principal for the carriage.**
The transport contract is **shipper ↔ fleet owner**; BharatTruck facilitates. Three specific tells
that pull toward GTA characterisation: ⚠️

- **the platform sets the freight price** (rather than the carrier quoting it)
- **the platform invoices the shipper for freight in its own name** (rather than for commission)
- **the platform takes the freight money as principal** rather than as a collection agent

> ⚠️ **This converges exactly with founder decision Q20** (*"The Platform never should have its own
> price"*). What was stated as a product preference turns out to also be a **legal protection**.
> Price *discovery* (a benchmark, a cost calculator, an average of what carriers charge) is safe.
> Price *setting* plus own-name freight invoicing is not. See §9.4 for what this means for the
> existing `bt-pricing-service`.

### 1.4 The architectural principle for the whole compliance layer

Rule 138(1)'s **second proviso** is an express statutory route for an e-commerce operator to furnish
e-way bill Part A **on the consignor's authorisation**, without that act making it a GTA. ✅

> Use it as the model for **every** document the platform generates:
> **acting on the principal's authorisation, in the principal's name.**

### 1.5 A separate exposure that keeping your name off the LR does NOT solve

**Carriage by Road Act 2007, s.2(a)** defines "common carrier" to expressly include *"a goods booking
company, contractor, agent, broker and courier agency."* ✅ That is broad enough to reach a
freight-booking marketplace.

**s.3(1): no person shall engage in the business of a common carrier without a certificate of
registration.** Penalty under s.18 — fine up to ₹5,000 first offence, ₹10,000 subsequent. The **Jan
Vishwas (Amendment of Provisions) Act 2026 (8 of 2026), w.e.f. 15.07.2026** narrowed s.18(1) to
contraventions of **s.3 only** — decriminalisation elsewhere, but **operating unregistered remains the
punished act**. ⚠️

**Action: take a deliberate view on s.3 registration.** This is independent of the GST analysis and is
not solved by document design.

### 1.6 If BharatTruck is an ECO, it has its own obligations

"Not a GTA" ≠ "not taxed". *A V Cargo Migrators* held the platform liable for: ⚠️

- **TCS under s.52 CGST** — **0.5%** total (0.25% CGST + 0.25% SGST, or 0.5% IGST), reduced from 1% by
  Notification 15/2024-CT w.e.f. 10.07.2024
- **GSTR-8** filing
- **Mandatory registration**

### 1.7 The ECO "local delivery" trap (new, 22.09.2025)

Effective **22 September 2025**, the GTA definition **excludes** ECOs providing or facilitating **local
delivery** (Notifs. 15/2025 & 16/2025-CT(R), 17.09.2025). But being pushed out of GTA lands you
somewhere worse: **Notification 17/2025-CT(R)** notified local delivery under **s.9(5) CGST**, making
the **ECO itself liable to pay 18%** where the underlying supplier is unregistered. ⚠️

❓ **"Local delivery" is nowhere defined** — verified: the phrase appears in the operative text of
Notif. 15/2025 three times and is defined nowhere.

**For interstate long-haul this should not bite. For any last-mile or intrastate short-haul product
line, get it assessed before launch.**

### 1.8 Platform liability for a defective e-way bill — the statutory position

**No statutory provision, reported case, advance ruling or CBIC circular imposes e-way bill liability
on a third-party software provider / ASP / GSP.** ✅ (genuine absence of authority, not absence of
searching — and it cuts both ways: there is no authority *immunising* you either.)

The structure, verified: ✅

| Provision | Reaches a software vendor? |
|---|---|
| **s.122(1A)** — retains benefit / at whose instance | **No.** Lists clauses (i), (ii), (vii), (ix) only. Transporting without documents is clause **(xiv)** — not listed. Structural, not arguable |
| **s.137** — offences by companies | **No.** Internal attribution rule: an offending company → *that company's own* officers |
| **s.129** penalties | **No.** Attach to owner of the goods, person transporting, owner of the conveyance |
| **s.122(3)(a)** — "aids or abets" | **The only realistic hook.** Covers clauses (i)–(xxi), which **includes (xiv)**. Requires a knowledge/intent element. Capped at **₹25,000** |

**Design consequence.** A platform that stays neutral tooling is a conduit. A platform that
**auto-generates on assumed data, suppresses validation errors, or advises on classification and
valuation** moves toward the abetment zone. This is a product decision with legal consequences.

The realistic exposure is **contractual/tortious, not tax-statutory** — a customer penalised by a
platform bug sues in contract or negligence. That is governed by BharatTruck's own terms, which is
where the drafting effort belongs.

---

## §2 — The document triangle

```
        TAX INVOICE  (Rule 46 / Rule 54(3))
             │  supplier → recipient; the tax event
             │
             ├──► EWB-01 Part A, field A.4  "Document Number"
             │
   LORRY RECEIPT / consignment note
        (Rule 4B lineage + Rule 54(3))
             │  carrier → consignor; receipt, custody, lien
             │
             └──► EWB-01 Part B, field B.2  "Transport Document Number"
                              │
                              └──► carried in the vehicle per Rule 138A(1)(b)
                                   (physical copy, EWB number, or RFID)
                                   — the LR itself need NOT be carried
```

**FORM GST EWB-01, Note 3, verbatim:** *"Transport Document number indicates **Goods Receipt Number**
or Railway Receipt Number or Airway Bill Number or Bill of Lading Number."* ✅

**For road freight the Goods Receipt Number IS the LR number.** That is the concrete integration point:
the LR number allocated in the fleet owner's series populates **EWB-01 field B.2**.

### 2.1 What must physically travel with the truck

**Rule 138A(1)** ✅ — the person in charge of a conveyance shall carry:
(a) the **invoice or bill of supply or delivery challan**; and
(b) **a copy of the e-way bill in physical form, OR the e-way bill number in electronic form**, or
mapped to RFID.

| Document | Hard copy required? |
|---|---|
| **E-way bill** | ❌ No — the **number in electronic form** suffices ✅ |
| **Tax invoice — e-invoicing taxpayer (AATO ≥ ₹5 cr)** | ❌ No — **QR with embedded IRN** producible electronically (Rule 138A(2), Notif. 72/2020) ✅ |
| **Tax invoice — non-e-invoicing taxpayer** | ✅ **Yes** — carry the *DUPLICATE FOR TRANSPORTER* copy. Rule 138A(1)(a) has **no** electronic relaxation ❓ *(most contested item in this doc — see §10)* |
| **Delivery challan** | ✅ Yes — *DUPLICATE FOR TRANSPORTER* |
| **Bill of entry (imports)** | ✅ Yes |
| **LR / consignment note** | ❌ **Not listed in Rule 138A at all** ✅ — unless the LR *is* the tax invoice |
| **RC / Insurance / Fitness / Permit / PUC / DL** | ❌ No — **DigiLocker or mParivahan** accepted (Rule 139 CMVR; MoRTH/PIB advisory 09.08.2018) ✅ |

> ⚠️ **DigiLocker caveat:** the advisory covers documents *fetched from the government wallet*. A photo
> or PDF of the RC in the phone gallery — or in the BharatTruck app — **is not the same thing** and is
> routinely rejected. Either integrate DigiLocker properly or tell drivers to keep mParivahan as the
> fallback.

---

## §3 — LR / consignment note

### 3.1 What it legally is

There is **no GST definition** of "consignment note". ✅ Guidance comes from the **Explanation to Rule
4B, Service Tax Rules 1994**: serially numbered; consignor and consignee names; **registration number
of the goods carriage**; details of goods; place of origin and destination; person liable to pay tax.

**CBIC Flyer No. 38 (01.01.2018), echoed by every AAR since:** *"If a consignment note is issued, it
indicates that the **lien on the goods has been transferred** and the transporter becomes
**responsible for the goods till its safe delivery** to the consignee."* ✅

❓ **Is it a document of title?** **Probably not, and do not build title-transfer logic on it.** Sale of
Goods Act s.2(4) lists bill of lading and **railway receipt** but **not** a lorry receipt; it can only
enter via the residual limb. Even for the *named* railway receipt, High Courts conflict.

### 3.2 Mandatory content

**Rule 54(3) CGST Rules 2017** is the live binding provision and is routinely overlooked: ✅

> *"Where the supplier of taxable service is a goods transport agency… the said supplier shall issue a
> tax invoice **or any other document in lieu thereof, by whatever name called**, containing the
> **gross weight of the consignment**, name of the consigner and the consignee, registration number of
> goods carriage…, details of goods transported, details of place of origin and destination, **GSTIN
> of the person liable for paying tax** whether as consigner, consignee or goods transport agency,
> **and also containing other information as mentioned under rule 46**."*

So the LR must carry **Rule 54(3) fields + everything in Rule 46**, including:

- (b) consecutive serial number, **≤16 characters**, unique for a financial year
- (n)/(o) place of supply; **address of delivery where different from place of supply** ← *this is the
  field POD should geofence against, not the billing address*
- **(p) whether tax is payable on reverse charge basis** ← load-bearing; the RCM/FCM flag
- (q) signature or digital signature — **dispensed with** for electronic invoices by the sixth proviso
  to Rule 46 (Notif. 74/2018-CT) ⚠️ *(Rule 54(3) has no express proviso of its own — inference)*

**Carriage by Road Act s.9(4)** additionally requires an undertaking about carrier liability under
s.10/s.11. ✅

⚠️ **Format trap:** GST prescribes *content*, not format. But **Carriage by Road Rules 2011 Rule 10**
*does* prescribe forms — **Form 7** (goods forwarding note, by the consignor) and **Form 8** (goods
receipt, by the carrier); hazardous goods need the upper-left corner printed in **red**. Commercial
practice treats Forms 7/8 as dead letters. That is a live (low-enforcement) non-compliance — make it a
conscious decision, not an accident.

### 3.3 LR numbering — the single most damaging thing you could get wrong

**The series belongs to the fleet owner. Each fleet owner needs its own independent, gapless,
per-financial-year sequence.**

> A global platform-wide LR counter would be **direct documentary evidence that the platform, not the
> carrier, operates the numbering** — precisely the fact that flips the GTA analysis.

Rule 46(b) expressly permits *"one or multiple series"* ✅, which is what makes per-fleet-owner series
lawful.

**Build to the stricter Rule 46 standard:**

```
^[A-Za-z0-9/-]{1,16}$          # ≤16 chars; alphanumerics + hyphen + slash ONLY
unique per (fleet_owner_id, financial_year)
reset 1 April
allocated inside the SAME DB transaction that persists the LR row  # no gaps under concurrency
never renumbered after issue
```

> ⚠️ A UUID or a 20-character slug is an **invalid** GST document number. This is a common bug in
> logistics SaaS.

### 3.4 Digital LR validity

**Valid.** ✅ Three independent bases: **IT Act s.4** (electronic record satisfies a writing
requirement), **IT Act s.5** (electronic signatures), **CGST s.145** (electronic records admissible
without producing the original, subject to the s.145(2) certificate). A consignment note is **not** in
the IT Act First Schedule exclusions.

**No paper LR need travel with the vehicle** (§2.1). The real constraint is **commercial**: where the
LR is surrendered against delivery or lodged with a bank, dematerialisation breaks the workflow.
**Design hybrid** — e-LR as system of record, print-on-demand.

---

## §4 — E-way bill

### 4.1 The value formula

**Rule 138(1):** required where **consignment value exceeds ₹50,000**. ✅

**Explanation 2 — the formula, verbatim:** value under s.15, **plus** CGST/SGST/UTGST/IGST and cess
charged, **minus** the value of exempt supply *where one invoice covers both exempt and taxable goods*. ✅

```
consignment_value = section_15_value
                  + cgst + sgst + utgst + igst + cess       # INCLUDED
                  - exempt_component                         # only on a mixed invoice
```

> ✅ **₹48,000 + 5% GST = ₹50,400 → e-way bill required.** Any threshold check on pre-tax value is
> simply wrong.

**Two carve-outs requiring an EWB regardless of value** ✅ — inter-State **principal → job worker**
(third proviso, generated by principal *or* job worker if registered), and inter-State **handicraft
goods** by a person exempt from registration under s.24(i)/(ii) (fourth proviso).

### 4.2 Thresholds must be an effective-dated table

**Inter-State is ₹50,000 everywhere and no state can vary it.** ✅ Intra-state varies, and is not a
single number:

| State | Intra-state position | Confidence |
|---|---|---|
| Delhi, Bihar, Maharashtra, Tamil Nadu, Punjab | ₹1,00,000 | ⚠️ |
| **Madhya Pradesh** | **No EWB intra-DISTRICT at any value**; ₹1,00,000 inter-district; ₹50,000 tobacco/pan masala; medicines exempt | ⚠️ |
| **Rajasthan** | **₹2,00,000 intra-city / ₹1,00,000 city-to-city**, with excluded goods reverting lower | ⚠️ |
| **Goa** | ₹50,000 **but only for 22 specified goods**; all others no EWB at any value | ⚠️ |
| **Jharkhand** | ₹1,00,000 *except* specified goods | ⚠️ |
| **West Bengal** | ❓ **CONTESTED** — see §0.2 | ❓ |
| Most others | ₹50,000 | ⚠️ |

**Required schema:**

```sql
-- keyed, versioned, provenanced. NEVER a constant.
ewb_threshold(state_code, effective_from, effective_to, goods_class,
              threshold_inr, notification_ref, verified_on, verified_by)
```

You will eventually need to answer *"what was the threshold on the date of that trip."*

### 4.3 Part A / Part B lifecycle

**Part A** (API names): `fromGstin`, `fromPincode`, `actFromStateCode`, `toGstin`, `toPincode`,
`actToStateCode`, `docNo` (≤16, alphanumeric + `/` `-`), `docDate`, `totalValue`/`totInvValue`,
`hsnCode`, `subSupplyType`, `transporterId`. ✅

**Part B:** `vehicleNo`, `vehicleType` (**R** regular / **O** ODC), `transMode` (1 road, 2 rail, 3 air,
4 ship, 5 inTransit), `transDocNo` ← **the LR number**, `transDocDate`. ✅

**Part B may be omitted only** for two distinct ≤50 km, same-State legs ✅ — consignor → transporter
(third proviso to 138(3)) and transporter → consignee (proviso to 138(5)). Most secondary sources
conflate these.

> ⚠️ **Non-furnishing of Part B makes the e-way bill invalid** — full s.129 detention exposure, not a
> ₹1,000 penalty. **Validate Part-B completion before dispatch.**

**Part-A slip** — Part A alone, `transporterId` mandatory, Part B fields blank. **Valid 15 days** for
Part B updation, then status **DIS (Discarded)**. ✅

### 4.4 Validity — and the midnight rule

| Distance | Validity |
|---|---|
| Up to **200 km** | 1 day |
| Each additional 200 km or part | +1 day |
| **ODC / multimodal with a ship leg**: up to 20 km | 1 day, +1 per 20 km |

✅ 200 km replaced 100 km w.e.f. 01.01.2021 (Notif. 94/2020-CT).

**Explanation 1:** each day expires at **midnight of the day immediately following the date of
generation** ✅ — so an EWB raised at 23:55 has ~24 hours and one raised at 00:05 has ~48.

> **Use the `validUpto` the API returns. Do not recompute the midnight rule yourself.**

**Extension** ❓ — Rule 138(10) proviso and NIC's FAQ say **8 hours after expiry only**; the NIC API
validations page and error 382 say **8 hours before or after**. The API is what gates you. Only the
**current transporter** may extend. **360-day cap** on cumulative extension (error 821).

### 4.5 Mid-transit changes — and the one-way door

**Part B updates are UNLIMITED** within validity ✅ — vehicle breakdown, transhipment, substitution all
use *Update vehicle number* with reason codes (1 breakdown, 2 transshipment, 3 others, 4 first time).

> 🔴 **Rule 138(5A) — the one-way door.** *"Provided that after the details of the conveyance have been
> updated by the transporter in Part B, the consignor or recipient… shall NOT be allowed to assign the
> e-way bill number to another transporter."* ✅

**This constrains the marketplace directly.** A *vehicle* change within the same transporter is fine.
A **carrier** swap after Part B is entered desyncs the platform from the EWB system permanently.

> This modifies founder decision Q17. *"Fleet owner redoes the e-way bill and truck assignment"* works
> for a **breakdown** (same transporter, new vehicle = a Part B update). It does **not** work if the
> load moves to a **different fleet** mid-transit — that must happen before Part B, or needs
> cancel-and-regenerate.

**Cancellation: 24 hours** from generation ✅ (API error 728 says from Part B entry ❓ — unreconciled),
generator only, **impossible once verified in transit**. **Rejection / deemed acceptance: 72 hours.** ✅

**Consolidated EWB (EWB-02)** is a **trip sheet with no independent validity** — constituent EWBs must
each stay valid. ✅

### 4.6 Exemptions — Rule 138(14)

15 clauses (a)–(o) ✅. Most relevant: non-motorised conveyance; customs-bond and customs-supervised
movement; **alcohol, petroleum crude, HSD, petrol, natural gas, ATF**; Schedule III no-supply; transit
cargo to/from **Nepal or Bhutan**; defence formations; **empty cargo containers**; ≤20 km to a
weighbridge and back under a Rule 55 delivery challan; **empty LPG cylinders** for non-supply.

**The Annexure has 8 entries** ✅ (LPG for household/NDEC; PDS kerosene; postal baggage; Ch. 71 pearls
and precious metals; Ch. 71 jewellery **excepting imitation jewellery 7117**; currency; used personal
and household effects; coral). See §0.2 for the 154-item myth.

### 4.7 Rule 138E — blocking, and what it means for the product

A counterparty gets **blocked from Part A** if they have not filed GSTR-3B for 2 consecutive periods,
GSTR-1 for any 2 periods, CMP-08 for 2 quarters, or their registration is suspended. ✅ In force since
21.11.2019 and actively enforced.

API errors **715** (consignor), **716** (consignee), **717** (transporter).

> A counterparty can go blocked mid-relationship through no fault of BharatTruck's. **Surface this as
> *"your shipper's GST filing is overdue"*, not as a system error.**

### 4.8 Integration — the GSP/ASP model

```
BharatTruck (ASP)  →  GSP  →  NIC EWB system
                            ↑
        the customer's own API username + password
        (created by THEM on the EWB portal)
```

- **There is no GSTN empanelment for ASPs.** You simply contract with a licensed GSP. ✅
- **Direct NIC access is impractical** — prerequisites page names ~**10,000 transactions/month per
  GSTIN**, an SSL domain, and max **3 Indian static IPs** whitelisted ⚠️ *(the onboarding page names no
  threshold — the two NIC pages differ ❓; confirm with a GSP)*. Note the ₹10cr/₹5cr turnover figures
  circulating online are about **e-invoicing/IRP**, not e-way bills — do not conflate.
- **Sandbox is free and open** at `einv-apisandbox.nic.in`. **The API contract is identical**, so the
  GSP choice is a base-URL-and-credentials swap, not a rewrite. ✅
- ⚠️ At least one GSP requires **ISO 27001:2013** within 90 days of go-live — a 3–6 month exercise.
  **Budget for it early; it gates go-live.**

**Per-customer onboarding step that CANNOT be automated** ✅ — for every shipper *and* every fleet
owner:

1. Log into `ewaybillgst.gov.in`
2. **Registration → For GSP**
3. Send OTP → Verify OTP
4. Select the GSP from a dropdown
5. Create an **API username + password** (distinct from portal login)
6. Hand those to BharatTruck

~2 minutes, OTP-gated, per GSTIN. **This is the biggest onboarding-funnel drop-off risk in the
product.** Build a guided wizard for it.

**Auth:** `POST /v1.03/auth`, RSA-encrypted credential envelope, returns `authtoken` + `sek`.
**Token lives 6 hours and does NOT slide** — re-calling auth returns the same token without resetting
the clock. Cache it. ✅

**Validations that will bite** ✅:

- **`transDistance`: pass `0`** and let NIC fill it from its pin-to-pin table. Eliminates a whole error
  class (error 702). Max 4,000 km.
- 🔴 **E-invoice blocking (errors 720/856):** if the supplier is **e-invoice enabled (AATO ≥ ₹5 cr)**,
  B2B/export **tax invoices must generate the EWB via the IRN/e-invoice system, not the EWB API.**
  **Either build both integrations or exclude shippers above ₹5 cr.**
- No two EWBs on the same consignor document number (error 604). **250 items max.** Document date
  cannot be older than **180 days** (error 820).
- Vehicle formats: `AB12A1234`, `AB12AB1234`, `ABC1234`, `DFXXXXXX`, `TMXXXXXX`, `BPXXXXXX`, `NPXXXXXX`.
- **Portal affinity (errors 444/445/448/449):** an EWB generated on NIC1 cannot be cancelled on NIC2.
  **Track which portal issued each EWB.**

### 4.9 Identifiers

| Identifier | Who | Notes |
|---|---|---|
| **GSTIN** | Registered transporter | **Is** the Transporter ID. A GSTIN-holder **cannot also enrol** for a TRANSIN — the portal blocks it at PAN validation ✅ |
| **TRANSIN** | Unregistered transporter, via **FORM GST ENR-01** (Rule 58(1)) | 15 chars, GSTIN-shaped: `2 state + 10 PAN + 1 entity + Z + 1 check` ⚠️ (layout evidenced by official API samples; positions 13/14 inferred). **Cannot be `fromGstin` or `toGstin`** (error 370) ✅ |
| **ENR-02 common enrolment** | Multi-State transporter on one PAN | 15 digits **starting with 88**; once obtained the GSTINs can no longer be used for Chapter XVI ✅ |
| **ENR-03 Enrolment ID** | Unregistered supplier/recipient | 15 chars; **usable in place of a GSTIN** on an EWB. Live **11.02.2025** (Notif. 12/2024-CT, commenced by 09/2025-CT). Aadhaar is **optional** — reject "biometric Aadhaar" framing ✅ |
| **Citizen enrolment** | One-off consumer | **No identifier, no account** — per-transaction mobile OTP ⚠️ |

> **Product requirement:** GSTIN-or-TRANSIN becomes a **required fleet-owner onboarding field**.
> Without one the shipper literally cannot assign the load in the EWB system — so it gates *bidding*,
> not just paperwork.

---

## §5 — Proof of Delivery

### 5.1 There is no statutory POD

**No Indian statute defines, prescribes the form of, or mandates a "proof of delivery."** ✅ POD is a
creature of contract and commercial custom. What the law gives instead:

- **Carriage by Road Act s.9** — goods receipt in **triplicate**, original to consignor; **prima facie
  evidence** of weight, measure and other particulars ✅
- **s.12** — the plaintiff **need not prove negligence**; liability attaches without fault ✅
- **s.17** — carrier not liable for act of God, war, riots, legal seizure, government order — *provided
  it exercised due diligence* ✅
- **Contract Act s.170** — **particular lien**: the carrier may retain goods for unpaid freight ⚠️

> **In practice the signed-and-stamped consignee copy of the LR is the operative proof.** And **the
> rubber stamp matters more than the signature** — a signature alone is routinely challenged as "some
> loader signed it". Any ePOD that captures only a finger-drawn signature and no stamp is **weaker than
> the paper it replaces**. Capture a photo of the stamped document alongside any digital signature.

### 5.2 Evidentiary design — the highest-leverage decisions

The **Bharatiya Sakshya Adhiniyam 2023 (BSA)** replaced the Indian Evidence Act **w.e.f. 01.07.2024**.
**s.63 BSA** is the successor to s.65B. ✅

Three changes to design for:

1. **s.63(4) certificate now needs TWO signatures** — the record custodian **and an expert**. ⚠️
   The Schedule prescribes **Part A** (party) and **Part B** (expert), and **Part B requires the hash
   value and the algorithm** (SHA-1, SHA-256, MD5 or other acceptable standard).
2. **"at each instance where it is being submitted"** — a fresh certificate per filing. The system must
   **regenerate a certificate on demand, years later, over the same record with the same hash.** ✅
3. ❓ **Who is an "expert" is undefined.** Candidates: an Examiner of Electronic Evidence notified under
   **IT Act s.79A**, or any person with special skill. No settled ruling. Build so integrity is
   **independently verifiable** by any competent expert.

**s.63(3)** treats multiple devices used together as **a single computer** ✅ — so driver phone + API +
Postgres + object storage are one device for evidentiary purposes. You do not certify each hop.

**IT Act s.7 is effectively a spec:** records must remain **accessible and usable**, retained **in the
format originally generated** (or demonstrably accurate), with **origin, destination, date and time**
preserved as retrievable metadata. ✅

### 5.3 🔴 The EXIF trap

**EXIF metadata is freely alterable** (ExifTool rewrites GPS, timestamps, device IDs). Courts treat it
as **supporting** evidence only. **A POD system whose integrity story is "the photo has a geotag" will
lose a contested dispute.** ⚠️

### 5.4 Capture spec

**Hard rules:**

1. **Camera-only capture. Disable gallery import.** A gallery-sourced image destroys provenance and is
   the most common fraud vector.
2. **Hash SHA-256 on device, before upload.** Server-side-only hashing proves integrity from the server
   onward — exactly the segment nobody disputes.
3. **Never re-encode the original** (IT Act s.7(b)). Serve derivatives; retain originals byte-identical.
   *Re-compressing POD photos on upload is the single most common way logistics apps destroy their own
   evidence.*
4. **Server time is authoritative.** Store device time as a claim, plus `clock_skew_seconds` — a large
   skew is itself a fraud signal.
5. **Append-only audit log** — access, export, modification attempts — retained as long as the POD.

**Capture-time fields:** `sha256_original`, `captured_at_device`, `captured_at_server`,
`clock_skew_seconds`, `lat`/`lng`/`gps_accuracy_m`, `gps_source` + **`mock_location_detected`**,
`geofence_result` (distance from the **Rule 46(o)** delivery address), `device_id`, `os_version`,
`app_version`, `driver_id`, `booking_id`, `lr_number`, `capture_method`.

**Server-side:** `sha256_received` (assert equality), `original_bytes_uri` (WORM / object-lock,
versioned, deletion disabled for the retention period), `exif_raw` preserved verbatim but never relied
on alone, `merkle_root` / daily anchor, `audit_log`.

### 5.5 The control combination that actually holds up

| Control | Verdict |
|---|---|
| Photo alone | ❌ trivially defeated |
| Geotag alone | ❌ mock-location apps; collapses once contested |
| **Continuous GPS trail** | ✅ **strong** — must be internally consistent over hours. Best fake-delivery defence |
| **Server-side timestamp** | ✅ strong, nearly free |
| **OTP to the consignee's registered phone** | ✅ **strongest single control** — the secret is held **off the driver's device**. Weakness is social (drivers phone ahead). **Mitigate: gate OTP issuance on a geofence-entry event** |
| **QR on the consignment, scanned at delivery** | ✅ strong **for identity of the goods** — which photo and OTP do not address at all |
| **Expected-vs-actual count** against a **server-held** quantity the driver cannot edit | ✅ **strong** — pilferage depends on paperwork agreeing with the reduced quantity |
| Consignee stamp photograph | ⚠️ moderate — forgeable, but a materially higher bar |
| **Lock consignee/address/drop sequence after dispatch** | ✅ strong and cheap — kills diversion fraud |
| **Seal number captured at load and unload** | ✅ strong — classic control |
| **Hash + append-only audit log** | ✅ **essential** — makes all the others credible |

> Together these require **driver, consignee and someone with server access to collude
> simultaneously.** Be candid internally: **none of this defeats the sedated-hijack / GPS-jamming
> pattern**, where cargo is gone before any delivery event. That is insurance and route-risk scoring,
> not POD. Don't overclaim.

### 5.6 The receiver flow must assume zero app installation

Contactless POD via **OTP-SMS, missed call, and WhatsApp** exists precisely because Indian
consignee-side staff will not install an app. ⚠️ **Design the no-install path as primary, not
degraded — and make it work on a feature phone.**

### 5.7 Discrepancy capture — the most under-built part of every ePOD

**Discrepancies must be noted on the LR at the moment of delivery.** Industry sources are blunt: failure
to note shortages or damage at delivery is the most common reason claims are denied outright. ⚠️

Capture, as structured data rather than a free-text remarks box:

- **expected vs actual quantity** as two numeric fields, delta computed and shown
- **typed discrepancy reason** — shortage / damage / wrong goods / refusal / partial acceptance
- **mandatory photo when delta ≠ 0**, geofenced and timestamped
- **dual acknowledgement** — driver *and* consignee both confirm on record (the digital analogue of a
  joint certificate)

**Then surface both claim clocks automatically:**

| Clock | From | Source |
|---|---|---|
| **180 days** — written notice to the carrier, a **pre-condition to suit** | **date of BOOKING** | Carriage by Road Act s.16 ✅ (Rajasthan HC, Jan 2025) |
| **7 days** — insurance claim intimation | date of **delivery** | policy terms ⚠️ |
| 3 years — contract suit | breach | Limitation Act Art. 55 ✅ |

> The 180-day clock runs **from booking, not delivery or discovery**. On a long haul with a paper POD
> returning in 10–20 days, a large part of the window burns before anyone knows there is a claim.
> Surfacing it turns POD from a record into a **claims-preservation tool**.

### 5.8 Freight terms are first-class, not a note

| Term | Meaning | POD interaction |
|---|---|---|
| **Paid** | consignor pays at booking | POD closes delivery only |
| **To Pay** | **consignee pays at delivery, before goods are released** | carrier exercises the **s.170 lien**; POD and payment are simultaneous |
| **To Be Billed** | billed later on credit | **POD submission triggers invoicing** |

> ⚠️ **"To Pay" is the informal sector's built-in escrow.** Any flow where POD-marks-delivered
> automatically releases the goods before payment is recorded **removes the only leverage a small
> operator has.** Model this as an enum; it also interacts with Rule 46(p) and the Rule 54(3) "person
> liable for paying tax."

---

## §6 — QR code design

> 🔴 **Do not encode consignment details in the QR payload.** A QR on a carton passes loaders, dhabas,
> godowns and toll plazas. If it encodes consignor/consignee names, addresses, phones and goods
> description, you have built a **broadcast disclosure** *and* handed cargo thieves a **target-selection
> tool** — the scanner learns the goods are pharmaceuticals and where they are going. Insider
> involvement is ~22% of cargo theft, with notable concentration in India. ⚠️

The DPDP defence does not work: **s.3(c)(ii)** exempts data made public **by the Data Principal** or
under a **legal obligation to publish**. A QR published by the platform is neither. ⚠️

**Copy the GST e-invoice QR model** ✅ — it carries only identifiers, is digitally signed, and is
**verified against the portal** rather than being self-describing.

**Required design:**

1. **Payload = opaque high-entropy token** + short integrity checksum. Not a booking ID, not
   sequential, nothing human-readable.
2. **Anonymous scan → minimal validity view only** — *"Valid consignment. Status: In transit."* No
   names, addresses, goods description or phone numbers.
3. **Full detail requires authorisation** — logged-in shipper/consignee/driver, or a one-time OTP to
   the registered consignee number.
4. **Log every scan** — server timestamp, IP, geolocation, authenticated identity. Simultaneously a
   privacy control, a **diversion-fraud signal**, and corroborating POD evidence.
5. **Rate-limit and alert on enumeration.**
6. **Rotate or expire** the token after delivery + a window.
7. Consider **signing** the token so authenticity is verifiable offline without disclosing anything.

> A QR scan is an **independent server-side event** that cannot be forged on the device. That pairing —
> photo *and* QR — is the real evidentiary value.

---

## §7 — Penalties, detention, and case law

### 7.1 Section 129 (as substituted w.e.f. 01.01.2022)

| Scenario | Taxable goods | Exempted goods |
|---|---|---|
| **129(1)(a)** owner **comes forward** | **200% of tax payable** | 2% of value or ₹25,000, whichever is **less** |
| **129(1)(b)** owner **does not** | **higher of** 50% **of goods value** *or* 200% of tax | 5% of value or ₹25,000, whichever is **less** |

✅ The pre-2022 "tax + 100% penalty" formula is **gone** — it is now **penalty only, no tax component**.

> 🔑 **Circular 76/50/2018-GST, Sl. No. 6:** *"if the invoice or any other specified document is
> accompanying the consignment, then **either the consignor or the consignee should be deemed to be the
> owner**."* ✅
>
> **So "does the driver have the invoice?" is worth more than any other single compliance check.** It
> keeps the case in the cheaper (a) bucket and keeps the transporter out of the 50%-of-goods-value
> bracket. One checklist item at dispatch.

**s.129(6) proviso:** the **conveyance is released on the transporter paying the s.129(3) penalty or
₹1,00,000, whichever is LESS.** ✅ A hard cap on a fleet owner's exposure for the truck itself — worth
surfacing in-product.

**s.126 does not help** — s.126(6) disapplies it where the penalty is a fixed percentage, which s.129
is. ✅ Relief comes from Circular 64 and the courts.

### 7.2 Circular 64/38/2018 — a free validation spec

Where the consignment carries **both** an invoice and an e-way bill, s.129 proceedings **may not** be
initiated for, *inter alia* (the list is **illustrative, not exhaustive** ✅):

| | Error |
|---|---|
| (a) | spelling mistake in consignor/consignee name, **GSTIN correct** |
| (b) | PIN code error, address otherwise correct — **provided it does not increase EWB validity** |
| (c) | consignee address error where locality and other details are correct |
| (d) | error in **one or two digits of the document number** |
| (e) | error at 4/6-digit HSN where **first 2 digits and the tax rate are correct** |
| (f) | error in **one or two digits/characters of the vehicle number** |

Penalty instead: **₹500 CGST + ₹500 SGST (₹1,000 IGST) per consignment**, under s.125 via DRC-07. ✅

> **Hard-block these six classes at input.** It protects customers from detention **and evidences the
> platform's own diligence** — which is exactly what keeps it clear of the s.122(3)(a) abetment
> analysis (§1.8).

### 7.3 Circular 49 para 3.2 — critical for part-loads

**Only goods/conveyances in respect of which a violation is established may be detained.** ✅
Illustration: a conveyance with **25 consignments**, valid documents for 20 and none for 5 → detention
**only as to the 5**.

> **Enforce per-consignment document integrity independently**, or one defaulting shipper takes down
> the whole vehicle.

### 7.4 Case law — mens rea

High Courts have **converged on mens rea being required for s.129** ⚠️. Leading authority:
**Satyam Shivam Papers** (Telangana HC 02.06.2021; **SLP dismissed by SC 12.01.2022** with costs
against Revenue) ✅ — e-way bill expired because a political rally blocked the road; no intent to
evade; demand quashed.

Followed by *Roli Enterprises*, *Hindustan Herbal Cosmetics* (typo in vehicle number — technical
breach), *Varun Beverages* (14-hour expiry, breakdown), *Kunal Aluminum* (HP HC 26.06.2025),
*Gaylord Packers* (Allahabad 17.07.2025, one-digit invoice error), *Balkrishna Industries* (Gujarat
23.02.2026, ~15 hours past expiry on a zero-rated export).

**The case that went the other way:** *Vardan Associates* (SC 31.10.2023) — but the delay was **over a
week**, a fresh EWB could have been generated and wasn't, and 🔴 **the order expressly states it is
passed under Article 142 and "shall not be treated as a precedent."** ✅

> **The operative distinction is not "expired e-way bill" — it is the length and explicability of the
> delay, and whether a fresh e-way bill could have been generated and wasn't.**
>
> **Product consequence: make regeneration and extension one tap, and LOG THE ATTEMPT.** "Could have
> regenerated and didn't" is what loses these cases.

❓ There is **settled High Court doctrine but no binding Supreme Court ratio** — Satyam Shivam was an
SLP dismissal on facts, Vardan was expressly non-precedential. Say so when advising customers.

⚠️ **Circular 41's MOV-01…MOV-11 procedure is a 2018 procedure running against a 2022 statute** — its
"tax and penalty" framing no longer matches s.129. **No post-2022 replacement circular exists.** That
mismatch is itself a litigation argument.

---

## §8 — Retention, records, and DPDP

### 8.1 Retention

**CGST s.36: 72 months from the DUE DATE OF FURNISHING THE ANNUAL RETURN** for the relevant FY ✅ —
*not* from the invoice date. Roughly 6 years 9 months from the start of the FY.

**Extended proviso:** where the person is party to an appeal/revision/proceeding **or is under
investigation** — records on that subject matter kept until **1 year after final disposal**, or the
above period, whichever is **later**. ✅ *Investigation alone triggers it.*

> **Recommended POD/document retention: 8 years from end of financial year.** That is defensible as
> *"retention necessary for compliance with law"* under **DPDP s.8(7)** — which is your answer to an
> erasure request. **Write it down as a policy with the statutory citations in it**; the carve-out is
> only as good as the obligation you can point at.

**Who bears the duty:** **s.35(2)** binds *"every transporter, **irrespective of whether he is a
registered person or not**"* ✅; **Rule 58(4)(a)** requires records of goods transported, delivered and
stored in transit with consignor/consignee GSTINs **per branch**.

**The duty stays with the fleet owner — it does not transfer to BharatTruck.** ✅ Nothing permits
delegating the *duty*, only the *mechanics*.

### 8.2 Electronic records — cloud is fine

**Rule 56(16):** manual records must be **kept at** the place of business; digital records need only be
**accessible at** it. ✅ **The statutory test for digital records is accessibility, not server
location** — cloud hosting is compatible.

**Rule 57** conditions: proper **back-up** restorable within a reasonable time; production **in hard
copy or electronically readable format**; and on demand, **file details, passwords, and explanation of
codes**, plus a sample in print. ✅

**Rule 56(8):** no entry erased or overwritten; **a log of every entry edited or deleted** must be
maintained. ✅ **Rule 56(15):** electronic records authenticated by **digital signature**. ✅

> **Design implication — and it is a compliance control, not a commercial nicety:** the fleet owner
> must be able to export their **complete** record set **unaided**, machine-readable *and* print,
> branch-wise with GSTINs, for 72+ months. **A platform that can hold a carrier's statutory records
> hostage has created a regulatory problem for its own customer.** Data portability and offboarding
> terms belong in the contract.

⚠️ **No CBIC circular exists** on cloud/off-premises/third-party record storage. The above is built
from the rules, not departmental guidance.

### 8.3 DPDP Act 2023 / Rules 2025

Act assented **11.08.2023**; **Rules notified November 2025**, phased — most substantive obligations
bite around **mid-2027** ⚠️ (verify commencement dates against the notification).

- **Photographs of identifiable individuals are personal data.** ✅
- **s.8(7)** — erase on withdrawal of consent or when the purpose is served, **subject to retention
  necessary for compliance with law** ← the GST s.36 / CBR s.16 shield.
- The **fixed 3-year erasure** rule applies only to very large classes (e-commerce ≥2 crore users etc.)
  — **a freight marketplace will not hit these**. Purpose limitation still applies. ⚠️
- Penalties up to **₹250 crore** for failure of reasonable security safeguards. ⚠️

**Three specific POD risks:**

1. **Faces in POD photos** — cleanest mitigation is **don't capture them**. Instruct drivers to
   photograph **goods and the stamped document**, not the person. If you must, auto-blur a derivative
   **but retain the unblurred original** for evidentiary integrity — these pull in opposite directions
   and the resolution is **access control, not deletion**.
2. **Photos of documents** carry names, addresses, GSTINs (PAN-derived for proprietorships). Treat as
   personal data.
3. **The QR** — see §6.

---

## §9 — Build requirements (the actionable distillation)

### 9.1 Data model

```
-- Identity / compliance
fleet_owner.gstin_or_transin          REQUIRED at onboarding — gates BIDDING, not just paperwork
fleet_owner.tax_posture               RCM (default) | FCM, with elected rate (5% no-ITC | 18% ITC) + effective FY
fleet_owner.lr_series                 per-owner prefix + FY-scoped counter

-- LR
lr.number                             ^[A-Za-z0-9/-]{1,16}$ ; unique per (fleet_owner, FY) ; reset 1 Apr
                                      allocated in the SAME txn as the row ; never renumbered
lr.freight_term                       enum: PAID | TO_PAY | TO_BE_BILLED     -- first-class, not a note
lr.issuer_*                           fleet owner legal name / GSTIN / address — NEVER the platform

-- E-way bill
ewb.number, ewb.generated_at, ewb.valid_upto        -- valid_upto FROM THE API, never recomputed
ewb.issuing_portal                    enum: NIC1 | NIC2                      -- portal affinity matters
ewb.part_b_entered_at                 -- after this, carrier reassignment is IMPOSSIBLE (Rule 138(5A))

-- Thresholds
ewb_threshold(state_code, effective_from, effective_to, goods_class,
              threshold_inr, notification_ref, verified_on)                  -- NEVER a constant

-- POD evidence
pod_photo.sha256_original             -- hashed ON DEVICE, before upload
pod_photo.original_bytes_uri          -- WORM / object-lock, versioned, NEVER re-encoded
pod_photo.captured_at_server          -- authoritative ; device time stored as a claim
pod_photo.clock_skew_seconds, mock_location_detected, gps_accuracy_m
pod_photo.geofence_result             -- vs the Rule 46(o) DELIVERY address, not billing
pod_delivery.expected_qty             -- SERVER-HELD, driver cannot edit
pod_delivery.actual_qty, discrepancy_type
audit_log                             -- append-only ; access, export, modification attempts
```

### 9.2 Validation gates

- [ ] Threshold check on **GST-inclusive** consignment value (§4.1)
- [ ] **Part B present before dispatch** — absence = full s.129 exposure (§4.3)
- [ ] Hard-block the **Circular 64 six error classes** at input (§7.2)
- [ ] **Per-consignment** document integrity for part-loads (§7.3)
- [ ] Refuse EWB API path for **e-invoice-enabled shippers (AATO ≥ ₹5 cr)** — route to IRN or exclude (§4.8)
- [ ] Invoice/LR number regex `^[A-Za-z0-9/-]{1,16}$` (§3.3)

### 9.3 Alerts and prompts

- [ ] **E-way bill expiry** — replicate the portal's 4-day window as a driver-app push. Mid-transit
      expiry is the most common cause of detention (§4.4)
- [ ] **"Does the driver have the invoice?"** at dispatch — highest-value single check (§7.1)
- [ ] **Rule 138E blocking** surfaced as *"your counterparty's GST filing is overdue"* (§4.7)
- [ ] **Annexure V / VI window, 1 Jan – 31 Mar** — per-fleet-owner annual prompt. Most carriers will
      miss it, and the cost is a whole FY on the wrong charge mechanism (§9.5)
- [ ] **180-day claim clock from BOOKING** + 7-day insurance clock, the moment a discrepancy is logged (§5.7)

### 9.4 What this means for existing services

| Service | Change implied |
|---|---|
| **`bt-pricing-service`** | 🔴 The cost-derived rate card (PR #38) must be positioned as **price discovery / benchmark**, never as the platform *setting* the freight price. Red line 3, §1.3. Founder Q20 and the GTA analysis agree — keep them agreed |
| **`bt-payment-service`** | Freight must not be invoiced or taken **in the platform's own name as principal**. Collection-agent framing only (§1.3) |
| **`bt-booking-service`** | Carrier reassignment must be **blocked once `part_b_entered_at` is set** (§4.5). Booking lifecycle gains LR + EWB states |
| **`bt-fleet-service`** | GSTIN/TRANSIN required; per-owner LR series; tax posture; the Annexure V/VI prompt |
| **POD (currently receiver-email OTP)** | Superseded by §5 — geofence-gated OTP, camera-only hashed photos, QR scan, structured counts. The **no-install receiver path is primary** (§5.6) |

### 9.5 GTA tax posture — the annual trap

Current rates (w.e.f. **22.09.2025**, Notif. 15/2025-CT(R)) ✅:

| Option | Rate | ITC | Who pays |
|---|---|---|---|
| Merit | **5%** | ❌ none | RCM **or** FCM |
| Standard | **18%** | ✅ full | Forward charge |

**The 12% option is gone.**

**RCM applies** where the recipient is a factory, registered society, co-operative society,
**any registered person**, body corporate, partnership firm/AOP, or casual taxable person ✅
(Notif. 13/2017-CT(R), Sl. No. 1). Outside those, the GTA pays under forward charge.
**GTA services to an unregistered person are exempt** under entry **21A** ⚠️ *(believed in force, not
primary-verified)*.

**Election mechanism:** **Annexure V** to opt into forward charge, **Annexure VI** to revert to RCM.
Window: **on or after 1 January and not later than 31 March of the PRECEDING financial year** ✅.
The election is **deemed to continue** for future years unless reverted (Notif. 06/2023-CT(R),
27.07.2023). *"15 March" and "re-file annually" are both stale.*

---

## §11 — Real-world document specimens (verified 2026-08-06)

Everything above is derived from statute and rulings. This section is derived from **actual production
documents** supplied by the founder: two VRL Logistics lorry receipts, two Destinio Clothing tax
invoices (below the e-invoicing threshold), and one Maru Enterprises **e-invoice** (above it, carrying
a live IRN and signed QR). Field names below are the ones real Indian operators actually print.

> **Why this matters more than a template:** the statute tells you what must be present. These tell you
> what a consignee, a checkpoint officer and an accounts team actually *expect to see* — and the gap
> between the two is where a generated document gets rejected in practice.

### 11.1 What the specimens CONFIRM

| Claim in this document | Specimen evidence |
|---|---|
| LR is issued in triplicate (Carriage by Road Act s.9) | VRL LR is marked **"CONSIGNEE'S COPY"**; founder confirms three copies — Transporter, Consignee, Consignor |
| Invoice numbering ≤16 chars, `[A-Za-z0-9/-]`, FY-scoped | `2026-27/11`, `2026-27/12` (Destinio, 10 chars) · `MA/4135/2526` (Maru, 12 chars) |
| Invoice copies are designated (Rule 48(1)) | **"Original Copy"** / **"Original For Receipient"** [sic] printed top-right |
| Rule 46(n)/(p) fields are real, not theoretical | **"Place of Supply : Karnataka (29)"**, **"Reverse Charge : N"** printed as their own labelled fields |
| The document triangle (§2) | Invoice carries **GR/RR No** + **E-Way Bill No** fields; the LR carries **Invoice No**, **Invoice Value** and **EwayNo** |
| ≥₹5 cr suppliers must use the IRN path | Maru's invoice carries **IRN** (64-hex), **ACK No**, **ACK Date** and a signed QR. Destinio's carries none |
| The consignee's **stamp** matters (§5.1) | VRL acknowledgement block reads *"Receiver's Signature, Name & **Seal**"* |
| "To Pay" is a first-class freight term (§5.8) | VRL LR prints **TOPAY** as a boxed field, alongside delivery mode **GODOWN** |
| Rule 48(4) exemption declaration (Notif. 26/2022) | VRL prints the full *"we are not required to prepare an invoice…"* declaration in the margin |

### 11.2 LR / consignment note — the real field set

Beyond the statutory minimum in §3.2, every one of these appears on the VRL specimens:

**Identity block (transporter)** — legal name, registered office, CIN, FSSAI licence, toll-free number,
email, website, **Transporter ID (= the GSTIN, `29AABCV3609C1ZJ`)**, PAN.

**Routing** — `FROM` origin branch + branch code + phone · `TO` destination + code + phone ·
**Booking Date** · **ETD** · **EntBy** (booking operator id — the audit trail).

**Cargo** — `Articles` (piece count) · **`A.Weight` (actual) vs `C.Weight` (charged)** · `Rate` ·
`RateType` (NORMAL) · `Volume discount` · **Description prefixed *"(said to contain)"*** — the carrier's
legal hedge, since they never open the packaging.

> ⚠️ **Actual vs charged weight is not cosmetic.** Freight bills on `C.Weight`, which is
> `max(actual, volumetric)`. A schema storing one weight cannot reproduce a real freight bill.

**Parties** — Consignor name + GSTIN + PAN · Consignee name + GSTIN.

**Linkage** — `Invoice No` · `Invoice Value Rs.` · **`EwayNo`**.

**Commercials** — `Service Category: Transport of Goods By Road` with **`SAC 996511`** · freight term
(**TOPAY**/PAID) · delivery mode (**GODOWN**/door) · `Loading/Unloading By: ☐ Consignor ☐ Consignee` ·
charge lines **Freight + Stationary charges + Hamali/Handling charges = Total**.

**Trailer** — LR number **printed twice, once as a barcode** · bank details for NEFT/RTGS ·
acknowledgement block · **"BOOKED AT OWNER'S RISK"** (the Carriage by Road Act s.10/s.11 risk-rate
election) · free-storage terms (7 days Greater Mumbai & Delhi NCR, 15 days elsewhere) · jurisdiction
clause.

### 11.3 Tax invoice — the real field set

**Header** — supplier GSTIN · **copy designation** · `TAX INVOICE` · supplier name, address, email ·
`Invoice No` · `Dated` · **`Place of Supply` with state code** · **`Reverse Charge: Y/N`**.

**Dispatch block** (the join to the LR) — `GR/RR No` · `Transport` · `Station` · `E-Way Bill No`.
Maru's richer variant adds `LR No` + date, **`Broker`**, delivery agent + their GSTIN, `CH.No`
(challan), `Order No`, `P.O.`, and **`Cr.Days` + `Due On`** (credit terms, printed in red).

**Parties** — **`Billed to` and `Shipped to` as separate blocks**, each with address, state + code,
pincode, GSTIN/UIN. Rule 46(o)'s "address of delivery where different from place of supply" is exactly
this, and §5.4 says the POD geofence must target the *Shipped to* address.

**Lines** — S.N. · Description · **HSN/SAC** · Qty · Unit · List Price · Discount% · Price · Amount.
Sub-lines carry size/colour breakdowns.

**Totals** — tax rows (CGST/SGST or **IGST** for inter-state) · **TCS** row (s.206C(1H)) · Round Off ·
Grand Total · a **tax-rate summary table** (Rate / Taxable Amt / Tax Amt / Total Tax) ·
**amount in words** · bank details · terms · `Receiver's Signature` · `for <SUPPLIER> / Authorised
Signatory`.

**E-invoice only (≥₹5 cr)** — **IRN** (64-hex SHA-256), **ACK No**, **ACK Date**, and the **signed QR**.

### 11.4 What the specimens teach that statute does not

1. **The invoice value on the LR is hand-keyed and drifts.** LR `1105853234` records
   `Invoice Value Rs.: 74741` and invoice `2026-27/11` totals **₹74,741** — an exact match. LR
   `1105854020` records `127552` against invoice `2026-27/12`, which totals **₹1,91,328** — a
   ₹63,776 discrepancy. A booking clerk retyped it. **A platform that generates both eliminates this
   entire class of error**, and consignment value drives the e-way bill threshold (§4.1), so the
   discrepancy is not merely clerical.
2. **Both parties print the other's document number.** The invoice reserves space for the LR and
   e-way bill; the LR reserves space for the invoice number, value and e-way bill. Neither is
   generated by the party printing it — they are transcribed. Same fix.
3. **The e-way bill number exists before either document is complete.** VRL prints `EwayNo` on a
   pre-printed LR, and the Destinio invoices leave `E-Way Bill No` blank. Confirms **D-17**: at MVP we
   *record and attach* an externally-generated number rather than generating one.

### 11.5 The e-way bill condition — VERIFIED against specimens

§4.8 states that a supplier who is **e-invoice enabled (AATO ≥ ₹5 cr)** must generate the e-way bill
**through the IRN/e-invoice system, not the EWB API** (NIC errors 720/856). The specimens show both
sides of that line in the same document set:

| Supplier | IRN present? | e-way bill path |
|---|---|---|
| **Maru Enterprises Pvt Ltd** | ✅ IRN + ACK + signed QR | **IRN path only** — the EWB API would reject it |
| **Destinio Clothing Co.** | ❌ none | EWB API path available |

**Consequence for the build, unchanged from D-17:** we support **neither generation path** at MVP.
Supporting both means a GSP contract *and* a second IRP integration (`BLOCKERS.md B-3`). We record the
number, its validity and the issuing portal, and we alert on expiry — which is where the detention
risk actually sits (§4.4).

> VRL's LR prints *"Auto E-way Bill extension is enabled with NIC integration"* — direct NIC API
> access, which §4.8 shows requires ~10,000 transactions/month per GSTIN. A national carrier clears
> that bar. **A marketplace and its shippers do not**, which is precisely why the GSP route is the
> only viable one for us.

---

## §10 — Open questions and unverified items

Do not build load-bearing logic on anything in this list without independent verification.

1. ❓ **Whether issuance is the GTA *test* or merely *evidence*.** Reading A (formal/documentary —
   *Flipkart*, CBIC Flyer 38, WB Directorate) and Reading B (substantive/liability — *K M Trans
   Logistics*, Rajasthan AAAR 20.11.2019) are **both supported and never reconciled**. They agree only
   while paper and commercial substance agree. **No court has decided the case where they diverge —
   and that case is BharatTruck's.**
2. ❓ **Whether a document generated by a third party can be "issued by" the named party.**
   *Uttarakhand FDC* (29.05.2020) is the only ruling near this, its reasoning was criticised as
   misdirected, and it is the closest analogue to the platform model. **Unresolved.**
3. ❓ **Whether a non-e-invoicing shipper may show the invoice digitally.** Rule 138A(1)(a) has no
   electronic relaxation, but much commentary asserts full digital carriage, and enforcement varies by
   state. **Do not put "go paperless in the cab" in product copy without a practitioner's written view.**
4. ❓ **"Local delivery" is undefined** in Notifs. 15/2025 and 16/2025 — the ECO carve-out's scope is
   genuinely uncertain (§1.7).
5. ❓ **Who qualifies as an "expert" under BSA s.63(4)** (§5.2).
6. ❓ **West Bengal's intra-state threshold history** (§0.2) — two passes disagreed.
7. ❓ **E-way bill extension window** — rule says 8 hours after expiry, API accepts 8 before and after.
8. ❓ **Cancellation clock** — rule says 24h from generation, API error 728 says from Part B entry.
9. ⚠️ **Entry 21A** (GTA → unregistered = exempt) believed in force, **not primary-verified**.
10. ⚠️ **Whether the Rule 46 sixth-proviso signature dispensation reaches Rule 54(3)** — should, by
    incorporation, but 54(2) and 54(4) got express provisos and 54(3) did not.
11. ⚠️ **Retention for unregistered enrolled transporters** — s.36 is keyed to s.35(1) and registered
    persons; the 72 months reaches s.35(2) transporters only by a chain of cross-references.
12. ⚠️ **NIC direct-API volume prerequisite** — the prerequisites page and the onboarding page differ.
13. ⚠️ **Advance rulings bind only their applicant** (s.103 CGST). Everything in §1.2 indicates
    departmental thinking, **not binding law**.
14. ❌ **An LR is probably NOT a document of title.** Do not build title-transfer logic on it.

### Counsel checklist

Take a written opinion on: (1) the GTA line for the platform-generated-LR model, incl. §1.3 red lines;
(2) Carriage by Road Act **s.3 registration** exposure for a freight-booking marketplace (§1.5);
(3) ECO/TCS obligations and the **local-delivery** carve-out if any last-mile line is planned (§1.7);
(4) ASP liability and indemnity terms mirroring the GSP contract (§1.8); (5) the DPDP posture for POD
photographs and the public QR (§6, §8.3).
