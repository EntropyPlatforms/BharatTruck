/**
 * Canonical error type + wire envelope for ALL BharatTruck services.
 *
 * Reused from here — do NOT re-declare per-service `TrackingError`/`BookingError`/etc.
 * Every service throws `AppError` and serialises with `errorEnvelope()`, so the API surface
 * (and the frontend/gateway that consume it) sees one consistent shape everywhere.
 */
/** Machine-readable error code. Extend the union as real codes are added — keep it a closed set. */
export type ErrorCode = 'VALIDATION_ERROR' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'INVALID_TRANSITION' | 'RATE_LIMITED' | 'UPSTREAM_ERROR' | 'INTERNAL' | 'AUCTION_CLOSED' | 'DUPLICATE_QUOTE' | 'QUOTE_NOT_FOUND' | 'ALREADY_AWARDED' | 'NEGOTIATION_CAP_REACHED' | 'GST_REQUIRED' | 'SELF_BID_FORBIDDEN';
/** The single error envelope every service returns on failure. snake_case-friendly + stable. */
export interface ErrorEnvelope {
    success: false;
    error: string;
    code: ErrorCode;
}
/** The success envelope counterpart, so `{ success, data }` is uniform across services. */
export interface SuccessEnvelope<T> {
    success: true;
    data: T;
}
export type ApiEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;
/**
 * Application error carrying an HTTP status + machine code. Throw this anywhere; a shared
 * Fastify error handler (see `@bharattruck/shared/http`, extracted during migration) maps it
 * to the envelope + status. 4xx are client-safe; 5xx messages are redacted at the boundary.
 */
export declare class AppError extends Error {
    readonly code: ErrorCode;
    readonly statusCode: number;
    /** true for expected 4xx (message is safe to return); false for 5xx (redact at the edge). */
    readonly expose: boolean;
    constructor(message: string, code: ErrorCode, statusCode: number);
    static validation(msg?: string): AppError;
    static unauthenticated(msg?: string): AppError;
    static forbidden(msg?: string): AppError;
    static notFound(msg?: string): AppError;
    static conflict(msg?: string): AppError;
    static invalidTransition(msg?: string): AppError;
    static rateLimited(msg?: string): AppError;
}
/** Serialise any thrown value into the wire error envelope. 5xx messages are redacted. */
export declare function errorEnvelope(err: unknown): {
    status: number;
    body: ErrorEnvelope;
};
/** Wrap a value in the success envelope. */
export declare function ok<T>(data: T): SuccessEnvelope<T>;
