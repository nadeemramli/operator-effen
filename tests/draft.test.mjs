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
  latestCount,
  countLog,
  countVersions,
} from "../apps/web/src/lib/draft.ts";
import { outOfScopeKeys } from "../apps/web/src/lib/access.ts";
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
  s = run(s, "outbound", "pack", {
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
  // A receipt never needs production's records; a bottle batch is refused.
  const bottleBatch = s.batches.find((b) => b.product !== "ady");
  assert.throws(
    () => run(s, "intake", "receive-ady", { batchId: bottleBatch.id, pic: "Receiver" }),
    /Choose a sachet batch/,
  );
  assert.equal(s.batches[0].steps.length, 5);
  assert.deepEqual(s.batches[0].route.stages, [
    "mixing",
    "filling",
    "batching",
    "hologram",
    "wrapping",
  ]);
  for (const [index, stage] of sachetProcesses.entries()) {
    s = run(s, "production", "machine", {
      id: batchId,
      stage: stage.id,
      pic: "Operator " + String.fromCharCode(65 + index),
    });
    assert.equal(batchComplete(s.batches[0]), index === 4);
    // Transfer needs the factory stages (mixing, filling) only.
    if (index < 1)
      assert.throws(
        () =>
          run(s, "production", "transfer", { id: batchId, pic: "Factory PIC" }),
        /mixing and filling/,
      );
  }
  assert.deepEqual(
    s.batches[0].steps.map((step) => [step.machine, step.pic, step.qty]),
    [
      ["Mixer machine", "Operator A", null],
      ["Sachet filling machine", "Operator B", null],
      ["Inkjet printer", "Operator C", null],
      ["Hologram machine", "Operator D", null],
      ["Shrink machine", "Operator E", null],
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
        stage: "mixing",
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
      run(s, "intake", "stock-add", { cartonId: source.id, qty: 1, pic: "X" }),
    /sachet/,
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
// A physical count recorded before 2026-11-11 (the retired `count` command) is still reviewed
// with an adjustment, as long as stock has not moved and it is the carton's latest count.
const legacyCount = (s, cartonId, actual, extra = {}) => {
  const count = {
    id: "legacy-" + Math.random().toString(36).slice(2),
    cartonId,
    book: available(s, s.cartons.find((c) => c.id === cartonId)),
    actual,
    pic: "X",
    at: new Date().toISOString(),
    adjusted: false,
    ...extra,
  };
  s.counts.unshift(count);
  return count;
};
test("legacy counts do not silently adjust stock; movement after a count invalidates its adjustment", () => {
  let s = createDraft();
  const { id } = legacyCount(s, "c-gly", 110);
  assert.equal(available(s, s.cartons.find((c) => c.id === "c-gly")), 118);
  s = run(s, "outbound", "issue", { cartonId: "c-gly", orderId: "o-3", qty: 1, pic: "X" });
  assert.throws(() => run(s, "intake", "adjust", { id, reason: "Recount" }), /moved.*Recount/);
  assert.throws(() => run(s, "intake", "count", { cartonId: "c-gly", actual: 110, pic: "X" }), /Unknown/);
});
test("legacy adjustments require a reason, apply once, and only to the carton's latest count", () => {
  let s = createDraft();
  const older = legacyCount(s, "c-gly", 110, { at: "2026-10-01T00:00:00Z" });
  const { id } = legacyCount(s, "c-gly", 112);
  assert.equal(latestCount(s, { id: "c-gly" }).id, id);
  assert.throws(() => run(s, "intake", "adjust", { id }), /reason/);
  assert.throws(() => run(s, "intake", "adjust", { id: older.id, reason: "x" }), /newer count/);
  s = run(s, "intake", "adjust", { id, reason: "Damaged units found" });
  assert.equal(available(s, s.cartons.find((c) => c.id === "c-gly")), 112);
  assert.throws(() => run(s, "intake", "adjust", { id, reason: "Again" }), /already/);
  assert.deepEqual(
    countLog(s, { id: "c-gly" }).current.map((e) => [e.kind, e.before, e.change, e.after]),
    [["count", 118, null, 110], ["count", 118, null, 112]],
  );
});
// 20261028090000: "Count stock" adds to a carton's balance; "Recount" resets it and retires
// the carton's earlier count entries from the list.
test("count stock adds to the carton; a recount resets it and retires the earlier entries", () => {
  let s = createDraft();
  const carton = () => s.cartons.find((c) => c.id === "c-syn");
  assert.equal(available(s, carton()), 118);
  const legacy = legacyCount(s, "c-syn", 136, { at: "2026-11-10T06:03:41.723Z" });
  assert.throws(() => run(s, "intake", "stock-add", { cartonId: "c-syn", qty: 0, pic: "Nurul" }), /whole number/);
  assert.throws(() => run(s, "intake", "stock-add", { cartonId: "c-syn", qty: 16 }), /pic/);
  assert.throws(
    () => run(s, "production", "stock-add", { cartonId: "c-syn", qty: 16, pic: "Helmi" }),
    /role/i,
  );
  let before = s;
  s = run(s, "intake", "stock-add", { cartonId: "c-syn", qty: 16, pic: "Nurul" });
  assert.deepEqual(outOfScopeKeys("stock-add", before, s), []);
  assert.equal(available(s, carton()), 134, "the counted stock is added to the balance");
  assert.equal(carton().qty, 120, "the received carton is never rewritten");
  const add = s.adjustments[0];
  assert.equal(add.kind, "add");
  assert.deepEqual([add.delta, add.from, add.to, add.pic, add.recordedBy.role], [16, 118, 134, "Nurul", "intake"]);
  assert.match(s.events[0].detail, /\+16 bottle · 118 → 134/);
  assert.deepEqual(
    countLog(s, carton()).current.map((e) => [e.kind, e.after]),
    [["count", 136], ["add", 134]],
  );
  // A recount needs a reason, a changed total and the stock-adjust capability.
  assert.throws(() => run(s, "intake", "recount", { cartonId: "c-syn", total: 130, pic: "Nurul" }), /reason/);
  assert.throws(
    () => run(s, "intake", "recount", { cartonId: "c-syn", total: 134, reason: "Same", pic: "Nurul" }),
    /already stands at 134/,
  );
  assert.throws(
    () => run(s, "production", "recount", { cartonId: "c-syn", total: 130, reason: "x", pic: "Helmi" }),
    /role/i,
  );
  before = s;
  s = run(s, "intake", "recount", { cartonId: "c-syn", total: 130, reason: "Physical stock take", pic: "Nurul" });
  assert.deepEqual(outOfScopeKeys("recount", before, s), []);
  assert.equal(available(s, carton()), 130, "the balance is reset to the recounted total");
  const rc = s.adjustments[0];
  assert.deepEqual([rc.kind, rc.delta, rc.from, rc.to, rc.reason], ["recount", -4, 134, 130, "Physical stock take"]);
  assert.match(s.events[0].detail, /134 → 130 bottle/);
  // The list keeps the recount only; the legacy count and the added stock are retired.
  const log = countLog(s, carton());
  assert.deepEqual(log.current.map((e) => e.kind), ["recount"]);
  assert.deepEqual(log.retired.map((e) => e.kind), ["count", "add"]);
  assert.equal(s.counts.find((k) => k.id === legacy.id).actual, 136, "retired entries stay in the document");
  assert.throws(() => run(s, "intake", "adjust", { id: legacy.id, reason: "x" }), /moved/);
  // Stock issued after the recount is counted back in as added stock.
  s = run(s, "intake", "stock-add", { cartonId: "c-syn", qty: 5, pic: "Nurul", note: "Second pallet" });
  assert.equal(available(s, carton()), 135);
  assert.equal(s.adjustments[0].reason, "Second pallet");
  assert.deepEqual(countLog(s, carton()).current.map((e) => e.kind), ["recount", "add"]);
  // A recount down to zero is allowed; below zero is not a whole number of bottles.
  s = run(s, "intake", "recount", { cartonId: "c-syn", total: 0, reason: "Rack cleared", pic: "Nurul" });
  assert.equal(available(s, carton()), 0);
  assert.throws(
    () => run(s, "intake", "recount", { cartonId: "c-syn", total: -1, reason: "x", pic: "Nurul" }),
    /whole number/,
  );
});
test("packer counts must be explicit and cannot overwrite an existing count", () => {
  const s = createDraft();
  const X = "Sample Packer A";
  s.orders.find((o) => o.id === "o-3").assignedPacker = X;
  assert.throws(
    () =>
      run(s, "outbound", "pack", {
        id: "o-3",
        actual: "",
        pic: X,
        labelPic: "Y",
      }),
    /actual/,
  );
  assert.throws(
    () =>
      run(s, "outbound", "pack", {
        id: "o-2",
        actual: 2,
        pic: X,
        labelPic: "Y",
      }),
    /supervisor correction/,
  );
  // The packer is always a packer profile, never a free name.
  assert.throws(
    () =>
      run(s, "outbound", "pack", { id: "o-3", actual: 0, pic: "X", labelPic: "Y" }),
    /actual packer's profile/,
  );
  const updated = run(s, "outbound", "pack", {
    id: "o-3",
    actual: 0,
    pic: X,
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
    /Unknown production stage/,
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
