import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/**
 * Pin the Turbopack root to this directory. Next.js otherwise infers the workspace root by
 * walking up for a lockfile, which picks up an unrelated one on some machines and silently
 * widens the file-watching scope. Pinning it keeps builds identical everywhere.
 */
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const isDev = process.env.NODE_ENV !== "production";

/**
 * The backend origin the browser will talk to. It is known at build time because
 * NEXT_PUBLIC_* values are inlined into the client bundle, which is what lets the CSP
 * below enumerate it precisely instead of falling back to a wildcard.
 */
const apiOrigin = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

/** The WebSocket origin is the API origin over ws/wss — same host, same derivation the client uses. */
const wsOrigin = apiOrigin.replace(/^http/, "ws");

/**
 * The dev server's own origin over ws://, for the HMR socket.
 *
 * Belt-and-braces, listed explicitly even though the socket is same-origin and Chromium
 * accepts it under `'self'`: some Firefox versions have not matched ws:// against `'self'`
 * in connect-src, and this project's dev loop is used from Firefox-family browsers. Not
 * verified here — it is cheap insurance, not a diagnosed fix. (The reload loop this was
 * first written for turned out to be `allowedDevOrigins`; see below.)
 *
 * Ports vary (3000 is taken often enough that Next picks 3001+), so this is a port wildcard
 * rather than a guess. Dev-only — the production CSP is unchanged and still pins
 * connect-src to exactly the one backend origin.
 */
const devWsOrigins = isDev ? " ws://localhost:* ws://127.0.0.1:*" : "";

/**
 * Content-Security-Policy.
 *
 * Notes on the two directives that look weak but are not negotiable here:
 *
 *   script-src 'unsafe-inline' — Next's App Router bootstraps hydration with inline
 *     scripts. Removing it requires per-request nonces, which a statically exported
 *     page cannot carry. 'unsafe-eval' is dev-only, where HMR needs it.
 *   style-src 'unsafe-inline' — Tailwind and Next inject style tags at runtime.
 *
 * The directives that actually matter for this app are tight: connect-src is limited to
 * the one backend origin (so a compromised dependency cannot exfiltrate a decrypted API
 * key to an arbitrary host), and blob: is permitted only where it is genuinely used —
 * img-src for canvas frames, media-src for TTS audio object URLs.
 *
 * In development, connect-src additionally allows the local HMR socket (see devWsOrigins).
 * That relaxation is compiled out of production builds.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${apiOrigin} ${wsOrigin}${devWsOrigins}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  // Only when the backend is actually reachable over TLS. Emitting this against an
  // http:// API origin makes the browser rewrite every backend call to https and
  // fail — which is exactly the `docker compose up` and self-hosted-over-LAN case.
  ...(apiOrigin.startsWith("https://") ? ["upgrade-insecure-requests"] : []),
].join("; ");

/**
 * Security headers applied to every response.
 *
 * Permissions-Policy keeps microphone and screen (display-capture) enabled on same-origin —
 * the app needs both — while disabling features we never use.
 */
const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), geolocation=(), payment=(), microphone=(self), display-capture=(self)",
  },
  // Only meaningful over HTTPS; harmless on plain-HTTP local dev.
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  turbopack: { root: projectRoot },
  /**
   * Trust 127.0.0.1 as a dev origin, not just `localhost`.
   *
   * Next blocks cross-origin requests to dev-only endpoints, and it treats 127.0.0.1 as a
   * *different* origin from localhost. Without this, opening the dev server at
   * http://127.0.0.1:3000 — the same address the terminal's "Network:" line and most
   * copy-pasted curl commands use — gets the HMR WebSocket rejected with a bare
   * `Unauthorized`, which is not a parseable HTTP response. The browser reports
   * ERR_INVALID_HTTP_RESPONSE, Next's dev client responds to the dead socket by reloading,
   * and the page reload-loops several times a second without ever staying alive long
   * enough to hydrate. The visible symptom is the server-rendered "Loading vault…" shell
   * forever, which looks like a hung app rather than a wrong hostname.
   *
   * Dev-only by definition; it has no effect on a production build.
   */
  allowedDevOrigins: ["127.0.0.1"],
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
