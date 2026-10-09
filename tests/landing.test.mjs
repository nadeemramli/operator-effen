// Where a signed-in person lands: the screen for their role on a refresh or a bare
// address, and the page they return to after signing in.
import test from "node:test";
import assert from "node:assert/strict";
import {
  allowedViews,
  homeView,
  resolveView,
  returnPath,
  views,
} from "../apps/web/src/lib/landing.ts";
import { roles } from "../apps/web/src/lib/draft.ts";

test("every role can open its home screen and at least Testing & feedback", () => {
  for (const { id } of roles) {
    assert.ok(allowedViews(id).includes(homeView(id)), id);
    assert.ok(allowedViews(id).includes("feedback"), id);
  }
});

test("management opens on Overview, not on its first sidebar entry (Driver trips)", () => {
  assert.equal(allowedViews("management")[0], "trips");
  assert.equal(homeView("management"), "overview");
  assert.equal(resolveView("management", null), "overview");
  assert.equal(resolveView("management", ""), "overview");
});

test("other roles open on their working screen", () => {
  assert.equal(homeView("production"), "production");
  assert.equal(homeView("intake"), "warehouse");
  assert.equal(homeView("outbound"), "input");
  assert.equal(homeView("admin"), "input");
  assert.equal(homeView("packer"), "packing");
  assert.equal(homeView("driver"), "trips");
  assert.equal(homeView("hr"), "overview");
});

test("a requested screen is kept when the role may open it", () => {
  assert.equal(resolveView("management", "reports"), "reports");
  assert.equal(resolveView("outbound", "orders"), "orders");
  assert.equal(resolveView("driver", "trace"), "trace");
});

test("a screen the role cannot open, or an unknown one, falls back to the role's home", () => {
  assert.equal(resolveView("driver", "overview"), "trips");
  assert.equal(resolveView("packer", "trips"), "packing");
  assert.equal(resolveView("management", "production"), "overview");
  assert.equal(resolveView("management", "nonsense"), "overview");
  assert.equal(resolveView("production", "feedback"), "feedback");
});

test("older view=outbound links open Order management for roles that have it", () => {
  assert.equal(resolveView("outbound", "outbound"), "orders");
  assert.equal(resolveView("admin", "outbound"), "orders");
  assert.equal(resolveView("management", "outbound"), "overview");
  assert.ok(!views.some((v) => v.id === "outbound"));
});

test("the return path after sign-in stays on this site", () => {
  assert.equal(returnPath("/?view=orders&date=2026-10-03"), "/?view=orders&date=2026-10-03");
  assert.equal(returnPath("/"), "/");
  assert.equal(returnPath(undefined), "/");
  assert.equal(returnPath(""), "/");
  assert.equal(returnPath("https://evil.example/"), "/");
  assert.equal(returnPath("//evil.example/"), "/");
  assert.equal(returnPath("/\\evil.example"), "/");
  assert.equal(returnPath("/login?next=/"), "/");
  assert.equal(returnPath("/api/logout"), "/");
  assert.equal(returnPath("/?view=orders\n"), "/");
  assert.equal(returnPath("/?" + "a".repeat(3000)), "/");
});
