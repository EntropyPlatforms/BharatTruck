import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { hydrateDriverIdentities } from '../lib/fleet-repo.js'
import { requireFleetAccess } from '../lib/fleet-access.js'
import {
  createVehicle,
  getVehicleFinance,
  listFleetVehicles,
  listVehicleLanes,
  listVehiclePermits,
  replaceVehicleLanes,
  replaceVehiclePermits,
  requireFleetVehicle,
  updateVehicle,
  upsertVehicleFinance,
} from '../lib/vehicles-repo.js'
import { listLiveAssignments } from '../lib/assignment.js'
import { getVehicleAvailability } from '../lib/vehicle-schedule.js'
import { getCostNorms, listModelCategories, vehicleAgeYears } from '../lib/economics.js'
import { assertParserAvailable, importVehiclesCsv, importVehiclesFromDocument, type BulkImportFormat } from '../lib/bulk-import.js'
import { parseOrThrow } from '../lib/types.js'
import { requireBusinessIdentity } from '../lib/vehicle-gate.js'

// -----------------------------------------------------------
// vehicleRoutes — fleet-owned trucks (mounted at /fleet/vehicles).
//
// model_category / manufacture_year are REQUIRED on create even though the column
// is nullable: they are what make the per-asset P&L computable, and a truck whose
// economics cannot be modelled is invisible in every dashboard the owner came for.
// (The columns stay nullable because legacy solo-driver rows predate them.)
// -----------------------------------------------------------

const emissionNorm = z.enum(['BS4', 'BS6', 'BS6_PH2'])

/**
 * A Postgres `date` column, validated HERE rather than at the database.
 *
 * Five fields map to `date` (finance start/end, permit issued_on/expiry_date, rc_expiry) and
 * were previously plain strings. That matters more than a tidy error message, because
 * `replaceVehiclePermits` and `replaceVehicleLanes` DELETE the existing rows and then INSERT
 * over two independent PostgREST calls with no transaction: a date the DB rejects means the
 * delete has already committed and the truck's permits are simply gone, surfaced as an opaque
 * 500. Rejecting the bad value before any write is what makes that unreachable.
 *
 * Requiring ISO `YYYY-MM-DD` is deliberate. Postgres's default DateStyle is `ISO, MDY`, so
 * `01-13-2025` does NOT error — it silently parses as 13 Jan 2025. A DD/MM/YYYY habit therefore
 * corrupts data rather than failing loudly, which is the worse outcome.
 *
 * `''` is coerced to null: an untouched date input in a form posts an empty string, and the
 * repo's `?? null` is nullish-coalescing, so it would otherwise pass `''` straight to a `date`.
 */
const dateOnly = z.preprocess(
  v => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
    .refine(s => {
      const d = new Date(`${s}T00:00:00Z`)
      // Round-trips only for a real calendar date — rejects 2026-02-30 and 2026-13-01,
      // which the regex alone happily accepts.
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
    }, 'Not a valid calendar date')
    .nullable(),
).nullable().optional()

const CreateVehicleBody = z.object({
  rc_number: z.string().trim().min(4, 'rc_number must be at least 4 characters').max(20),
  model_category: z.string().trim().min(1, 'model_category is required'),
  manufacture_year: z.number().int().min(1990, 'manufacture_year must be between 1990 and 2100').max(2100),
  // Null means "older than BS4" — a real case on a 15-year-old truck, and the cost
  // model has dedicated *_old columns for it.
  emission_norm: emissionNorm.nullable().optional(),
  capacity_tons: z.number().positive().max(100).nullable().optional(),
  volume_cuft: z.number().positive().max(100_000).nullable().optional(),
  current_odometer_km: z.number().int().min(0).max(5_000_000).nullable().optional(),
  body_type: z.string().trim().max(50).nullable().optional(),
  axle_config: z.string().trim().max(20).nullable().optional(),
  maker_model: z.string().trim().max(100).nullable().optional(),
  fuel_type: z.string().trim().max(20).nullable().optional(),
  rc_expiry: dateOnly,
})

const UpdateVehicleBody = CreateVehicleBody.partial().refine(
  body => Object.keys(body).length > 0,
  'No fields to update',
)

const BulkBody = z.object({
  format: z.enum(['csv', 'xlsx', 'pdf', 'image'], {
    errorMap: () => ({ message: 'format must be one of csv, xlsx, pdf, image' }),
  }),
  content: z.string().min(1, 'content is required'),
  // For pdf/image, `content` is base64 of the file and `mime_type` is its exact type
  // (application/pdf, image/jpeg, …) so Document AI gets the right hint. Ignored for csv.
  mime_type: z.string().trim().max(100).optional(),
})

const FinanceBody = z.object({
  lender: z.string().trim().max(120).nullable().optional(),
  loan_account_no: z.string().trim().max(60).nullable().optional(),
  principal_inr: z.number().positive().max(100_000_000).nullable().optional(),
  emi_amount_inr: z.number().min(0, 'emi_amount_inr cannot be negative').max(10_000_000),
  emi_day_of_month: z.number().int().min(1).max(31).nullable().optional(),
  tenure_months: z.number().int().positive().max(600).nullable().optional(),
  interest_rate_pct: z.number().min(0).max(100).nullable().optional(),
  start_date: dateOnly,
  end_date: dateOnly,
  outstanding_inr: z.number().min(0).max(100_000_000).nullable().optional(),
  insurance_annual_inr: z.number().min(0).max(10_000_000).default(0),
  permit_annual_inr: z.number().min(0).max(10_000_000).default(0),
  fitness_annual_inr: z.number().min(0).max(10_000_000).default(0),
})

const PermitsBody = z.object({
  permits: z.array(z.object({
    permit_type: z.enum(['national', 'state', 'contract_carriage', 'goods']).default('national'),
    // Empty for a national permit — that is the migration's documented convention.
    allowed_states: z.array(z.string().trim().min(1).max(5)).max(40).default([]),
    permit_number: z.string().trim().max(60).nullable().optional(),
    issued_on: dateOnly,
    expiry_date: dateOnly,
    is_active: z.boolean().default(true),
  })).max(20),
})

const LanesBody = z.object({
  lanes: z.array(z.object({
    origin_city: z.string().trim().min(1, 'origin_city is required').max(100),
    destination_city: z.string().trim().min(1, 'destination_city is required').max(100),
    origin_lat: z.number().min(-90).max(90).nullable().optional(),
    origin_lng: z.number().min(-180).max(180).nullable().optional(),
    dest_lat: z.number().min(-90).max(90).nullable().optional(),
    dest_lng: z.number().min(-180).max(180).nullable().optional(),
    typical_distance_km: z.number().positive().max(10_000).nullable().optional(),
    is_primary: z.boolean().default(false),
  })).max(20),
}).refine(
  // vehicle_lanes_one_primary would reject this at the DB anyway; catching it here
  // gives the owner a field-level message instead of a constraint name.
  body => body.lanes.filter(l => l.is_primary).length <= 1,
  'At most one lane may be marked primary',
)

const IdParam = z.object({ id: z.string().uuid('id must be a valid UUID') })

export async function vehicleRoutes(app: FastifyInstance) {
  // POST /fleet/vehicles
  app.post('/', async (req, reply) => {
    const owner = await requireFleetAccess(req.user, 'manage_assets')
    // Adding a truck needs the business's GSTIN on file (lib/vehicle-gate.ts). Checked
    // BEFORE body validation so an owner without GST hears the real blocker first, not
    // a field message they would fix only to hit this wall next.
    await requireBusinessIdentity(owner)
    const body = parseOrThrow(CreateVehicleBody, req.body)
    // Reject an unknown category up front: the DB has no FK to vehicle_cost_norms,
    // so an unmatched value would only surface later as un-modellable economics.
    await getCostNorms(body.model_category)

    const vehicle = await createVehicle(owner.id, body)
    return reply.status(201).send({ success: true, data: vehicle })
  })

  // POST /fleet/vehicles/bulk — csv parsed directly; pdf/image go through OCR (Document AI);
  // xlsx returns 501. A larger bodyLimit than the app default because a base64-encoded scan is
  // far bigger than a CSV (still well under Cloud Run's request cap).
  app.post('/bulk', { bodyLimit: 15 * 1024 * 1024 }, async (req, reply) => {
    const owner = await requireFleetAccess(req.user, 'manage_assets')
    // Same GST gate as the single-truck create: a bulk register is N inserts.
    await requireBusinessIdentity(owner)
    const body = parseOrThrow(BulkBody, req.body)
    const format = body.format as BulkImportFormat
    assertParserAvailable(format)

    const result =
      format === 'csv'
        ? await importVehiclesCsv(owner.id, body.content)
        : await importVehiclesFromDocument(
            owner.id,
            Buffer.from(body.content, 'base64'),
            body.mime_type ?? (format === 'pdf' ? 'application/pdf' : 'image/jpeg'),
          )
    // 207-style semantics without the multistatus body: partial success is the normal outcome
    // of a real fleet register, so it is still a 200 with the per-row errors attached.
    return reply.send({ success: true, data: result })
  })

  // GET /fleet/vehicles — list + live status (assigned / idle) in two queries.
  app.get('/', async (req, reply) => {
    const owner = await requireFleetAccess(req.user, 'any')
    const [vehicles, live] = await Promise.all([
      listFleetVehicles(owner.id),
      listLiveAssignments(owner.id),
    ])
    const liveByVehicle = new Map(live.map(a => [a.vehicle_id, a]))
    const identities = await hydrateDriverIdentities(live.map(a => a.driver_id))

    return reply.send({
      success: true,
      data: vehicles.map(v => {
        const assignment = liveByVehicle.get(v.id)
        return {
          ...v,
          age_years: vehicleAgeYears(v.manufacture_year),
          status: assignment ? 'on_trip' : 'idle',
          current_assignment: assignment
            ? {
                assignment_id: assignment.id,
                booking_id: assignment.booking_id,
                driver_id: assignment.driver_id,
                driver_name: identities.get(assignment.driver_id)?.full_name ?? null,
                assigned_at: assignment.assigned_at,
              }
            : null,
        }
      }),
    })
  })

  // GET /fleet/vehicles/model-categories — the allowed model_category values, so
  // the onboarding form and the CSV template stay in step with the seeded norms.
  app.get('/model-categories', async (req, reply) => {
    await requireFleetAccess(req.user, 'any')
    return reply.send({ success: true, data: await listModelCategories() })
  })

  // GET /fleet/vehicles/:id — the full asset record.
  app.get('/:id', async (req, reply) => {
    const owner = await requireFleetAccess(req.user, 'any')
    const params = parseOrThrow(IdParam, req.params)
    const vehicle = await requireFleetVehicle(owner.id, params.id)

    const [finance, permits, lanes, live] = await Promise.all([
      getVehicleFinance(vehicle.id),
      listVehiclePermits(vehicle.id),
      listVehicleLanes(vehicle.id),
      listLiveAssignments(owner.id),
    ])
    const assignment = live.find(a => a.vehicle_id === vehicle.id) ?? null

    return reply.send({
      success: true,
      data: {
        ...vehicle,
        age_years: vehicleAgeYears(vehicle.manufacture_year),
        status: assignment ? 'on_trip' : 'idle',
        finance,
        permits,
        lanes,
        current_assignment: assignment,
      },
    })
  })

  // GET /fleet/vehicles/:id/availability
  //
  // D-19's read side: the owner asks BEFORE choosing a truck, so "this one is out
  // until the 13th" shows up in the picker rather than as a 409 after they have
  // already told the shipper which truck is coming.
  //
  // NO DATE RANGE, DELIBERATELY. The tempting signature is ?from=&to= — "is this
  // truck free 20-25 Aug". It is not offered because assignment is gated by
  // vehicle_assignments_one_live_per_vehicle, which refuses a second live assignment
  // on ANY dates: answering "free 20-25 Aug" for a truck that is out today would be
  // a promise POST /fleet/bookings/:id/assign is guaranteed to break every time. The
  // two endpoints answer the same question or this one does not ship.
  app.get('/:id/availability', async (req, reply) => {
    const owner = await requireFleetAccess(req.user, 'any')
    const params = parseOrThrow(IdParam, req.params)
    // Tenancy first: this must not become a way to probe another fleet's trucks.
    const vehicle = await requireFleetVehicle(owner.id, params.id)

    return reply.send({ success: true, data: await getVehicleAvailability(vehicle.id) })
  })

  // PATCH /fleet/vehicles/:id
  app.patch('/:id', async (req, reply) => {
    const owner = await requireFleetAccess(req.user, 'manage_assets')
    const params = parseOrThrow(IdParam, req.params)
    const body = parseOrThrow(UpdateVehicleBody, req.body)
    if (body.model_category) await getCostNorms(body.model_category)

    const vehicle = await updateVehicle(owner.id, params.id, body)
    return reply.send({ success: true, data: vehicle })
  })

  // PUT /fleet/vehicles/:id/finance — EMI + annual carrying costs.
  app.put('/:id/finance', async (req, reply) => {
    const owner = await requireFleetAccess(req.user, 'manage_assets')
    const params = parseOrThrow(IdParam, req.params)
    const body = parseOrThrow(FinanceBody, req.body)
    const vehicle = await requireFleetVehicle(owner.id, params.id)

    const finance = await upsertVehicleFinance(vehicle.id, {
      lender: body.lender ?? null,
      loan_account_no: body.loan_account_no ?? null,
      principal_inr: body.principal_inr ?? null,
      emi_amount_inr: body.emi_amount_inr,
      emi_day_of_month: body.emi_day_of_month ?? null,
      tenure_months: body.tenure_months ?? null,
      interest_rate_pct: body.interest_rate_pct ?? null,
      start_date: body.start_date ?? null,
      end_date: body.end_date ?? null,
      outstanding_inr: body.outstanding_inr ?? null,
      insurance_annual_inr: body.insurance_annual_inr,
      permit_annual_inr: body.permit_annual_inr,
      fitness_annual_inr: body.fitness_annual_inr,
    })
    return reply.send({ success: true, data: finance })
  })

  // PUT /fleet/vehicles/:id/permits — replaces the whole permit set for the truck.
  app.put('/:id/permits', async (req, reply) => {
    const owner = await requireFleetAccess(req.user, 'manage_assets')
    const params = parseOrThrow(IdParam, req.params)
    const body = parseOrThrow(PermitsBody, req.body)
    const vehicle = await requireFleetVehicle(owner.id, params.id)

    const permits = await replaceVehiclePermits(vehicle.id, body.permits)
    return reply.send({ success: true, data: permits })
  })

  // PUT /fleet/vehicles/:id/lanes — the corridor the truck actually runs. Editable
  // by design: the corridor is a CONSEQUENCE of the permits, not a hardcoded route.
  app.put('/:id/lanes', async (req, reply) => {
    const owner = await requireFleetAccess(req.user, 'manage_assets')
    const params = parseOrThrow(IdParam, req.params)
    const body = parseOrThrow(LanesBody, req.body)
    const vehicle = await requireFleetVehicle(owner.id, params.id)

    const lanes = await replaceVehicleLanes(vehicle.id, body.lanes)
    return reply.send({ success: true, data: lanes })
  })
}
