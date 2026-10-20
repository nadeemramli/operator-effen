// WP2: production records the factory stages (mixing, filling) and sends the batch; stock-in
// records the warehouse stages (batching, hologram, wrapping) before the box count.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyCommand,
  batchComplete,
  createDraft,
  factoryStages,
  factoryStagesDone,
  stageStep,
  warehouseStages,
  warehouseStagesDone,
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
const planned = () =>
  as(createDraft(), "production", "batch", {
    product: "ady",
    code: "WH-1",
    date: "2026-10-01",
    route: "sachet-v2",
  });
const record = (s, role, id, stage, pic = "PIC " + stage) =>
  as(s, role, "machine", { id, stage, pic });

test("the factory/warehouse split matches the database function", () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/20261009090001_operator_warehouse_stages.sql", import.meta.url),
    "utf8",
  );
  const start = sql.indexOf("create function operator_private.factory_stage");
  const body = sql.slice(start, sql.indexOf("$$;", start));
  const listed = /p_stage in \(([^)]*)\)/.exec(body)[1].match(/'([^']+)'/g).map((x) => x.slice(1, -1));
  assert.deepEqual(listed, factoryStages);
  assert.deepEqual(warehouseStages(planned().batches[0]), ["batching", "hologram", "wrapping"]);
});

test("transfer needs mixing and filling; the box count needs the three warehouse stages", () => {
  let s = planned();
  const id = s.batches[0].id;
  s = record(s, "production", id, "mixing");
  assert.throws(
    () => as(s, "production", "transfer", { id, pic: "F" }),
    /mixing and filling stages before sending to the warehouse/,
  );
  s = record(s, "production", id, "filling");
  assert.equal(factoryStagesDone(s.batches[0]), true);
  assert.equal(warehouseStagesDone(s.batches[0]), false);
  const before = s;
  s = as(s, "production", "transfer", { id, pic: "F" });
  assert.deepEqual(outOfScopeKeys("transfer", before, s), []);
  // Factory stages close at transfer.
  assert.throws(() => record(s, "production", id, "mixing", "Other"), /already/);
  s = as(s, "intake", "receive-ady", { batchId: id, pic: "Receiver" });
  const receiptId = s.adypocideReceipts[0].id;
  const finalize = (state) =>
    as(state, "intake", "stock-in-ady", { receiptId, boxes: 40, rack: "B-1", pic: "Nurul" });
  for (const stage of ["batching", "hologram"]) {
    s = record(s, "intake", id, stage);
    assert.throws(() => finalize(s), /Record the warehouse stages/);
  }
  const beforeWrap = s;
  s = record(s, "intake", id, "wrapping");
  assert.deepEqual(outOfScopeKeys("machine", beforeWrap, s), []);
  assert.equal(warehouseStagesDone(s.batches[0]), true);
  assert.equal(batchComplete(s.batches[0]), true);
  // Warehouse stages recorded after transfer are the normal flow, not a revision.
  assert.equal(s.batches[0].revisions, undefined);
  s = finalize(s);
  assert.equal(s.cartons[0].qty, 40);
  assert.equal(s.cartons[0].batchId, id);
});

test("warehouse-stage corrections before the box count are not revisions; factory ones are", () => {
  let s = planned();
  const id = s.batches[0].id;
  for (const stage of ["mixing", "filling"]) s = record(s, "production", id, stage);
  s = as(s, "production", "transfer", { id, pic: "F" });
  s = record(s, "intake", id, "batching", "Op B");
  s = as(s, "intake", "change-step-pic", {
    id,
    stage: "batching",
    kind: "correction",
    pic: "Op B2",
    reason: "Wrong person",
    expectedVersion: stageStep(s.batches[0], "batching").version,
  });
  assert.equal(s.batches[0].revisions, undefined);
  assert.doesNotMatch(s.events[0].detail, /revised after transfer/);
  // Warehouse-stage rework is allowed until the box count.
  s = as(s, "intake", "stage-rework", {
    id,
    stage: "batching",
    pic: "Op B3",
    reason: "Reprinted",
    expectedVersion: stageStep(s.batches[0], "batching").version,
  });
  assert.equal(stageStep(s.batches[0], "batching").occurrences.length, 1);
  assert.throws(
    () =>
      as(s, "production", "stage-rework", {
        id,
        stage: "mixing",
        pic: "X",
        reason: "x",
        expectedVersion: stageStep(s.batches[0], "mixing").version,
      }),
    /still in production/,
  );
  // A production correction of a factory stage after transfer is still a revision.
  s = as(s, "production", "change-step-pic", {
    id,
    stage: "mixing",
    kind: "correction",
    pic: "Op M2",
    reason: "Wrong person",
    expectedVersion: stageStep(s.batches[0], "mixing").version,
  });
  assert.equal(s.batches[0].revisions.length, 1);
  assert.equal(s.batches[0].revisions[0].stage, "mixing");
  // After the box count, any change is a revision.
  for (const stage of ["hologram", "wrapping"]) s = record(s, "intake", id, stage);
  s = as(s, "intake", "receive-ady", { batchId: id, pic: "R" });
  s = as(s, "intake", "stock-in-ady", {
    receiptId: s.adypocideReceipts[0].id,
    boxes: 3,
    rack: "B",
    pic: "SV",
  });
  s = as(s, "intake", "change-step-pic", {
    id,
    stage: "wrapping",
    kind: "correction",
    pic: "Op W2",
    reason: "Wrong person",
    expectedVersion: stageStep(s.batches[0], "wrapping").version,
  });
  assert.equal(s.batches[0].revisions.length, 2);
});

test("a reviewed four-stage batch follows the same split", () => {
  let s = createDraft();
  s = as(s, "production", "batch", { product: "ady", code: "V1", date: "2026-10-01", route: "sachet-v2" });
  const b = s.batches[0];
  // Turn it into a reviewed four-stage (sachet-v1) batch, as route-review keep-legacy does.
  b.route = { id: "sachet-v1", stages: ["mixing", "filling", "batching", "wrapping"], at: "t" };
  b.steps = b.steps.filter((st) => st.sachetStage !== "hologram");
  for (const stage of ["mixing", "filling"]) s = record(s, "production", b.id, stage);
  s = as(s, "production", "transfer", { id: b.id, pic: "F" });
  s = as(s, "intake", "receive-ady", { batchId: b.id, pic: "R" });
  const receiptId = s.adypocideReceipts[0].id;
  s = record(s, "intake", b.id, "batching");
  assert.throws(
    () => as(s, "intake", "stock-in-ady", { receiptId, boxes: 1, rack: "B", pic: "SV" }),
    /warehouse stages/,
  );
  s = record(s, "intake", b.id, "wrapping");
  s = as(s, "intake", "stock-in-ady", { receiptId, boxes: 1, rack: "B", pic: "SV" });
  assert.equal(s.cartons[0].batchId, b.id);
});

test("historical batches without a route snapshot are not re-gated at the box count", () => {
  const s = createDraft();
  const b = s.batches.find((x) => x.id === "b-ady");
  delete b.route;
  b.steps = b.steps.map((st) => ({ ...st, sachetStage: undefined, machine: "Old machine" }));
  s.adypocideReceipts = [{ id: "r-old", ref: b.code, batchId: b.id, pic: "R", at: "t" }];
  const next = as(s, "intake", "stock-in-ady", { receiptId: "r-old", boxes: 2, rack: "B", pic: "SV" });
  assert.equal(next.cartons[0].qty, 2);
});

// Optional stages (20261022090000): Hologram may be skipped with a reason; the Shrink machine
// is recorded together with the finished box count.
import {
  available,
  batchBoxHistory,
  batchBoxTotal,
  isOptionalStage,
  optionalStages,
  stageSatisfied,
  stageSkipped,
} from "../apps/web/src/lib/draft.ts";

const atWarehouse = () => {
  let s = planned();
  const id = s.batches[0].id;
  s = record(s, "production", id, "mixing");
  s = record(s, "production", id, "filling");
  s = as(s, "production", "transfer", { id, pic: "F" });
  return { s, id };
};

test("the optional stages match the database function", () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/20261022090000_operator_optional_stages.sql", import.meta.url),
    "utf8",
  );
  const start = sql.indexOf("create function operator_private.optional_stage");
  const body = sql.slice(start, sql.indexOf("$$;", start));
  const listed = /p_stage in \(([^)]*)\)/.exec(body)[1].match(/'([^']+)'/g).map((x) => x.slice(1, -1));
  assert.deepEqual(listed, optionalStages);
  assert.equal(isOptionalStage("hologram"), true);
  for (const stage of ["mixing", "filling", "batching", "wrapping"]) assert.equal(isOptionalStage(stage), false);
});

test("Hologram can be skipped with a reason and then counts for the box count", () => {
  let { s, id } = atWarehouse();
  s = as(s, "intake", "receive-ady", { batchId: id, pic: "Receiver" });
  const receiptId = s.adypocideReceipts[0].id;
  s = record(s, "intake", id, "batching");
  s = record(s, "intake", id, "wrapping");
  assert.throws(
    () => as(s, "intake", "stock-in-ady", { receiptId, boxes: 10, rack: "B-1", pic: "Nurul" }),
    /or skip an optional stage/,
  );
  // Required stages cannot be skipped; a reason is required.
  assert.throws(() => as(s, "intake", "stage-skip", { id, stage: "batching", reason: "x" }), /cannot be skipped/);
  assert.throws(() => as(s, "intake", "stage-skip", { id, stage: "hologram" }), /reason/i);
  const before = s;
  s = as(s, "intake", "stage-skip", { id, stage: "hologram", reason: "Plain pack, no hologram" });
  assert.deepEqual(outOfScopeKeys("stage-skip", before, s), []);
  const step = stageStep(s.batches[0], "hologram");
  assert.equal(step.done, false);
  assert.equal(step.skipped.reason, "Plain pack, no hologram");
  assert.equal(step.skipped.recordedBy.userId, "u-intake");
  assert.equal(stageSkipped(s.batches[0], "hologram"), true);
  assert.equal(stageSatisfied(s.batches[0], "hologram"), true);
  assert.equal(warehouseStagesDone(s.batches[0]), true);
  assert.equal(batchComplete(s.batches[0]), true);
  assert.equal(s.batches[0].revisions, undefined);
  assert.match(s.events[0].action, /skipped/);
  assert.throws(() => as(s, "intake", "stage-skip", { id, stage: "hologram", reason: "again" }), /already skipped/);
  // Rework and corrections still need a completion.
  assert.throws(() => as(s, "intake", "stage-rework", { id, stage: "hologram", pic: "P", reason: "x" }), /first completion/);
  s = as(s, "intake", "stock-in-ady", { receiptId, boxes: 10, rack: "B-1", pic: "Nurul" });
  assert.equal(s.cartons[0].qty, 10);
  // Stages are closed once the box count is finalized.
  assert.throws(() => as(s, "intake", "stage-skip", { id, stage: "hologram", reason: "x" }), /already/);
});

test("a skipped stage can still be completed later; the skip is cleared", () => {
  let { s, id } = atWarehouse();
  s = as(s, "intake", "stage-skip", { id, stage: "hologram", reason: "Thought not needed" });
  s = record(s, "intake", id, "hologram", "Holo PIC");
  const step = stageStep(s.batches[0], "hologram");
  assert.equal(step.done, true);
  assert.equal(step.pic, "Holo PIC");
  assert.equal(step.skipped, undefined);
  assert.match(s.events[0].detail, /after being skipped/);
  assert.throws(() => as(s, "intake", "stage-skip", { id, stage: "hologram", reason: "x" }), /already has a recorded PIC/);
});

test("the Shrink machine is recorded with the finished box count in one entry", () => {
  let { s, id } = atWarehouse();
  const count = (state, extra = {}) =>
    as(state, "intake", "wrapping-count", { id, stage: "wrapping", pic: "Nurul", boxes: 24, rack: "B-2", ...extra });
  // Earlier warehouse stages first (hologram may be skipped).
  assert.throws(() => count(s), /Record Inkjet printer \(batching\) and Hologram machine \(or skip/);
  s = record(s, "intake", id, "batching");
  assert.throws(() => count(s), /Record Hologram machine \(or skip/);
  s = as(s, "intake", "stage-skip", { id, stage: "hologram", reason: "No hologram" });
  // Only the last warehouse stage carries the count; only stock-in enters it.
  assert.throws(() => count(s, { stage: "batching" }), /last warehouse stage/);
  assert.throws(
    () => as(s, "production", "wrapping-count", { id, stage: "wrapping", pic: "P", boxes: 1, rack: "B" }),
    /intake|role|allowed/i,
  );
  const before = s;
  s = count(s);
  assert.deepEqual(outOfScopeKeys("wrapping-count", before, s), []);
  const wrap = stageStep(s.batches[0], "wrapping");
  assert.equal(wrap.done, true);
  assert.equal(wrap.pic, "Nurul");
  assert.equal(wrap.recordedBy.userId, "u-intake");
  // The receipt is recorded with the count and finalized; one box carton on the rack.
  const receipts = s.adypocideReceipts.filter((r) => r.batchId === id);
  assert.equal(receipts.length, 1);
  assert.ok(receipts[0].stockedAt);
  assert.equal(s.cartons.filter((c) => c.batchId === id).length, 1);
  assert.equal(s.cartons[0].qty, 24);
  assert.equal(s.cartons[0].unit, "box");
  assert.equal(s.cartons[0].rack, "B-2");
  assert.equal(s.cartons[0].batchId, id);
  assert.equal(s.batches[0].revisions, undefined);
  // A second count goes through the ordinary box stock-in; the stage is not recorded twice.
  assert.throws(() => count(s), /already recorded/);
  s = as(s, "intake", "stock-in-ady", { batchId: id, boxes: 6, rack: "B-2", pic: "Nurul" });
  assert.equal(s.cartons.filter((c) => c.batchId === id).length, 2);
});

test("the combined entry uses the receipt awaiting boxing when there is one", () => {
  let { s, id } = atWarehouse();
  s = as(s, "intake", "receive-ady", { batchId: id, pic: "Receiver" });
  s = record(s, "intake", id, "batching");
  s = record(s, "intake", id, "hologram");
  s = as(s, "intake", "wrapping-count", { id, stage: "wrapping", pic: "Nurul", boxes: 3, rack: "B" });
  const receipts = s.adypocideReceipts.filter((r) => r.batchId === id);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].pic, "Receiver");
  assert.equal(receipts[0].stockCartonId, s.cartons[0].id);
});

// 20261023090000: the receipt and the box count record the transfer when production has not.
test("stock-in counts a batch production has not finished recording; the transfer follows once it has", () => {
  let s = planned();
  const id = s.batches[0].id;
  s = record(s, "production", id, "mixing");
  s = record(s, "intake", id, "batching");
  s = as(s, "intake", "stage-skip", { id, stage: "hologram", reason: "No hologram" });
  s = record(s, "intake", id, "wrapping");
  // Filling has no PIC: the count works, the batch is not marked as sent.
  const before = s;
  s = as(s, "intake", "stock-in-ady", { batchId: id, boxes: 5, rack: "B", pic: "Nurul" });
  assert.deepEqual(outOfScopeKeys("stock-in-ady", before, s), []);
  assert.equal(s.batches[0].transferredAt, undefined);
  assert.equal(s.cartons.filter((c) => c.batchId === id)[0].qty, 5);
  assert.match(s.events[0].detail, /factory stages \(mixing, filling\) still open/);
  // A receipt for the next delivery works the same way.
  s = as(s, "intake", "receive-ady", { batchId: id, pic: "Nurul" });
  assert.equal(s.batches[0].transferredAt, undefined);
  // Production can still record filling (the batch is not sent) and then send it itself…
  s = record(s, "production", id, "filling");
  assert.equal(s.batches[0].transferredAt, undefined);
  // …or stock-in's next entry records the transfer on its behalf.
  s = as(s, "intake", "stock-in-ady", { receiptId: s.adypocideReceipts.find((r) => r.batchId === id && !r.stockedAt).id, boxes: 2, rack: "B", pic: "Nurul" });
  assert.ok(s.batches[0].transferredAt);
  assert.equal(s.batches[0].transferPic, "Nurul");
  assert.ok(s.events.some((e) => e.action === "Batch sent to warehouse" && /by stock-in/.test(e.detail)));
  assert.throws(() => as(s, "production", "transfer", { id, pic: "Helmi" }), /already been sent/);
});

test("a receipt before the transfer marks the batch as sent; a combined Shrink entry too", () => {
  let s = planned();
  const id = s.batches[0].id;
  for (const stage of ["mixing", "filling"]) s = record(s, "production", id, stage);
  const before = s;
  s = as(s, "intake", "receive-ady", { batchId: id, pic: "Receiver" });
  assert.deepEqual(outOfScopeKeys("receive-ady", before, s), []);
  assert.ok(s.batches[0].transferredAt);
  assert.equal(s.batches[0].transferPic, "Receiver");
  let t = planned();
  const id2 = t.batches[0].id;
  for (const stage of ["mixing", "filling"]) t = record(t, "production", id2, stage);
  t = record(t, "intake", id2, "batching");
  t = record(t, "intake", id2, "hologram");
  t = as(t, "intake", "wrapping-count", { id: id2, stage: "wrapping", pic: "Nurul", boxes: 9, rack: "B" });
  assert.ok(t.batches[0].transferredAt);
  assert.equal(t.cartons.filter((c) => c.batchId === id2)[0].qty, 9);
});

test("stock-in's first warehouse stage record marks the batch as sent once mixing and filling have a PIC", () => {
  let s = planned();
  const id = s.batches[0].id;
  s = record(s, "production", id, "mixing");
  // Factory gate not met yet: the stage saves, the batch stays unsent.
  s = record(s, "intake", id, "batching");
  assert.equal(s.batches[0].transferredAt, undefined);
  s = record(s, "production", id, "filling");
  assert.equal(s.batches[0].transferredAt, undefined);
  // Production's own warehouse record never sends; stock-in's does.
  let p = record(s, "production", id, "hologram", "Helmi");
  assert.equal(p.batches[0].transferredAt, undefined);
  const before = s;
  s = as(s, "intake", "stage-skip", { id, stage: "hologram", reason: "No hologram" });
  assert.deepEqual(outOfScopeKeys("stage-skip", before, s), []);
  assert.ok(s.batches[0].transferredAt);
  assert.equal(s.batches[0].transferPic, "Synthetic intake");
  assert.ok(s.events.some((e) => e.action === "Batch sent to warehouse" && /Hologram machine skip by stock-in/.test(e.detail)));
  let t = planned();
  const id2 = t.batches[0].id;
  for (const stage of ["mixing", "filling"]) t = record(t, "production", id2, stage);
  t = record(t, "intake", id2, "wrapping", "Munirah");
  assert.ok(t.batches[0].transferredAt);
  assert.equal(t.batches[0].transferPic, "Munirah");
  assert.throws(() => as(t, "production", "transfer", { id: id2, pic: "Helmi" }), /already been sent/);
});

// 20261025090000: a recount replaces the batch total and keeps the earlier total as a version.
test("a recount replaces the box total; the history keeps every version", () => {
  let s = planned();
  const id = s.batches[0].id;
  for (const stage of ["mixing", "filling"]) s = record(s, "production", id, stage);
  s = record(s, "intake", id, "batching");
  s = as(s, "intake", "stage-skip", { id, stage: "hologram", reason: "No hologram" });
  s = as(s, "intake", "wrapping-count", { id, stage: "wrapping", pic: "Nurul", boxes: 350, rack: "B" });
  const batch = () => s.batches.find((b) => b.id === id);
  assert.equal(batchBoxTotal(s, batch()), 350);
  assert.throws(
    () => as(s, "intake", "recount-ady", { batchId: id, total: 350, reason: "Same", pic: "Nurul" }),
    /already 350/,
  );
  assert.throws(
    () => as(s, "intake", "recount-ady", { batchId: id, total: 550, pic: "Nurul" }),
    /reason/i,
  );
  assert.throws(
    () => as(s, "production", "recount-ady", { batchId: id, total: 550, reason: "x", pic: "Helmi" }),
    /does not permit|intake|role/i,
  );
  const before = s;
  s = as(s, "intake", "recount-ady", { batchId: id, total: 550, reason: "Second count after stacking", pic: "Nurul" });
  assert.deepEqual(outOfScopeKeys("recount-ady", before, s), []);
  assert.equal(batchBoxTotal(s, batch()), 550);
  const carton = s.cartons.find((c) => c.batchId === id);
  assert.equal(carton.qty, 350, "the received carton is never rewritten");
  assert.equal(available(s, carton), 550, "the rack balance follows the recount");
  const adj = s.adjustments.find((a) => a.cartonId === carton.id);
  assert.equal(adj.kind, "recount");
  assert.equal(adj.delta, 200);
  assert.equal(adj.from, 350);
  assert.equal(adj.to, 550);
  assert.equal(adj.recordedBy.userId, "u-intake");
  assert.match(s.events[0].detail, /350 → 550 boxes/);
  // A further delivery still adds a carton; the history shows every version in order.
  s = as(s, "intake", "stock-in-ady", { batchId: id, boxes: 20, rack: "B", pic: "Nurul" });
  assert.equal(batchBoxTotal(s, batch()), 570);
  assert.deepEqual(
    batchBoxHistory(s, batch()).map((v) => [v.kind, v.change, v.total]),
    [["count", 350, 350], ["recount", 200, 550], ["add", 20, 570]],
  );
  // A lower recount is limited to what is still on the racks.
  s = as(s, "intake", "recount-ady", { batchId: id, total: 560, reason: "Ten damaged", pic: "Nurul" });
  assert.equal(batchBoxTotal(s, batch()), 560);
  assert.throws(
    () => as(s, "intake", "recount-ady", { batchId: id, total: -1, reason: "x", pic: "Nurul" }),
    /at least|0|number/i,
  );
  const order = s.orders.find((o) => o.product === "ady" && o.reviewState !== "pending" && !o.dispatched);
  if (order) {
    s = as(s, "outbound", "issue", { cartonId: carton.id, orderId: order.id, qty: 540, pic: "SO" });
    assert.throws(
      () => as(s, "intake", "recount-ady", { batchId: id, total: 10, reason: "x", pic: "Nurul" }),
      /still on the racks/,
    );
  }
});
