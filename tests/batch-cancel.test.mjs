// Cancelling a mistaken batch and correcting its work date before it leaves the factory.
// Reported by a bottle supervisor: a batch was recorded with the wrong date and could not be
// fixed or removed before "Send to fulfilment".
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCommand,
  batchLock,
  ConflictError,
  createDraft,
  isCalendarDate,
  withBatchReferences,
} from "../apps/web/src/lib/draft.ts";
import { effectiveCapabilities } from "../apps/web/src/lib/access.ts";

const member = (role) => ({
  kind: "member",
  role,
  name: "SV " + role,
  userId: "u-" + role,
  siteId: "site-a",
});
const run = (s, type, input, role = "production") =>
  applyCommand(s, {
    type,
    role,
    input,
    actor: member(role),
    capabilities: effectiveCapabilities(role),
  });
const byCode = (s, code) => s.batches.find((b) => b.code === code);

/** The reported case: a fully recorded bottle batch, nothing sent to fulfilment yet. */
function recordedBottle(code = "CN0028") {
  let s = run(createDraft(), "batch", {
    product: "cav",
    code,
    date: "2026-10-15",
    target: 887,
  });
  const id = byCode(s, code).id;
  for (let step = 0; step < 4; step++)
    s = run(s, "step", {
      id,
      step,
      pic: "PIC " + step,
      ...(step === 3 ? { qty: 887, qc: "pass" } : {}),
    });
  return { s, id };
}
function plannedSachet(code = "ADY-MISTAKE") {
  const s = run(createDraft(), "batch", {
    product: "ady",
    code,
    date: "2026-10-14",
  });
  return { s, id: byCode(s, code).id };
}

test("a recorded but unsent bottle batch is cancelled, never deleted, with reason, PIC and audit entry", () => {
  const { s, id } = recordedBottle();
  const before = byCode(s, "CN0028");
  assert.equal(before.actual, 887);
  assert.equal(before.sent, 0);
  assert.equal(batchLock(s, before), null);
  const next = run(s, "batch-cancel", {
    id,
    reason: "Recorded with the wrong date",
    pic: "Supervisor A",
    expectedVersion: before.version ?? 0,
  });
  const b = byCode(next, "CN0028");
  assert.equal(next.batches.length, s.batches.length, "the batch stays in the records");
  assert.equal(b.cancelled.reason, "Recorded with the wrong date");
  assert.equal(b.cancelled.pic, "Supervisor A");
  assert.equal(b.cancelled.recordedBy.userId, "u-production");
  assert.ok(b.cancelled.at);
  assert.deepEqual(b.steps, before.steps, "recorded steps are kept for history");
  assert.equal(b.version, (before.version ?? 0) + 1);
  assert.equal(next.events[0].action, "Batch cancelled");
  assert.equal(next.events[0].entity, id);
  assert.match(next.events[0].detail, /CN0028 .*Supervisor A .*wrong date/);
  assert.equal(next.events[0].recorder.userId, "u-production");
  assert.equal(batchLock(next, b), "cancelled");
});

test("cancelling needs a reason and a PIC, the production supervisor, and happens once", () => {
  const { s, id } = recordedBottle();
  assert.throws(() => run(s, "batch-cancel", { id, pic: "Supervisor A" }), /reason/);
  assert.throws(() => run(s, "batch-cancel", { id, reason: "Mistake" }), /pic/);
  for (const role of ["intake", "outbound", "admin", "management"])
    assert.throws(
      () => run(s, "batch-cancel", { id, reason: "Mistake", pic: "X" }, role),
      /does not permit/,
      role,
    );
  // The fictional preview names the responsible role instead.
  assert.throws(
    () =>
      applyCommand(s, {
        type: "batch-cancel",
        role: "intake",
        input: { id, reason: "Mistake", pic: "X" },
      }),
    /Production supervisor/,
  );
  const cancelled = run(s, "batch-cancel", { id, reason: "Mistake", pic: "X" });
  assert.throws(
    () => run(cancelled, "batch-cancel", { id, reason: "Again", pic: "X" }),
    /already cancelled/,
  );
  // A stale form (someone changed the batch after it was opened) is a record conflict.
  assert.throws(
    () => run(s, "batch-cancel", { id, reason: "Mistake", pic: "X", expectedVersion: 7 }),
    ConflictError,
  );
});

test("a batch that left the factory or has warehouse records cannot be cancelled", () => {
  const { s, id } = recordedBottle();
  const sent = run(s, "transfer", { id, qty: 100, pic: "F" });
  assert.throws(
    () => run(sent, "batch-cancel", { id, reason: "Mistake", pic: "X" }),
    /already been sent to fulfilment\. It can no longer be cancelled/,
  );
  // Sachet batches leave the factory when they are sent to the warehouse.
  let { s: sachet, id: sachetId } = plannedSachet();
  for (const stage of ["mixing", "filling"])
    sachet = run(sachet, "machine", { id: sachetId, stage, pic: "P" });
  sachet = run(sachet, "transfer", { id: sachetId, pic: "F" });
  assert.throws(
    () => run(sachet, "batch-cancel", { id: sachetId, reason: "Mistake", pic: "X" }),
    /sent to the warehouse/,
  );
  sachet = run(sachet, "receive-ady", { batchId: sachetId, pic: "R" }, "intake");
  assert.throws(
    () =>
      run(sachet, "batch-correct", {
        id: sachetId,
        field: "date",
        date: "2026-10-13",
        reason: "x",
        pic: "X",
      }),
    /sent to the warehouse\. Its work date can no longer be corrected/,
  );
  // Any stock carton recorded against the batch (for example older data) also blocks it.
  const carton = structuredClone(s);
  carton.cartons.unshift({
    id: "c-legacy",
    ref: "CN0028",
    batchId: id,
    product: "cav",
    unit: "bottle",
    qty: 5,
    rack: "A",
    pic: "R",
    at: "2026-10-15T08:00:00.000Z",
  });
  assert.throws(
    () => run(carton, "batch-cancel", { id, reason: "Mistake", pic: "X" }),
    /warehouse receipts or stock cartons/,
  );
});

test("a cancelled batch is refused by every command that records against it", () => {
  const { s, id } = recordedBottle();
  const open = run(s, "batch", {
    product: "gly",
    code: "GLY-OPEN",
    date: "2026-10-15",
    target: 5,
  });
  const openId = byCode(open, "GLY-OPEN").id;
  let c = run(open, "batch-cancel", { id, reason: "Mistake", pic: "X" });
  c = run(c, "batch-cancel", { id: openId, reason: "Planned twice", pic: "X" });
  const refused = /was cancelled/;
  assert.throws(() => run(c, "transfer", { id, qty: 1, pic: "F" }), refused);
  assert.throws(() => run(c, "step", { id: openId, step: 0, pic: "P" }), refused);
  assert.throws(
    () =>
      run(c, "change-step-pic", {
        id,
        step: 0,
        kind: "correction",
        pic: "Q",
        reason: "x",
      }),
    refused,
  );
  assert.throws(
    () =>
      run(c, "batch-correct", {
        id,
        field: "date",
        date: "2026-10-14",
        reason: "x",
        pic: "X",
      }),
    /cancelled\. Its record can no longer be changed/,
  );
  assert.throws(
    () => run(c, "receive", { batchId: id, qty: 1, rack: "A", pic: "R" }, "intake"),
    refused,
  );
  let { s: sachet, id: sachetId } = plannedSachet();
  sachet = run(sachet, "batch-cancel", { id: sachetId, reason: "Mistake", pic: "X" });
  assert.throws(
    () => run(sachet, "machine", { id: sachetId, stage: "mixing", pic: "P" }),
    refused,
  );
  assert.throws(() => run(sachet, "transfer", { id: sachetId, pic: "F" }), refused);
  assert.throws(
    () =>
      run(sachet, "stage-rework", {
        id: sachetId,
        stage: "mixing",
        pic: "P",
        reason: "x",
      }),
    refused,
  );
  assert.throws(
    () => run(sachet, "receive-ady", { batchId: sachetId, pic: "R" }, "intake"),
    refused,
  );
});

test("the batch number of a cancelled batch stays reserved", () => {
  const { s, id } = recordedBottle();
  const c = run(s, "batch-cancel", { id, reason: "Mistake", pic: "X" });
  assert.throws(
    () =>
      run(c, "batch", { product: "cav", code: "cn0028", date: "2026-10-16", target: 887 }),
    /cancelled batch and stays reserved/,
  );
  const next = run(c, "batch", {
    product: "cav",
    code: "CN0028-R",
    date: "2026-10-16",
    target: 887,
  });
  assert.equal(byCode(next, "CN0028-R").cancelled, undefined);
});

test("the work date is corrected with a reason and PIC, keeping every recorded step", () => {
  const { s, id } = recordedBottle();
  const before = byCode(s, "CN0028");
  const next = run(s, "batch-correct", {
    id,
    field: "date",
    date: "2026-10-16",
    reason: "Forgot to change the date when planning",
    pic: "Supervisor A",
    expectedVersion: before.version ?? 0,
  });
  const b = byCode(next, "CN0028");
  assert.equal(b.date, "2026-10-16");
  assert.deepEqual(b.steps, before.steps);
  assert.equal(b.actual, 887);
  assert.equal(b.corrections.length, 1);
  const { id: correctionId, at, recordedBy, ...correction } = b.corrections[0];
  assert.ok(correctionId && at);
  assert.deepEqual(correction, {
    field: "date",
    from: "2026-10-15",
    to: "2026-10-16",
    reason: "Forgot to change the date when planning",
    pic: "Supervisor A",
  });
  assert.equal(recordedBy.userId, "u-production");
  assert.equal(b.revisions, undefined, "not a revision after transfer");
  assert.equal(next.events[0].action, "Batch date corrected");
  assert.match(next.events[0].detail, /2026-10-15 → 2026-10-16/);
  // A second correction is appended, never replacing the first.
  const again = run(next, "batch-correct", {
    id,
    field: "date",
    date: "2026-10-15",
    reason: "Back to the planning date",
    pic: "Supervisor A",
  });
  assert.deepEqual(
    byCode(again, "CN0028").corrections.map((c) => c.to),
    ["2026-10-16", "2026-10-15"],
  );
  // Still in the factory: it can be sent afterwards as usual.
  const sent = run(next, "transfer", { id, qty: 887, pic: "F" });
  assert.equal(byCode(sent, "CN0028").sent, 887);
  assert.throws(
    () =>
      run(sent, "batch-correct", {
        id,
        field: "date",
        date: "2026-10-15",
        reason: "x",
        pic: "X",
      }),
    /already been sent to fulfilment\. Its work date can no longer be corrected/,
  );
});

test("date corrections are validated", () => {
  const { s, id } = recordedBottle();
  const input = { id, field: "date", reason: "Wrong date", pic: "X" };
  for (const date of ["2026-02-30", "16/10/2026", "2026-10-16T08:00", "tomorrow"])
    assert.throws(() => run(s, "batch-correct", { ...input, date }), /calendar date/, date);
  assert.throws(() => run(s, "batch-correct", { ...input, date: "" }), /date/);
  assert.throws(
    () => run(s, "batch-correct", { ...input, date: "2026-10-15" }),
    /different work date/,
  );
  assert.throws(
    () => run(s, "batch-correct", { ...input, field: "rack", date: "2026-10-16" }),
    /Choose what to correct/,
  );
  assert.throws(
    () => run(s, "batch-correct", { ...input, date: "2026-10-16", reason: "" }),
    /reason/,
  );
  assert.throws(
    () => run(s, "batch-correct", { ...input, date: "2026-10-16", pic: "" }),
    /pic/,
  );
  assert.throws(
    () => run(s, "batch-correct", { ...input, date: "2026-10-16" }, "intake"),
    /does not permit/,
  );
  // Recorded actual times stay on or after the work date.
  let { s: sachet, id: sachetId } = plannedSachet();
  sachet = run(sachet, "machine", {
    id: sachetId,
    stage: "mixing",
    pic: "P",
    occurredAt: "2026-10-14T09:00",
  });
  const sachetInput = { id: sachetId, field: "date", reason: "x", pic: "X" };
  assert.throws(
    () => run(sachet, "batch-correct", { ...sachetInput, date: "2026-10-15" }),
    /cannot be after work already recorded on 2026-10-14/,
  );
  const earlier = run(sachet, "batch-correct", { ...sachetInput, date: "2026-10-13" });
  assert.equal(byCode(earlier, "ADY-MISTAKE").date, "2026-10-13");
  assert.equal(isCalendarDate("2028-02-29"), true);
  assert.equal(isCalendarDate("2027-02-29"), false);
});

test("a supervisor of another site cannot cancel or correct this site's batch", () => {
  const { s, id } = recordedBottle();
  s.batches.find((x) => x.id === id).siteId = "site-b";
  assert.throws(
    () => run(s, "batch-cancel", { id, reason: "Mistake", pic: "X" }),
    /another site/,
  );
  assert.throws(
    () =>
      run(s, "batch-correct", {
        id,
        field: "date",
        date: "2026-10-16",
        reason: "x",
        pic: "X",
      }),
    /another site/,
  );
});

// 20261029090000: batch settings. The batch number is corrected at any time; the product and
// target only while the batch is still in the factory; every correction is kept.
test("the batch number is corrected at any time, uniquely, and cartons follow it", () => {
  const { s, id } = recordedBottle();
  const v = byCode(s, "CN0028").version ?? 0;
  const fix = (state, input, role) =>
    run(state, "batch-correct", { id, expectedVersion: byCode(state, "CN0028")?.version ?? v, ...input }, role);
  assert.throws(() => fix(s, { field: "code", code: "CN0028", reason: "x", pic: "A" }), /different/);
  assert.throws(() => fix(s, { field: "code", code: "CN0029", pic: "A" }), /reason/);
  const taken = s.batches.find((b) => b.id !== id).code;
  assert.throws(() => fix(s, { field: "code", code: taken.toLowerCase(), reason: "x", pic: "A" }), /already exists/);
  assert.throws(() => fix(s, { field: "code", code: "CN0029", reason: "x", pic: "A" }, "intake"), /permit|role/i);
  let next = fix(s, { field: "code", code: "CN0029", reason: "Typo on the plan", pic: "Supervisor A" });
  let b = next.batches.find((x) => x.id === id);
  assert.equal(b.code, "CN0029");
  assert.deepEqual(
    b.corrections.map((c) => [c.field, c.from, c.to, c.reason, c.recordedBy.userId]),
    [["code", "CN0028", "CN0029", "Typo on the plan", "u-production"]],
  );
  assert.match(next.events[0].detail, /batch number: CN0028 → CN0029/);
  // Sent to fulfilment and received into stock: the number can still be corrected and the
  // stock carton shows the new number; nothing else can change any more.
  next = run(next, "transfer", { id, qty: 887, pic: "F" });
  next = run(next, "receive", { batchId: id, qty: 887, rack: "A-1", pic: "R" }, "intake");
  assert.equal(next.cartons[0].ref, "CN0029");
  const sentVersion = next.batches.find((x) => x.id === id).version;
  assert.throws(
    () => run(next, "batch-correct", { id, expectedVersion: sentVersion, field: "product", product: "gly", reason: "x", pic: "A" }),
    /sent.*batch number can/,
  );
  assert.throws(
    () => run(next, "batch-cancel", { id, expectedVersion: sentVersion, reason: "x", pic: "A" }),
    /sent.*cancelled; its batch number/,
  );
  next = run(next, "batch-correct", { id, expectedVersion: sentVersion, field: "code", code: "CN0030", reason: "Second typo", pic: "A" });
  // The API serves every state through withBatchReferences, so the carton shows the new number.
  const served = withBatchReferences(next);
  assert.equal(served.cartons[0].ref, "CN0030");
  assert.equal(served.cartons[0].legacyRef, "CN0029");
  // The old number of a cancelled batch stays reserved, for renames too.
  const planned = run(createDraft(), "batch", { product: "cav", code: "CN0040", date: "2026-10-01", target: 2 });
  const gone = planned.batches[0];
  const cancelled = run(planned, "batch-cancel", { id: gone.id, expectedVersion: gone.version ?? 0, reason: "Twice", pic: "A" });
  const other = run(cancelled, "batch", { product: "cav", code: "CN0041", date: "2026-10-01", target: 2 });
  assert.throws(
    () => run(other, "batch-correct", { id: other.batches[0].id, expectedVersion: 0, field: "code", code: "cn0040", reason: "x", pic: "A" }),
    /reserved/,
  );
});
test("the product changes within the same line and the target for bottles, while in the factory", () => {
  const { s, id } = recordedBottle();
  const at = (state) => state.batches.find((x) => x.id === id);
  const fix = (state, input) =>
    run(state, "batch-correct", { id, expectedVersion: at(state).version ?? 0, ...input });
  assert.throws(() => fix(s, { field: "product", product: "ady", reason: "x", pic: "A" }), /same line/);
  assert.throws(() => fix(s, { field: "product", product: "cav", reason: "x", pic: "A" }), /different/);
  assert.throws(() => fix(s, { field: "product", product: "nope", reason: "x", pic: "A" }), /Choose a product/);
  let next = fix(s, { field: "product", product: "gly", reason: "Planned under the wrong product", pic: "A" });
  assert.equal(at(next).product, "gly");
  assert.deepEqual(at(next).steps, at(s).steps, "recorded steps are kept");
  assert.throws(() => fix(next, { field: "target", target: at(next).target, reason: "x", pic: "A" }), /different/);
  assert.throws(() => fix(next, { field: "target", target: 0, reason: "x", pic: "A" }), /whole number/);
  next = fix(next, { field: "target", target: 900, reason: "Order grew", pic: "A" });
  assert.equal(at(next).target, 900);
  assert.deepEqual(
    at(next).corrections.map((c) => [c.field, c.from, c.to]),
    [["product", "cav", "gly"], ["target", "887", "900"]],
  );
  assert.throws(() => fix(next, { field: "rack", reason: "x", pic: "A" }), /Choose what to correct/);
  const sachet = run(createDraft(), "batch", { product: "ady", code: "AD-1", date: "2026-10-01", route: "sachet-v2" });
  assert.throws(
    () => run(sachet, "batch-correct", { id: sachet.batches[0].id, expectedVersion: 0, field: "target", target: 5, reason: "x", pic: "A" }),
    /no target/,
  );
});
