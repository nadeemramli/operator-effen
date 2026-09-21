import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCommand,
  createDraft,
  available,
  orderIssued,
  batchReceived,
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
test("sachet boxing conserves source units and requires an explicit ratio", () => {
  let s = createDraft();
  const input = {
    cartonId: "c-ady",
    boxes: 10,
    loss: 2,
    ref: "TEST-BOXES",
    rack: "B-01",
    pic: "X",
  };
  assert.throws(() => run(s, "intake", "box", input), /ratio/);
  s = run(s, "intake", "box", { ...input, ratio: 20 });
  assert.equal(
    available(
      s,
      s.cartons.find((c) => c.id === "c-ady"),
    ),
    298,
  );
  assert.equal(available(s, s.cartons[0]), 10);
  assert.equal(s.cartons[0].unit, "box");
  assert.equal(s.cartons[0].batchId, "b-ady");
  assert.throws(
    () =>
      run(s, "outbound", "issue", {
        cartonId: "c-ady",
        orderId: "o-6",
        qty: 1,
        pic: "X",
      }),
    /saleable/,
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
