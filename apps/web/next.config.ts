import type { NextConfig } from "next";
import { staticSecurityHeaders } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Request-independent security headers on every response, static assets included.
  // The per-request Content Security Policy is added by src/proxy.ts.
  headers: async () => [{ source: "/(.*)", headers: staticSecurityHeaders }],
};

export default nextConfig;
