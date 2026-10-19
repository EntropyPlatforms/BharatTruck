import type { NextConfig } from "next";

/**
 * Security response headers for the app itself.
 *
 * The gateway already sets these for /api/* (bt-gateway/nginx.conf.template), but bt-app is
 * served straight off its own Cloud Run service, so nothing was setting them for the HTML and
 * client bundle — a scan of the deployed app returned no security headers at all.
 *
 * Deliberately NO Content-Security-Policy yet: the map surface loads Google Maps JS and its
 * tiles/fonts, so a CSP written blind would break tracking in production. That needs to be
 * authored against the real set of Google origins and verified on a preview first.
 */
const securityHeaders = [
  // HTTPS only, for a year, including subdomains. Cloud Run is HTTPS-only already; this stops a
  // downgrade attempt before the request is made.
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  // Clickjacking: nothing here is meant to be framed (matches the gateway's DENY for /api).
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // No feature needs these; geolocation stays available because the driver flow uses it.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), payment=()" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
