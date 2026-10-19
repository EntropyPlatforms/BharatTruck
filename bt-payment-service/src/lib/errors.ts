// -----------------------------------------------------------
// PaymentError — domain error for the cash-recorded payment flow,
// carrying an HTTP status + machine code (same envelope shape as the
// other services' errors).
// -----------------------------------------------------------

export type PaymentErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'AMOUNT_MISMATCH'
  | 'GATEWAY_NOT_CONFIGURED'
  | 'PAYMENT_PENDING'
  | 'UPSTREAM_ERROR'

export class PaymentError extends Error {
  public readonly code: PaymentErrorCode
  public readonly httpStatus: number

  constructor(message: string, code: PaymentErrorCode, httpStatus = 400) {
    super(message)
    this.name = 'PaymentError'
    this.code = code
    this.httpStatus = httpStatus
  }
}
