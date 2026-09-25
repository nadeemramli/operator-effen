import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCommand,
  createDraft,
  packageGroups,
  dailyTally,
  orderIssued,
} from "../apps/web/src/lib/draft.ts";
const date = "2026-09-25";
const run = (s, type, input, role = "outbound") =>
  applyCommand(s, { type, role, input });
function fixture() {
  let s = createDraft();
  const template = s.orders[0];
  s.orders = Array.from({ length: 20 }, (_, i) => ({
    ...template,
    id: `parcel-${String(i).padStart(2, "0")}`,
    awb: `TEST-PARCEL-${i}`,
    product: "cav",
    package: "Package A",
    expected: 4,
    originalExpected: 4,
    actual: null,
    dispatched: false,
    printed: false,
    assignedPacker: undefined,
    packer: "",
    date,
  }));
  s.issues = [];
  s.sortCounts = [];
  s = run(s, "sort-count", {
    date,
    product: "cav",
    counted: 80,
    pic: "Supervisor",
  });
  return s;
}
const input = (s, a = 10, b = 10) => ({
  date,
  group: packageGroups(s.orders).find(
    (g) => g.product === "cav" && g.perParcel === 4,
  ).key,
  packers: ["Sample Packer A", "Sample Packer B"],
  allocation_0: a,
  allocation_1: b,
  pic: "Supervisor",
});
test("20 package orders split 10/10 automatically without print confirmation; retry retains assignment", () => {
  let s = fixture();
  s = run(s, "assign-package", input(s));
  for (const p of ["Sample Packer A", "Sample Packer B"])
    assert.equal(s.orders.filter((o) => o.assignedPacker === p).length, 10);
  assert.ok(s.orders.every((o) => !o.printed));
  const events = s.events.length;
  const again = run(s, "assign-package", input(s));
  assert.deepEqual(again.orders, s.orders);
  assert.equal(again.events.length, events);
  s = run(s, "issue-orders", {
    ids: s.orders.map((o) => o.id),
    cartonId: "c-cav",
    qty: 80,
    pic: "Supervisor",
  });
  assert.equal(orderIssued(s, s.orders[0]), 4);
  assert.throws(
    () =>
      run(
        s,
        "pack",
        {
          id: s.orders[0].id,
          actual: 4,
          pic: "Sample Packer B",
          labelPic: "Sample Packer B",
        },
        "packer",
      ),
    /assigned packer/,
  );
  s = run(
    s,
    "pack",
    {
      id: s.orders[0].id,
      actual: 4,
      pic: "Sample Packer A",
      labelPic: "Sample Packer A",
    },
    "packer",
  );
  assert.equal(dailyTally(s, date)[0].packed, 4);
});
test("reassignment requires reason, keeps completed parcels and does not exceed remaining demand", () => {
  let s = run(fixture(), "assign-package", input(fixture()));
  s.orders[0].actual = 4;
  s.orders[0].packer = "Sample Packer A";
  assert.throws(() => run(s, "assign-package", input(s, 10, 10)), /exceed/);
  assert.throws(() => run(s, "assign-package", input(s, 5, 14)), /reason/);
  s = run(s, "assign-package", {
    ...input(s, 5, 14),
    reason: "Second packer taking over",
  });
  assert.equal(s.orders[0].assignedPacker, "Sample Packer A");
  assert.equal(
    s.orders.filter(
      (o) => o.actual === null && o.assignedPacker === "Sample Packer A",
    ).length,
    5,
  );
  assert.equal(
    s.orders.filter((o) => o.assignedPacker === "Sample Packer B").length,
    14,
  );
});
test("package allocations enforce role, valid staff, nonnegative integers and fresh count", () => {
  const s = fixture();
  assert.throws(
    () => run(s, "assign-package", input(s), "packer"),
    /supervisor/,
  );
  assert.throws(
    () => run(s, "assign-package", input(s, -1, 10)),
    /whole number/,
  );
  assert.throws(
    () => run(s, "assign-package", input(s, 1.5, 10)),
    /whole number/,
  );
  assert.throws(
    () =>
      run(s, "assign-package", {
        ...input(s),
        packers: ["Sample Packer A", "Sample Packer A"],
      }),
    /distinct/,
  );
  assert.throws(
    () => run(s, "assign-package", { ...input(s), packers: ["Unknown"] }),
    /packer profile/,
  );
  s.orders.push({ ...s.orders[0], id: "late", awb: "TEST-LATE" });
  assert.throws(
    () => run(s, "assign-package", input(s)),
    /current supervisor count/,
  );
});
test("groups keep brands and parcel sizes separate even when package names match", () => {
  const s = fixture();
  s.orders.push({
    ...s.orders[0],
    id: "box",
    awb: "TEST-BOX",
    product: "ady",
    expected: 1,
  });
  s.orders.push({ ...s.orders[0], id: "size", awb: "TEST-SIZE", expected: 2 });
  s.orders.push({
    ...s.orders[0],
    id: "mixed",
    awb: "TEST-MIXED",
    lines: [
      { product: "ady", expected: 1, originalExpected: 1, actual: null },
      { product: "cav", expected: 1, originalExpected: 1, actual: null },
    ],
  });
  const groups = packageGroups(s.orders);
  assert.equal(groups.length, 3);
  assert.equal(
    groups.reduce((n, g) => n + g.orders.length, 0),
    22,
  );
  const assigned = run(s, "sort-count", {
    date,
    product: "cav",
    counted: 83,
    pic: "Supervisor",
    note: "New records",
  });
  const result = run(assigned, "assign-package", input(assigned, 0, 1));
  assert.equal(
    result.orders.find((o) => o.id === "mixed").assignedPacker,
    undefined,
  );
});
test("legacy mixed record splits only with real distinct AWBs and preserves total demand and provenance", () => {
  const s = fixture();
  const o = s.orders[0];
  o.lines = [
    { product: "cav", expected: 1, originalExpected: 1, actual: null },
    { product: "ady", expected: 1, originalExpected: 1, actual: null },
  ];
  o.expected = 2;
  const input = {
    id: o.id,
    awb_cav: "REAL-CAV-001",
    awb_ady: "REAL-ADY-001",
    package_cav: "Single",
    package_ady: "Single",
    pic: "Supervisor",
    reason: "Separate brand parcels",
  };
  assert.throws(
    () => run(s, "split-order", { ...input, awb_ady: input.awb_cav }),
    /distinct actual AWB/,
  );
  const result = run(s, "split-order", input);
  assert.equal(result.orders.length, 21);
  assert.equal(result.orders.find((x) => x.id === o.id).awb, "REAL-CAV-001");
  assert.equal(
    result.orders.find((x) => x.awb === "REAL-ADY-001").product,
    "ady",
  );
  assert.equal(dailyTally(result, date)[0].expected, 77);
  assert.equal(
    dailyTally(result, date).find((t) => t.product === "ady").expected,
    1,
  );
  assert.ok(
    result.events.some(
      (e) =>
        e.action === "Brands separated into parcels" &&
        e.detail.includes(o.awb),
    ),
  );
  s.issues.push({
    id: "existing",
    orderId: o.id,
    cartonId: "c-cav",
    qty: 1,
    pic: "Supervisor",
    at: new Date().toISOString(),
  });
  assert.throws(() => run(s, "split-order", input), /historical record/);
});
test("direct legacy commands cannot assign, issue or pack a combined brand parcel", () => {
  const s = fixture(),
    o = s.orders[0];
  o.lines = [
    { product: "cav", expected: 1, originalExpected: 1, actual: null },
    { product: "ady", expected: 1, originalExpected: 1, actual: null },
  ];
  o.assignedPacker = "Sample Packer A";
  assert.throws(
    () =>
      run(s, "assign-orders", {
        ids: [o.id],
        packer: "Sample Packer A",
        pic: "Supervisor",
      }),
    /Separate brands/,
  );
  assert.throws(
    () =>
      run(s, "issue", {
        orderId: o.id,
        cartonId: "c-cav",
        qty: 1,
        pic: "Supervisor",
      }),
    /Separate brands/,
  );
  assert.throws(
    () =>
      run(
        s,
        "pack",
        {
          id: o.id,
          pic: "Sample Packer A",
          actual_cav: 1,
          actual_ady: 1,
          labelPic: "Sample Packer A",
        },
        "packer",
      ),
    /Separate brands/,
  );
});
