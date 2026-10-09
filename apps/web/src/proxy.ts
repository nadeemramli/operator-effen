import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { authCookieOptions, SESSION_ONLY_COOKIE } from "@/lib/supabase/remember";
import { contentSecurityPolicy } from "@/lib/security-headers";

export async function proxy(request: NextRequest) {
  // One nonce per request: Next.js reads it from the forwarded CSP header and puts it on
  // the inline scripts it renders, so no other inline script can run.
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce);
  const forward = () => {
    // Rebuilt after cookie refreshes so the forwarded Cookie header is current.
    const headers = new Headers(request.headers);
    headers.set("x-nonce", nonce);
    headers.set("content-security-policy", csp);
    return NextResponse.next({ request: { headers } });
  };
  let response = forward();
  const sessionOnly = request.cookies.get(SESSION_ONLY_COOKIE)?.value === "1";
  if (
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  ) {
    const db = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      {
        cookies: {
          getAll: () => request.cookies.getAll(),
          setAll(values, headers) {
            values.forEach(({ name, value }) => request.cookies.set(name, value));
            response = forward();
            values.forEach(({ name, value, options }) =>
              response.cookies.set(
                name,
                value,
                authCookieOptions(options, sessionOnly),
              ),
            );
            if (headers)
              Object.entries(headers).forEach(([name, value]) =>
                response.headers.set(name, value),
              );
          },
        },
      },
    );
    await db.auth.getUser();
  }
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Content-Security-Policy", csp);
  return response;
}
export const config = {
  matcher: ["/((?!_next/static|_next/image|vendor/|favicon.ico|icon.svg).*)"],
};
