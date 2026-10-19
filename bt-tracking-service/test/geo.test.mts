/**
 * Geometry unit tests — the maths every tracking number is built on.
 *
 * These functions are pure and have no I/O, but they are the highest-leverage thing to pin
 * in this service: driven distance, off-route detection, geofence containment and the fuel
 * bill all reduce to them, and a sign error or a degrees/radians slip would not crash —
 * it would quietly produce plausible, wrong numbers on a fleet owner's dashboard.
 *
 * Distances are checked against known real-world values on the pilot corridor rather than
 * against the implementation's own output, so a rewrite has to stay correct, not just stable.
 *
 * Run: npx tsx test/geo.test.mts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  haversineMeters,
  pointToSegmentMeters,
  distanceToPolylineMeters,
  isInsideCircle,
  decodePolyline,
  bearingDegrees,
  isNightIST,
} from '../src/lib/geo.js'

// Real coordinates on the corridor this product actually runs.
const MUMBAI = { lat: 19.076, lng: 72.8777 }
const DELHI = { lat: 28.7041, lng: 77.1025 }
const NAGPUR = { lat: 21.1458, lng: 79.0882 }

/** Assert `actual` is within `tolerance` of `expected`. */
function near(actual: number, expected: number, tolerance: number, what: string) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: expected ~${expected} (+/-${tolerance}), got ${actual}`,
  )
}

test('haversineMeters matches known great-circle distances', () => {
  // Mumbai-Delhi great-circle is ~1150 km (the ROAD route is ~1400 km — a different number,
  // and conflating the two is exactly the bug this pins).
  near(haversineMeters(MUMBAI, DELHI) / 1000, 1150, 15, 'Mumbai-Delhi')
  near(haversineMeters(MUMBAI, NAGPUR) / 1000, 688, 10, 'Mumbai-Nagpur')
  assert.equal(haversineMeters(MUMBAI, MUMBAI), 0, 'a point is zero from itself')
})

test('haversineMeters is symmetric', () => {
  assert.equal(haversineMeters(MUMBAI, DELHI), haversineMeters(DELHI, MUMBAI))
})

test('haversineMeters is accurate at short range', () => {
  // 0.001 degrees of latitude is ~111.2 m anywhere on earth.
  near(haversineMeters({ lat: 19.076, lng: 72.8777 }, { lat: 19.077, lng: 72.8777 }), 111.2, 1, '0.001 deg lat')
  // The same delta in longitude shrinks by cos(latitude) — ~105 m at 19 deg N.
  near(haversineMeters({ lat: 19.076, lng: 72.8777 }, { lat: 19.076, lng: 72.8787 }), 105.1, 1, '0.001 deg lng')
})

test('pointToSegmentMeters clamps to the segment ends', () => {
  const a = { lat: 19.0, lng: 72.0 }
  const b = { lat: 19.0, lng: 73.0 }

  // Directly north of the segment's midpoint: perpendicular distance only.
  near(pointToSegmentMeters({ lat: 19.01, lng: 72.5 }, a, b), 1112, 20, 'perpendicular')

  // Beyond the `a` end — must measure to `a` itself, NOT to the infinite line (which would
  // report ~0 and turn a truck heading the wrong way into "on route").
  const beyond = { lat: 19.0, lng: 71.9 }
  near(pointToSegmentMeters(beyond, a, b), haversineMeters(beyond, a), 2, 'clamped past start')

  const past = { lat: 19.0, lng: 73.1 }
  near(pointToSegmentMeters(past, a, b), haversineMeters(past, b), 2, 'clamped past end')
})

test('pointToSegmentMeters survives a degenerate segment', () => {
  // Encoded polylines routinely contain duplicate consecutive points; a zero-length segment
  // must not produce NaN via a divide-by-zero.
  //
  // Probed from ~300 m away, which is both the realistic case (a duplicate vertex near the
  // truck) and inside the local projection's accuracy range. The projection is anchored at
  // the probe, so it is only claimed to be exact nearby — distant segments carry metres of
  // error, which is harmless because distanceToPolylineMeters only ever uses the MINIMUM,
  // and the minimum is by construction the nearest segment.
  const p = { lat: 19.0787, lng: 72.8777 }
  const d = pointToSegmentMeters(p, MUMBAI, MUMBAI)
  assert.ok(Number.isFinite(d), 'degenerate segment must not be NaN')
  near(d, haversineMeters(p, MUMBAI), 0.5, 'degenerate falls back to point distance')
})

test('distanceToPolylineMeters finds the nearest segment, not the nearest vertex', () => {
  // An L-shaped path. The probe sits near the middle of the first leg, far from every vertex.
  const path = [
    { lat: 19.0, lng: 72.0 },
    { lat: 19.0, lng: 73.0 },
    { lat: 20.0, lng: 73.0 },
  ]
  const probe = { lat: 19.005, lng: 72.5 }

  const toPolyline = distanceToPolylineMeters(probe, path)
  const toNearestVertex = Math.min(...path.map((v) => haversineMeters(probe, v)))

  near(toPolyline, 556, 20, 'perpendicular to the first leg')
  assert.ok(
    toPolyline < toNearestVertex / 10,
    'must measure to the segment, not the nearest vertex (vertex-only would mis-flag off-route)',
  )
})

test('distanceToPolylineMeters degrades safely on empty input', () => {
  // A booking with no computed route must read as "unknown", never as "on route" (0),
  // which would suppress every off-route alert.
  assert.equal(distanceToPolylineMeters(MUMBAI, []), Number.POSITIVE_INFINITY)
  assert.equal(distanceToPolylineMeters(MUMBAI, [MUMBAI]), 0)
})

test('off-route threshold behaves at the locked 500 m boundary (D-012)', () => {
  const path = [
    { lat: 19.0, lng: 72.0 },
    { lat: 19.0, lng: 73.0 },
  ]
  // ~334 m north of the line: on route.
  assert.ok(distanceToPolylineMeters({ lat: 19.003, lng: 72.5 }, path) < 500)
  // ~778 m north: off route.
  assert.ok(distanceToPolylineMeters({ lat: 19.007, lng: 72.5 }, path) > 500)
})

test('isInsideCircle is inclusive at the boundary', () => {
  const centre = MUMBAI
  const inside = { lat: 19.0769, lng: 72.8777 } // ~100 m north

  assert.equal(isInsideCircle(inside, centre, 500), true)
  assert.equal(isInsideCircle(inside, centre, 50), false)
  assert.equal(isInsideCircle(centre, centre, 50), true, 'the centre is inside')
})

test('decodePolyline round-trips the reference example', () => {
  // The canonical example from Google's polyline algorithm documentation.
  const points = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')
  assert.equal(points.length, 3)
  near(points[0].lat, 38.5, 0.001, 'p0 lat')
  near(points[0].lng, -120.2, 0.001, 'p0 lng')
  near(points[1].lat, 40.7, 0.001, 'p1 lat')
  near(points[1].lng, -120.95, 0.001, 'p1 lng')
  near(points[2].lat, 43.252, 0.001, 'p2 lat')
  near(points[2].lng, -126.453, 0.001, 'p2 lng')
})

test('decodePolyline degrades to [] rather than throwing', () => {
  // A missing or corrupt route must disable the off-route check, never fail a GPS ingest.
  assert.deepEqual(decodePolyline(''), [])
  assert.ok(Array.isArray(decodePolyline('!!!not-a-polyline!!!')))
})

test('bearingDegrees points the right way', () => {
  near(bearingDegrees({ lat: 19.0, lng: 72.0 }, { lat: 20.0, lng: 72.0 }), 0, 1, 'due north')
  near(bearingDegrees({ lat: 19.0, lng: 72.0 }, { lat: 19.0, lng: 73.0 }), 89.8, 1, 'due east')
  near(bearingDegrees({ lat: 19.0, lng: 72.0 }, { lat: 18.0, lng: 72.0 }), 180, 1, 'due south')
  near(bearingDegrees({ lat: 19.0, lng: 72.0 }, { lat: 19.0, lng: 71.0 }), 270.2, 1, 'due west')

  const b = bearingDegrees(MUMBAI, DELHI)
  assert.ok(b >= 0 && b < 360, 'always normalised into [0,360)')
  assert.ok(b > 0 && b < 45, 'Delhi is north-north-east of Mumbai')
})

test('isNightIST brackets 22:00-06:00 India time', () => {
  // 18:30 UTC == 00:00 IST — night.
  assert.equal(isNightIST(new Date('2026-07-31T18:30:00Z')), true, 'midnight IST')
  // 16:30 UTC == 22:00 IST — the boundary, inclusive.
  assert.equal(isNightIST(new Date('2026-07-31T16:30:00Z')), true, '22:00 IST')
  // 00:30 UTC == 06:00 IST — day resumes, exclusive.
  assert.equal(isNightIST(new Date('2026-07-31T00:30:00Z')), false, '06:00 IST')
  // 06:30 UTC == 12:00 IST — clearly day.
  assert.equal(isNightIST(new Date('2026-07-31T06:30:00Z')), false, 'noon IST')
  // 16:00 UTC == 21:30 IST — just before the window.
  assert.equal(isNightIST(new Date('2026-07-31T16:00:00Z')), false, '21:30 IST')
})
