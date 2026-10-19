import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { BookingError } from '../lib/types.js'
import * as docsvc from '../lib/documents/service.js'
import * as ewb from '../lib/ewb/service.js'
import { EwbError } from '../lib/ewb/nic.js'

// ============================================================
// Freight documents — LR / consignment note, tax invoice, e-way bill record.
//
// Registered under the EXISTING /bookings prefix rather than a new one, on
// purpose: bt-gateway already routes /bookings to this service, so this slice
// ships without an edge config change and cannot be half-deployed (routes live,
// gateway not updated). Every path here is new — nothing existing changes shape.
//
// All four are safe against a pre-0024 database: the reads answer "no documents"
// and the writes fail with a 503 naming the missing migration.
// ============================================================

const UuidParamSchema = z.object({ id: z.string().uuid('id must be a valid UUID') })

const EwbParamsSchema = z.object({
  id: z.string().uuid('id must be a valid UUID'),
  ewbNumber: z.string().regex(/^\d{12}$/, 'e-way bill number is 12 digits'),
})

function handleError(reply: FastifyReply, err: unknown) {
  if (err instanceof EwbError) {
    return reply.status(err.httpStatus).send({ success: false, error: err.message, code: err.code })
  }
  if (err instanceof BookingError) {
    return reply.status(err.httpStatus).send({ success: false, error: err.message, code: err.code })
  }
  reply.log.error(err, 'Unhandled error in document routes')
  return reply.status(500).send({ success: false, error: 'Internal server error' })
}

function parseId(reply: FastifyReply, params: unknown): string | null {
  const parsed = UuidParamSchema.safeParse(params)
  if (!parsed.success) {
    reply.status(400).send({ success: false, error: parsed.error.errors[0].message, code: 'VALIDATION_ERROR' })
    return null
  }
  return parsed.data.id
}

function parseBody<T>(reply: FastifyReply, schema: z.ZodType<T>, body: unknown): T | null {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    const issue = parsed.error.errors[0]
    reply.status(400).send({
      success: false,
      error: `${issue.path.join('.') || 'body'}: ${issue.message}`,
      code: 'VALIDATION_ERROR',
    })
    return null
  }
  return parsed.data
}

export async function documentRoutes(app: FastifyInstance) {
  // ── E-way bills generated on NIC's portal through the GSP (lib/ewb) ──────────────────
  // The shipper's portal API login (never read back), then generate / Part B / extend /
  // cancel / sync / PDF on a booking's bill. Static paths first so they never match /:id.

  app.get('/eway-portal/credentials', async (req, reply) => {
    try { return reply.send({ success: true, data: await ewb.portalCredentialsView(req.user.userId) }) }
    catch (err) { return handleError(reply, err) }
  })

  app.put('/eway-portal/credentials', async (req, reply) => {
    const body = parseBody(reply, ewb.PortalCredentialsBodySchema, req.body)
    if (!body) return
    try { return reply.send({ success: true, data: await ewb.savePortalCredentials(req.user.userId, body) }) }
    catch (err) { return handleError(reply, err) }
  })

  app.delete('/eway-portal/credentials', async (req, reply) => {
    try { await ewb.removePortalCredentials(req.user.userId); return reply.send({ success: true, data: { configured: false } }) }
    catch (err) { return handleError(reply, err) }
  })

  app.get('/:id/documents/eway-bill/defaults', async (req, reply) => {
    const id = parseId(reply, req.params)
    if (!id) return
    try { return reply.send({ success: true, data: await ewb.generateDefaults(id, req.user) }) }
    catch (err) { return handleError(reply, err) }
  })

  app.post('/:id/documents/eway-bill/generate', async (req, reply) => {
    const id = parseId(reply, req.params)
    if (!id) return
    const body = parseBody(reply, ewb.GenerateEwayBillBodySchema, req.body)
    if (!body) return
    try { return reply.status(201).send({ success: true, data: await ewb.generateEwayBill(id, body, req.user) }) }
    catch (err) { return handleError(reply, err) }
  })

  const EwbParams = z.object({ id: z.string().uuid(), ewbNumber: z.string().regex(/^\d{12}$/) })
  const parseEwbParams = (reply: FastifyReply, params: unknown) => {
    const r = EwbParams.safeParse(params)
    if (!r.success) { reply.status(400).send({ success: false, error: 'id must be a UUID and ewbNumber 12 digits', code: 'VALIDATION_ERROR' }); return null }
    return r.data
  }

  app.put('/:id/documents/eway-bill/:ewbNumber/vehicle', async (req, reply) => {
    const p = parseEwbParams(reply, req.params)
    if (!p) return
    const body = parseBody(reply, ewb.UpdateVehicleBodySchema, req.body)
    if (!body) return
    try { return reply.send({ success: true, data: await ewb.updateVehicle(p.id, p.ewbNumber, body, req.user) }) }
    catch (err) { return handleError(reply, err) }
  })

  app.post('/:id/documents/eway-bill/:ewbNumber/extend', async (req, reply) => {
    const p = parseEwbParams(reply, req.params)
    if (!p) return
    const body = parseBody(reply, ewb.ExtendValidityBodySchema, req.body)
    if (!body) return
    try { return reply.send({ success: true, data: await ewb.extendValidity(p.id, p.ewbNumber, body, req.user) }) }
    catch (err) { return handleError(reply, err) }
  })

  app.post('/:id/documents/eway-bill/:ewbNumber/cancel-on-portal', async (req, reply) => {
    const p = parseEwbParams(reply, req.params)
    if (!p) return
    const body = parseBody(reply, ewb.CancelOnPortalBodySchema, req.body)
    if (!body) return
    try { return reply.send({ success: true, data: await ewb.cancelOnPortal(p.id, p.ewbNumber, body, req.user) }) }
    catch (err) { return handleError(reply, err) }
  })

  app.post('/:id/documents/eway-bill/:ewbNumber/sync', async (req, reply) => {
    const p = parseEwbParams(reply, req.params)
    if (!p) return
    try { return reply.send({ success: true, data: await ewb.syncFromPortal(p.id, p.ewbNumber, req.user) }) }
    catch (err) { return handleError(reply, err) }
  })

  app.get('/:id/documents/eway-bill/:ewbNumber/pdf', async (req, reply) => {
    const p = parseEwbParams(reply, req.params)
    if (!p) return
    try { return reply.send({ success: true, data: await ewb.pdfUrl(p.id, p.ewbNumber, req.user) }) }
    catch (err) { return handleError(reply, err) }
  })


  // GET /bookings/:id/documents — everything on file for the trip.
  app.get('/:id/documents', async (req, reply) => {
    const id = parseId(reply, req.params)
    if (!id) return
    try {
      return reply.send({ success: true, data: await docsvc.getBookingDocuments(id, req.user) })
    } catch (err) {
      return handleError(reply, err)
    }
  })

  // POST /bookings/:id/documents/lr — the CARRIER issues the consignment note.
  //
  // 201 on first issue, 200 on a repeat: the RPC is idempotent per booking and
  // returns the document already issued rather than minting a second one, because
  // a document that is already in the consignee's hands is never renumbered.
  app.post('/:id/documents/lr', async (req, reply) => {
    const id = parseId(reply, req.params)
    if (!id) return
    const body = parseBody(reply, docsvc.IssueLorryReceiptBodySchema, req.body)
    if (!body) return
    try {
      const lr = await docsvc.issueLorryReceipt(id, body, req.user)
      return reply.status(201).send({ success: true, data: lr })
    } catch (err) {
      return handleError(reply, err)
    }
  })

  // POST /bookings/:id/documents/invoice — the SHIPPER issues their tax invoice,
  // numbered on their own series (never the carrier's).
  app.post('/:id/documents/invoice', async (req, reply) => {
    const id = parseId(reply, req.params)
    if (!id) return
    const body = parseBody(reply, docsvc.IssueInvoiceBodySchema, req.body)
    if (!body) return
    try {
      const invoice = await docsvc.issueFreightInvoice(id, body, req.user)
      return reply.status(201).send({ success: true, data: invoice })
    } catch (err) {
      return handleError(reply, err)
    }
  })

  // POST /bookings/:id/documents/eway-bill — RECORD an externally generated bill
  // (D-17). valid_upto is required in the body and is stored verbatim; there is
  // no code path in this service that computes one.
  app.post('/:id/documents/eway-bill', async (req, reply) => {
    const id = parseId(reply, req.params)
    if (!id) return
    const body = parseBody(reply, docsvc.RecordEwayBillBodySchema, req.body)
    if (!body) return
    try {
      const record = await docsvc.recordEwayBill(id, body, req.user)
      return reply.status(201).send({ success: true, data: record })
    } catch (err) {
      return handleError(reply, err)
    }
  })

  // POST /bookings/:id/documents/scan — parse a NIC document QR (e-way bill / GST e-invoice)
  // into fields that PREFILL the e-way/invoice forms, so the driver stops re-typing a 12-digit
  // number at the gate (§6). The client decodes the QR and posts { raw }; a human still confirms
  // by saving the actual document. Reads only — never issues a document, never touches the POD photo.
  app.post('/:id/documents/scan', async (req, reply) => {
    const id = parseId(reply, req.params)
    if (!id) return
    const body = parseBody(reply, docsvc.ScanDocumentBodySchema, req.body)
    if (!body) return
    try {
      const result = await docsvc.scanDocument(id, body, req.user)
      return reply.send({ success: true, data: result })
    } catch (err) {
      return handleError(reply, err)
    }
  })

  // POST /bookings/:id/documents/ocr — OCR a photographed/handwritten INVOICE (no scannable QR)
  // into the same prefill fields as /scan, via Document AI's Invoice Parser. Client posts
  // { content: base64, mime_type }; a human still confirms by saving the invoice. Reads only —
  // never issues a document, never touches the POD photo. A larger bodyLimit than the default
  // because a base64 image/PDF is far bigger than a decoded QR string. Returns a clean 501 when
  // invoice OCR is not configured on the deployment.
  app.post('/:id/documents/ocr', { bodyLimit: 15 * 1024 * 1024 }, async (req, reply) => {
    const id = parseId(reply, req.params)
    if (!id) return
    const body = parseBody(reply, docsvc.OcrDocumentBodySchema, req.body)
    if (!body) return
    try {
      const result = await docsvc.ocrDocument(id, body, req.user)
      return reply.send({ success: true, data: result })
    } catch (err) {
      return handleError(reply, err)
    }
  })

  // PATCH /bookings/:id/documents/eway-bill/:ewbNumber — file what the PORTAL did
  // to a bill (§4.5: cancelled within 24h, rejected within 72h).
  //
  // Without this, eway_bill_records could hold several bills per booking but never
  // say which one still stands, so "which e-way bill was live when the vehicle was
  // stopped" — the question the multi-row design exists to answer — had no answer.
  // We record the portal's act; we do not adjudicate its 24-hour window.
  app.patch('/:id/documents/eway-bill/:ewbNumber', async (req, reply) => {
    const params = EwbParamsSchema.safeParse(req.params)
    if (!params.success) {
      return reply.status(400).send({
        success: false,
        error: params.error.errors[0].message,
        code: 'VALIDATION_ERROR',
      })
    }
    const body = parseBody(reply, docsvc.SetEwayBillStatusBodySchema, req.body)
    if (!body) return
    try {
      const record = await docsvc.setEwayBillStatus(params.data.id, params.data.ewbNumber, body, req.user)
      return reply.send({ success: true, data: record })
    } catch (err) {
      return handleError(reply, err)
    }
  })
}
