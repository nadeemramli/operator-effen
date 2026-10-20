// Stock-in records the warehouse stages only, and enters a sachet batch's total boxes at its
// last warehouse stage (the Shrink machine), by batch, without a separate receive step.
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCommand,
  batchBoxTotal,
  createDraft,
  stageStep,
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
    code: "TOTAL-1",
    date: "2026-10-01",
    route: "sachet-v2",
  });
const record = (s, role, id, stage, pic = "PIC " + stage) =>
  as(s, role, "machine", { id, stage, pic });
/** A five-stage batch sent to the warehouse, with its warehouse stages open. */
function sent() {
  let s = planned();
  const id = s.batches[0].id;
  for (const stage of ["mixing", "filling"]) s = record(s, "production", id, stage);
  s = as(s, "production", "transfer", { id, pic: "Factory SV" });
  return { s, id };
}
/** A sent batch with batching, hologram and wrapping recorded by stock-in. */
function shrunk() {
  let { s, id } = sent();
  for (const stage of ["batching", "hologram", "wrapping"]) s = record(s, "intake", id, stage);
  return { s, id };
}
const count = { boxes: 40, rack: "B-1", pic: "Stock-in SV" };

test("stock-in records the warehouse stages only; production records the factory stages", () => {
  let s = planned();
  const id = s.batches[0].id;
  for (const stage of ["mixing", "filling"])
    assert.throws(() => record(s, "intake", id, stage), /recorded by production/);
  for (const stage of ["mixing", "filling"]) s = record(s, "production", id, stage);
  assert.equal(stageStep(s.batches[0], "mixing").recordedBy.role, "production");
  // Stock-in may not rework or correct a factory stage either.
  assert.throws(
    () =>
      as(s, "intake", "stage-rework", {
        id,
        stage: "mixing",
        pic: "X",
        reason: "x",
        expectedVersion: stageStep(s.batches[0], "mixing").version,
      }),
    /recorded by production/,
  );
  assert.throws(
    () =>
      as(s, "intake", "stage-correct", {
        id,
        stage: "filling",
        field: "occurredAt",
        occurredAt: "2026-10-01T09:00",
        reason: "x",
        expectedVersion: stageStep(s.batches[0], "filling").version,
      }),
    /recorded by production/,
  );
  s = as(s, "production", "transfer", { id, pic: "F" });
  for (const stage of ["batching", "hologram", "wrapping"]) s = record(s, "intake", id, stage);
  assert.equal(warehouseStagesDone(s.batches[0]), true);
  assert.equal(stageStep(s.batches[0], "wrapping").recordedBy.role, "intake");
  // Stock-in reworks and corrects its own stages until the box count.
  s = as(s, "intake", "stage-rework", {
    id,
    stage: "wrapping",
    pic: "Op W",
    reason: "Re-wrapped",
    expectedVersion: stageStep(s.batches[0], "wrapping").version,
  });
  assert.equal(stageStep(s.batches[0], "wrapping").occurrences.length, 1);
});

test("the box count by batch records the receipt and the box carton in one step", () => {
  const { s: before, id } = shrunk();
  assert.equal(batchBoxTotal(before, before.batches[0]), null);
  const receipts = before.adypocideReceipts?.length ?? 0;
  const s = as(before, "intake", "stock-in-ady", { batchId: id, ...count });
  assert.deepEqual(outOfScopeKeys("stock-in-ady", before, s), []);
  const carton = s.cartons[0];
  assert.equal(carton.batchId, id);
  assert.equal(carton.qty, 40);
  assert.equal(carton.unit, "box");
  assert.equal(carton.ref, "TOTAL-1");
  assert.equal(carton.rack, "B-1");
  assert.equal(carton.pic, "Stock-in SV");
  assert.equal(s.adypocideReceipts.length, receipts + 1);
  const receipt = s.adypocideReceipts[0];
  assert.equal(receipt.batchId, id);
  assert.equal(receipt.ref, "TOTAL-1");
  assert.equal(receipt.pic, "Stock-in SV");
  assert.ok(receipt.stockedAt);
  assert.equal(receipt.stockCartonId, carton.id);
  const added = s.events.slice(0, s.events.length - before.events.length);
  assert.deepEqual(
    added.map((e) => e.action),
    ["Sachet box count finalized", "Sachet cartons received for boxing"],
  );
  assert.match(added[1].detail, /recorded at the box count/);
  assert.ok(added.every((e) => e.entity === id && e.recorder.role === "intake"));
  assert.equal(batchBoxTotal(s, s.batches[0]), 40);
  // Not a revision: warehouse stages recorded before the box count are the normal flow.
  assert.equal(s.batches[0].revisions, undefined);
});

test("the box count by batch reuses the receipt awaiting boxing", () => {
  let { s, id } = shrunk();
  s = as(s, "intake", "receive-ady", { batchId: id, pic: "Receiver" });
  const receipt = s.adypocideReceipts[0];
  const before = s;
  s = as(s, "intake", "stock-in-ady", { batchId: id, ...count });
  assert.equal(s.adypocideReceipts.length, before.adypocideReceipts.length);
  assert.equal(s.adypocideReceipts[0].id, receipt.id);
  assert.equal(s.adypocideReceipts[0].pic, "Receiver");
  assert.equal(s.adypocideReceipts[0].stockCartonId, s.cartons[0].id);
  assert.equal(s.events.length, before.events.length + 1);
  assert.equal(s.events[0].action, "Sachet box count finalized");
});

test("a second box count for the batch adds a second receipt and carton to the total", () => {
  let { s, id } = shrunk();
  s = as(s, "intake", "stock-in-ady", { batchId: id, ...count });
  s = as(s, "intake", "stock-in-ady", { batchId: id, boxes: 5, rack: "B-2", pic: "Stock-in SV" });
  const receipts = s.adypocideReceipts.filter((r) => r.batchId === id);
  const cartons = s.cartons.filter((c) => c.batchId === id);
  assert.equal(receipts.length, 2);
  assert.ok(receipts.every((r) => r.stockedAt));
  assert.notEqual(receipts[0].stockCartonId, receipts[1].stockCartonId);
  assert.deepEqual(cartons.map((c) => c.qty), [5, 40]);
  assert.equal(batchBoxTotal(s, s.batches[0]), 45);
});

test("the box count by batch is refused for unsent, cancelled, bottle and unfinished batches", () => {
  // Not sent and the factory stages incomplete: the count works but does not mark it sent.
  let s = planned();
  const id = s.batches[0].id;
  s = record(s, "production", id, "mixing");
  for (const stage of ["batching", "hologram", "wrapping"]) s = record(s, "intake", id, stage);
  s = as(s, "intake", "stock-in-ady", { batchId: id, ...count });
  assert.equal(s.batches[0].transferredAt, undefined);
  assert.ok(s.cartons.some((c) => c.batchId === id));
  // Warehouse stages incomplete.
  let open = sent();
  open.s = record(open.s, "intake", open.id, "batching");
  open.s = record(open.s, "intake", open.id, "hologram");
  assert.throws(
    () => as(open.s, "intake", "stock-in-ady", { batchId: open.id, ...count }),
    /Record the warehouse stages/,
  );
  // Cancelled.
  const cancelled = shrunk();
  cancelled.s.batches[0].cancelled = { at: "t", reason: "Planned by mistake", pic: "SV" };
  assert.throws(
    () => as(cancelled.s, "intake", "stock-in-ady", { batchId: cancelled.id, ...count }),
    /cancelled/,
  );
  // Another site.
  const other = shrunk();
  other.s.batches[0].siteId = "site-b";
  assert.throws(
    () => as(other.s, "intake", "stock-in-ady", { batchId: other.id, ...count }),
    /another site/,
  );
  // A bottle batch, even once sent.
  const bottle = createDraft().batches.find((b) => !b.product.startsWith("ady") && b.sent > 0);
  assert.ok(bottle, "the sandbox seed has a sent bottle batch");
  assert.throws(
    () => as(createDraft(), "intake", "stock-in-ady", { batchId: bottle.id, ...count }),
    /Choose a sachet batch/,
  );
  // Only stock-in finalizes box counts.
  const ready = shrunk();
  assert.throws(
    () => as(ready.s, "production", "stock-in-ady", { batchId: ready.id, ...count }),
    /does not permit/,
  );
  // Neither a receipt nor a batch.
  assert.throws(() => as(ready.s, "intake", "stock-in-ady", count), /receiptId/);
});

test("the box-count gate checks the warehouse stages; factory stages were checked at transfer", () => {
  const base = shrunk();
  // Simulate a snapshot batch whose factory record is no longer complete after transfer.
  const mixing = stageStep(base.s.batches[0], "mixing");
  mixing.done = false;
  assert.ok(base.s.batches[0].route);
  assert.equal(warehouseStagesDone(base.s.batches[0]), true);
  const byBatch = as(base.s, "intake", "stock-in-ady", { batchId: base.id, ...count });
  assert.equal(byBatch.cartons[0].qty, 40);
  const received = as(base.s, "intake", "receive-ady", { batchId: base.id, pic: "R" });
  const byReceipt = as(received, "intake", "stock-in-ady", {
    receiptId: received.adypocideReceipts[0].id,
    ...count,
  });
  assert.equal(byReceipt.cartons[0].batchId, base.id);
});

test("the total-boxes helper sums the batch's box cartons only", () => {
  let { s, id } = shrunk();
  const b = () => s.batches.find((x) => x.id === id);
  assert.equal(batchBoxTotal(s, b()), null);
  s = as(s, "intake", "stock-in-ady", { batchId: id, boxes: 12, rack: "R", pic: "SV" });
  s = as(s, "intake", "stock-in-ady", { batchId: id, boxes: 0, rack: "R", pic: "SV" });
  // An old sachet-unit carton of the same batch is not boxes.
  s.cartons.push({ ...s.cartons[0], id: "legacy-sachets", unit: "sachet", qty: 300 });
  // Another batch's boxes are not counted.
  s.cartons.push({ ...s.cartons[0], id: "other", batchId: "b-ady", qty: 7 });
  assert.equal(batchBoxTotal(s, b()), 12);
});
