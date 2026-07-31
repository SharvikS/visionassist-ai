import type { NextConfig } from "next";

/**
 * Security headers applied to every response. A strict Content-Security-Policy is
 * intentionally deferred to deployment config (M5) because it must enumerate the backend
 * API/WS origin and would otherwise break local HMR.
 *
 * Permissions-Policy keeps microphone and screen (display-capture) enabled on same-origin —
 * the app needs both — while disabling features we never use.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), geolocation=(), payment=(), microphone=(self), display-capture=(self)",
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
