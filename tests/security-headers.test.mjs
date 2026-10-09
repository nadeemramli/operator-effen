// Browser security policy (readiness workstream #9): the Content Security Policy that
// src/proxy.ts sends with every page and the request-independent headers next.config adds.
import test from "node:test";
import assert from "node:assert/strict";
import {
  contentSecurityPolicy,
  staticSecurityHeaders,
} from "../apps/web/src/lib/security-headers.ts";

const directives = (csp) =>
  Object.fromEntries(csp.split("; ").map((d) => [d.split(" ")[0], d]));

test("production policy: nonce-based scripts, no framing, uploads and photos only via Supabase", () => {
  const d = directives(
    contentSecurityPolicy("abc123", "https://example.supabase.co", false),
  );
  assert.equal(
    d["script-src"],
    "script-src 'self' 'nonce-abc123' 'strict-dynamic' 'wasm-unsafe-eval'",
  );
  assert.equal(d["connect-src"], "connect-src 'self' https://example.supabase.co");
  assert.equal(d["img-src"], "img-src 'self' blob: data: https://example.supabase.co");
  assert.equal(d["worker-src"], "worker-src 'self' blob:");
  assert.equal(d["frame-ancestors"], "frame-ancestors 'none'");
  assert.equal(d["object-src"], "object-src 'none'");
  assert.equal(d["base-uri"], "base-uri 'self'");
  assert.equal(d["form-action"], "form-action 'self'");
  assert.ok("upgrade-insecure-requests" in d);
  assert.ok(!d["script-src"].includes("unsafe-inline"));
  assert.ok(!d["script-src"].includes("'unsafe-eval'"));
});

test("the Supabase origin is taken from the URL, never a path or an invalid value", () => {
  assert.match(
    contentSecurityPolicy("n", "https://example.supabase.co/rest/v1", false),
    /connect-src 'self' https:\/\/example\.supabase\.co;/,
  );
  assert.match(contentSecurityPolicy("n", "", false), /connect-src 'self';/);
  assert.match(contentSecurityPolicy("n", "not a url", false), /connect-src 'self';/);
  assert.match(contentSecurityPolicy("n", undefined, false), /img-src 'self' blob: data:;/);
});

test("the dev server gets eval and websockets for hot reload and nothing else extra", () => {
  const dev = directives(contentSecurityPolicy("n", "http://127.0.0.1:54321", true));
  const prod = directives(contentSecurityPolicy("n", "http://127.0.0.1:54321", false));
  assert.equal(dev["script-src"], prod["script-src"] + " 'unsafe-eval'");
  assert.equal(dev["connect-src"], prod["connect-src"] + " ws: wss:");
  assert.ok(!("upgrade-insecure-requests" in dev));
  for (const key of Object.keys(prod))
    if (!["script-src", "connect-src", "upgrade-insecure-requests"].includes(key))
      assert.equal(dev[key], prod[key], key);
});

test("request-independent headers block framing, sniffing and leaking referrers", () => {
  const h = Object.fromEntries(staticSecurityHeaders.map((x) => [x.key, x.value]));
  assert.equal(h["X-Frame-Options"], "DENY");
  assert.equal(h["X-Content-Type-Options"], "nosniff");
  assert.equal(h["Referrer-Policy"], "same-origin");
  assert.match(h["Permissions-Policy"], /camera=\(\)/);
  assert.ok(!("Strict-Transport-Security" in h), "HSTS is set by the host, not twice");
});
