// Face-match verification — compares a live selfie against the photo on an ID document, via the
// provider. Both images are base64; they are passed through and never persisted here.

import { failed, fromOutcome, manualReview, type Verifier } from '../verify.js'

export const verifyFaceMatch: Verifier = async (request, ctx) => {
  const image1 = String(request.metadata.image1 ?? request.metadata.image_1 ?? '')
  const image2 = String(request.metadata.image2 ?? request.metadata.image_2 ?? '')
  if (!image1 || !image2) return { result: failed('image1 and image2 (base64) are required') }

  const outcome = await ctx.provider.verifyFaceMatch({ image1, image2 })
  if (outcome.unavailable) return { result: manualReview(outcome.reason ?? 'no KYC provider configured') }
  return { result: fromOutcome(outcome, 'The faces did not match') }
}
