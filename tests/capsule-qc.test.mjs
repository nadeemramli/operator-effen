// WP1: capsule (bottle) batches record PIC-only machine steps and one QC count at the end.
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCommand,
  batchComplete,
  createDraft,
  isQcStep,
} from "../apps/web/src/lib/draft.ts";
import { outOfScopeKeys } from "../apps/web/src/lib/access.ts";

const run = (s, type, input, role = "production") =>
  applyCommand(s, { type, input, role });
const plan = () =>
  run(createDraft(), "batch", { product: "cav", code: "QC-1", date: "2026-10-01", target: 120 });

test("only the last bottle step is the QC step; sachet stages never are", () => {
  const b = plan().batches[0];
  assert.deepEqual(
    b.steps.map((_, i) => isQcStep(b, i)),
    [false, false, false, true],
  );
  const ady = run(createDraft(), "batch", { product: "ady", code: "S-1", date: "2026-10-01" })
    .batches[0];
  assert.equal(ady.steps.some((_, i) => isQcStep(ady, i)), false);
});

test("a machine step records its PIC without a quantity, and ignores one if sent", () => {
  let s = plan();
  const id = s.batches[0].id;
  s = run(s, "step", { id, step: 0, pic: "Operator A", start: "08:00" });
  const first = s.batches[0].steps[0];
  assert.equal(first.done, true);
  assert.equal(first.qty, null);
  assert.equal(first.qc, "not-recorded");
  assert.equal(first.start, "08:00");
  assert.equal(s.batches[0].actual, 0);
  // A quantity or QC result sent for a machine step is not recorded.
  s = run(s, "step", { id, step: 1, pic: "Operator B", qty: 999, qc: "pass" });
  assert.equal(s.batches[0].steps[1].qty, null);
  assert.equal(s.batches[0].steps[1].qc, "not-recorded");
  assert.equal(s.batches[0].actual, 0);
  assert.match(s.events[0].detail, /^Capsule Counter & Silica Gel · Operator B$/);
  assert.throws(() => run(s, "step", { id, step: 1, pic: "Operator B" }), /already recorded/);
});

test("the QC step requires the count and a QC result, and sets the finished quantity", () => {
  let s = plan();
  const id = s.batches[0].id;
  for (const step of [0, 1, 2]) s = run(s, "step", { id, step, pic: "Operator" });
  assert.throws(() => run(s, "step", { id, step: 3, pic: "QC", qc: "pass" }), /Please enter qty/);
  assert.throws(() => run(s, "step", { id, step: 3, pic: "QC", qty: 118 }), /Please complete qc/);
  const before = s;
  s = run(s, "step", { id, step: 3, pic: "QC Faris", qty: 118, qc: "pass" });
  const b = s.batches[0];
  assert.equal(b.steps[3].qty, 118);
  assert.equal(b.actual, 118);
  assert.equal(batchComplete(b), true);
  assert.equal(s.events[0].detail, "QC count 118 bottles · QC: pass · QC Faris");
  assert.deepEqual(outOfScopeKeys("step", before, s), []);
  // Finished = QC count, and it can be sent to fulfilment.
  s = run(s, "transfer", { id, qty: 118, pic: "Sender" });
  assert.equal(s.batches[0].sent, 118);
  assert.throws(() => run(s, "transfer", { id, qty: 1, pic: "Sender" }), /exceeds/);
});

test("historical batches whose machine steps carry an output still read and transfer", () => {
  const s = plan();
  const b = s.batches[0];
  b.steps = b.steps.map((st, i) => ({
    ...st,
    pic: "Old PIC",
    qty: [130, 125, 122, 120][i],
    done: true,
    qc: i === 3 ? "pass" : "not-recorded",
  }));
  b.actual = 120;
  const next = run(s, "transfer", { id: b.id, qty: 100, pic: "Sender" });
  const kept = next.batches[0];
  assert.deepEqual(kept.steps.map((st) => st.qty), [130, 125, 122, 120]);
  assert.equal(kept.sent, 100);
  assert.equal(kept.actual, 120);
});
