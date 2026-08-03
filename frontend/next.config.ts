import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/**
 * Pin the Turbopack root to this directory. Next.js otherwise infers the workspace root by
 * walking up for a lockfile, which picks up an unrelated one on some machines and silently
 * widens the file-watching scope. Pinning it keeps builds identical everywhere.
 */
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

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
  turbopack: { root: projectRoot },
  /**
   * Emit a self-contained server bundle (`.next/standalone`) carrying only the modules
   * actually imported. The container image copies that instead of the whole
   * node_modules tree, which is the difference between a ~200 MB and a ~1 GB image.
   */
  output: "standalone",
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
