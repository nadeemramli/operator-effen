import type { NextRequest } from "next/server";

// The request Host is the browser-facing authority. Next's internal URL can use
// 0.0.0.0 behind the development server or a reverse proxy.
export function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (
    !origin ||
    !host ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return false;
  try {
    const parsed = new URL(origin);
    return parsed.host === host && parsed.protocol === request.nextUrl.protocol;
  } catch {
    return false;
  }
}
