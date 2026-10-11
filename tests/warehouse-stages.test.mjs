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

test("transfer needs mixing and filling only; the box count needs all five stages", () => {
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
