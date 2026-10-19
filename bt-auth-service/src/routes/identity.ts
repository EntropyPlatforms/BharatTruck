/**
 * Identity-lifecycle routes the unified app needs (D-32/D-33), all ADDITIVE.
 *
 *  • POST /drivers/me        — become a driver in-app, from any starting persona (D-32).
 *  • POST /fleet-owners/me   — become a fleet owner in-app, from any starting persona (D-32).
 *  • GET  /me/completeness   — the persona-completeness ring (D-33). DISPLAY-ONLY, NEVER GATES (D-31).
 *  • POST /me/acknowledgements — record a versioned self-declaration (D-31).
 *
 * WHY THESE REPLACE THE SIGNUP ROLE-BRANCH AS THE WAY PROFILES COME INTO BEING (D-32):
 * today a `drivers`/`fleet_owners` row is only ever born from ensureRoleProfile() on the signup role.
 * That models persona as a ladder climbed at sign-in. Under the emergent model a persona is a FRONT
 * DOOR: a shipper who adds their first truck becomes a driver; a driver who grows into a fleet becomes
 * a fleet owner — neither should have to re-sign-up. These endpoints are that forward path. The
 * signup branch stays for back-compat; it is no longer the only way in.
 *
 * Authorization: every route here acts on the CALLER'S OWN identity (JWT userId). A user may create
 * their own driver/fleet profile freely — it is a fact about themselves — and can NEVER create or
 * mutate another user's, because the userId is taken from the verified token, never from the body.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { PAN_RE, gstinProblem } from '../lib/gst.js'
import { resolvePersonas, type UserRole } from '@bharattruck/shared'
import { authenticate } from '../lib/authenticate.js'
import { ACKNOWLEDGEMENTS } from '../lib/acknowledgements.js'
import { computeCompleteness, type CompletenessFacts } from '../lib/completeness.js'

// fleet_owners.company_name is NOT NULL. Mirror of fleetCompanyName() in auth.ts: fall through the
// identity we already hold so the row can exist the instant the owner declares, with a truthful,
// non-empty placeholder they rename later via bt-fleet-service. Kept local rather than shared to keep
// auth.ts's diff at zero; the two are trivial and independently correct.
function fleetCompanyName(supplied: string | undefined, user: Record<string, unknown>): string {
  const candidates = [supplied, user.full_name as string | null | undefined, (user.email as string | null | undefined)?.split('@')[0]]
  for (const c of candidates) {
    const trimmed = c?.trim()
    if (trimmed) return trimmed
  }
  return 'Fleet owner'
}

// Optional seed fields for the fleet profile. NONE are required — D-31: declaring the persona must not
// be gated behind supplying business data. company_name/gstin only PREFILL the row if given.
const CreateFleetOwnerBody = z.object({
  company_name:     z.string().min(2).max(200).optional(),
  gstin:            z.string().trim().toUpperCase().superRefine((g, ctx) => {
    const problem = gstinProblem(g)
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid GSTIN — ${problem}` })
  }).optional(),
  // Same format gate the sibling write path enforces (bt-fleet-service owners.ts,
  // review S-7) — this route seeds the SAME fleet_owners row, and a max(10) here
  // let any string through while the fleet route refused it (review follow-up:
  // the acceptance bypass). trim+uppercase first, matching that route's handling.
  pan:              z.string().trim().toUpperCase().regex(PAN_RE, 'Invalid PAN').optional(),
  contact_phone:    z.string().max(20).optional(),
  billing_address:  z.string().max(500).optional(),
  city:             z.string().max(100).optional(),
  state:            z.string().max(100).optional(),
}).strict()

const AcknowledgementBody = z.object({
  // Constrained to the registry's keys — an unknown kind has no canonical text and is refused.
  kind: z.enum(Object.keys(ACKNOWLEDGEMENTS) as [string, ...string[]]),
}).strict()

export async function identityRoutes(app: FastifyInstance) {

  // ── POST /drivers/me ─────────────────────────────────────────────────────────
  // Create the caller's drivers row if absent; idempotent. This is what a shipper does when they add
  // their first truck, and what an employed-driver invite acceptance needs. Returns the drivers row.
  app.post('/drivers/me', { preHandler: authenticate }, async (req, reply) => {
    const userId = req.user.userId

    // Read-then-write rather than a blind upsert so the response carries the ACTUAL row either way,
    // and a repeat call is a clean no-op that returns the existing profile untouched.
    const { data: existing, error: readErr } = await app.supabase
      .from('drivers').select('*').eq('user_id', userId).maybeSingle()
    if (readErr) return reply.status(500).send({ success: false, error: 'Failed to read driver profile' })
    if (existing) return reply.send({ success: true, data: { driver: existing, created: false } })

    const { data: driver, error } = await app.supabase
      .from('drivers').insert({ user_id: userId }).select('*').single()
    if (error) {
      // Two requests racing on the same user: the UNIQUE(user_id) caught what our read missed. Re-read
      // and answer with the row that won — idempotent, never a 500.
      if (error.code === '23505') {
        const { data: raced } = await app.supabase.from('drivers').select('*').eq('user_id', userId).maybeSingle()
        if (raced) return reply.send({ success: true, data: { driver: raced, created: false } })
      }
      return reply.status(500).send({ success: false, error: 'Failed to create driver profile' })
    }

    return reply.status(201).send({ success: true, data: { driver, created: true } })
  })

  // ── POST /fleet-owners/me ────────────────────────────────────────────────────
  // Create the caller's fleet_owners row if absent; idempotent. A user who declared "fleet owner" at
  // signup (D-32) OR a driver who grows into one calls this. Optional profile seed fields; none required.
  app.post('/fleet-owners/me', { preHandler: authenticate }, async (req, reply) => {
    const body = CreateFleetOwnerBody.safeParse(req.body ?? {})
    if (!body.success) return reply.status(400).send({ success: false, error: body.error.errors[0].message })
    const userId = req.user.userId

    const { data: existing, error: readErr } = await app.supabase
      .from('fleet_owners').select('*').eq('user_id', userId).maybeSingle()
    if (readErr) return reply.status(500).send({ success: false, error: 'Failed to read fleet profile' })
    // Idempotent: a repeat call does NOT overwrite a company name/GSTIN the owner has since edited —
    // same reason ensureRoleProfile uses ignoreDuplicates on the fleet side.
    if (existing) return reply.send({ success: true, data: { fleet_owner: existing, created: false } })

    // Need the user row to derive a non-empty company_name placeholder when none was supplied.
    const { data: user } = await app.supabase
      .from('users').select('full_name, email').eq('id', userId).maybeSingle()

    const { company_name, ...seed } = body.data
    const { data: fleetOwner, error } = await app.supabase
      .from('fleet_owners')
      .insert({ user_id: userId, company_name: fleetCompanyName(company_name, user ?? {}), ...seed })
      .select('*').single()
    if (error) {
      if (error.code === '23505') {
        const { data: raced } = await app.supabase.from('fleet_owners').select('*').eq('user_id', userId).maybeSingle()
        if (raced) return reply.send({ success: true, data: { fleet_owner: raced, created: false } })
      }
      return reply.status(500).send({ success: false, error: 'Failed to create fleet profile' })
    }

    return reply.status(201).send({ success: true, data: { fleet_owner: fleetOwner, created: true } })
  })

  // ── GET /me/completeness ─────────────────────────────────────────────────────
  // The D-33 ring. DISPLAY-ONLY METADATA — it NEVER gates anything (D-31). The payload even carries a
  // `gates_nothing: true` flag so a client cannot misread a low percentage as a permission decision.
  app.get('/me/completeness', { preHandler: authenticate }, async (req, reply) => {
    const userId = req.user.userId

    // Display-only ring (D-33) that changes rarely. A short shared cache keeps it off the DB on
    // repeat views and — the reason this exists — stops its several queries stacking past the
    // gateway timeout when the DB is under polling load (the intermittent "Server error — please
    // try again"). Redis is best-effort: any cache error falls through to a fresh compute.
    const cacheKey = `completeness:v1:${userId}`
    try {
      const cached = await app.redis.get(cacheKey)
      if (cached) return reply.send({ success: true, data: { completeness: JSON.parse(cached) } })
    } catch { /* ignore cache read errors — compute fresh below */ }

    const { data: user } = await app.supabase
      .from('users').select('gstin, role, primary_persona').eq('id', userId).maybeSingle()
    if (!user) return reply.status(404).send({ success: false, error: 'User not found' })

    // Capabilities/ids drive WHICH persona rings are shown; computed from owned assets, not the
    // token. resolvePersonas and the acknowledgements read are independent — run them together.
    const [snapshot, ackRes] = await Promise.all([
      resolvePersonas(app.supabase, userId, (user.primary_persona ?? user.role ?? 'shipper') as UserRole),
      app.supabase.from('persona_acknowledgements').select('kind').eq('user_id', userId),
    ])

    // Every persona-conditional fact in ONE parallel wave (was three sequential steps): under DB
    // throttling, a chain of ~3s queries is exactly what tipped this endpoint past the timeout.
    const [kycRes, licRes, foRes, bankRes] = await Promise.all([
      snapshot.driver_id
        ? app.supabase.from('kyc_documents').select('doc_type, status').eq('user_id', userId)
        : Promise.resolve({ data: [] as Array<{ doc_type: string; status: string }> }),
      snapshot.driver_id
        ? app.supabase.from('driver_licenses').select('status').eq('driver_id', snapshot.driver_id).maybeSingle()
        : Promise.resolve({ data: null as { status: string } | null }),
      snapshot.fleet_owner_id
        ? app.supabase.from('fleet_owners').select('gstin').eq('id', snapshot.fleet_owner_id).maybeSingle()
        : Promise.resolve({ data: null as { gstin: string | null } | null }),
      snapshot.fleet_owner_id
        ? app.supabase.from('bank_accounts').select('verification_status').eq('user_id', userId)
        : Promise.resolve({ data: [] as Array<{ verification_status: string }> }),
    ])

    const verifiedKyc = new Set(
      ((kycRes.data ?? []) as Array<{ doc_type: string; status: string }>)
        .filter((d) => d.status === 'approved')
        .map((d) => d.doc_type),
    )
    const banks = (bankRes.data ?? []) as Array<{ verification_status: string }>

    const facts: CompletenessFacts = {
      user_gstin: (user.gstin as string | null) ?? null,
      fleet_gstin: (foRes.data as { gstin: string | null } | null)?.gstin ?? null,
      verified_kyc_doc_types: verifiedKyc,
      driver_licence_status: (licRes.data as { status: string } | null)?.status ?? null,
      has_bank_account: banks.length > 0,
      has_verified_bank_account: banks.some((b) => b.verification_status === 'verified'),
      acknowledged_kinds: new Set(((ackRes.data ?? []) as Array<{ kind: string }>).map((a) => a.kind)),
    }

    const completeness = computeCompleteness(snapshot, facts)
    // Best-effort 60s cache. POST /me/acknowledgements deletes this key, so a fresh declaration
    // shows on the ring immediately rather than waiting out the TTL.
    try { await app.redis.set(cacheKey, JSON.stringify(completeness), 'EX', 60) } catch { /* ignore */ }

    return reply.send({ success: true, data: { completeness } })
  })

  // ── POST /me/acknowledgements ─────────────────────────────────────────────────
  // Record a versioned self-declaration (D-31). We store the EXACT text served, keyed by kind+version,
  // not a boolean — a boolean proves nothing later; the verbatim statement is the artifact that makes
  // a declaration a stronger position than a missing KYC record.
  app.post('/me/acknowledgements', { preHandler: authenticate }, async (req, reply) => {
    const body = AcknowledgementBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ success: false, error: body.error.errors[0].message })

    const def = ACKNOWLEDGEMENTS[body.data.kind]
    const { data: ack, error } = await app.supabase
      .from('persona_acknowledgements')
      .insert({
        user_id:   req.user.userId,
        kind:      body.data.kind,
        version:   def.version,
        statement: def.statement, // server-owned text, stored verbatim
      })
      .select('id, kind, version, statement, acknowledged_at')
      .single()
    if (error) return reply.status(500).send({ success: false, error: 'Failed to record acknowledgement' })

    // This declaration flips a completeness item to 'declared' — drop the cached ring so the next
    // /me/completeness recomputes instead of serving a stale (up to 60s old) percentage.
    try { await app.redis.del(`completeness:v1:${req.user.userId}`) } catch { /* ignore */ }

    return reply.status(201).send({ success: true, data: { acknowledgement: ack } })
  })
}
