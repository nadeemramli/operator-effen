// The server-side capability tables must match the database reference data, and every
// command must stay inside the state scope the database enforces for it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyCommand, createDraft } from "../apps/web/src/lib/draft.ts";
import { effectiveCapabilities, outOfScopeKeys } from "../apps/web/src/lib/access.ts";
import {
  commandRules,
  grantableRoles,
  memberRoles,
  roleCapabilities,
} from "../apps/web/src/lib/capabilities.ts";

const migration = (name) =>
  readFileSync(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), "utf8");
const sql = migration("20261005090000_operator_trusted_commands");
// 20261006: one driver role (assistant reference rows deleted) and driver trip rules.
const trips = migration("20261006090000_operator_driver_trips");
// 20261008: packers record their own packing; packer profiles.
const packers = migration("20261008090000_operator_packer_self_entry");
const section = (table, source = sql) => {
  const start = source.indexOf(`insert into public.${table}`);
  return start < 0 ? "" : source.slice(start, source.indexOf(";", start));
};
// Floor improvements (October 2026): later migrations seed further rows.
const later = [
  "20261009090002_operator_stock_returns",
  "20261009090003_operator_trip_dropoffs",
].map(migration);
const merged = (table) =>
  section(table) +
  section(table, trips) +
  section(table, packers) +
  later.map((m) => section(table, m)).join("");

test("one driver role: the migration removes the separate assistant role", () => {
  assert.match(trips, /update public\.operator_memberships\s+set role = 'driver', updated_at = now\(\)\s+where role = 'assistant';/);
  assert.match(trips, /delete from public\.operator_role_capabilities where role = 'assistant';/);
  assert.match(trips, /delete from public\.operator_grantable_roles where grantable_role = 'assistant';/);
  assert.match(trips, /check \(role in \('production', 'intake', 'outbound', 'admin', 'hr', 'management',\s+'packer', 'driver'\)\)/);
  assert.ok(!memberRoles.includes("assistant"));
});

test("role capabilities match the database seed", () => {
  const pairs = [...merged("operator_role_capabilities").matchAll(/\('([a-z]+)', '([a-z.]+)'\)/g)]
    .map(([, r, c]) => r + ":" + c)
    .filter((pair) => !pair.startsWith("assistant:"))
    .sort();
  const ts = Object.entries(roleCapabilities)
    .flatMap(([r, caps]) => caps.map((c) => r + ":" + c))
    .sort();
  assert.deepEqual(ts, pairs);
});

test("command rules match the database seed", () => {
  const rows = Object.fromEntries(
    [...merged("operator_command_rules").matchAll(/\('([a-z-]+)', '([a-z.]+)', '\{([a-zA-Z,]+)\}'\)/g)].map(
      ([, cmd, cap, keys]) => [cmd, { capability: cap, stateKeys: keys.split(",") }],
    ),
  );
  assert.deepEqual(rows, commandRules);
});

test("grantable roles match the database seed", () => {
  const block = section("operator_grantable_roles");
  assert.match(block, /select 'hr', r from unnest\(array\['production', 'intake', 'outbound', 'admin', 'hr',\s+'management', 'packer', 'driver', 'assistant'\]\)/);
  assert.match(block, /unnest\(array\['production', 'intake', 'outbound'\]\) g,\s+unnest\(array\['packer', 'driver', 'assistant'\]\) r/);
  // ...minus the assistant rows deleted by 20261006.
  assert.deepEqual(grantableRoles.production, ["packer", "driver"]);
  assert.deepEqual(grantableRoles.hr, [...memberRoles]);
  assert.equal(grantableRoles.hr.length, 8);
  assert.equal(grantableRoles.admin, undefined);
  assert.equal(grantableRoles.management, undefined);
});

test("every operational command stays inside its database scope", () => {
  const seen = new Set();
  const actor = (role) => ({ kind: "member", role, name: role, userId: "u-" + role, siteId: "site-a" });
  let s = createDraft();
  const run = (role, type, input) => {
    const next = applyCommand(s, {
      type,
      role,
      input,
      actor: actor(role),
      capabilities: effectiveCapabilities(role),
    });
    assert.deepEqual(outOfScopeKeys(type, s, next), [], type);
    seen.add(type);
    s = next;
    return next;
  };
  run("production", "batch", { product: "ady", code: "COV-1", date: "2026-10-01" });
  const id = s.batches[0].id;
  run("intake", "machine-create", { stage: "hologram", name: "Holo" });
  const m = s.machines[0];
  run("production", "machine-update", { id: m.id, name: "Holo 2", expectedVersion: m.version });
  run("production", "machine-deactivate", { id: m.id, reason: "x", expectedVersion: m.version + 1 });
  run("production", "machine-reactivate", { id: m.id, reason: "x", expectedVersion: m.version + 2 });
  for (const stage of ["mixing", "filling", "batching", "hologram", "wrapping"])
    run(stage === "hologram" ? "intake" : "production", "machine", { id, stage, pic: "P" });
  run("production", "stage-rework", { id, stage: "mixing", pic: "P", reason: "redo" });
  run("intake", "change-step-pic", { id, stage: "mixing", kind: "correction", pic: "Q", reason: "x" });
  run("intake", "stage-correct", {
    id,
    stage: "hologram",
    field: "machine",
    machineId: s.machines[0].id,
    reason: "x",
    expectedVersion: s.batches[0].steps.find((x) => x.sachetStage === "hologram").version,
  });
  run("production", "transfer", { id, pic: "F" });
  run("intake", "receive-ady", { batchId: id, pic: "R" });
  run("intake", "stock-in-ady", { receiptId: s.adypocideReceipts[0].id, boxes: 3, rack: "R", pic: "R" });
  run("production", "batch", { product: "cav", code: "COV-B", date: "2026-10-01", target: 2 });
  const bottle = s.batches[0].id;
  for (let i = 0; i < 4; i++) run("production", "step", { id: bottle, step: i, pic: "P", qty: 2, qc: "not-recorded" });
  run("production", "transfer", { id: bottle, qty: 2, pic: "F" });
  run("intake", "receive", { batchId: bottle, qty: 2, rack: "R", pic: "R" });
  run("intake", "count", { cartonId: s.cartons[0].id, actual: 1, pic: "R" });
  run("intake", "adjust", { id: s.counts[0].id, reason: "Broken bottle" });
  run("intake", "return", { cartonId: s.cartons[0].id, qty: 1, reason: "Courier return", awb: "RT 123", pic: "R" });
  run("admin", "order", { awb: "COV-AWB", product: "cav", channel: "TikTok", package: "P", expected: 1, date: "2026-10-01" });
  const o = s.orders[0].id;
  run("outbound", "edit-order", { id: o, awb: "COV-AWB", product: "cav", channel: "TikTok", package: "P", expected: 1, date: "2026-10-01" });
  run("outbound", "review-order", { id: o, pic: "S" });
  run("outbound", "sort-count", { date: "2026-10-01", product: "cav", counted: 1, pic: "S" });
  run("outbound", "print-orders", { ids: [o], pic: "S" });
  run("outbound", "issue-orders", { ids: [o], cartonId: "c-cav", qty: 1, pic: "S" });
  run("outbound", "assign-orders", { ids: [o], packer: "Sample Packer A", pic: "S" });
  run("outbound", "pack", { id: o, actual: 1, pic: "Sample Packer A", labelPic: "X" });
  const profileId = "20000000-0000-4000-8000-000000000001";
  run("outbound", "staff-profile-create", { profileId, name: "Synthetic Packer" });
  run("outbound", "staff-profile-update", { id: profileId, name: "Synthetic Packer Z" });
  run("outbound", "order", { awb: "COV-AWB-2", product: "cav", channel: "TikTok", package: "P", expected: 1, date: "2026-10-01" });
  const own = s.orders[0].id;
  run("outbound", "review-order", { id: own, pic: "S" });
  run("outbound", "sort-count", { date: "2026-10-01", product: "cav", counted: 2, pic: "S", note: "Recount" });
  run("outbound", "assign-orders", { ids: [own], packer: profileId, pic: "S" });
  {
    const next = applyCommand(s, {
      type: "pack-own",
      role: "packer",
      input: { id: own, actual: 1 },
      actor: actor("packer"),
      capabilities: effectiveCapabilities("packer"),
      performer: profileId,
    });
    assert.deepEqual(outOfScopeKeys("pack-own", s, next), [], "pack-own");
    seen.add("pack-own");
    s = next;
  }
  run("outbound", "correct", { id: o, field: "actual", qty: 1, reason: "Recount" });
  run("outbound", "dispatch", { id: o, reference: "M-1", pic: "D" });
  run("management", "review", { text: "Check" });
  run("packer", "feedback", { text: "Note" });
  run("production", "close", { date: "2026-10-01", note: "Done" });
  run("driver", "trip", { driver: "Sample Driver", assistant: "Sample Assistant", pickupAt: "2026-10-01T09:00" });
  run("driver", "trip-update", { id: s.trips[0].id, arriveAt: "2026-10-01T10:30" });
  run("driver", "trip-dropoff", { id: s.trips[0].id, at: "2026-10-01T10:00", photo: "10000000-0000-4000-8000-00000000000a/00000000-0000-4000-8000-000000000001/" + "a".repeat(64) + ".jpg" });
  run("production", "route-review", (() => {
    const legacy = s.batches.find((b) => b.id === "b-ady");
    delete legacy.route;
    delete legacy.transferredAt;
    legacy.steps = legacy.steps.filter((x) => x.sachetStage !== "hologram");
    s.adypocideReceipts = s.adypocideReceipts.filter((r) => r.batchId !== "b-ady");
    return { id: "b-ady", decision: "upgrade", reason: "In use" };
  })());
  // Every event created above carries the member recorder that made it.
  assert.ok(s.events.every((e) => e.id === "seed" || e.recorder?.kind === "member"));
  const untested = Object.keys(commandRules).filter((c) => !seen.has(c));
  assert.deepEqual(untested.sort(), [
    "assign-package",
    "import-receive",
    "import-release",
    "import-save",
    "issue",
    "move-orders",
    "print",
    "split-order",
  ]);
});
