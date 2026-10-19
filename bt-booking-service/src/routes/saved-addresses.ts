import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { supabase } from '../lib/supabase.js'
import { BookingError } from '../lib/types.js'

// -----------------------------------------------------------
// Saved-address book (D-020 / migration 0035). A shipper reuses the same 4-5 pickup points, so
// the post-load form should be a pick, not a re-typed address and a re-dragged gate pin. Every
// row is owned by the caller (users.id); there is no cross-user read. Mounted under /me so it
// rides the gateway's existing /api/me/ route to this service — no gateway change.
// -----------------------------------------------------------

const COLS =
  'id, label, place_id, formatted_address, lat, lng, gate_lat, gate_lng, pincode, state_code, use_count, last_used_at, created_at'

const CreateSchema = z.object({
  label: z.string().trim().max(120).optional(),
  place_id: z.string().max(512).optional(),
  formatted_address: z.string().trim().min(1).max(500),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  gate_lat: z.number().min(-90).max(90).optional(),
  gate_lng: z.number().min(-180).max(180).optional(),
  pincode: z.string().regex(/^\d{6}$/, 'pincode must be 6 digits').optional(),
  state_code: z.string().regex(/^\d{2}$/, 'state_code must be a 2-digit GST code').optional(),
}).strict()

const IdParam = z.object({ id: z.string().uuid('id must be a valid UUID') })

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof BookingError) {
    return reply.status(err.httpStatus).send({ success: false, error: err.message, code: err.code })
  }
  reply.log.error(err, 'Unhandled error in saved-address routes')
  return reply.status(500).send({ success: false, error: 'Internal server error' })
}

export async function savedAddressRoutes(app: FastifyInstance) {
  // GET /me/addresses — the caller's saved addresses, most-recently-used first.
  app.get('/addresses', async (req, reply) => {
    const { data, error } = await supabase
      .from('saved_addresses')
      .select(COLS)
      .eq('user_id', req.user.userId)
      .order('last_used_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
    if (error) return fail(reply, new Error(`saved_addresses select failed: ${error.message}`))
    return reply.send({ success: true, data: data ?? [] })
  })

  // POST /me/addresses — save a place, or re-save the same place_id (bump its use_count and
  // refresh its details) rather than duplicating it. A hand-pinned address (no place_id) is
  // always inserted, since two different gates can share a blank place_id.
  app.post('/addresses', async (req, reply) => {
    const parsed = CreateSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }
    const body = parsed.data
    const nowIso = new Date().toISOString()

    try {
      if (body.place_id) {
        const { data: existing, error: findErr } = await supabase
          .from('saved_addresses')
          .select('id, use_count')
          .eq('user_id', req.user.userId)
          .eq('place_id', body.place_id)
          .maybeSingle()
        if (findErr) throw new Error(`saved_addresses select failed: ${findErr.message}`)

        if (existing) {
          const row = existing as { id: string; use_count: number }
          const { data, error } = await supabase
            .from('saved_addresses')
            .update({
              label: body.label ?? null,
              formatted_address: body.formatted_address,
              lat: body.lat, lng: body.lng,
              gate_lat: body.gate_lat ?? null, gate_lng: body.gate_lng ?? null,
              pincode: body.pincode ?? null, state_code: body.state_code ?? null,
              use_count: Number(row.use_count) + 1,
              last_used_at: nowIso,
              updated_at: nowIso,
            })
            .eq('id', row.id)
            .eq('user_id', req.user.userId)
            .select(COLS)
            .single()
          if (error) throw new Error(`saved_addresses update failed: ${error.message}`)
          return reply.status(200).send({ success: true, data })
        }
      }

      const { data, error } = await supabase
        .from('saved_addresses')
        .insert({
          user_id: req.user.userId,
          label: body.label ?? null,
          place_id: body.place_id ?? null,
          formatted_address: body.formatted_address,
          lat: body.lat, lng: body.lng,
          gate_lat: body.gate_lat ?? null, gate_lng: body.gate_lng ?? null,
          pincode: body.pincode ?? null, state_code: body.state_code ?? null,
          use_count: 1,
          last_used_at: nowIso,
        })
        .select(COLS)
        .single()
      if (error) throw new Error(`saved_addresses insert failed: ${error.message}`)
      return reply.status(201).send({ success: true, data })
    } catch (err) {
      return fail(reply, err)
    }
  })

  // DELETE /me/addresses/:id — remove one of the caller's own saved addresses.
  app.delete('/addresses/:id', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params)
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }
    const { error, count } = await supabase
      .from('saved_addresses')
      .delete({ count: 'exact' })
      .eq('id', parsed.data.id)
      .eq('user_id', req.user.userId)
    if (error) return fail(reply, new Error(`saved_addresses delete failed: ${error.message}`))
    if (!count) return reply.status(404).send({ success: false, error: 'Saved address not found', code: 'NOT_FOUND' })
    return reply.send({ success: true, data: { deleted: parsed.data.id } })
  })
}
