/**
 * gstStateCode — best-effort GST 2-digit state code from a free-text state, a two-letter
 * code, or an already-canonical 2-digit code. Returns null when it cannot be resolved (the
 * caller falls back to the national default diesel price, or keeps a null state_code).
 */
export declare function gstStateCode(raw: string | null | undefined): string | null;
