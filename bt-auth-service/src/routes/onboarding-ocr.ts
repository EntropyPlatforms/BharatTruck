import type { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { z } from 'zod'
import { resolvePersonas, can, type UserRole } from '@bharattruck/shared'
import { authenticate } from '../lib/authenticate.js'
import { consume, envInt } from '../lib/rate-limit.js'
import { OcrError, driverOcrConfigured, readDocumentText } from '../lib/ocr/docai.js'
import { countFound, parseBankDocument, parseDrivingLicence } from '../lib/ocr/driver-docs.js'
import { parseGstCertificate, parsePanCard } from '../lib/ocr/business-docs.js'
import { parseAadhaar } from '../lib/ocr/identity-docs.js'

// -----------------------------------------------------------
// Driver-document scan — photograph the licence / a cheque or passbook, get the form filled in.
//
//   GET  /onboarding/ocr/config   is scanning switched on? (the app hides the buttons if not)
//   POST /onboarding/ocr          { kind, mime_type, content_base64 } -> { fields, found }
//                                 kind: licence | bank | gst (registration certificate) | pan | aadhaar
//                                 (an Aadhaar scan never returns the Aadhaar number — see identity-docs.ts)
//
// READ-ONLY. The photo is sent to the OCR provider, turned into suggested field values, and
// dropped: it is not stored, and nothing is written to the driver's record. The driver reviews
// the filled form and saves it through the existing POST /onboarding/license and
// /onboarding/bank-account routes, which validate it like any typed submission. The raw OCR text
// is never returned or logged — a licence carries an address and a date of birth.
//
// Off until DOCAI_OCR_PROCESSOR_ID is set (lib/ocr/docai.ts).
// -----------------------------------------------------------

type Reader = (bytes: Buffer, mimeType: string) => Promise<string>
// `reader: null` forces "off"; omitted = the real Document AI call when configured.
type OcrRouteOptions = FastifyPluginOptions & { reader?: Reader | null }

const MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const

const ScanBody = z.object({
  kind:           z.enum(['licence', 'bank', 'gst', 'pan', 'aadhaar']),
  mime_type:      z.enum(MIME_TYPES, { errorMap: () => ({ message: 'Upload a JPG, PNG or WebP photo, or a PDF' }) }),
  content_base64: z.string().min(1, 'The file is empty').regex(/^[A-Za-z0-9+/=\s]+$/, 'The file is not valid base64'),
})

// The app downsizes a photo to well under 1 MB before sending; this is the ceiling for a PDF.
const MAX_BYTES = 6 * 1024 * 1024
// Each scan is a paid OCR call, so it is metered per user. Generous for a real driver retaking a
// blurry photo; tight enough that a script cannot run up a bill.
const SCAN_LIMIT = envInt('OCR_SCAN_LIMIT', 20)
const SCAN_WINDOW_S = envInt('OCR_SCAN_WINDOW_S', 3600)

export async function onboardingOcrRoutes(app: FastifyInstance, opts: OcrRouteOptions) {
  const reader: Reader | null =
    opts.reader === undefined ? (driverOcrConfigured() ? readDocumentText : null) : opts.reader

  app.get('/ocr/config', { preHandler: authenticate }, async (_req, reply) => {
    return reply.send({ success: true, data: { enabled: !!reader } })
  })

  app.post('/ocr', { preHandler: authenticate, bodyLimit: 9 * 1024 * 1024 }, async (req, reply) => {
    if (!reader) {
      return reply.status(501).send({
        success: false,
        error: 'Document scanning is not switched on. Type the details in instead.',
        code: 'OCR_NOT_CONFIGURED',
      })
    }

    const body = ScanBody.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.errors[0].message, code: 'VALIDATION_ERROR' })
    }

    // The licence belongs to a driver record, so it takes the same 'drive' capability as every
    // licence route. A bank account can be linked by any signed-in user (POST /bank-account has
    // no capability gate), so scanning a cheque follows it; so do the GST certificate and PAN
    // card, which any account (shipper or fleet) saves on its own profile.
    if (body.data.kind === 'licence' || body.data.kind === 'aadhaar') {
      const snapshot = await resolvePersonas(app.supabase, req.user.userId, (req.user.role ?? 'shipper') as UserRole)
      if (!can(snapshot, 'drive')) {
        return reply.status(403).send({ success: false, error: 'Only drivers can access onboarding' })
      }
    }

    const bytes = Buffer.from(body.data.content_base64, 'base64')
    if (bytes.length === 0) {
      return reply.status(400).send({ success: false, error: 'The file is empty', code: 'VALIDATION_ERROR' })
    }
    if (bytes.length > MAX_BYTES) {
      return reply.status(413).send({ success: false, error: 'That file is too large. Use a photo under 6 MB.', code: 'FILE_TOO_LARGE' })
    }

    // Skipped only where no Redis is wired (unit tests); every deployed instance has it.
    if (app.hasDecorator('redis')) {
      const verdict = await consume(app.redis, `ocr_scan:${req.user.userId}`, SCAN_LIMIT, SCAN_WINDOW_S)
      if (!verdict.allowed) {
        return reply.status(429).send({
          success: false,
          error: 'Too many scans. Type the details in, or try again later.',
          code: 'RATE_LIMITED',
          retry_after_s: verdict.retryAfterS,
        })
      }
    }

    let text: string
    try {
      text = await reader(bytes, body.data.mime_type)
    } catch (err) {
      if (err instanceof OcrError) {
        req.log.error({ code: err.code }, `driver document OCR failed: ${err.message}`)
        return reply.status(err.httpStatus).send({
          success: false,
          error: 'Could not read the document right now. Type the details in, or try again.',
          code: err.code,
        })
      }
      req.log.error(err, 'driver document OCR failed')
      return reply.status(502).send({ success: false, error: 'Could not read the document right now. Type the details in, or try again.', code: 'OCR_UPSTREAM' })
    }

    const fields =
      body.data.kind === 'licence' ? parseDrivingLicence(text)
      : body.data.kind === 'bank' ? parseBankDocument(text)
      : body.data.kind === 'gst' ? parseGstCertificate(text)
      : body.data.kind === 'pan' ? parsePanCard(text)
      : parseAadhaar(text)
    return reply.send({ success: true, data: { kind: body.data.kind, fields, found: countFound(fields) } })
  })
}
