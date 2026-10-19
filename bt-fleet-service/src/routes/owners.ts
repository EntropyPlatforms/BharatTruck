import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createFleetOwner, getFleetOwnerByUserId, requireFleetOwner, updateFleetOwner } from '../lib/fleet-repo.js'
import { FleetError, parseOrThrow } from '../lib/types.js'

// -----------------------------------------------------------
// ownerRoutes — the fleet party itself (mounted at /fleet/owners).
//
// fleet_owners.user_id is the ONLY link between a JWT and a tenant. It is written
// once, from req.user.userId, and is not patchable — re-pointing it would hand one
// account another fleet's entire estate.
// -----------------------------------------------------------

// -----------------------------------------------------------
// GSTIN / PAN — FORMAT, not just length.
//
// These were length-only (`.length(15)` / `.length(10)`), which is not validation: it
// accepts fifteen letters as a GSTIN. The live data shows the gap being used — one
// fleet carries pan 'ABCDE123FG', exactly ten characters and not a PAN (the 6th-9th
// characters must be digits).
//
// The GSTIN pattern is COPIED DELIBERATELY from the two places that already agree on
// it for the shipper side — bt-auth-service/src/routes/identity.ts and the
// users_gstin_format CHECK on the users table — so that the same number is not valid
// for a shipper and invalid for a fleet. PAN has no existing precedent in the codebase;
// this is the standard Income Tax format: five letters, four digits, one letter.
//
// Uppercased BEFORE the regex rather than rejecting lowercase. Both identifiers are
// canonically uppercase (the users CHECK will not store anything else, and the settings
// UI already uppercases on the way in), so normalising here means a fleet owner typing
// their own GSTIN in lower case gets it stored correctly instead of getting an error
// that reads as though the number itself were wrong.
//
// NOTE for anyone extending this: there is no DB CHECK behind fleet_owners the way
// users_gstin_format sits behind users.gstin, so this schema is currently the only
// thing enforcing the format. Adding that constraint needs a migration number.
// -----------------------------------------------------------

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const PAN_PATTERN = /^[A-Z]{3}[ABCFGHLJPT][A-Z][0-9]{4}[A-Z]$/

// The 15th character of a GSTIN is a check digit over the first 14 (GSTN's mod-36 scheme).
// Shape alone let "99ZZZZZ9999Z9Z9" through (UAT BT-11). Same function as
// bt-auth-service/src/lib/gst.ts; kept local so this ships without a shared-package rebuild.
const GSTIN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
function gstinCheckDigitOk(g: string): boolean {
  let sum = 0
  for (let i = 0; i < 14; i++) {
    const product = GSTIN_ALPHABET.indexOf(g[i]) * (i % 2 === 0 ? 1 : 2)
    sum += Math.floor(product / 36) + (product % 36)
  }
  return GSTIN_ALPHABET[(36 - (sum % 36)) % 36] === g[14]
}

export const OwnerProfileBody = z.object({
  company_name: z.string().trim().min(2, 'company_name must be at least 2 characters').max(120),
  gstin: z.string().trim().toUpperCase()
    .regex(GSTIN_PATTERN, 'gstin must be a valid 15-character GSTIN, e.g. 27AAPFU0939F1ZV')
    .refine(gstinCheckDigitOk, 'gstin check character does not match — one of the characters is mistyped')
    .optional(),
  pan: z.string().trim().toUpperCase()
    .regex(PAN_PATTERN, 'pan must be a valid 10-character PAN, e.g. ABCDE1234F')
    .optional(),
  contact_phone: z.string().trim().min(8).max(20).optional(),
  billing_address: z.string().trim().max(500).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  monthly_overhead_inr: z.number().min(0, 'monthly_overhead_inr cannot be negative').max(100_000_000).optional(),
})

const UpdateOwnerBody = OwnerProfileBody.partial().refine(
  body => Object.keys(body).length > 0,
  'No fields to update',
)

export async function ownerRoutes(app: FastifyInstance) {
  // POST /fleet/owners — register the fleet profile. D-27/D-32 DE-ROLE: any authenticated
  // user may create THEIR OWN fleet profile — becoming a fleet owner is a fact about
  // yourself, gated by nothing but identity. user_id is taken from the verified token and
  // never the body (see the file header), so one account can never mint another's; the
  // existence check below is the only guard, 409-ing a second registration for the same
  // account. (The idempotent sibling is POST /identity/fleet-owners/me in bt-auth-service.)
  app.post('/', async (req, reply) => {
    const body = parseOrThrow(OwnerProfileBody, req.body)
    const existing = await getFleetOwnerByUserId(req.user.userId)
    if (existing) {
      throw new FleetError('A fleet profile already exists for this account', 'CONFLICT', 409)
    }
    const owner = await createFleetOwner({ ...body, user_id: req.user.userId })
    return reply.status(201).send({ success: true, data: owner })
  })

  // GET /fleet/owners/me
  app.get('/me', async (req, reply) => {
    const owner = await requireFleetOwner(req.user)
    return reply.send({ success: true, data: owner })
  })

  // PATCH /fleet/owners/me
  app.patch('/me', async (req, reply) => {
    const owner = await requireFleetOwner(req.user)
    const patch = parseOrThrow(UpdateOwnerBody, req.body)
    const updated = await updateFleetOwner(owner.id, patch)
    return reply.send({ success: true, data: updated })
  })
}
