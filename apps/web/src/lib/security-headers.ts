/**
 * Browser security policy for every HTML and API response (readiness workstream #9).
 * The Content Security Policy is per request because Next.js needs the nonce on its
 * own inline scripts; `proxy.ts` generates it. PDF and OCR workers are served from
 * /vendor without this header, so they keep loading their WebAssembly cores.
 */
const origin = (value: string | undefined) => {
  try {
    return value ? new URL(value).origin : "";
  } catch {
    return "";
  }
};

/** Policy for the document that carries `nonce`; `dev` loosens it for the dev server. */
export function contentSecurityPolicy(
  nonce: string,
  supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL,
  dev = process.env.NODE_ENV !== "production",
) {
  // Uploads go straight to Supabase Storage with a signed URL; photos and PDFs are read
  // back from there with a short-lived signed URL.
  const supabase = origin(supabaseUrl);
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'` +
      (dev ? " 'unsafe-eval'" : ""),
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' blob: data:${supabase ? " " + supabase : ""}`,
    `connect-src 'self'${supabase ? " " + supabase : ""}${dev ? " ws: wss:" : ""}`,
    "worker-src 'self' blob:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

/** Headers that do not depend on the request. Strict-Transport-Security is set by Vercel. */
export const staticSecurityHeaders: { key: string; value: string }[] = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "same-origin" },
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];
