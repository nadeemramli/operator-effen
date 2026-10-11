// WP3: stock returns go back into an existing stock carton of the batch, append-only.
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCommand,
  available,
  batchReturned,
  cartonReturned,
  createDraft,
} from "../apps/web/src/lib/draft.ts";
import { outOfScopeKeys } from "../apps/web/src/lib/access.ts";

const member = (role) => ({
  kind: "member",
  role,
  name: "Synthetic " + role,
  userId: "u-" + role,
  siteId: "site-a",
});
const as = (s, role, type, input) =>
  applyCommand(s, { type, role, input, actor: member(role) });
const carton = (s, id = "c-cav") => s.cartons.find((c) => c.id === id);
const input = { cartonId: "c-cav", qty: 2, reason: "Courier return", pic: "Nurul" };

test("a return raises the carton's available balance and is attributed", () => {
  const before = createDraft();
  const was = available(before, carton(before));
  const s = as(before, "intake", "return", { ...input, awb: " sp 1234 5678 " });
  assert.equal(available(s, carton(s)), was + 2);
  assert.equal(cartonReturned(s, carton(s)), 2);
  assert.equal(batchReturned(s, s.batches.find((b) => b.id === carton(s).batchId)), 2);
  const r = s.returns[0];
  assert.equal(r.awb, "SP12345678");
  assert.equal(r.recordedBy.userId, "u-intake");
  assert.equal(s.events[0].action, "Stock returned to rack");
  assert.match(s.events[0].detail, /rack A/);
  assert.deepEqual(outOfScopeKeys("return", before, s), []);
});

test("issued stock and returns reconcile in the carton trace", () => {
  let s = createDraft();
  const c = carton(s);
  const issued = s.issues.filter((i) => i.cartonId === c.id).reduce((n, i) => n + i.qty, 0);
  s = as(s, "intake", "return", input);
  s = as(s, "intake", "return", { ...input, qty: 1, reason: "Damaged box returned" });
  assert.equal(available(s, carton(s)), c.qty - issued + 3);
  // The original issues are untouched: a return is its own movement.
  assert.equal(s.issues.filter((i) => i.cartonId === c.id).reduce((n, i) => n + i.qty, 0), issued);
  assert.equal(s.returns.length, 2);
});

test("returns are refused without a reason, quantity or stock carton, and for other roles", () => {
  const s = createDraft();
  assert.throws(() => as(s, "intake", "return", { ...input, reason: "" }), /Please complete reason/);
  assert.throws(() => as(s, "intake", "return", { ...input, pic: "" }), /Please complete pic/);
  assert.throws(() => as(s, "intake", "return", { ...input, qty: 0 }), /valid whole number/);
  assert.throws(() => as(s, "intake", "return", { ...input, cartonId: "nope" }), /stock carton/);
  assert.throws(() => as(s, "intake", "return", { ...input, awb: "X".repeat(41) }), /40 characters/);
  // A loose-sachet carton (historical, before box counts) is not a stock carton.
  const loose = structuredClone(s);
  loose.cartons.push({ ...carton(s), id: "c-loose", product: "ady", unit: "sachet" });
  assert.throws(() => as(loose, "intake", "return", { ...input, cartonId: "c-loose" }), /stock carton/);
  for (const role of ["production", "outbound", "admin", "packer"])
    assert.throws(() => as(s, role, "return", input));
});
