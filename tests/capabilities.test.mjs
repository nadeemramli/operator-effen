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
  roleCapabilities,
} from "../apps/web/src/lib/capabilities.ts";

const sql = readFileSync(
  new URL("../supabase/migrations/20261005090000_operator_trusted_commands.sql", import.meta.url),
  "utf8",
);
const section = (table) => {
  const start = sql.indexOf(`insert into public.${table}`);
  return sql.slice(start, sql.indexOf(";", start));
};

test("role capabilities match the database seed", () => {
  const pairs = [...section("operator_role_capabilities").matchAll(/\('([a-z]+)', '([a-z.]+)'\)/g)]
    .map(([, r, c]) => r + ":" + c)
    .sort();
  const ts = Object.entries(roleCapabilities)
    .flatMap(([r, caps]) => caps.map((c) => r + ":" + c))
    .sort();
  assert.deepEqual(ts, pairs);
});

test("command rules match the database seed", () => {
  const rows = Object.fromEntries(
    [...section("operator_command_rules").matchAll(/\('([a-z-]+)', '([a-z.]+)', '\{([a-zA-Z,]+)\}'\)/g)].map(
      ([, cmd, cap, keys]) => [cmd, { capability: cap, stateKeys: keys.split(",") }],
    ),
  );
  assert.deepEqual(rows, commandRules);
});

test("grantable roles match the database seed", () => {
  const block = section("operator_grantable_roles");
  assert.match(block, /select 'hr', r from unnest\(array\['production', 'intake', 'outbound', 'admin', 'hr',\s+'management', 'packer', 'driver', 'assistant'\]\)/);
  assert.match(block, /unnest\(array\['production', 'intake', 'outbound'\]\) g,\s+unnest\(array\['packer', 'driver', 'assistant'\]\) r/);
  assert.deepEqual(grantableRoles.production, ["packer", "driver", "assistant"]);
  assert.equal(grantableRoles.hr.length, 9);
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
  run("admin", "order", { awb: "COV-AWB", product: "cav", channel: "TikTok", package: "P", expected: 1, date: "2026-10-01" });
  const o = s.orders[0].id;
  run("outbound", "edit-order", { id: o, awb: "COV-AWB", product: "cav", channel: "TikTok", package: "P", expected: 1, date: "2026-10-01" });
  run("outbound", "review-order", { id: o, pic: "S" });
  run("outbound", "sort-count", { date: "2026-10-01", product: "cav", counted: 1, pic: "S" });
  run("outbound", "print-orders", { ids: [o], pic: "S" });
  run("outbound", "issue-orders", { ids: [o], cartonId: "c-cav", qty: 1, pic: "S" });
  run("outbound", "assign-orders", { ids: [o], packer: "Sample Packer A", pic: "S" });
  run("outbound", "pack", { id: o, actual: 1, pic: "Sample Packer A", labelPic: "X" });
  run("outbound", "correct", { id: o, field: "actual", qty: 1, reason: "Recount" });
  run("outbound", "dispatch", { id: o, reference: "M-1", pic: "D" });
  run("management", "review", { text: "Check" });
  run("packer", "feedback", { text: "Note" });
  run("production", "close", { date: "2026-10-01", note: "Done" });
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
