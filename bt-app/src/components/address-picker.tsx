'use client'

/**
 * AddressPicker — pick a pickup/drop location instead of typing raw lat/lng (D-020).
 *
 * WHY: the post-load form used to have the shipper key decimal coordinates by hand, with the
 * address a separate free-text box. A mistyped coordinate silently breaks the POD geofence gate
 * and the routed distance, and the booking never captured the pincode/state the e-way bill needs.
 * This resolves a typed address through bt-tracking-service's Places proxy to lat/lng + pincode +
 * GST state code, and lets the user drag an EXACT-GATE pin distinct from the address centroid
 * (which can sit a few hundred metres from the real loading dock).
 *
 * Emits one PickedLocation. `lat/lng` are the address pin (distance is priced on these);
 * `gate_lat/gate_lng` are the dragged pin (the POD geofence uses these). A manual-coordinate
 * fallback stays, so a geocoding outage never blocks a booking.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { APIProvider, Map, AdvancedMarker, Pin } from '@vis.gl/react-google-maps'
import { ChevronDown, LocateFixed, MapPin, Search, Star, Trash2, X } from 'lucide-react'

import { MapBoundary } from '@/components/map-guard'
import { useIsDark } from '@/components/theme-sync'
import { GOOGLE_MAPS_BROWSER_KEY, GOOGLE_MAPS_MAP_ID } from '@/lib/maps'
import {
  ApiError, deleteSavedAddress, listSavedAddresses, placeDetails, placesAutocomplete, reverseGeocode, saveAddress,
  type PlaceSuggestion, type SavedAddress,
} from '@/lib/api'

export type PickedLocation = {
  address: string
  lat: number
  lng: number
  place_id?: string
  pincode?: string
  state_code?: string
  gate_lat?: number
  gate_lng?: number
}

const inputCls =
  'w-full h-11 rounded-[10px] border border-gray-200 bg-white px-3 text-sm text-gray-900 placeholder:text-gray-400 ' +
  'outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100'
const linkCls =
  'text-xs font-semibold text-blue-600 hover:text-blue-700 inline-flex items-center gap-1 rounded ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600'

// Centre of India — the map opens here when picking a location with no address typed yet.
const INDIA_CENTER = { lat: 22.9734, lng: 78.6569 }

// lat/lng are stored to 7 decimals (~1 cm), matching the DB numeric(10,8)/(11,8) columns.
const round7 = (n: number) => Math.round(n * 1e7) / 1e7

function messageOf(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong'
}

function newSessionToken(): string {
  try { return crypto.randomUUID() } catch { return `${Date.now()}-${Math.random().toString(16).slice(2)}` }
}

export default function AddressPicker({
  label,
  value,
  onChange,
  pinColor = '#2563eb',
  required = false,
}: {
  label: string
  value: PickedLocation | null
  onChange: (loc: PickedLocation | null) => void
  pinColor?: string
  /** Show the required-field marker beside the label (the form validates). */
  required?: boolean
}) {
  const inputId = useId()
  const dark = useIsDark()
  const [query, setQuery] = useState(value?.address ?? '')
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [manual, setManual] = useState(false)
  const [saved, setSaved] = useState<SavedAddress[] | null>(null)
  const [showSaved, setShowSaved] = useState(false)
  // Map-pick mode: show the map (to drop a pin) even before an address has been chosen.
  const [pickOnMap, setPickOnMap] = useState(false)
  // Bumped to force the uncontrolled <Map> to remount and recenter on a new point (address
  // picked / saved place / current location). NOT bumped on a tap or drag, so the map holds
  // its position while the user is placing the pin.
  const [mapNonce, setMapNonce] = useState(0)
  const recenterMap = () => setMapNonce((n) => n + 1)
  // True while a dropped pin is being reverse-geocoded to its pincode/state.
  const [resolvingPin, setResolvingPin] = useState(false)

  const sessionRef = useRef<string>(newSessionToken())
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Guards against an out-of-order autocomplete response overwriting a newer one.
  const seqRef = useRef(0)
  // Same guard for reverse-geocode: a newer dropped pin must win over an older in-flight lookup.
  const revSeqRef = useRef(0)

  // Keep the input in step when the parent clears/loads a value (e.g. picked from saved).
  useEffect(() => { setQuery(value?.address ?? '') }, [value?.address])

  const runAutocomplete = useCallback((q: string) => {
    if (q.trim().length < 2) { setSuggestions([]); setOpen(false); return }
    const seq = ++seqRef.current
    setLoading(true)
    placesAutocomplete(q, sessionRef.current)
      .then((res) => {
        if (seq !== seqRef.current) return // a newer keystroke already fired
        setSuggestions(res.suggestions)
        setOpen(res.suggestions.length > 0)
      })
      .catch((err) => { if (seq === seqRef.current) toast.error(messageOf(err)) })
      .finally(() => { if (seq === seqRef.current) setLoading(false) })
  }, [])

  function onType(q: string) {
    setQuery(q)
    // Typing after a pick invalidates the pick — the parent decides what that means (a stale
    // quote, usually). We only null it once, when a picked value first diverges from its text.
    if (value && q !== value.address) onChange(null)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runAutocomplete(q), 300)
  }

  async function select(s: PlaceSuggestion) {
    setOpen(false)
    setSuggestions([])
    setLoading(true)
    try {
      const d = await placeDetails(s.place_id, sessionRef.current)
      // A session ends at the details call; the next search bills as a new session.
      sessionRef.current = newSessionToken()
      onChange({
        address: d.formatted_address || s.description,
        lat: d.lat,
        lng: d.lng,
        place_id: d.place_id,
        pincode: d.pincode ?? undefined,
        state_code: d.state_code ?? undefined,
        // The gate starts on the address pin; the user drags it to the exact gate.
        gate_lat: d.lat,
        gate_lng: d.lng,
      })
      recenterMap() // if the map was already open (pick-on-map), snap it to the chosen address
    } catch (err) {
      toast.error(messageOf(err))
    } finally {
      setLoading(false)
    }
  }

  // A raw map pin / current location: set the PRIMARY point outright, then reverse-geocode it to
  // auto-fill the nearest pincode + GST state (D-021). The pin is set synchronously so it never
  // waits on the network; the pincode/state fill in a moment later. If reverse geocoding is
  // unavailable (Geocoding API not enabled) or the point has no postal area, it stays coords-only
  // — a dropped pin never fabricates a place_id and never blocks on the lookup.
  function dropPin(lat: number, lng: number) {
    const rlat = round7(lat)
    const rlng = round7(lng)
    const base: PickedLocation = {
      address: `Pinned location (${rlat.toFixed(5)}, ${rlng.toFixed(5)})`,
      lat: rlat,
      lng: rlng,
      gate_lat: rlat,
      gate_lng: rlng,
    }
    onChange(base)

    const seq = ++revSeqRef.current
    setResolvingPin(true)
    reverseGeocode(rlat, rlng)
      .then((r) => {
        if (seq !== revSeqRef.current) return // a newer pin superseded this lookup
        if (r.resolved && (r.pincode || r.state_code)) {
          onChange({
            ...base,
            address: r.formatted_address || base.address,
            pincode: r.pincode ?? undefined,
            state_code: r.state_code ?? undefined,
          })
        }
      })
      .catch(() => { /* keep coords-only — a pin must never fail because reverse geocoding did */ })
      .finally(() => { if (seq === revSeqRef.current) setResolvingPin(false) })
  }

  // One handler for a map tap OR a marker drag. When an address was geocoded (has place_id) the
  // address centroid is preserved and only the exact-gate pin moves (the two-pin model). With no
  // geocoded address, the whole point moves.
  function onMapInteract(lat: number, lng: number) {
    if (value?.place_id) {
      onChange({ ...value, gate_lat: round7(lat), gate_lng: round7(lng) })
    } else {
      dropPin(lat, lng)
    }
  }

  function useMyLocation() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      toast.error('Location is not available on this device')
      return
    }
    setPickOnMap(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        dropPin(pos.coords.latitude, pos.coords.longitude)
        recenterMap()
      },
      () => toast.error('Could not get your location — tap the map to drop a pin instead'),
      { enableHighAccuracy: true, timeout: 10000 },
    )
  }

  async function loadSaved() {
    setShowSaved((s) => !s)
    if (saved === null) {
      try { setSaved(await listSavedAddresses()) } catch (err) { toast.error(messageOf(err)); setSaved([]) }
    }
  }

  function pickSaved(a: SavedAddress) {
    setShowSaved(false)
    onChange({
      address: a.formatted_address,
      lat: Number(a.lat),
      lng: Number(a.lng),
      place_id: a.place_id ?? undefined,
      pincode: a.pincode ?? undefined,
      state_code: a.state_code ?? undefined,
      gate_lat: a.gate_lat != null ? Number(a.gate_lat) : Number(a.lat),
      gate_lng: a.gate_lng != null ? Number(a.gate_lng) : Number(a.lng),
    })
  }

  async function saveCurrent() {
    if (!value) return
    try {
      const created = await saveAddress({
        formatted_address: value.address,
        lat: value.lat, lng: value.lng,
        place_id: value.place_id,
        gate_lat: value.gate_lat, gate_lng: value.gate_lng,
        pincode: value.pincode, state_code: value.state_code,
      })
      toast.success('Saved to your address book')
      setSaved((prev) => (prev ? [created, ...prev.filter((p) => p.id !== created.id)] : [created]))
    } catch (err) {
      toast.error(messageOf(err))
    }
  }

  async function removeSaved(id: string) {
    try {
      await deleteSavedAddress(id)
      setSaved((prev) => (prev ? prev.filter((p) => p.id !== id) : prev))
    } catch (err) {
      toast.error(messageOf(err))
    }
  }

  const gate = value ? { lat: value.gate_lat ?? value.lat, lng: value.gate_lng ?? value.lng } : null
  const movedGate = !!value && (value.gate_lat !== value.lat || value.gate_lng !== value.lng)

  // The map is shown once a value exists (to fine-tune the gate) OR when the user opens map-pick
  // mode to drop a pin from scratch. It centres on the chosen point, else on India to pan from.
  const showMap = !!GOOGLE_MAPS_BROWSER_KEY && (value !== null || pickOnMap)
  const mapCenter = value ? { lat: value.lat, lng: value.lng } : INDIA_CENTER
  const mapZoom = value ? 16 : 5

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <label htmlFor={inputId} className="text-sm font-medium text-gray-700">
          {label}{required && <span className="text-red-500"> *</span>}
          <span className="sr-only"> address</span>
        </label>
        <button type="button" onClick={loadSaved} aria-expanded={showSaved} className={linkCls}>
          <Star className="w-3.5 h-3.5" /> Saved places <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showSaved ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {showSaved && (
        <div className="mb-2 rounded-xl border border-gray-200 bg-white p-1.5 shadow-sm">
          {saved === null ? (
            <p className="text-xs text-gray-400 px-1 py-1">Loading…</p>
          ) : saved.length === 0 ? (
            <p className="text-xs text-gray-400 px-1 py-1">No saved places yet. Pick an address, then “Save”.</p>
          ) : (
            <ul className="max-h-48 overflow-auto">
              {saved.map((a) => (
                <li key={a.id} className="flex items-center gap-2">
                  <button type="button" onClick={() => pickSaved(a)} className="flex-1 min-w-0 text-left px-2.5 py-2 rounded-lg hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
                    <span className="block text-sm font-medium text-gray-900 truncate">{a.label || a.formatted_address}</span>
                    {a.label && <span className="block text-xs text-gray-400 truncate">{a.formatted_address}</span>}
                  </button>
                  <button type="button" onClick={() => removeSaved(a.id)} aria-label="Remove saved place" className="p-2 rounded-lg text-gray-300 hover:text-red-600 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        <input
          id={inputId}
          value={query}
          onChange={(e) => onType(e.target.value)}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          placeholder="Start typing an address…"
          className={`${inputCls} pl-9 ${value ? 'pr-9' : ''}`}
          autoComplete="off"
        />
        {value && (
          <button
            type="button"
            onClick={() => { setQuery(''); onChange(null); setSuggestions([]); setOpen(false) }}
            aria-label="Clear"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            <X className="w-4 h-4" />
          </button>
        )}

        {open && suggestions.length > 0 && (
          <ul className="absolute z-20 mt-1 w-full rounded-xl border border-gray-200 bg-white shadow-lg overflow-hidden">
            {suggestions.map((s) => (
              <li key={s.place_id}>
                <button type="button" onClick={() => select(s)} className="w-full text-left px-3 py-2.5 hover:bg-gray-50 focus-visible:outline-none focus-visible:bg-blue-50">
                  <span className="block text-sm font-medium text-gray-900">{s.main_text}</span>
                  {s.secondary_text && <span className="block text-xs text-gray-400 truncate">{s.secondary_text}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {loading && <p className="mt-1.5 text-xs text-gray-500">Looking up…</p>}

      {value && (
        <div className="mt-1.5 flex items-start justify-between gap-3 text-xs text-gray-500">
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0">
            {value.pincode && <><span className="tabular-nums">PIN {value.pincode}</span><span className="text-gray-300" aria-hidden>·</span></>}
            {value.state_code && <><span>State {value.state_code}</span><span className="text-gray-300" aria-hidden>·</span></>}
            <span className="tabular-nums">{value.lat.toFixed(5)}, {value.lng.toFixed(5)}</span>
            {resolvingPin && <span className="text-gray-400">· Finding pincode…</span>}
          </span>
          <button type="button" onClick={saveCurrent} className={`${linkCls} shrink-0`}>
            <Star className="w-3.5 h-3.5 fill-current" /> Save
          </button>
        </div>
      )}

      {showMap && (
        <div className="mt-2">
          <div className="h-52 rounded-xl overflow-hidden border border-gray-200">
            <MapBoundary fallback={<div className="h-full grid place-items-center bg-gray-50 text-xs text-gray-500 px-4 text-center"><span className="inline-flex items-center gap-1.5"><MapPin className="w-4 h-4 text-gray-400" />Map unavailable — coordinates still saved.</span></div>}>
              <APIProvider apiKey={GOOGLE_MAPS_BROWSER_KEY!}>
                <Map
                  key={`${mapNonce}-${dark ? 'dark' : 'light'}`}
                  colorScheme={dark ? 'DARK' : 'LIGHT'}
                  defaultCenter={mapCenter}
                  defaultZoom={mapZoom}
                  mapId={GOOGLE_MAPS_MAP_ID || undefined}
                  gestureHandling="greedy"
                  disableDefaultUI
                  clickableIcons={false}
                  onClick={(e) => { const p = e.detail.latLng; if (p) onMapInteract(p.lat, p.lng) }}
                  style={{ width: '100%', height: '100%' }}
                >
                  {/* Grey address centroid — shown only when a geocoded address is present (two-pin model). */}
                  {value?.place_id && (
                    <AdvancedMarker position={{ lat: value.lat, lng: value.lng }} title={`${label} address`}>
                      <Pin background="#9ca3af" borderColor="#6b7280" glyphColor="#374151" />
                    </AdvancedMarker>
                  )}
                  {/* The draggable pin: the exact gate for a geocoded address, or the location itself for a dropped pin. */}
                  {gate && (
                    <AdvancedMarker
                      position={gate}
                      title={value?.place_id ? 'Drag to the exact gate' : 'Drag to adjust the location'}
                      draggable
                      onDragEnd={(e) => { const p = e.latLng; if (p) onMapInteract(p.lat(), p.lng()) }}
                    >
                      <Pin background={pinColor} borderColor={pinColor} glyphColor="#ffffff" />
                    </AdvancedMarker>
                  )}
                </Map>
              </APIProvider>
            </MapBoundary>
          </div>

          <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-gray-500 inline-flex items-center gap-1">
              <MapPin className="w-3.5 h-3.5" />
              {!value
                ? 'Tap the map to drop a pin at the exact location.'
                : !value.place_id
                  ? (value.pincode ? 'Pinned — PIN & state filled from the map.' : 'Pinned. Tap or drag to adjust; type an address above for PIN & state.')
                  : (movedGate ? 'Gate pin set — deliveries geofence to this exact point.' : 'Drag the coloured pin to the exact gate.')}
            </p>
            <button type="button" onClick={useMyLocation} className={`${linkCls} shrink-0`}>
              <LocateFixed className="w-3.5 h-3.5" /> Use my location
            </button>
          </div>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        {GOOGLE_MAPS_BROWSER_KEY && !value && (
          <button type="button" onClick={() => setPickOnMap((m) => !m)} className={linkCls}>
            <MapPin className="w-3.5 h-3.5" /> {pickOnMap ? 'Hide map' : 'Select on map'}
          </button>
        )}
        <button type="button" onClick={() => setManual((m) => !m)} aria-expanded={manual} className="text-xs font-medium text-gray-500 hover:text-gray-800 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
          {manual ? 'Hide manual coordinates' : 'Enter coordinates manually instead'}
        </button>
      </div>
      {manual && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <input
            type="number" step="any" placeholder="Latitude" aria-label={`${label} latitude`}
            defaultValue={value?.lat ?? ''}
            onChange={(e) => {
              const lat = parseFloat(e.target.value)
              if (Number.isFinite(lat)) onChange({ address: value?.address || `${lat.toFixed(5)}, ${value?.lng ?? ''}`, lat, lng: value?.lng ?? 0, gate_lat: lat, gate_lng: value?.gate_lng ?? value?.lng ?? 0 })
            }}
            className={`${inputCls} tabular-nums`}
          />
          <input
            type="number" step="any" placeholder="Longitude" aria-label={`${label} longitude`}
            defaultValue={value?.lng ?? ''}
            onChange={(e) => {
              const lng = parseFloat(e.target.value)
              if (Number.isFinite(lng)) onChange({ address: value?.address || `${value?.lat ?? ''}, ${lng.toFixed(5)}`, lat: value?.lat ?? 0, lng, gate_lat: value?.gate_lat ?? value?.lat ?? 0, gate_lng: lng })
            }}
            className={`${inputCls} tabular-nums`}
          />
        </div>
      )}
    </div>
  )
}
