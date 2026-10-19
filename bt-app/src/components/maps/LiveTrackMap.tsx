'use client'

/**
 * LiveTrackMap — the shipper's live-tracking map, COPIED into bt-app per the frozen
 * Maps & Tracking contract decision #8 (docs/BIBLE.md §3.1 — apps do NOT share the
 * map component). Ported from shipper/src/components/maps/LiveTrackMap.tsx.
 *
 * FROZEN facts this obeys:
 *  - Browser layer uses `@vis.gl/react-google-maps` + the Maps JavaScript API only.
 *    The road polyline is computed server-side by bt-tracking-service (Routes API)
 *    and passed in already ENCODED — this component only DRAWS it.
 *  - Only the public browser key / map id are read here (both `NEXT_PUBLIC_`). The
 *    secret server key never touches app code.
 *
 * Degrades gracefully, and more completely than the shipper's original did: it
 * reuses bt-app's map-guard, so a MISSING key, an INVALID/over-quota/wrong-referrer
 * key (Google's `gm_authFailure`), a thrown render error, or tiles that simply never
 * paint all collapse to the same honest "map unavailable" note — never a crash and
 * never an endless grey box. The booking page around it stays fully usable, because
 * the map is the nicest way to read a trip, not the only one.
 */

import { useEffect, useMemo } from 'react'
import { APIProvider, Map, AdvancedMarker, useMap } from '@vis.gl/react-google-maps'
import { MapBoundary, MapFallback, useMapsAuthFailed, useMapRenderWatchdog } from '@/components/map-guard'
import { useIsDark } from '@/components/theme-sync'
import {
  decodePolyline,
  lerp,
  GOOGLE_MAPS_BROWSER_KEY,
  GOOGLE_MAPS_MAP_ID,
  type LatLng,
  type MapBounds,
} from '@/lib/maps'

interface LiveTrackMapProps {
  origin: LatLng
  dest: LatLng
  /** Encoded polyline of the base road route (from bt-tracking-service). */
  encodedPolyline?: string
  /** Route viewport to fit; falls back to the decoded path / pickup+drop. */
  bounds?: MapBounds
  /** Current driver position; hidden when null/undefined. */
  driver?: LatLng | null
  className?: string
}

const DEFAULT_CLASS = 'h-[60vh] w-full rounded-xl overflow-hidden border border-gray-200'

export default function LiveTrackMap({
  origin,
  dest,
  encodedPolyline,
  bounds,
  driver,
  className,
}: LiveTrackMapProps) {
  const path = useMemo(
    () => (encodedPolyline ? decodePolyline(encodedPolyline) : []),
    [encodedPolyline],
  )
  const center = useMemo(() => lerp(origin, dest, 0.5), [origin, dest])

  // Two of the three failure detectors sit above the map subtree: Google's own
  // auth-failure callback, and a watchdog that fires if tiles never paint. The
  // third (a thrown render error) is caught by MapBoundary just inside.
  const dark = useIsDark()
  const authFailed = useMapsAuthFailed()
  const { timedOut, onReady } = useMapRenderWatchdog()

  // A missing key must degrade to a usable page, not a crash — the caption and the
  // rest of the booking page work with no map at all.
  if (!GOOGLE_MAPS_BROWSER_KEY) {
    return <MapUnavailable className={className} detail="Live map key is not configured for this deployment." />
  }

  if (authFailed || timedOut) {
    return (
      <MapUnavailable
        className={className}
        detail="Google rejected the map key for this site. It is usually the key's allowed-referrer list, an unactivated API, or an exhausted quota."
      />
    )
  }

  return (
    <div className={className ?? DEFAULT_CLASS}>
      <MapBoundary fallback={<MapUnavailable className={className} detail="The live map could not be drawn. This is a display problem only." />}>
        <APIProvider apiKey={GOOGLE_MAPS_BROWSER_KEY}>
          <Map
            // The colour scheme is fixed when a map is created: remount on a theme change.
            key={dark ? 'dark' : 'light'}
            colorScheme={dark ? 'DARK' : 'LIGHT'}
            defaultCenter={center}
            defaultZoom={7}
            mapId={GOOGLE_MAPS_MAP_ID || undefined}
            gestureHandling="greedy"
            disableDefaultUI
            style={{ width: '100%', height: '100%' }}
          >
            <AdvancedMarker position={origin} title="Pickup">
              <Pin color="#16a34a" label="A" />
            </AdvancedMarker>
            <AdvancedMarker position={dest} title="Drop">
              <Pin color="#dc2626" label="B" />
            </AdvancedMarker>
            {driver && (
              <AdvancedMarker position={driver} title="Driver">
                <span style={{ fontSize: 30, lineHeight: 1 }}>🚚</span>
              </AdvancedMarker>
            )}
            <RouteOverlay path={path} origin={origin} dest={dest} bounds={bounds} onReady={onReady} />
          </Map>
        </APIProvider>
      </MapBoundary>
    </div>
  )
}

/**
 * Draws the road polyline and fits the viewport to the route (or, when no polyline
 * is available yet, to the pickup/drop pair). Also reports the first real paint
 * (`tilesloaded`) so the render watchdog can stand down — the map instance existing
 * is not proof anything drew, so we wait for tiles, not for `useMap()`.
 */
function RouteOverlay({
  path,
  origin,
  dest,
  bounds,
  onReady,
}: {
  path: LatLng[]
  origin: LatLng
  dest: LatLng
  bounds?: MapBounds
  onReady: () => void
}) {
  const map = useMap()

  useEffect(() => {
    if (!map) return
    const listener = map.addListener('tilesloaded', onReady)
    return () => listener.remove()
  }, [map, onReady])

  useEffect(() => {
    if (!map) return

    const line =
      path.length > 1
        ? new google.maps.Polyline({
            path,
            geodesic: false,
            strokeColor: '#2563eb',
            strokeOpacity: 0.9,
            strokeWeight: 4,
          })
        : null
    line?.setMap(map)

    const box = new google.maps.LatLngBounds()
    if (bounds) {
      box.extend({ lat: bounds.sw_lat, lng: bounds.sw_lng })
      box.extend({ lat: bounds.ne_lat, lng: bounds.ne_lng })
    } else {
      const pts = path.length > 1 ? path : [origin, dest]
      pts.forEach((p) => box.extend(p))
    }
    if (!box.isEmpty()) map.fitBounds(box, 48)

    return () => {
      line?.setMap(null)
    }
  }, [map, path, origin, dest, bounds])

  return null
}

function Pin({ color, label }: { color: string; label: string }) {
  return (
    <div
      style={{
        width: 26,
        height: 26,
        borderRadius: '50% 50% 50% 0',
        transform: 'rotate(-45deg)',
        background: color,
        border: '2px solid white',
        boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <span style={{ transform: 'rotate(45deg)', color: 'white', fontSize: 12, fontWeight: 700 }}>
        {label}
      </span>
    </div>
  )
}

function MapUnavailable({ className, detail }: { className?: string; detail: string }) {
  return (
    <MapFallback
      className={className ?? DEFAULT_CLASS}
      detail={detail}
      note="The trip status and live-location caption below are unaffected."
    />
  )
}
