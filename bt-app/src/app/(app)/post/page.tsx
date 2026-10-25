'use client'

/**
 * Post a Load (ship surface — Phase 2 of docs/UNIFIED_APP_PLAN.md).
 *
 * Ported from shipper/src/app/bookings/new/page.tsx into bt-app's house style
 * (light cards, the shared Field/INPUT/PRIMARY_BTN conventions, ErrorNote banners
 * for failures, toast for success — matching settings/ and the fleet console).
 *
 * The flow the backend requires, kept intact:
 *  - Route COORDINATES drive both the quote and the booking: bt-pricing-service
 *    DERIVES distance server-side from them (the shipper never types a distance),
 *    and the SAME coords + vehicle class are sent on create so the booking binds to
 *    the locked quote (a mismatch is rejected).
 *  - The price is ADVISORY on an auction (D-11): a reference, not a charge. The
 *    panel says so, driven by the server's own classification.
 *  - A load must name a REACHABLE consignee (D-29): name + phone are required.
 *    Receiver email is the optional legacy POD inbox.
 *  - On submit → createBooking → the new load's detail page.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import Image from 'next/image'
import { AlertCircle, Check, ChevronUp, Info, Lightbulb } from 'lucide-react'

import { Card, ErrorNote } from '@/components/stat'
import {
  ApiError,
  assignToBooking,
  createBooking,
  directAttachBooking,
  getPriceQuote,
  priceQuoteBasis,
  priceQuoteHeading,
  quoteKindOf,
  setExpectedQuantity,
} from '@/lib/api'
import { useAuth } from '@/lib/auth'
import FleetPairPicker, { type FleetPair } from '@/components/fleet-pair-picker'
import AddressPicker, { type PickedLocation } from '@/components/address-picker'
import RouteMap from '@/components/maps/RouteMap'
import { cityOf } from '@/components/driver/trip-bits'
import { inr, todayInIndia } from '@/lib/format'
import CargoDetails, { EMPTY_CARGO_DETAILS, dimensionsJson, expectedQuantity, type CargoDetailsValue } from '@/components/cargo-details'
import { VEHICLE_CLASS_LIMITS, canCarry, vehicleClassForWeight } from '@/lib/vehicle-class'
import QuoteRoughBreakdown from '@/components/quote-rough-breakdown'
import {
  BTN_PRIMARY, BTN_SECONDARY, HINT, INPUT, INPUT_ERROR, LABEL, SEG_OFF, SEG_ON, SELECT, TEXTAREA, cx, pill,
} from '@/lib/ui'
import type {
  BookingType,
  ConsigneeInput,
  PriceQuote,
  PriceQuoteLoadType,
  PriceQuoteVehicleType,
} from '@/lib/types'

const LOAD_TYPES: { value: PriceQuoteLoadType; label: string }[] = [
  { value: 'general', label: 'General' },
  { value: 'fragile', label: 'Fragile' },
  { value: 'perishable', label: 'Perishable' },
  { value: 'hazardous', label: 'Hazardous' },
  { value: 'heavy_machinery', label: 'Heavy machinery' },
]

const VEHICLE_TYPES: { value: PriceQuoteVehicleType; label: string }[] = [
  { value: 'mini_truck', label: 'Mini truck' },
  { value: 'lcv', label: 'LCV' },
  { value: 'hcv', label: 'HCV' },
  { value: 'trailer', label: 'Trailer' },
]

// Geocoding metadata beyond the lat/lng strings: the resolved place + the dragged gate pin.
type GeoMeta = { place_id?: string; pincode?: string; state_code?: string; gate_lat?: number; gate_lng?: number }

/** A 10-digit Indian mobile, best-effort normalised (the server is authoritative). */
function toTenDigit(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  return digits.length > 10 ? digits.slice(-10) : digits
}

export default function PostLoadPage() {
  const router = useRouter()
  // A poster who holds a fleet profile is a DISTRIBUTOR — they can carry their own load with
  // their own fleet (D-10). Only they see the truck+driver picker below; everyone else keeps
  // the solo direct-attach by driver id.
  const { personas } = useAuth()
  const isDistributor = !!personas?.fleet_owner_id

  const [submitting, setSubmitting] = useState(false)
  const [quoting, setQuoting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [gstinBlocked, setGstinBlocked] = useState(false)
  const [panBlocked, setPanBlocked] = useState(false)
  const [quoteError, setQuoteError] = useState<string | null>(null)

  const [bookingType, setBookingType] = useState<BookingType>('auction')

  // Quote-affecting fields are controlled so a stale lock can be invalidated the
  // moment any of them changes — a price priced for one trip must never be
  // submitted against another.
  const [sourceAddress, setSourceAddress] = useState('')
  const [sourceLat, setSourceLat] = useState('')
  const [sourceLng, setSourceLng] = useState('')
  const [destAddress, setDestAddress] = useState('')
  const [destLat, setDestLat] = useState('')
  const [destLng, setDestLng] = useState('')
  // Geocoding metadata (D-020) that the string lat/lng states above don't carry: the resolved
  // place_id/pincode/state_code and the dragged exact-gate pin. Kept beside the strings so the
  // quote/submit logic that reads sourceLat/etc. is unchanged.
  const [sourceGeo, setSourceGeo] = useState<GeoMeta | null>(null)
  const [destGeo, setDestGeo] = useState<GeoMeta | null>(null)
  const [vehicleType, setVehicleType] = useState<PriceQuoteVehicleType>('lcv')
  const [loadType, setLoadType] = useState<PriceQuoteLoadType>('general')
  const [weightKg, setWeightKg] = useState('')
  const [cargo, setCargo] = useState<CargoDetailsValue>(EMPTY_CARGO_DETAILS)
  // Why the vehicle class just changed (or why a lighter one is greyed out) — the weight decides.
  const [classNote, setClassNote] = useState<string | null>(null)

  const vehicleLabel = (v: PriceQuoteVehicleType) => VEHICLE_TYPES.find((t) => t.value === v)?.label ?? v

  // The weight picks the class: 50,000 kg cannot go on an LCV, so the selection moves up to the
  // lightest class that carries it and says so. A class that already fits is left alone.
  function applyWeight(raw: string) {
    setWeightKg(raw)
    invalidateQuote('the weight')
    const kg = Number(raw)
    const fit = vehicleClassForWeight(kg)
    if (!fit || canCarry(vehicleType, kg)) { setClassNote(null); return }
    const from = vehicleType
    setVehicleType(fit)
    setClassNote(`Moved to ${vehicleLabel(fit)}: ${kg.toLocaleString('en-IN')} kg is more than a ${vehicleLabel(from)} carries (up to ${VEHICLE_CLASS_LIMITS[from].toLocaleString('en-IN')} kg).`)
  }

  // Consignee (D-29): name + phone required, receiver email optional.
  const [consigneeName, setConsigneeName] = useState('')
  const [consigneePhone, setConsigneePhone] = useState('')
  const [receiverEmail, setReceiverEmail] = useState('')

  // Schedule + marketplace routing.
  const [pickupDate, setPickupDate] = useState('')
  const [pickupTimeSlot, setPickupTimeSlot] = useState('')
  const [specialInstructions, setSpecialInstructions] = useState('')
  const [targetDriverId, setTargetDriverId] = useState('')
  // Distributor direct-attach: the truck + driver from the poster's own fleet.
  const [fleetPair, setFleetPair] = useState<FleetPair>({ vehicleId: null, driverId: null })
  const [auctionDeadline, setAuctionDeadline] = useState('')

  const [quote, setQuote] = useState<PriceQuote | null>(null)
  // A quote was discarded because a price-bearing field changed — see invalidateQuote.
  const [quoteStale, setQuoteStale] = useState(false)
  // WHICH price-bearing field changed — so the notice names the change (review S-2
  // asked for "naming the change", not just announcing one happened).
  const [staleField, setStaleField] = useState<string | null>(null)

  // Derived, not stored: a date already keyed in stops being valid when midnight passes,
  // and state set on change would keep reporting the answer from when it was typed.
  const pickupDateError = pickupDate && pickupDate < todayInIndia()
    ? 'Pickup cannot be in the past.'
    : null

  /**
   * Drop a quote that no longer describes this load — and SAY SO.
   *
   * The dropping was always correct: these are the price-bearing fields, and
   * submitting a price quoted for a different trip would be worse than asking for a
   * new one. What was missing is that it happened in silence. The quote card simply
   * vanished and the button went back to "Get quote", so a shipper correcting a typo
   * in the weight had no way to tell whether they had invalidated their pricing or
   * mis-clicked something — and the draft looks identical either way.
   *
   * `quoteStale` is set only when a real quote was discarded, so it never fires on the
   * first pass through an empty form (nothing was lost, so there is nothing to report).
   */
  function invalidateQuote(field?: string) {
    setQuote((q) => {
      if (!q) return q
      setQuoteStale(true)
      setStaleField(field ?? null)
      return null
    })
  }

  function changeBookingType(next: BookingType) {
    if (next === bookingType) return
    setBookingType(next)
    invalidateQuote('the booking type')
  }

  async function handleGetQuote() {
    setQuoteError(null)
    const sLat = parseFloat(sourceLat)
    const sLng = parseFloat(sourceLng)
    const dLat = parseFloat(destLat)
    const dLng = parseFloat(destLng)
    const weight = parseFloat(weightKg)

    if (![sLat, sLng, dLat, dLng].every(Number.isFinite)) {
      setQuoteError('Enter valid pickup & drop coordinates before getting a quote.')
      return
    }
    if (!Number.isFinite(weight) || weight <= 0) {
      setQuoteError('Enter a valid weight (kg) before getting a quote.')
      return
    }

    setQuoting(true)
    try {
      const q = await getPriceQuote({
        source_lat: sLat,
        source_lng: sLng,
        dest_lat: dLat,
        dest_lng: dLng,
        vehicle_type: vehicleType,
        load_type: loadType,
        weight_kg: weight,
        booking_type: bookingType,
      })
      setQuote(q)
      setQuoteStale(false)
      toast.success(quoteKindOf(q, bookingType) === 'advisory' ? 'Estimate ready' : 'Price locked')
    } catch (err: unknown) {
      setQuoteError(err instanceof ApiError ? err.message : 'Could not get a price quote — please try again.')
    } finally {
      setQuoting(false)
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setFormError(null)

    if (!quote) {
      setFormError('Get a price quote before creating the booking.')
      return
    }
    const weight = parseFloat(weightKg)
    if (!Number.isFinite(weight) || weight <= 0) {
      setFormError('Enter a valid weight (kg).')
      return
    }
    if (!sourceAddress.trim() || !destAddress.trim()) {
      setFormError('Enter both a pickup and a drop address.')
      return
    }
    if (!pickupDate) {
      setFormError('Choose a pickup date.')
      return
    }
    // Belt and braces with the field-level message: `min` and the inline error are both
    // client-side hints, and the shipper may have had this form open across midnight.
    // The server refuses it either way — this just keeps the refusal legible.
    if (pickupDateError) {
      setFormError(pickupDateError)
      return
    }
    const name = consigneeName.trim()
    const phone = toTenDigit(consigneePhone)
    if (!name) {
      setFormError('Enter the consignee’s name — a load must name who receives it (D-29).')
      return
    }
    if (!/^[6-9]\d{9}$/.test(phone)) {
      setFormError('Enter a valid 10-digit Indian mobile number for the consignee.')
      return
    }
    const distributorDirect = isDistributor && bookingType === 'direct'
    if (bookingType === 'direct') {
      if (distributorDirect) {
        if (!fleetPair.vehicleId || !fleetPair.driverId) {
          setFormError('Pick both a truck and a driver from your fleet.')
          return
        }
      } else if (!targetDriverId.trim()) {
        setFormError('A direct booking needs the target driver’s ID.')
        return
      }
    }

    const consignee: ConsigneeInput = { name, phone }

    setSubmitting(true)
    try {
      const booking = await createBooking({
        source_address: sourceAddress.trim(),
        source_lat: parseFloat(sourceLat),
        source_lng: parseFloat(sourceLng),
        destination_address: destAddress.trim(),
        dest_lat: parseFloat(destLat),
        dest_lng: parseFloat(destLng),
        // Geocoding (D-020): the resolved place + the dragged exact-gate pins. Undefined values
        // are stripped by createBooking, so a manual-coordinate post sends none of them.
        source_place_id: sourceGeo?.place_id,
        source_pincode: sourceGeo?.pincode,
        source_state_code: sourceGeo?.state_code,
        source_gate_lat: sourceGeo?.gate_lat,
        source_gate_lng: sourceGeo?.gate_lng,
        dest_place_id: destGeo?.place_id,
        dest_pincode: destGeo?.pincode,
        dest_state_code: destGeo?.state_code,
        dest_gate_lat: destGeo?.gate_lat,
        dest_gate_lng: destGeo?.gate_lng,
        load_type: loadType,
        weight_kg: weight,
        vehicle_type: vehicleType,
        quote_id: quote.quote_id,
        pickup_date: pickupDate,
        pickup_time_slot: pickupTimeSlot.trim() || undefined,
        special_instructions: specialInstructions.trim() || undefined,
        consignee,
        receiver_email: receiverEmail.trim() || undefined,
        booking_type: bookingType,
        dimensions_json: dimensionsJson(cargo),
        // A distributor attaches to their OWN fleet below (never a solo target driver).
        target_driver_id: (!distributorDirect && bookingType === 'direct') ? targetDriverId.trim() || undefined : undefined,
        auction_deadline:
          bookingType === 'auction' && auctionDeadline
            ? new Date(auctionDeadline).toISOString()
            : undefined,
      })

      // The expected count is its own shipper-only call (the server holds it, never the driver).
      // Best-effort: the load is posted either way; the shipper can set it on the load page.
      const expected = expectedQuantity(cargo)
      if (expected) {
        try { await setExpectedQuantity(booking.id, expected.qty, expected.unit) }
        catch { toast.message('Load posted — the expected count could not be saved; add it on the load page.') }
      }

      if (distributorDirect) {
        // Create → attach to my fleet → pair my chosen truck + driver. If the pairing step
        // trips (e.g. the truck is already on a trip), the load is still attached to the
        // fleet and shows in Trips → Needs assignment, so nothing is lost.
        await directAttachBooking(booking.id)
        try {
          await assignToBooking(booking.id, fleetPair.driverId!, fleetPair.vehicleId!)
          toast.success('Load posted and assigned to your truck & driver')
        } catch {
          toast.success('Load posted and attached to your fleet — finish assigning it in Trips')
        }
      } else {
        toast.success('Load posted')
      }
      router.push(`/loads/${booking.id}`)
    } catch (err: unknown) {
      // GSTIN missing (FB-04): point at Settings rather than a dead-end message. Keyed on
      // the dedicated GST_REQUIRED code, not message text (which shares VALIDATION_ERROR with
      // an expired quote-lock and could be reworded/localized).
      if (err instanceof ApiError && err.code === 'GST_REQUIRED') {
        setFormError(err.message)
        setGstinBlocked(true)
        setSubmitting(false)
        return
      }
      // PAN not verified (mandatory since 2026-10-15): same shape — the fix is in Settings.
      if (err instanceof ApiError && err.code === 'PAN_REQUIRED') {
        setFormError(err.message)
        setPanBlocked(true)
        setSubmitting(false)
        return
      }
      // An expired or already-used price-lock: drop it and make the shipper re-quote.
      if (err instanceof ApiError && (err.code === 'VALIDATION_ERROR' || err.code === 'INVALID_TRANSITION')) {
        setQuote(null)
        setFormError('Your quoted price is no longer valid — please get a new quote and try again.')
        setGstinBlocked(false); setPanBlocked(false)
      } else {
        setFormError(err instanceof ApiError ? err.message : 'Could not post the load — please try again.')
        setGstinBlocked(false); setPanBlocked(false)
      }
      setSubmitting(false)
    }
  }

  const kind = quote ? quoteKindOf(quote, bookingType) : null

  const advisory = kind === 'advisory'
  const pickupValue: PickedLocation | null =
    Number.isFinite(parseFloat(sourceLat)) && Number.isFinite(parseFloat(sourceLng))
      ? {
          address: sourceAddress, lat: parseFloat(sourceLat), lng: parseFloat(sourceLng),
          place_id: sourceGeo?.place_id, pincode: sourceGeo?.pincode, state_code: sourceGeo?.state_code,
          gate_lat: sourceGeo?.gate_lat, gate_lng: sourceGeo?.gate_lng,
        }
      : null
  const dropValue: PickedLocation | null =
    Number.isFinite(parseFloat(destLat)) && Number.isFinite(parseFloat(destLng))
      ? {
          address: destAddress, lat: parseFloat(destLat), lng: parseFloat(destLng),
          place_id: destGeo?.place_id, pincode: destGeo?.pincode, state_code: destGeo?.state_code,
          gate_lat: destGeo?.gate_lat, gate_lng: destGeo?.gate_lng,
        }
      : null

  const submitLabel = submitting ? 'Posting…' : quote ? 'Post load' : 'Get a quote to continue'

  return (
    <div className="xl:flex">
      <PhotoPanel />
      <div className="min-w-0 flex-1 p-4 lg:p-8 max-w-[112rem] mx-auto pb-32 lg:pb-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          <h1 className="text-[2rem] sm:text-[2.5rem] leading-tight font-extrabold tracking-[-0.025em] text-gray-900">
            Post a <span className="text-brand-500">Load</span>
          </h1>
          <p className="mt-1 text-[0.9375rem] sm:text-base text-gray-600">Create a booking and take it to the marketplace or your own fleet.</p>
        </div>
        <Stepper steps={[
          { id: 'route', label: 'Route', done: !!(sourceLat && destLat) },
          { id: 'consignee', label: 'Consignee', done: consigneeName.trim().length > 1 && toTenDigit(consigneePhone).length === 10 },
          { id: 'cargo', label: 'Cargo', done: Number(weightKg) > 0 },
          { id: 'schedule', label: 'Schedule', done: !!pickupDate },
          { id: 'price', label: 'Price', done: !!quote },
        ]} />
      </div>

      <form onSubmit={handleSubmit} className="grid gap-5 lg:gap-6 lg:grid-cols-[minmax(0,1fr)_360px] items-start">
        <div className="min-w-0 space-y-4">
          {/* 1 · Route */}
          <Section n={1} id="route" title="Route" sub="Add pickup and drop locations. Drag the pins to the exact gate.">
            <div className="grid gap-5 @2xl:grid-cols-2">
              <AddressPicker
                label="Pickup"
                required
                pinColor="#16a34a"
                value={pickupValue}
                onChange={(loc: PickedLocation | null) => {
                  // A gate drag keeps the same lat/lng, so it must NOT invalidate the price lock —
                  // only a new address (a new lane) does.
                  const laneChanged = !loc || String(loc.lat) !== sourceLat || String(loc.lng) !== sourceLng
                  if (loc) {
                    setSourceAddress(loc.address); setSourceLat(String(loc.lat)); setSourceLng(String(loc.lng))
                    setSourceGeo({ place_id: loc.place_id, pincode: loc.pincode, state_code: loc.state_code, gate_lat: loc.gate_lat, gate_lng: loc.gate_lng })
                  } else {
                    setSourceAddress(''); setSourceLat(''); setSourceLng(''); setSourceGeo(null)
                  }
                  if (laneChanged) invalidateQuote('the pickup location')
                }}
              />
              <AddressPicker
                label="Drop"
                required
                pinColor="#dc2626"
                value={dropValue}
                onChange={(loc: PickedLocation | null) => {
                  const laneChanged = !loc || String(loc.lat) !== destLat || String(loc.lng) !== destLng
                  if (loc) {
                    setDestAddress(loc.address); setDestLat(String(loc.lat)); setDestLng(String(loc.lng))
                    setDestGeo({ place_id: loc.place_id, pincode: loc.pincode, state_code: loc.state_code, gate_lat: loc.gate_lat, gate_lng: loc.gate_lng })
                  } else {
                    setDestAddress(''); setDestLat(''); setDestLng(''); setDestGeo(null)
                  }
                  if (laneChanged) invalidateQuote('the drop location')
                }}
              />
            </div>
            {/* Both ends picked: show the lane. A dashed straight line — the road route is
                priced server-side when the quote is fetched, not drawn here. */}
            {sourceLat && destLat && (
              <RouteMap
                origin={{ lat: Number(sourceLat), lng: Number(sourceLng) }}
                dest={{ lat: Number(destLat), lng: Number(destLng) }}
                originLabel={cityOf(sourceAddress)}
                destLabel={cityOf(destAddress)}
                padding={48}
                className="mt-5 h-44 w-full rounded-xl border border-gray-200"
                fallback={null}
              />
            )}
          </Section>

          {/* 2 · Consignee (D-29) */}
          <Section n={2} id="consignee" title="Consignee" sub="Receiver details for delivery and POD.">
            <div className="grid gap-4 @lg:grid-cols-2 @2xl:grid-cols-3">
              <Field id="consignee_name" label="Name" required hint="The person or business receiving the load.">
                <input
                  id="consignee_name"
                  value={consigneeName}
                  onChange={(e) => setConsigneeName(e.target.value)}
                  placeholder="Anita Traders"
                  className={INPUT}
                />
              </Field>
              <Field id="consignee_phone" label="Mobile" required hint="10-digit Indian mobile.">
                <div className="flex">
                  <span className="inline-flex items-center px-3 rounded-l-[10px] border border-r-0 border-gray-200 bg-gray-50 text-sm text-gray-600 tabular-nums" aria-hidden>+91</span>
                  <input
                    id="consignee_phone"
                    type="tel"
                    inputMode="tel"
                    value={consigneePhone}
                    onChange={(e) => setConsigneePhone(e.target.value)}
                    placeholder="98765 43210"
                    className={cx(INPUT, 'rounded-l-none tabular-nums')}
                  />
                </div>
              </Field>
              <Field id="receiver_email" label="Receiver email (optional)" hint="Delivery code is emailed here.">
                <input
                  id="receiver_email"
                  type="email"
                  value={receiverEmail}
                  onChange={(e) => setReceiverEmail(e.target.value)}
                  placeholder="consignee@example.com"
                  className={INPUT}
                />
              </Field>
            </div>
          </Section>

          {/* 3 · Cargo & vehicle — these drive the price quote */}
          <Section n={3} id="cargo" title="Cargo & vehicle" sub="Describe what you are shipping.">
            <div className="grid gap-4 @md:grid-cols-2 @2xl:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] items-start">
              <div className="@md:col-span-2 @2xl:col-span-1">
                <p id="vehicle_type_label" className={LABEL}>Vehicle type <span className="text-red-500">*</span></p>
                <div role="radiogroup" aria-labelledby="vehicle_type_label" className="grid grid-cols-4 rounded-xl border border-gray-200 bg-white p-1 gap-1">
                  {VEHICLE_TYPES.map((v) => {
                    const kg = Number(weightKg) || 0
                    const tooLight = kg > 0 && !canCarry(v.value, kg)
                    return (
                      <button
                        key={v.value}
                        type="button"
                        role="radio"
                        aria-checked={vehicleType === v.value}
                        aria-disabled={tooLight || undefined}
                        title={tooLight ? `Carries up to ${VEHICLE_CLASS_LIMITS[v.value].toLocaleString('en-IN')} kg` : undefined}
                        onClick={() => {
                          if (tooLight) {
                            setClassNote(`A ${v.label} carries up to ${VEHICLE_CLASS_LIMITS[v.value].toLocaleString('en-IN')} kg — this ${kg.toLocaleString('en-IN')} kg load needs ${vehicleLabel(vehicleClassForWeight(kg) ?? 'trailer')} or bigger.`)
                            return
                          }
                          if (vehicleType !== v.value) { setVehicleType(v.value); setClassNote(null); invalidateQuote('the vehicle type') }
                        }}
                        className={cx(
                          vehicleType === v.value ? SEG_ON : SEG_OFF,
                          tooLight && 'opacity-40 line-through decoration-gray-400 cursor-not-allowed',
                          'px-2.5 whitespace-nowrap text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600',
                        )}
                      >
                        {v.label}
                      </button>
                    )
                  })}
                </div>
                <p className={cx('mt-1.5 text-xs', classNote ? 'text-amber-700' : 'text-gray-500')}>
                  {classNote ?? 'Picked from the weight: Mini truck to 1,500 kg · LCV to 7,000 kg · HCV to 25,000 kg · Trailer above.'}
                </p>
              </div>
              <Field id="load_type" label="Load type" required>
                <select
                  id="load_type"
                  value={loadType}
                  onChange={(e) => { setLoadType(e.target.value as PriceQuoteLoadType); invalidateQuote('the load type') }}
                  className={SELECT}
                >
                  {LOAD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </Field>
              <Field id="weight_kg" label="Weight" required>
                <div className="relative">
                  <input
                    id="weight_kg"
                    type="number"
                    min="1"
                    value={weightKg}
                    onChange={(e) => applyWeight(e.target.value)}
                    placeholder="5000"
                    className={cx(INPUT, 'pr-10 tabular-nums')}
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 pointer-events-none">kg</span>
                </div>
              </Field>
            </div>
            <CargoDetails value={cargo} onChange={setCargo} />
            <p className="mt-3 text-xs text-gray-500 inline-flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5 text-blue-500" /> Distance is derived from the coordinates above.
            </p>
          </Section>

          {/* 4 · Schedule */}
          <Section n={4} id="schedule" title="Schedule" sub="When should the truck pick up the load?">
            <div className="grid gap-4 @xl:grid-cols-2">
              <div className="grid grid-cols-2 gap-4 content-start">
                <Field id="pickup_date" label="Pickup date" required>
                  <input
                    id="pickup_date"
                    type="date"
                    // The server refuses a past pickup date, but only at POST — so without
                    // this the picker cheerfully offered last month and the refusal arrived
                    // at the end of a long form, attached to nothing the shipper could see.
                    min={todayInIndia()}
                    value={pickupDate}
                    onChange={(e) => setPickupDate(e.target.value)}
                    className={pickupDateError ? INPUT_ERROR : INPUT}
                    aria-describedby={pickupDateError ? 'pickup_date_error' : undefined}
                    aria-invalid={pickupDateError ? true : undefined}
                  />
                  {/* `min` is a hint, not a guarantee — it greys out earlier days in the
                      picker but a typed or pasted date still lands. This is the field-level
                      error the review asked for: shown on entry, next to the field, rather
                      than as a form-wide message after submit. */}
                  {pickupDateError && (
                    <p id="pickup_date_error" className="mt-1 text-xs font-medium text-red-600">
                      {pickupDateError}
                    </p>
                  )}
                </Field>
                <Field id="pickup_time_slot" label="Time slot (optional)">
                  <input
                    id="pickup_time_slot"
                    value={pickupTimeSlot}
                    onChange={(e) => setPickupTimeSlot(e.target.value)}
                    placeholder="9 AM – 12 PM"
                    className={INPUT}
                  />
                </Field>
              </div>
              <Field id="special_instructions" label="Special instructions (optional)">
                <textarea
                  id="special_instructions"
                  rows={3}
                  value={specialInstructions}
                  onChange={(e) => setSpecialInstructions(e.target.value)}
                  placeholder="Any special handling requirements…"
                  className={TEXTAREA}
                />
              </Field>
            </div>
          </Section>

          {/* 5 · Marketplace routing */}
          <Section n={5} id="fill" title="How to fill it" sub="Choose how you want to move this load.">
            <div role="radiogroup" aria-label="How to fill it" className="grid gap-3 @xl:grid-cols-2 items-start">
              <TypeCard
                active={bookingType === 'auction'}
                onClick={() => changeBookingType('auction')}
                title="Auction"
                hint="Open to all carriers — they bid, you pick."
              >
                <Field id="auction_deadline" label="Auction deadline (optional)">
                  <input
                    id="auction_deadline"
                    type="datetime-local"
                    value={auctionDeadline}
                    onChange={(e) => setAuctionDeadline(e.target.value)}
                    className={INPUT}
                  />
                </Field>
              </TypeCard>
              <TypeCard
                active={bookingType === 'direct'}
                onClick={() => changeBookingType('direct')}
                title="Direct"
                hint={isDistributor ? 'Carry it with your own fleet.' : 'Sent to one specific driver.'}
              >
                {isDistributor ? (
                  <div>
                    <p className={LABEL}>Carry it with your fleet</p>
                    <FleetPairPicker value={fleetPair} onChange={setFleetPair} loadWeightKg={parseFloat(weightKg) || null} />
                  </div>
                ) : (
                  <Field id="target_driver_id" label="Target driver ID">
                    <input
                      id="target_driver_id"
                      value={targetDriverId}
                      onChange={(e) => setTargetDriverId(e.target.value)}
                      placeholder="UUID of the driver"
                      className={cx(INPUT, 'font-mono')}
                    />
                  </Field>
                )}
              </TypeCard>
            </div>
          </Section>
        </div>

        {/* Price panel — sticky beside the form on desktop, at the end of the form on phones */}
        <aside id="price" className="lg:sticky lg:top-6 scroll-mt-20">
          <Card>
            <div className="px-5 pt-4 pb-3 border-b border-gray-100">
              <h2 className="text-lg font-extrabold tracking-tight text-gray-900">Price estimate</h2>
              <p className="text-sm text-gray-500">Get an estimate before posting.</p>
            </div>
            <div className="p-5 space-y-4">
              {!quote && !quoteStale && !quoteError && (
                <div className="rounded-xl border border-blue-100 bg-blue-50 px-3.5 py-3 text-sm text-blue-900 flex items-start gap-2.5">
                  <Info className="w-4 h-4 mt-0.5 shrink-0 text-blue-600" />
                  Fill route, vehicle and weight to price this load.
                </div>
              )}

              <button
                type="button"
                onClick={handleGetQuote}
                disabled={quoting}
                className={cx(quote ? BTN_SECONDARY : BTN_PRIMARY, 'w-full h-11')}
              >
                {quoting && <span className="w-4 h-4 border-2 border-gray-900 border-t-transparent rounded-full animate-spin" />}
                {quoting ? 'Getting price…' : quote ? 'Refresh quote' : 'Get quote'}
              </button>

              {quoteError && <ErrorNote message={quoteError} />}

              {/* The quote is gone because the load changed — not because anything failed.
                  Sits where the quote card was, so the space does not just go blank, and
                  names the rest of the draft as safe: the fear this answers is "have I
                  lost what I typed?", which is why it says what was NOT lost. */}
              {quoteStale && !quote && !quoteError && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3.5 flex items-start gap-2.5">
                  <AlertCircle className="w-5 h-5 shrink-0 text-amber-500" />
                  <div>
                    <p className="text-sm font-semibold text-amber-900">This change needs a new quote</p>
                    <p className="mt-0.5 text-xs text-amber-800">
                      You changed {staleField ?? 'something the price depends on'}, so the previous
                      quote no longer applies. The rest of your draft is untouched — get a new quote
                      to post.
                    </p>
                  </div>
                </div>
              )}

              {quote && (
                <div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold text-gray-700">{priceQuoteHeading(quote, bookingType)}</span>
                    {advisory && <span className={pill('amber')}>Reference, not binding</span>}
                  </div>
                  <div className="relative mt-1 flex items-center gap-2">
                    <p className="text-[2.125rem] leading-tight font-extrabold text-gray-900 tabular-nums">{inr(quote.quoted_price)}</p>
                    {/* (i) — the rough working behind the number, on request (2026-10-17). Three
                        round lines that add up to the quote; the platform's share sits inside
                        "Running, tolls & handling", never as a line of its own. */}
                    <QuoteRoughBreakdown quote={quote} />
                  </div>

                  {/* The final price only (2026-10-15): the cost lines, cost floor and market tiles
                      read as several competing prices and confused testers (UAT BT-03/BT-04).
                      The quote and its basis are unchanged. */}

                  <p className="mt-3 text-xs text-gray-500">
                    {priceQuoteBasis(quote, bookingType)}{' '}
                    <span className="text-gray-700 font-medium">
                      {advisory ? 'Estimate' : 'Price'} valid until{' '}
                      {new Date(quote.expires_at).toLocaleString('en-IN')}.
                    </span>
                  </p>
                </div>
              )}

              {formError && ((gstinBlocked || panBlocked) ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm flex items-start gap-2.5">
                  <AlertCircle className="w-4.5 h-4.5 mt-0.5 shrink-0 text-red-600" />
                  <div className="min-w-0">
                    <p className="text-red-700">{formError}</p>
                    <p className="mt-1 text-gray-700">
                      <Link href={panBlocked ? '/settings#pan' : '/settings'} className="font-semibold text-blue-600 hover:underline">
                        {panBlocked ? 'Open Settings → PAN' : 'Open Settings → Your GSTIN'}
                      </Link>
                      {' '}{panBlocked ? 'to verify it' : 'to add it'}, then try posting again.
                    </p>
                  </div>
                </div>
              ) : (
                <ErrorNote message={formError} />
              ))}

              <button type="submit" disabled={submitting || !quote} className={cx(BTN_PRIMARY, 'w-full h-12 text-base')}>
                {submitLabel}
              </button>
            </div>
          </Card>
          <TipsCard />
        </aside>

        {/* Phones: the price rides along at the bottom, with the one action that applies now. */}
        <div className="lg:hidden fixed inset-x-0 bottom-0 z-30 border-t border-gray-200 bg-white/95 backdrop-blur px-4 py-3 shadow-[0_-4px_16px_rgba(16,24,40,0.06)]">
          <div className="flex items-center gap-3">
            <a href="#price" className="min-w-0 flex-1 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
              {quote ? (
                <>
                  <span className="block text-xl font-extrabold text-gray-900 tabular-nums leading-tight">{inr(quote.quoted_price)}</span>
                  <span className="block text-xs text-gray-500 truncate">{advisory ? 'Reference, not binding' : priceQuoteHeading(quote, bookingType)}</span>
                </>
              ) : (
                <>
                  <span className="block text-sm font-semibold text-gray-900">No price yet</span>
                  <span className="block text-xs text-gray-500 truncate">{quoteStale ? 'Your change needs a new quote' : 'Get a quote to post'}</span>
                </>
              )}
            </a>
            {quote ? (
              <button type="submit" disabled={submitting} className={cx(BTN_PRIMARY, 'h-12 px-6 text-base')}>
                {submitting ? 'Posting…' : 'Post load'}
              </button>
            ) : (
              <button type="button" onClick={handleGetQuote} disabled={quoting} className={cx(BTN_PRIMARY, 'h-12 px-6 text-base')}>
                {quoting ? 'Getting price…' : 'Get quote'}
              </button>
            )}
            <a href="#price" aria-label="Show price details" className="p-2 -mr-2 rounded-lg text-gray-500 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
              <ChevronUp className="w-5 h-5" />
            </a>
          </div>
        </div>
      </form>
      </div>
    </div>
  )
}

/**
 * Wide screens only: the brand's highway photograph as a tall panel beside the form, with
 * the brand line over it. Sticks to the viewport while the form scrolls. Decorative.
 */
function PhotoPanel() {
  return (
    <aside className="relative hidden w-[19rem] shrink-0 2xl:w-[22rem] xl:block" aria-hidden>
      <div className="sticky top-0 h-dvh overflow-hidden">
        <Image src="/images/highway-india-map.webp" alt="" fill sizes="100vw" className="object-cover dark:hidden object-[57%_100%]" />
        <Image src="/images/highway-india-map-night.webp" alt="" fill sizes="100vw" className="object-cover hidden dark:block object-[57%_100%]" />
        <div className="absolute inset-0 bg-gradient-to-t from-[#0b0e13]/75 via-[#0b0e13]/10 to-transparent" />
        {/* Right edge dissolves into the page (an overlay, not a mask: cheap to scroll). */}
        <div className="absolute inset-y-0 right-0 w-2/5 bg-gradient-to-r from-transparent to-gray-50" />
        <p className="absolute inset-x-6 bottom-10 text-[1.625rem] font-extrabold leading-tight tracking-tight text-[#fff]">
          Connecting every mile across <span className="text-brand-400">India</span>
        </p>
      </div>
    </aside>
  )
}

/** Progress across the form's sections: a step lights up once its required fields are filled. */
function Stepper({ steps }: { steps: { id: string; label: string; done: boolean }[] }) {
  const current = steps.findIndex(st => !st.done)
  return (
    <ol className="hidden items-start md:flex" aria-label="Progress">
      {steps.map((st, i) => {
        const active = i === (current === -1 ? steps.length - 1 : current)
        return (
          <li key={st.id} className="flex items-start">
            {i > 0 && <span className={cx('mt-3.5 h-px w-8 lg:w-12', steps[i - 1].done ? 'bg-brand-400' : 'bg-gray-300')} aria-hidden />}
            <a href={`#${st.id}`} className="flex w-[4.25rem] flex-col items-center gap-1.5 rounded-lg text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
              <span className={cx(
                'inline-flex h-7 w-7 items-center justify-center rounded-full border text-xs font-bold',
                st.done ? 'border-brand-500 bg-brand-500 text-ink'
                  : active ? 'border-brand-500 bg-white text-brand-600 ring-4 ring-brand-100'
                    : 'border-gray-300 bg-white text-gray-500',
              )}>
                {st.done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : i + 1}
              </span>
              <span className={cx('text-xs', st.done || active ? 'font-bold text-gray-900' : 'font-medium text-gray-500')}>{st.label}</span>
            </a>
          </li>
        )
      })}
    </ol>
  )
}

const TIPS = [
  'Pick the exact gate on the map for pickup and drop',
  'Give the real weight and load type — bids depend on them',
  'Add the receiver\'s email so the delivery code reaches them',
  'Mention special handling in the instructions',
]

function TipsCard() {
  return (
    <Card className="mt-5 p-5">
      <h2 className="flex items-center gap-2.5 text-base font-extrabold tracking-tight text-gray-900">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-brand-50 text-brand-600"><Lightbulb className="h-5 w-5" /></span>
        Tips for better bids
      </h2>
      <ul className="mt-3 space-y-2 text-sm text-gray-700">
        {TIPS.map(t => (
          <li key={t} className="flex items-start gap-2.5">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" strokeWidth={3} aria-hidden /> {t}
          </li>
        ))}
      </ul>
    </Card>
  )
}

function Section({
  n, id, title, sub, children,
}: { n: number; id: string; title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="bg-white rounded-2xl border border-gray-200/80 shadow-[0_2px_10px_rgba(20,24,31,0.04)] scroll-mt-20">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 pt-4 pb-3">
        <span className="w-8 h-8 rounded-lg bg-brand-500 text-ink text-sm font-extrabold inline-flex items-center justify-center shrink-0" aria-hidden>{n}</span>
        <h2 id={`${id}-title`} className="text-lg font-extrabold tracking-tight text-gray-900">{title}</h2>
        {sub && <p className="text-sm text-gray-500 basis-full sm:basis-auto">{sub}</p>}
      </div>
      <div className="px-5 pb-5 @container">{children}</div>
    </section>
  )
}


function TypeCard({
  active, onClick, title, hint, children,
}: { active: boolean; onClick: () => void; title: string; hint: string; children?: React.ReactNode }) {
  return (
    <div className={cx(
      'rounded-xl border transition-colors',
      active ? 'border-brand-400 bg-brand-50/60 ring-1 ring-brand-200' : 'border-gray-200 hover:bg-gray-50',
    )}>
      <button
        type="button"
        role="radio"
        aria-checked={active}
        onClick={onClick}
        className="w-full flex items-start gap-3 p-4 text-left rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
      >
        <span className={cx(
          'mt-0.5 w-5 h-5 rounded-full border-2 inline-flex items-center justify-center shrink-0',
          active ? 'border-brand-500' : 'border-gray-300',
        )}>
          {active && <span className="w-2.5 h-2.5 rounded-full bg-brand-500" />}
        </span>
        <span>
          <span className="block text-[0.9375rem] font-bold text-gray-900">{title}</span>
          <span className="block text-sm text-gray-500 mt-0.5">{hint}</span>
        </span>
      </button>
      {active && children && <div className="px-4 pb-4">{children}</div>}
    </div>
  )
}

function Field({
  id, label, hint, required, children,
}: { id: string; label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={LABEL}>
        {label}{required && <span className="text-red-500"> *</span>}
      </label>
      {children}
      {hint && <p className={HINT}>{hint}</p>}
    </div>
  )
}
