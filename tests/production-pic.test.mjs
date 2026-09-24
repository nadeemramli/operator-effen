import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCommand,
  createDraft,
  batchComplete,
  batchReceived,
  available,
  withBatchReferences,
  products,
  sachetProcesses,
} from "../apps/web/src/lib/draft.ts";
const run = (s, type, input, role = "production") =>
  applyCommand(s, { type, input, role });
const plan = (product = "cav") =>
  run(createDraft(), "batch", {
    product,
    code: "PIC-TEST",
    date: "2020-01-01",
    target: 10,
    pic_0: "PIC A",
    pic_1: "PIC B",
    pic_2: "PIC C",
    pic_3: "PIC D",
  });
test("planning assigns PICs for both factory routes without marking work complete or creating stock", () => {
  for (const product of ["cav", "ady"]) {
    const s = plan(product),
      b = s.batches[0];
    assert.deepEqual(
      b.steps.map((s) => s.pic),
      ["PIC A", "PIC B", "PIC C", "PIC D"],
    );
    assert.equal(
      b.steps.every((s) => !s.done && s.qty === null),
      true,
    );
    assert.equal(batchComplete(b), false);
    assert.equal(batchReceived(s, b), 0);
    assert.equal(b.steps[0].picHistory[0].kind, "assignment");
  }
});
test("correction and shift handover preserve participants, reasons and output through process completion", () => {
  let s = plan(),
    id = s.batches[0].id;
  s = run(s, "change-step-pic", {
    id,
    step: 0,
    kind: "correction",
    pic: "PIC B",
    reason: "Supervisor selected the wrong profile",
  });
  s = run(s, "change-step-pic", {
    id,
    step: 0,
    kind: "handover",
    pic: "PIC C",
    effectiveAt: "2020-01-01T11:00",
    reason: "Shift change",
  });
  assert.equal(s.batches[0].steps[0].done, false);
  assert.throws(
    () =>
      run(s, "step", {
        id,
        step: 0,
        pic: "PIC A",
        qty: 10,
        qc: "not-recorded",
      }),
    /Edit PIC/,
  );
  s = run(s, "step", {
    id,
    step: 0,
    pic: "PIC C",
    qty: 10,
    qc: "not-recorded",
  });
  const step = s.batches[0].steps[0];
  assert.equal(step.qty, 10);
  assert.equal(step.pic, "PIC C");
  assert.equal(step.done, true);
  assert.deepEqual(
    step.picHistory.map((h) => h.kind),
    ["assignment", "correction", "handover"],
  );
  assert.equal(step.picHistory[1].from, "PIC A");
  assert.equal(step.picHistory[2].effectiveAt, "2020-01-01T03:00:00.000Z");
  assert.ok(
    s.events.some(
      (e) =>
        e.action === "Production shift handover" &&
        e.detail.includes("PIC B → PIC C"),
    ),
  );
  s = run(s, "change-step-pic", {
    id,
    step: 0,
    kind: "correction",
    pic: "PIC D",
    reason: "Corrected current profile",
  });
  assert.equal(s.batches[0].steps[0].qty, 10);
  assert.equal(s.batches[0].steps[0].picHistory.length, 4);
});
test("handover validation enforces a different PIC, a reason, chronology, role and an untransferred batch", () => {
  let s = plan(),
    id = s.batches[0].id;
  const input = {
    id,
    step: 0,
    kind: "handover",
    pic: "PIC B",
    effectiveAt: "2020-01-01T11:00",
    reason: "Shift change",
  };
  assert.throws(
    () => run(s, "change-step-pic", { ...input, pic: "PIC A" }),
    /different/,
  );
  assert.throws(
    () => run(s, "change-step-pic", { ...input, reason: "" }),
    /reason/,
  );
  assert.throws(
    () =>
      run(s, "change-step-pic", { ...input, effectiveAt: "2999-01-01T11:00" }),
    /future/,
  );
  assert.throws(
    () =>
      run(s, "change-step-pic", { ...input, effectiveAt: "2019-12-31T11:00" }),
    /batch date/,
  );
  assert.throws(() => run(s, "change-step-pic", input, "packer"), /supervisor/);
  s = run(s, "change-step-pic", input);
  assert.throws(
    () => run(s, "change-step-pic", { ...input, pic: "PIC C" }),
    /later/,
  );
  s.batches[0].sent = 1;
  assert.throws(
    () =>
      run(s, "change-step-pic", {
        ...input,
        pic: "PIC C",
        effectiveAt: "2020-01-01T12:00",
      }),
    /transferred/,
  );
  s = run(s, "change-step-pic", {
    id,
    step: 0,
    kind: "correction",
    pic: "PIC C",
    reason: "Historical selection error",
  });
  assert.equal(s.batches[0].sent, 1);
});
test("sachet completion retains planned and corrected PIC history", () => {
  let s = plan("ady"),
    id = s.batches[0].id;
  s = run(s, "change-step-pic", {
    id,
    step: 0,
    kind: "correction",
    pic: "Replacement",
    reason: "Wrong planned PIC",
  });
  for (const [i, stage] of sachetProcesses.entries())
    s = run(s, "machine", {
      id,
      stage: stage.id,
      pic: i === 0 ? "Replacement" : ["PIC A", "PIC B", "PIC C", "PIC D"][i],
    });
  assert.equal(batchComplete(s.batches[0]), true);
  assert.equal(s.batches[0].steps[0].picHistory.length, 2);
  assert.equal(
    s.batches[0].steps.every((s) => s.qty === null),
    true,
  );
});
test("bottle receipts inherit batch number and keep separate rack balances under separate IDs", () => {
  let s = createDraft(),
    b = s.batches.find((b) => b.product === "cav");
  s = run(s, "transfer", { id: b.id, qty: 20, pic: "Factory" });
  for (const rack of ["A-01", "B-02"])
    s = run(
      s,
      "receive",
      { batchId: b.id, qty: 10, rack, pic: "Receiver" },
      "intake",
    );
  const [second, first] = s.cartons;
  assert.equal(first.ref, b.code);
  assert.equal(second.ref, b.code);
  assert.notEqual(first.id, second.id);
  assert.equal(available(s, first), 10);
  assert.equal(available(s, second), 10);
  assert.equal(batchReceived(s, b), 140);
  assert.throws(
    () =>
      run(
        s,
        "receive",
        { batchId: b.id, qty: 1, rack: "A", pic: "X" },
        "intake",
      ),
    /exceeds/,
  );
});
test("sachet receipt and box stock inherit the batch number; duplicate pending and finalized actions are blocked", () => {
  let s = createDraft();
  s.adypocideReceipts = [];
  s = run(s, "receive-ady", { batchId: "b-ady", pic: "Receiver" }, "intake");
  const receipt = s.adypocideReceipts[0];
  assert.equal(receipt.ref, "TEST-ADY-001");
  assert.throws(
    () =>
      run(s, "receive-ady", { batchId: "b-ady", pic: "Receiver" }, "intake"),
    /awaiting boxing/,
  );
  s = run(
    s,
    "stock-in-ady",
    { receiptId: receipt.id, boxes: 12, rack: "B", pic: "Stock-in" },
    "intake",
  );
  assert.equal(s.cartons[0].ref, "TEST-ADY-001");
  assert.throws(
    () =>
      run(
        s,
        "stock-in-ady",
        { receiptId: receipt.id, boxes: 12, rack: "B", pic: "Stock-in" },
        "intake",
      ),
    /already/,
  );
  s = run(s, "receive-ady", { batchId: "b-ady", pic: "Receiver" }, "intake");
  assert.notEqual(s.adypocideReceipts[0].id, receipt.id);
  assert.equal(s.adypocideReceipts[0].ref, receipt.ref);
});
test("reference normalization preserves legacy aliases, record IDs and stock allocations", () => {
  const original = createDraft();
  original.cartons[0].ref = "OLD-CARTON";
  const s = withBatchReferences(original),
    c = s.cartons[0];
  assert.equal(c.ref, s.batches.find((b) => b.id === c.batchId).code);
  assert.equal(c.legacyRef, "OLD-CARTON");
  assert.equal(c.id, original.cartons[0].id);
  assert.equal(available(s, c), available(original, original.cartons[0]));
  assert.deepEqual(s.issues, original.issues);
  assert.equal(original.cartons[0].ref, "OLD-CARTON");
  assert.deepEqual(withBatchReferences(s), s);
});
test("future catalog sachet products use the fixed route and retain their product at stock-in", () => {
  let s = createDraft();
  products.push({
    id: "test-sachet",
    name: "Test sachet product",
    short: "TST",
    unit: "box",
    factory: "sachet",
    color: "var(--info)",
  });
  try {
    s = run(s, "batch", {
      product: "test-sachet",
      code: "NEW-SACHET",
      date: "2020-01-01",
    });
    const id = s.batches[0].id;
    assert.equal(s.batches[0].steps.length, 4);
    for (const stage of sachetProcesses)
      s = run(s, "machine", { id, stage: stage.id, pic: "PIC" });
    s = run(s, "transfer", { id, pic: "Factory" });
    s = run(s, "receive-ady", { batchId: id, pic: "Receiver" }, "intake");
    s = run(
      s,
      "stock-in-ady",
      {
        receiptId: s.adypocideReceipts[0].id,
        boxes: 5,
        rack: "C",
        pic: "Stock-in",
      },
      "intake",
    );
    assert.equal(s.cartons[0].product, "test-sachet");
    assert.equal(s.cartons[0].ref, "NEW-SACHET");
  } finally {
    products.pop();
  }
});
