import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCommand,
  createDraft,
  available,
  orderIssued,
  batchReceived,
  batchComplete,
  sachetProcesses,
  stepNames,
  adypocideReceipts,
  stockCartons,
} from "../apps/web/src/lib/draft.ts";
const run = (s, role, type, input) => applyCommand(s, { role, type, input });
test("factory → carton → parcel preserves batch linkage and does not deduct twice", () => {
  let s = createDraft();
  s = run(s, "production", "transfer", {
    id: "b-cav",
    qty: 10,
    pic: "Sample PIC A",
  });
  s = run(s, "intake", "receive", {
    batchId: "b-cav",
    qty: 10,
    ref: "TEST-NEW-CARTON",
    rack: "A-09",
    pic: "Sample PIC B",
  });
  const c = s.cartons[0];
  s = run(s, "admin", "order", {
    product: "cav",
    awb: "TEST-NEW-AWB",
    channel: "Shopee",
    date: "2026-09-21",
    package: "Test pair",
    expected: 2,
  });
  s = run(s, "admin", "review-order", { id: s.orders[0].id, pic: "Reviewer" });
  s.orders[0].assignedPacker = "Sample Packer A";
  const order = s.orders[0];
  s = run(s, "outbound", "issue", {
    cartonId: c.id,
    orderId: order.id,
    qty: 2,
    pic: "Sample PIC C",
  });
  s = run(s, "packer", "pack", {
    id: order.id,
    actual: 2,
    pic: "Sample Packer A",
    labelPic: "Sample Packer B",
  });
  s = run(s, "outbound", "dispatch", {
    id: order.id,
    reference: "TEST-MANIFEST",
    pic: "Sample PIC D",
  });
  assert.equal(available(s, c), 8);
  assert.equal(s.issues.find((i) => i.orderId === order.id).cartonId, c.id);
  assert.equal(c.batchId, "b-cav");
  assert.equal(s.orders[0].dispatched, true);
  assert.equal(batchReceived(s, s.batches[0]), 130);
});
test("a stock issue cannot overdraw a carton or use another product", () => {
  const s = createDraft();
  assert.throws(
    () =>
      run(s, "outbound", "issue", {
        cartonId: "c-cav",
        orderId: "o-2",
        qty: 115,
        pic: "X",
      }),
    /Not enough/,
  );
  assert.throws(
    () =>
      run(s, "outbound", "issue", {
        cartonId: "c-gly",
        orderId: "o-2",
        qty: 1,
        pic: "X",
      }),
    /matching/,
  );
  assert.equal(available(s, s.cartons[0]), 114);
});
test("Adypocide records machines and PICs, then creates stock only from warehouse box counts", () => {
  let s = run(createDraft(), "production", "batch", {
    product: "ady",
    code: "ADY-NEW",
    date: "2026-09-24",
  });
  const batchId = s.batches[0].id;
  assert.equal(batchComplete(s.batches[0]), false);
  assert.throws(
    () => run(s, "production", "transfer", { id: batchId, pic: "Factory PIC" }),
    /machine and PIC/,
  );
  assert.throws(
    () =>
      run(s, "intake", "receive-ady", {
        batchId,
        ref: "ADY-IN",
        pic: "Receiver",
      }),
    /sent to the warehouse/,
  );
  assert.equal(s.batches[0].steps.length, 4);
  for (const [index, stage] of sachetProcesses.entries()) {
    s = run(s, "production", "machine", {
      id: batchId,
      stage: stage.id,
      pic: "Operator " + String.fromCharCode(65 + index),
    });
    assert.equal(batchComplete(s.batches[0]), index === 3);
    if (index < 3)
      assert.throws(
        () =>
          run(s, "production", "transfer", { id: batchId, pic: "Factory PIC" }),
        /all four/,
      );
  }
  assert.deepEqual(
    s.batches[0].steps.map((step) => [step.machine, step.pic, step.qty]),
    [
      ["Mixer machine", "Operator A", null],
      ["Sachet filling machine", "Operator B", null],
      ["Inkjet printer", "Operator C", null],
      ["Shrink machine", "Operator D", null],
    ],
  );
  assert.equal(s.batches[0].target, 0);
  assert.equal(s.batches[0].actual, 0);
  s = run(s, "production", "transfer", {
    id: batchId,
    pic: "Factory supervisor",
  });
  assert.throws(
    () =>
      run(s, "production", "transfer", {
        id: batchId,
        pic: "Factory supervisor",
      }),
    /already/,
  );
  assert.throws(
    () =>
      run(s, "production", "machine", {
        id: batchId,
        machine: "Machine 3",
        pic: "Operator C",
      }),
    /already/,
  );
  s = run(s, "intake", "receive-ady", {
    batchId,
    ref: "ADY-IN",
    pic: "Receiver",
  });
  const receiptId = s.adypocideReceipts[0].id;
  assert.equal(
    stockCartons(s).some((c) => c.batchId === batchId),
    false,
  );
  assert.equal(batchReceived(s, s.batches[0]), 0);
  assert.throws(
    () =>
      run(s, "intake", "receive-ady", {
        batchId,
        ref: "ady-in",
        pic: "Receiver",
      }),
    /awaiting boxing/,
  );
  const input = {
    receiptId,
    boxes: 87,
    ref: "ADY-BOXES",
    rack: "B-01",
    pic: "Stock-in supervisor",
  };
  for (const role of [
    "production",
    "admin",
    "outbound",
    "packer",
    "management",
  ])
    assert.throws(() => run(s, role, "stock-in-ady", input), /supervisor/);
  for (const boxes of [undefined, "", -1, 1.5])
    assert.throws(
      () => run(s, "intake", "stock-in-ady", { ...input, boxes }),
      /boxes|whole number/,
    );
  s = run(s, "intake", "stock-in-ady", input);
  const carton = s.cartons[0];
  assert.equal(carton.batchId, batchId);
  assert.equal(carton.unit, "box");
  assert.equal(carton.qty, 87);
  assert.equal(carton.pic, "Stock-in supervisor");
  assert.equal(batchReceived(s, s.batches[0]), 87);
  assert.equal(s.adypocideReceipts[0].stockCartonId, carton.id);
  assert.ok(s.adypocideReceipts[0].stockedAt);
  assert.throws(() => run(s, "intake", "stock-in-ady", input), /already/);
  s = run(s, "outbound", "issue", {
    cartonId: carton.id,
    orderId: "o-6",
    qty: 2,
    pic: "Outbound",
  });
  assert.equal(available(s, carton), 85);
  assert.equal(
    s.batches.find((b) => b.id === batchId).steps[1].pic,
    "Operator B",
  );
});
test("Adypocide rejects old quantity workflows and allows an explicit zero finished-box count", () => {
  let s = createDraft();
  assert.throws(
    () =>
      run(s, "intake", "receive", {
        batchId: "b-ady",
        qty: 500,
        ref: "OLD",
        rack: "A",
        pic: "X",
      }),
    /boxing/,
  );
  assert.throws(
    () =>
      run(s, "production", "step", {
        id: "b-ady",
        step: 0,
        qty: 500,
        pic: "X",
        qc: "pass",
      }),
    /machine and PIC/,
  );
  assert.throws(
    () =>
      run(s, "intake", "box", {
        cartonId: "c-ady",
        ratio: 20,
        boxes: 10,
        loss: 0,
      }),
    /no longer/,
  );
  s = run(s, "intake", "stock-in-ady", {
    receiptId: "r-ady",
    boxes: 0,
    ref: "ZERO-BOXES",
    rack: "B",
    pic: "X",
  });
  assert.equal(s.cartons[0].qty, 0);
  assert.ok(s.adypocideReceipts[0].stockedAt);
  assert.equal(
    stockCartons(s).some((c) => c.unit === "sachet"),
    false,
  );
});
test("legacy sachet receipts need a fresh box count without converting or replacing existing box stock", () => {
  let s = createDraft();
  delete s.adypocideReceipts;
  const batch = s.batches.find((b) => b.id === "b-ady");
  delete batch.transferredAt;
  batch.sent = 500;
  const source = {
    id: "legacy-sachets",
    ref: "LEGACY-IN",
    batchId: batch.id,
    product: "ady",
    unit: "sachet",
    qty: 500,
    rack: "B",
    pic: "Receiver",
    at: "2026-09-21",
  };
  const existing = {
    ...source,
    id: "existing-boxes",
    ref: "OLD-BOXES",
    unit: "box",
    qty: 10,
  };
  s.cartons.push(source, existing);
  s.boxing.push({
    id: "old-boxing",
    sourceId: source.id,
    cartonId: existing.id,
    boxes: 10,
    ratio: 20,
    loss: 2,
    pic: "X",
    at: "2026-09-21",
  });
  assert.equal(available(s, source), 298);
  assert.equal(adypocideReceipts(s).length, 1);
  assert.equal(
    stockCartons(s)
      .filter((c) => c.product === "ady")
      .reduce((n, c) => n + c.qty, 0),
    10,
  );
  assert.throws(
    () =>
      run(s, "intake", "count", { cartonId: source.id, actual: 298, pic: "X" }),
    /box count/,
  );
  s = run(s, "intake", "stock-in-ady", {
    receiptId: source.id,
    boxes: 12,
    ref: "NEW-BOXES",
    rack: "B",
    pic: "Supervisor",
  });
  assert.deepEqual(
    s.cartons.find((c) => c.id === source.id),
    { ...source, ref: batch.code, legacyRef: source.ref },
  );
  assert.deepEqual(
    s.cartons.find((c) => c.id === existing.id),
    { ...existing, ref: batch.code, legacyRef: existing.ref },
  );
  assert.equal(batchReceived(s, batch), 22);
  assert.equal(adypocideReceipts(s).filter((r) => !r.stockedAt).length, 0);
  assert.throws(
    () =>
      run(s, "intake", "stock-in-ady", {
        receiptId: source.id,
        boxes: 12,
        ref: "AGAIN",
        rack: "B",
        pic: "X",
      }),
    /already/,
  );
});
test("counts do not silently adjust stock; movement after a count invalidates its adjustment", () => {
  let s = run(createDraft(), "intake", "count", {
    cartonId: "c-gly",
    actual: 110,
    pic: "X",
  });
  const id = s.counts[0].id;
  assert.equal(
    available(
      s,
      s.cartons.find((c) => c.id === "c-gly"),
    ),
    118,
  );
  s = run(s, "outbound", "issue", {
    cartonId: "c-gly",
    orderId: "o-3",
    qty: 1,
    pic: "X",
  });
  assert.throws(
    () => run(s, "intake", "adjust", { id, reason: "Recount" }),
    /moved/,
  );
});
test("adjustments require a reason and cannot be applied twice", () => {
  let s = run(createDraft(), "intake", "count", {
    cartonId: "c-gly",
    actual: 110,
    pic: "X",
  });
  const id = s.counts[0].id;
  assert.throws(() => run(s, "intake", "adjust", { id }), /reason/);
  s = run(s, "intake", "adjust", { id, reason: "Damaged units found" });
  assert.equal(
    available(
      s,
      s.cartons.find((c) => c.id === "c-gly"),
    ),
    110,
  );
  assert.throws(
    () => run(s, "intake", "adjust", { id, reason: "Again" }),
    /already/,
  );
});
test("packer counts must be explicit and cannot overwrite an existing count", () => {
  const s = createDraft();
  s.orders.find((o) => o.id === "o-3").assignedPacker = "X";
  assert.throws(
    () =>
      run(s, "packer", "pack", {
        id: "o-3",
        actual: "",
        pic: "X",
        labelPic: "Y",
      }),
    /actual/,
  );
  assert.throws(
    () =>
      run(s, "packer", "pack", {
        id: "o-2",
        actual: 2,
        pic: "X",
        labelPic: "Y",
      }),
    /supervisor correction/,
  );
  const updated = run(s, "packer", "pack", {
    id: "o-3",
    actual: 0,
    pic: "X",
    labelPic: "Y",
  });
  assert.equal(updated.orders.find((o) => o.id === "o-3").actual, 0);
  assert.equal(
    orderIssued(
      updated,
      updated.orders.find((o) => o.id === "o-3"),
    ),
    2,
  );
});
test("corrections preserve the original expected snapshot and audit reason", () => {
  let s = run(createDraft(), "outbound", "correct", {
    id: "o-2",
    field: "expected",
    qty: 4,
    reason: "Package selection corrected",
  });
  const o = s.orders.find((o) => o.id === "o-2");
  assert.equal(o.originalExpected, 2);
  assert.equal(o.expected, 4);
  assert.match(s.events[0].detail, /2 → 4.*Package selection corrected/);
  assert.throws(
    () =>
      run(s, "management", "correct", {
        id: "o-2",
        field: "actual",
        qty: 2,
        reason: "No",
      }),
    /supervisor/,
  );
});
test("mismatch handover needs a recorded exception", () => {
  const s = createDraft();
  assert.throws(
    () =>
      run(s, "outbound", "dispatch", {
        id: "o-2",
        reference: "TEST",
        pic: "X",
      }),
    /note/,
  );
  const updated = run(s, "outbound", "dispatch", {
    id: "o-2",
    reference: "TEST",
    pic: "X",
    note: "Sample exception review",
  });
  assert.equal(updated.orders.find((o) => o.id === "o-2").dispatched, true);
});
test("management can request follow-up but cannot change stock; duplicate AWBs are rejected", () => {
  const s = createDraft();
  assert.throws(
    () =>
      run(s, "management", "receive", {
        batchId: "b-cav",
        qty: 1,
        ref: "X",
        rack: "A",
        pic: "X",
      }),
    /supervisor/,
  );
  assert.equal(
    run(s, "management", "review", { text: "Review this batch" }).notes[0].kind,
    "review",
  );
  assert.throws(
    () =>
      run(s, "admin", "order", {
        product: "cav",
        awb: "test-awb-1001",
        channel: "Shopee",
        date: "2026-09-21",
        package: "Test",
        expected: 2,
      }),
    /already/,
  );
});
test("unfinished batches cannot be transferred and QC is never inferred", () => {
  const s = createDraft();
  assert.throws(
    () =>
      run(s, "production", "transfer", { id: "b-cav-next", qty: 10, pic: "X" }),
    /remaining/,
  );
  assert.ok(s.batches[0].steps.every((st) => st.qc === "not-recorded"));
  assert.equal(
    run(s, "production", "close", { date: "2026-09-21", note: "Daily review" })
      .batches[0].steps[3].qc,
    "not-recorded",
  );
});

test("sachet route rejects arbitrary or duplicate stages and preserves legacy machine records", () => {
  let s = run(createDraft(), "production", "batch", {
    product: "ady",
    code: "FIXED-ADY",
    date: "2026-09-24",
  });
  const batch = s.batches[0];
  assert.throws(
    () =>
      run(s, "production", "machine", {
        id: batch.id,
        stage: "custom",
        pic: "X",
      }),
    /four fixed/,
  );
  assert.throws(
    () =>
      run(s, "production", "machine", {
        id: batch.id,
        stage: "mixing",
        pic: "",
      }),
    /pic/,
  );
  assert.throws(
    () =>
      run(s, "packer", "machine", { id: batch.id, stage: "mixing", pic: "X" }),
    /supervisor/,
  );
  s = run(s, "production", "machine", {
    id: batch.id,
    stage: "mixing",
    pic: "Operator A",
  });
  assert.throws(
    () =>
      run(s, "production", "machine", {
        id: batch.id,
        stage: "mixing",
        pic: "Operator B",
      }),
    /already/,
  );
  // A pre-standardization machine record must not be mistaken for a fixed stage.
  s.batches[0].steps = [
    {
      machine: "Historical filling machine",
      pic: "Original PIC",
      qty: null,
      start: "",
      end: "",
      done: true,
      qc: "not-recorded",
    },
  ];
  assert.equal(batchComplete(s.batches[0]), false);
  s = run(s, "production", "machine", {
    id: batch.id,
    stage: "mixing",
    pic: "New PIC",
  });
  assert.equal(s.batches[0].steps[0].pic, "Original PIC");
  assert.equal(stepNames(s.batches[0])[0][0], "Historical filling machine");
  assert.equal(stepNames(s.batches[0])[1][0], "Mixer machine (mixing)");
  assert.equal(batchComplete(s.batches[0]), false);
});
