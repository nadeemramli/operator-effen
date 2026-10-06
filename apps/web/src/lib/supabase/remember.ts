/**
 * "Keep me signed in" is off: this marker (itself a browser-session cookie) tells every
 * cookie writer to store the Supabase auth cookies without an expiry, so they end when
 * the browser closes. Without it the library's long-lived cookies are kept.
 */
export const SESSION_ONLY_COOKIE = "operator-session-only";

type CookieOptions = { maxAge?: number; expires?: Date | number | string };

/** Drops the expiry from auth cookies for session-only sign-ins; deletions pass through. */
export function authCookieOptions<T extends CookieOptions | undefined>(
  options: T,
  sessionOnly: boolean,
): T {
  if (!sessionOnly || !options) return options;
  const deleting =
    (options.maxAge !== undefined && options.maxAge <= 0) ||
    (options.expires !== undefined &&
      new Date(options.expires).getTime() <= Date.now());
  if (deleting) return options;
  const { maxAge, expires, ...rest } = options;
  void maxAge;
  void expires;
  return rest as T;
}
