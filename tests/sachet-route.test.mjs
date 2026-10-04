// OPER-4: versioned five-stage sachet route with Hologram.
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCommand,
  batchComplete,
  batchRoute,
  createDraft,
  routeStages,
  sachetRoutes,
  stageStep,
  stepNames,
} from "../apps/web/src/lib/draft.ts";

const run = (s, type, input, role = "production") =>
  applyCommand(s, { type, role, input });
const five = ["mixing", "filling", "batching", "hologram", "wrapping"];
function planned(plan = {}) {
  return run(createDraft(), "batch", {
    product: "ady",
    code: "ROUTE-1",
    date: "2026-09-30",
    route: "sachet-v2",
    ...plan,
  });
}
// The four-stage shape saved before this change: no route snapshot, positional steps.
function legacyFourStage(s, transferred = true) {
  const b = s.batches.find((x) => x.id === "b-ady");
  delete b.route;
  b.steps = b.steps.filter((st) => st.sachetStage !== "hologram");
  if (!transferred) {
    delete b.transferredAt;
    delete b.transferPic;
    s.adypocideReceipts = [];
  }
  return b;
}
const record = (s, id, stage, pic = "PIC " + stage, extra = {}) =>
  run(s, "machine", { id, stage, pic, ...extra });

test("the sandbox seed's sachet batch carries a five-stage snapshot", () => {
  const b = createDraft().batches.find((x) => x.id === "b-ady");
  assert.equal(b.route.id, "sachet-v2");
  assert.deepEqual(b.steps.map((st) => st.sachetStage), five);
  assert.equal(batchComplete(b), true);
});
test("new sachet batches snapshot the five-stage route with stable keys and bilingual labels", () => {
  const s = planned();
  const b = s.batches[0];
  assert.equal(b.route.id, "sachet-v2");
  assert.deepEqual(b.route.stages, five);
  assert.deepEqual(
    b.steps.map((step) => step.sachetStage),
    five,
  );
  assert.deepEqual(routeStages(b).map((st) => [st.en, st.ms])[3], [
    "Hologram machine",
    "Mesin hologram",
  ]);
  assert.deepEqual(stepNames(b)[4], [
    "Shrink machine (plastic wrapping)",
    "Mesin shrink (balutan plastik)",
  ]);
  // Later edits to the route catalogue do not change an existing batch's snapshot.
  const original = sachetRoutes["sachet-v2"].stages;
  sachetRoutes["sachet-v2"].stages = [...original, "future-stage"];
  try {
    assert.deepEqual(batchRoute(b).stages, five);
  } finally {
    sachetRoutes["sachet-v2"].stages = original;
  }
});

test("a planned Hologram PIC is not completed work, and transfer needs all five actual records", () => {
  let s = planned({ pic_3: "Planned Holo PIC" });
  const id = s.batches[0].id;
  assert.equal(stageStep(s.batches[0], "hologram").pic, "Planned Holo PIC");
  assert.equal(stageStep(s.batches[0], "hologram").done, false);
  for (const stage of ["mixing", "filling", "batching", "wrapping"])
    s = record(s, id, stage);
  assert.equal(batchComplete(s.batches[0]), false);
  assert.throws(
    () => run(s, "transfer", { id, pic: "Factory" }),
    /all five stages/,
  );
  // QC is never inferred from completion.
  assert.ok(s.batches[0].steps.every((st) => st.qc === "not-recorded"));
  assert.throws(() => record(s, id, "hologram", ""), /pic/);
  s = record(s, id, "hologram", "Planned Holo PIC");
  assert.equal(batchComplete(s.batches[0]), true);
  s = run(s, "transfer", { id, pic: "Factory" });
  assert.ok(s.batches[0].transferredAt);
  assert.equal(s.cartons.filter((c) => c.batchId === id).length, 0);
});

test("unknown stages and incorrect route keys fail clearly", () => {
  const s = planned();
  const id = s.batches[0].id;
  assert.throws(() => record(s, id, "laminating"), /Unknown production stage "laminating"/);
  assert.throws(
    () =>
      run(createDraft(), "batch", {
        product: "ady",
        code: "BAD-ROUTE",
        date: "2026-09-30",
        route: "sachet-v1",
      }),
    /Unknown or retired production route/,
  );
  assert.throws(
    () =>
      run(createDraft(), "batch", {
        product: "ady",
        code: "BAD-ROUTE",
        date: "2026-09-30",
        route: "sachet-v9",
      }),
    /sachet-v9/,
  );
});

test("duplicate completion of a stage is rejected; stale versions conflict", () => {
  let s = planned();
  const id = s.batches[0].id;
  s = record(s, id, "mixing", "PIC A", { expectedVersion: 0 });
  assert.throws(() => record(s, id, "mixing", "PIC A"), /already has a recorded PIC/);
  assert.throws(
    () => record(s, id, "filling", "PIC B", { expectedVersion: 3 }),
    /changed by another entry/,
  );
});

test("route order is fixed while late entry keeps actual, out-of-screen-order times", () => {
  let s = planned();
  const id = s.batches[0].id;
  // Recorded out of screen order, with the earlier stage entered later.
  s = record(s, id, "wrapping", "PIC W", { occurredAt: "2026-09-30T16:00" });
  s = record(s, id, "mixing", "PIC M", { occurredAt: "2026-09-30T08:00" });
  s = record(s, id, "hologram", "PIC H", { occurredAt: "2026-09-30T07:30" });
  const b = s.batches[0];
  assert.deepEqual(routeStages(b).map((st) => st.id), five);
  assert.equal(stageStep(b, "mixing").occurredAt, "2026-09-30T00:00:00.000Z");
  assert.equal(stageStep(b, "hologram").occurredAt, "2026-09-29T23:30:00.000Z");
  assert.notEqual(stageStep(b, "mixing").recordedAt, stageStep(b, "mixing").occurredAt);
  assert.throws(
    () => record(s, id, "filling", "PIC F", { occurredAt: "2026-09-29T23:00" }),
    /before the batch work date/,
  );
  assert.throws(
    () => record(s, id, "filling", "PIC F", { occurredAt: "30/09/2026 08:00" }),
    /Malaysia time/,
  );
});

test("rework occurrences are accountable and do not duplicate completion", () => {
  let s = planned();
  const id = s.batches[0].id;
  assert.throws(
    () => run(s, "stage-rework", { id, stage: "hologram", pic: "P", reason: "Smudged" }),
    /first completion/,
  );
  s = record(s, id, "hologram", "PIC H");
  s = run(s, "stage-rework", {
    id,
    stage: "hologram",
    pic: "PIC H2",
    reason: "Hologram misaligned; re-run",
    occurredAt: "2026-09-30T11:00",
  });
  const step = stageStep(s.batches[0], "hologram");
  assert.equal(step.pic, "PIC H");
  assert.equal(step.occurrences.length, 1);
  assert.equal(step.occurrences[0].pic, "PIC H2");
  assert.equal(step.occurrences[0].kind, "rework");
  assert.equal(s.batches[0].steps.filter((x) => x.sachetStage === "hologram").length, 1);
  assert.throws(
    () => run(s, "stage-rework", { id, stage: "hologram", pic: "P" }),
    /reason/,
  );
});

test("legacy completed/transferred four-stage batches stay valid and readable", () => {
  const s = createDraft();
  const legacy = legacyFourStage(s);
  assert.equal(legacy.route, undefined);
  assert.deepEqual(batchRoute(legacy), {
    ...sachetRoutes["sachet-v1"],
    status: "historical",
  });
  assert.equal(batchComplete(legacy), true);
  assert.equal(legacy.steps.length, 4);
  assert.equal(stageStep(legacy, "hologram"), undefined);
  assert.throws(
    () => run(s, "route-review", { id: "b-ady", decision: "upgrade", reason: "x" }),
    /historical route/,
  );
  // Positional free-form records are never reinterpreted as fixed stages.
  legacy.steps = [{ machine: "Old filler", pic: "Old PIC", qty: null, start: "", end: "", done: true, qc: "not-recorded" }];
  assert.equal(batchRoute(legacy).id, "legacy-freeform");
  assert.equal(stepNames(legacy)[0][0], "Old filler");
});

test("an in-progress legacy batch needs an explicit reviewed upgrade; Hologram is never auto-completed", () => {
  const s = createDraft();
  const b = legacyFourStage(s, false);
  assert.equal(batchRoute(b).status, "needs-review");
  assert.throws(() => run(s, "transfer", { id: b.id, pic: "F" }), /Review its route/);
  assert.throws(() => record(s, b.id, "hologram"), /not part of this batch's route/);
  assert.throws(
    () => run(s, "route-review", { id: b.id, decision: "auto", reason: "x" }),
    /five-stage route or keep/,
  );
  assert.throws(() => run(s, "route-review", { id: b.id, decision: "upgrade" }), /reason/);
  assert.throws(
    () => run(s, "route-review", { id: b.id, decision: "upgrade", reason: "x" }, "intake"),
    /supervisor role/,
  );
  const positions = b.steps.map((st) => st.sachetStage);
  const upgraded = run(s, "route-review", {
    id: b.id,
    decision: "upgrade",
    reason: "Hologram machine used from today",
  });
  const u = upgraded.batches.find((x) => x.id === b.id);
  assert.deepEqual(u.route.stages, five);
  assert.equal(u.route.review.from, "sachet-v1");
  assert.deepEqual(u.steps.slice(0, 4).map((st) => st.sachetStage), positions);
  assert.equal(stageStep(u, "hologram").done, false);
  assert.equal(stageStep(u, "hologram").pic, "");
  assert.equal(batchComplete(u), false);
  assert.throws(() => run(upgraded, "transfer", { id: b.id, pic: "F" }), /all five/);
  // Alternatively keep the recorded four-stage route, explicitly and with a reason.
  const kept = run(s, "route-review", {
    id: b.id,
    decision: "keep-legacy",
    reason: "Batch finished before the Hologram machine was installed",
  });
  const k = kept.batches.find((x) => x.id === b.id);
  assert.equal(k.route.id, "sachet-v1");
  assert.equal(stageStep(k, "hologram"), undefined);
  const sent = run(kept, "transfer", { id: b.id, pic: "F" });
  assert.ok(sent.batches.find((x) => x.id === b.id).transferredAt);
});

test("bottle production keeps its quantity route", () => {
  let s = createDraft();
  s = run(s, "batch", { product: "cav", code: "BOT-1", date: "2026-09-30", target: 10 });
  const b = s.batches[0];
  assert.equal(b.route, undefined);
  assert.equal(b.steps.length, 4);
  assert.throws(() => run(s, "machine", { id: b.id, stage: "mixing", pic: "P" }), /sachet products/);
  for (let i = 0; i < 4; i++)
    s = run(s, "step", { id: b.id, step: i, pic: "P", qty: 10, qc: "not-recorded" });
  s = run(s, "transfer", { id: b.id, qty: 10, pic: "F" });
  assert.equal(s.batches[0].sent, 10);
});
