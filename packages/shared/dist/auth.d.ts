export type UserRole = 'shipper' | 'driver' | 'admin' | 'fleet_owner';
export type AuthenticatedUser = {
    userId: string;
    role: UserRole;
};
export declare class JwtError extends Error {
    constructor(message: string);
}
/** Pull a bearer token from an Authorization header value, or null if absent/malformed. */
export declare function extractBearer(header: string | undefined | null): string | null;
/**
 * Verify an HS256 token with the shared secret and return the identity.
 * Throws JwtError on a bad/expired token or a missing `userId` claim.
 */
export declare function verifyJwt(token: string, secret: string): AuthenticatedUser;
