// -----------------------------------------------------------
// PodError — domain error for the receiver-OTP POD flow, with an
// HTTP status + machine code attached (mirrors bt-booking-service's
// BookingError envelope shape so the API stays consistent).
// -----------------------------------------------------------

export type PodErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'NO_RECEIVER_EMAIL'
  | 'OTP_EXPIRED'
  | 'OTP_INVALID'
  | 'RATE_LIMITED'
  | 'INVALID_TRANSITION'
  | 'UPSTREAM_ERROR'

export class PodError extends Error {
  public readonly code: PodErrorCode
  public readonly httpStatus: number

  constructor(message: string, code: PodErrorCode, httpStatus = 400) {
    super(message)
    this.name = 'PodError'
    this.code = code
    this.httpStatus = httpStatus
  }
}
