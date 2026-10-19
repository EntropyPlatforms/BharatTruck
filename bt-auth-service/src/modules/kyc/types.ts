// KYCResult, KYCStatus, KYCLevel enums and interfaces shared across all verifications

export class NotImplementedError extends Error {
  constructor(fn: string) {
    super(`${fn} is not implemented yet`)
    this.name = 'NotImplementedError'
  }
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export enum KYCStatus {
  Success       = 'success',
  Failed        = 'failed',
  Pending       = 'pending',
  ManualReview  = 'manual_review',
}

export enum KYCLevel {
  L0 = 'L0', // No verification done
  L1 = 'L1', // Phone + Email verified
  L2 = 'L2', // + Aadhaar + PAN
  L3 = 'L3', // + DL / RC / GST + face-match + bank
}

export enum UserRole {
  Customer      = 'CUSTOMER',
  Driver        = 'DRIVER',
  FleetOperator = 'FLEET_OPERATOR',
}

// ---------------------------------------------------------------------------
// Core interfaces
// ---------------------------------------------------------------------------

export interface KYCResult {
  status:       KYCStatus
  kyc_level:    KYCLevel
  provider_ref: string           // Surepass / Vahan / internal reference ID
  raw_response: unknown          // Full provider response stored as-is for audit
  verified_at:  Date | null
  error?:       string           // Human-readable reason on failure / manual_review
}

export interface KYCRequest {
  user_id:  string
  role:     UserRole
  metadata: Record<string, unknown>  // Verification-specific inputs (e.g. aadhaar_number, otp, image_base64)
}

// ---------------------------------------------------------------------------
// DB row shape (mirrors user_kyc table columns)
// ---------------------------------------------------------------------------

export interface KYCRecord {
  id:           string
  user_id:      string
  role:         UserRole
  kyc_level:    KYCLevel
  verifications: Record<string, KYCResult>  // keyed by verification type, e.g. 'aadhaar', 'pan'
  created_at:   string
  updated_at:   string
}
