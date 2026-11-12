/**
 * The pure rules behind a shipper's "Preferred" carriers (src/lib/preferred/rules.ts):
 * which trips count, who gets the credit for a fleet trip, the order the picker shows,
 * phone masking, and what the search box will and will not run.
 * Run: npx tsx test/preferred-carriers.unit.mts
 */
import { createChecker } from './support/fake-supabase.mts'
import {
  maskPhone,
  parseCarrierSearch,
  rankPreferred,
  reasonsFor,
  tallyFinishedTrips,
} from '../src/lib/preferred/rules.js'

const { check, finish } = createChecker()

// ---- tallyFinishedTrips ------------------------------------------------------
{
  const t = tallyFinishedTrips([
    { driver_id: 'D1', fleet_owner_id: null, updated_at: '2026-10-01T00:00:00Z' },
    { driver_id: 'D1', fleet_owner_id: null, updated_at: '2026-10-05T00:00:00Z' },
    // A fleet trip driven by an employee: the FLEET was hired, so the fleet is credited.
    { driver_id: 'D9', fleet_owner_id: 'F1', updated_at: '2026-10-03T00:00:00Z' },
    { driver_id: null, fleet_owner_id: null, updated_at: '2026-10-04T00:00:00Z' },
  ])
  const d1 = t.find((x) => x.kind === 'driver' && x.id === 'D1')
  check('two solo trips tally to 2 for that driver', d1?.trips === 2, JSON.stringify(d1))
  check('last_trip_at is the most recent of them', d1?.last_trip_at === '2026-10-05T00:00:00Z')
  check('a fleet trip credits the fleet', t.some((x) => x.kind === 'fleet_owner' && x.id === 'F1' && x.trips === 1))
  check('…and NOT the employee who drove it', !t.some((x) => x.id === 'D9'))
  check('a trip with no carrier credits nobody', t.length === 2)
}

// ---- rankPreferred -----------------------------------------------------------
{
  const ranked = rankPreferred([
    { name: 'Star only, older',  trips_with_you: 0, last_trip_at: null, starred_at: '2026-09-01T00:00:00Z' },
    { name: 'One trip',          trips_with_you: 1, last_trip_at: '2026-10-09T00:00:00Z' },
    { name: 'Three trips',       trips_with_you: 3, last_trip_at: '2026-08-01T00:00:00Z' },
    { name: 'One trip, older',   trips_with_you: 1, last_trip_at: '2026-10-01T00:00:00Z' },
    { name: 'Star only, newer',  trips_with_you: 0, last_trip_at: null, starred_at: '2026-10-10T00:00:00Z' },
  ]).map((c) => c.name)
  check('most finished trips first', ranked[0] === 'Three trips', ranked.join(' | '))
  check('equal trips: most recent first', ranked[1] === 'One trip' && ranked[2] === 'One trip, older', ranked.join(' | '))
  check('star-only carriers after every carrier with history, newest star first',
    ranked[3] === 'Star only, newer' && ranked[4] === 'Star only, older', ranked.join(' | '))
}

// ---- reasonsFor --------------------------------------------------------------
check('reasons: trips + starred', JSON.stringify(reasonsFor(2, true)) === '["trips","starred"]')
check('reasons: star only', JSON.stringify(reasonsFor(0, true)) === '["starred"]')
check('reasons: none', reasonsFor(0, false).length === 0)

// ---- maskPhone ---------------------------------------------------------------
check('a phone shows only its last four digits', maskPhone('9876543210') === '••••••3210')
check('a +91 number masks the same way', maskPhone('+91 98765 43210') === '••••••3210')
check('no phone → null', maskPhone(null) === null && maskPhone('12') === null)

// ---- parseCarrierSearch ------------------------------------------------------
{
  const byPhone = parseCarrierSearch('+91 98765-43210')
  check('a whole mobile (with +91, spaces, dash) searches by exact phone',
    byPhone?.by === 'phone' && byPhone.phone === '9876543210', JSON.stringify(byPhone))
  check('a leading 0 is accepted too', (parseCarrierSearch('09876543210') as any)?.phone === '9876543210')
  check('a PARTIAL number is refused — the directory cannot be walked by digits', parseCarrierSearch('98765') === null)
  check('a non-mobile 10-digit number is refused', parseCarrierSearch('1234567890') === null)
  check('a one-letter name is refused', parseCarrierSearch('r') === null)
  check('blank is refused', parseCarrierSearch('   ') === null && parseCarrierSearch(undefined) === null)
  const name = parseCarrierSearch('  Ravi ')
  check('a name becomes a contains-pattern', name?.by === 'name' && name.pattern === '%Ravi%', JSON.stringify(name))
  const wild = parseCarrierSearch('%_')
  check('LIKE wildcards typed by the user are escaped, not obeyed',
    wild?.by === 'name' && wild.pattern === '%\\%\\_%', JSON.stringify(wild))
}

finish()
