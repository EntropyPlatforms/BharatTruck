'use client'

/**
 * RouteMap — a compact, real Google map for PREVIEWS: a trip's pickup → drop before live
 * tracking starts, the fleet's trucks on the dashboard, the landing hero. Live tracking
 * keeps LiveTrackMap (cloud-styled vector map, AdvancedMarker, polling).
 *
 * Same frozen Maps contract as LiveTrackMap: Maps JavaScript API via
 * `@vis.gl/react-google-maps`, public browser key only, never a server key.
 *
 * Deliberately created WITHOUT a mapId so the classic JSON style (LIGHT_MAP_STYLE) applies,
 * and markers are plain HTML in an OverlayView (Advanced Markers need a mapId; the classic
 * google.maps.Marker is deprecated). With no road polyline the pickup → drop line is drawn
 * DASHED — an honest "as the crow flies" sketch, not a pretend road route.
 *
 * Degrades like every map here (map-guard): no key, a rejected key, a render error or tiles
 * that never paint all show `fallback` (default: the MapFallback note). Nothing around it
 * depends on the map.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps'
import { Truck } from 'lucide-react'
import { MapBoundary, MapFallback, useMapsAuthFailed, useMapRenderWatchdog } from '@/components/map-guard'
import {
  decodePolyline,
  GOOGLE_MAPS_BROWSER_KEY,
  DARK_MAP_STYLE,
  LIGHT_MAP_STYLE,
  type LatLng,
  type MapBounds,
} from '@/lib/maps'
import { cx } from '@/lib/ui'
import { useIsDark } from '@/components/theme-sync'

export interface MapTruck {
  id: string
  position: LatLng
  /** moving = green ring, stopped = amber, offline = grey. */
  tone?: 'moving' | 'stopped' | 'offline'
  title?: string
}

type Padding = number | { top: number; right: number; bottom: number; left: number }

interface RouteMapProps {
  origin?: LatLng | null
  dest?: LatLng | null
  /** Short place names drawn beside the pins (e.g. city). */
  originLabel?: string
  destLabel?: string
  /** A known road path (or waypoints); otherwise `encodedPolyline`; otherwise a dashed line. */
  path?: LatLng[]
  encodedPolyline?: string
  bounds?: MapBounds
  trucks?: MapTruck[]
  /** Pan/zoom allowed (cooperative: two fingers / ctrl+scroll). Default false: a still picture. */
  interactive?: boolean
  /** Keep the route clear of overlays the caller draws on top (px). */
  padding?: Padding
  /** Zoom used when there is only one point to show. */
  singleZoom?: number
  className?: string
  /** Shown instead of the map when it cannot be drawn. */
  fallback?: ReactNode
  /** Overlays (chips, legends) positioned over the map; hidden along with it on fallback. */
  children?: ReactNode
}

export default function RouteMap({
  origin, dest, originLabel, destLabel, path, encodedPolyline, bounds, trucks = [],
  interactive = false, padding = 40, singleZoom = 9, className = 'h-56 w-full', fallback, children,
}: RouteMapProps) {
  const roadPath = useMemo(
    () => (path && path.length > 1 ? path : encodedPolyline ? decodePolyline(encodedPolyline) : []),
    [path, encodedPolyline],
  )
  const dark = useIsDark()
  const authFailed = useMapsAuthFailed()
  const { timedOut, onReady } = useMapRenderWatchdog()

  const unavailable = fallback ?? (
    <MapFallback className={className} detail="The map could not be loaded. Everything else on this page works." />
  )
  if (!GOOGLE_MAPS_BROWSER_KEY || authFailed || timedOut) return <>{unavailable}</>

  const center = origin ?? dest ?? trucks[0]?.position ?? { lat: 22.5, lng: 79 }

  return (
    <div className={cx('relative overflow-hidden bg-[#f3f5f8] dark:bg-[#151b25]', className)}>
      <MapBoundary fallback={unavailable}>
        {/* English labels: the app is in English, and bilingual place names crowd a small map. */}
        <APIProvider apiKey={GOOGLE_MAPS_BROWSER_KEY} language="en">
          <Map
            defaultCenter={center}
            defaultZoom={6}
            styles={dark ? DARK_MAP_STYLE : LIGHT_MAP_STYLE}
            disableDefaultUI
            zoomControl={interactive}
            gestureHandling={interactive ? 'cooperative' : 'none'}
            keyboardShortcuts={false}
            clickableIcons={false}
            backgroundColor={dark ? '#151b25' : '#f3f5f8'}
            style={{ width: '100%', height: '100%' }}
          >
            <Route
              origin={origin ?? null}
              dest={dest ?? null}
              road={roadPath}
              bounds={bounds}
              trucks={trucks}
              padding={padding}
              singleZoom={singleZoom}
              onReady={onReady}
            />
            {origin && (
              <HtmlMarker position={origin} z={2}>
                <Stop kind="origin" label={originLabel} />
              </HtmlMarker>
            )}
            {dest && (
              <HtmlMarker position={dest} z={2}>
                <Stop kind="dest" label={destLabel} />
              </HtmlMarker>
            )}
            {trucks.map(t => (
              <HtmlMarker key={t.id} position={t.position} z={3}>
                <TruckDot tone={t.tone} title={t.title} />
              </HtmlMarker>
            ))}
          </Map>
        </APIProvider>
        {children}
      </MapBoundary>
    </div>
  )
}

/**
 * Draws the route (a pale halo under a solid line; dashed when there is no road path),
 * fits the view to everything shown, re-fits when the box resizes, and reports the
 * first painted tiles to the render watchdog.
 */
function Route({
  origin, dest, road, bounds, trucks, padding, singleZoom, onReady,
}: {
  origin: LatLng | null
  dest: LatLng | null
  road: LatLng[]
  bounds?: MapBounds
  trucks: MapTruck[]
  padding: Padding
  singleZoom: number
  onReady: () => void
}) {
  const map = useMap()

  useEffect(() => {
    if (!map) return
    const l = map.addListener('tilesloaded', onReady)
    return () => l.remove()
  }, [map, onReady])

  useEffect(() => {
    if (!map) return
    const lines: google.maps.Polyline[] = []
    if (road.length > 1) {
      lines.push(new google.maps.Polyline({ path: road, strokeColor: '#9db6ff', strokeOpacity: 0.6, strokeWeight: 10, clickable: false, map }))
      lines.push(new google.maps.Polyline({ path: road, strokeColor: '#2457f5', strokeOpacity: 1, strokeWeight: 4, clickable: false, map }))
    } else if (origin && dest) {
      lines.push(new google.maps.Polyline({
        path: [origin, dest],
        geodesic: true,
        strokeOpacity: 0,
        clickable: false,
        icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: '#2457f5', strokeWeight: 3, scale: 3 }, offset: '0', repeat: '14px' }],
        map,
      }))
    }
    return () => lines.forEach(l => l.setMap(null))
  }, [map, road, origin, dest])

  // Fit the view to the route, pins and trucks — and again whenever the box changes size.
  const fitKey = JSON.stringify([origin, dest, road.length, road[0], road[road.length - 1], bounds, trucks.map(t => t.position), padding])
  useEffect(() => {
    if (!map) return
    const pts: LatLng[] = [...road, ...(origin ? [origin] : []), ...(dest ? [dest] : []), ...trucks.map(t => t.position)]
    const fit = () => {
      if (bounds) {
        map.fitBounds({ south: bounds.sw_lat, west: bounds.sw_lng, north: bounds.ne_lat, east: bounds.ne_lng }, padding)
      } else if (pts.length === 1) {
        map.setCenter(pts[0]); map.setZoom(singleZoom)
      } else if (pts.length > 1) {
        const box = new google.maps.LatLngBounds()
        pts.forEach(p => box.extend(p))
        map.fitBounds(box, padding)
      }
    }
    fit()
    const ro = new ResizeObserver(() => fit())
    ro.observe(map.getDiv())
    return () => ro.disconnect()
    // fitKey stands in for the array/object props, which are rebuilt on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, fitKey, singleZoom])

  return null
}

/**
 * An HTML element pinned to a lat/lng (centre-anchored), drawn through an OverlayView so
 * it needs no mapId. Not interactive: it sits in the overlay pane, below the map's events.
 */
function HtmlMarker({ position, z = 1, children }: { position: LatLng; z?: number; children: ReactNode }) {
  const map = useMap()
  const [el] = useState(() => (typeof document === 'undefined' ? null : document.createElement('div')))
  const pos = useRef(position)
  const overlay = useRef<google.maps.OverlayView | null>(null)

  useEffect(() => {
    if (!map || !el) return
    const ov = new google.maps.OverlayView()
    ov.onAdd = () => {
      el.style.position = 'absolute'
      el.style.zIndex = String(z)
      ov.getPanes()?.overlayLayer.appendChild(el)
    }
    ov.draw = () => {
      const p = ov.getProjection()?.fromLatLngToDivPixel(pos.current)
      if (!p) return
      el.style.left = `${p.x}px`
      el.style.top = `${p.y}px`
    }
    ov.onRemove = () => el.remove()
    ov.setMap(map)
    overlay.current = ov
    return () => { ov.setMap(null); overlay.current = null }
  }, [map, el, z])

  useEffect(() => {
    pos.current = position
    overlay.current?.draw()
  }, [position])

  if (!el) return null
  return createPortal(<div className="-translate-x-1/2 -translate-y-1/2">{children}</div>, el)
}

function Stop({ kind, label }: { kind: 'origin' | 'dest'; label?: string }) {
  return (
    <div className="relative">
      <span
        className={cx(
          'block rounded-full shadow-[0_1px_3px_rgba(20,24,31,0.35)]',
          // Pickup green, drop red — the same colours as the route rails beside every map.
          kind === 'origin' ? 'h-4 w-4 border-[4px] border-emerald-500 bg-white' : 'h-4 w-4 border-[3px] border-white bg-red-500',
        )}
      />
      {label && (
        <span className="absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap rounded-md bg-white/95 px-1.5 py-0.5 text-[0.75rem] font-bold text-gray-900 shadow-[0_1px_3px_rgba(20,24,31,0.18)]">
          {label}
        </span>
      )}
    </div>
  )
}

const TRUCK_RING: Record<NonNullable<MapTruck['tone']>, string> = {
  moving: 'ring-emerald-500',
  stopped: 'ring-amber-500',
  offline: 'ring-gray-400',
}

function TruckDot({ tone = 'moving', title }: { tone?: MapTruck['tone']; title?: string }) {
  return (
    <span
      title={title}
      className={cx(
        'flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-brand-500 text-ink shadow-[0_2px_6px_rgba(20,24,31,0.35)] ring-2',
        TRUCK_RING[tone],
        tone === 'offline' && 'bg-gray-200 text-gray-500',
      )}
    >
      <Truck className="h-4 w-4" strokeWidth={2.4} />
    </span>
  )
}
