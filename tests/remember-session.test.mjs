// "Keep me signed in" off must leave auth cookies without an expiry, and never block sign-out.
import test from "node:test";
import assert from "node:assert/strict";
import { authCookieOptions } from "../apps/web/src/lib/supabase/remember.ts";

const long = { path: "/", sameSite: "lax", httpOnly: false, maxAge: 34560000 };

test("remembered sign-ins keep the library's long-lived cookie", () => {
  assert.deepEqual(authCookieOptions(long, false), long);
});

test("session-only sign-ins drop maxAge and expires", () => {
  const options = { ...long, expires: new Date(Date.now() + 60_000) };
  assert.deepEqual(authCookieOptions(options, true), {
    path: "/",
    sameSite: "lax",
    httpOnly: false,
  });
});

test("cookie deletions pass through unchanged", () => {
  const byAge = { ...long, maxAge: 0 };
  const byDate = { path: "/", expires: new Date(0) };
  assert.equal(authCookieOptions(byAge, true), byAge);
  assert.equal(authCookieOptions(byDate, true), byDate);
});

test("missing options are left alone", () => {
  assert.equal(authCookieOptions(undefined, true), undefined);
});
