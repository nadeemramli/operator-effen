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
        "outbound",
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
    "outbound",
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
  assert.equal(groups.length, 4);
  assert.equal(
    groups.reduce((n, g) => n + g.orders.length, 0),
    23,
  );
  // The parcel with two brands forms its own mixed group, listed last.
  const mixed = groups.at(-1);
  assert.ok(mixed.mixed && groups.slice(0, -1).every((g) => !g.mixed));
  assert.deepEqual(mixed.products, ["cav", "ady"]);
  assert.deepEqual(mixed.contents, [
    { product: "cav", expected: 1 },
    { product: "ady", expected: 1 },
  ]);
  assert.deepEqual(
    mixed.orders.map((o) => o.id),
    ["mixed"],
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
function mixedFixture() {
  const s = fixture();
  for (const o of s.orders.slice(0, 2))
    o.lines = [
      { product: "cav", expected: 4, originalExpected: 4, actual: null },
      { product: "syn", expected: 6, originalExpected: 6, actual: null },
    ];
  for (const o of s.orders.slice(0, 2)) {
    o.package = "1 × cave04 (4) · 1 × syn06 (6)";
    o.expected = 10;
    o.originalExpected = 10;
  }
  return s;
}
const mixedInput = (s, a = 1, b = 1) => ({
  date,
  group: packageGroups(s.orders).find((g) => g.mixed).key,
  packers: ["Sample Packer A", "Sample Packer B"],
  allocation_0: a,
  allocation_1: b,
  pic: "Supervisor",
});
test("a mixed package group is assigned once every product in it has a current count", () => {
  let s = mixedFixture();
  const group = packageGroups(s.orders).find((g) => g.mixed);
  assert.equal(group.orders.length, 2);
  assert.equal(group.perParcel, 10);
  // Cavernosil was counted; Synovil, the other product in the parcel, was not.
  assert.throws(
    () => run(s, "assign-package", mixedInput(s)),
    /supervisor count for Synovil/,
  );
  s = run(s, "sort-count", {
    date,
    product: "syn",
    counted: 12,
    pic: "Supervisor",
  });
  s = run(s, "assign-package", mixedInput(s));
  const parcels = s.orders.filter((o) => o.lines);
  assert.deepEqual(parcels.map((o) => o.assignedPacker).sort(), [
    "Sample Packer A",
    "Sample Packer B",
  ]);
  // The single-product Cavernosil group is untouched by the mixed assignment.
  assert.ok(s.orders.filter((o) => !o.lines).every((o) => !o.assignedPacker));
});
test("a mixed parcel takes stock per product and records each product's packed count", () => {
  let s = mixedFixture();
  for (const [product, counted] of [
    ["cav", 80],
    ["syn", 12],
  ])
    s = run(s, "sort-count", {
      date,
      product,
      counted,
      pic: "Supervisor",
      note: "Mixed parcels added",
    });
  s = run(s, "assign-package", mixedInput(s));
  const o = s.orders.find((x) => x.lines);
  const cav = s.cartons.find((c) => c.id === "c-cav");
  s = run(s, "issue-orders", {
    ids: [o.id],
    cartonId: cav.id,
    qty: 4,
    pic: "Supervisor",
  });
  let parcel = s.orders.find((x) => x.id === o.id);
  assert.equal(orderIssued(s, parcel, "cav"), 4);
  assert.equal(orderIssued(s, parcel, "syn"), 0);
  // Only the Cavernosil share of the parcel can be taken from a Cavernosil carton.
  assert.throws(
    () =>
      run(s, "issue-orders", {
        ids: [o.id],
        cartonId: cav.id,
        qty: 1,
        pic: "Supervisor",
      }),
    /remaining demand/,
  );
  s = run(s, "pack", {
    id: o.id,
    pic: parcel.assignedPacker,
    actual_cav: 4,
    actual_syn: 5,
    labelPic: parcel.assignedPacker,
  });
  parcel = s.orders.find((x) => x.id === o.id);
  assert.deepEqual(
    parcel.lines.map((l) => [l.product, l.actual]),
    [
      ["cav", 4],
      ["syn", 5],
    ],
  );
  assert.equal(parcel.actual, 9);
  const tally = dailyTally(s, date);
  assert.equal(tally.find((t) => t.product === "syn").mismatched, 1);
  assert.equal(tally.find((t) => t.product === "cav").mismatched, 0);
  assert.match(s.events[0].detail, /Cavernosil: 4 .*Synovil: 5 /);
});
test("couriers form separate package groups; assigning the Ninja Van group leaves SPX parcels alone", () => {
  let s = fixture();
  s.orders.forEach((o, i) =>
    i < 12
      ? Object.assign(o, { courier: "Ninja Van", channel: "Luxana" })
      : Object.assign(o, { courier: "SPX", channel: i % 2 ? "Shopee" : "TikTok" }),
  );
  const groups = packageGroups(s.orders);
  assert.deepEqual(
    groups.map((g) => [g.package, g.perParcel, g.courier, g.orders.length]),
    [
      ["Package A", 4, "Ninja Van", 12],
      ["Package A", 4, "SPX", 8],
    ],
  );
  assert.deepEqual(groups[0].channels, ["Luxana"]);
  assert.deepEqual(groups[1].channels, ["Shopee", "TikTok"]);
  assert.notEqual(groups[0].key, groups[1].key);
  const ninja = {
    date,
    group: groups[0].key,
    packers: ["Sample Packer A", "Sample Packer B"],
    allocation_0: 6,
    allocation_1: 6,
    pic: "Supervisor",
  };
  assert.throws(
    () => run(s, "assign-package", { ...ninja, allocation_1: 7 }),
    /exceed/,
  );
  s = run(s, "assign-package", ninja);
  for (const o of s.orders)
    if (o.courier === "Ninja Van") assert.ok(o.assignedPacker);
    else assert.equal(o.assignedPacker, undefined);
  assert.ok(
    s.events.some(
      (e) =>
        e.action === "Package packer assignment" &&
        e.detail.includes("Ninja Van"),
    ),
  );
  // The SPX lane goes to its own team without disturbing the Ninja Van assignments.
  const before = s.orders
    .filter((o) => o.courier === "Ninja Van")
    .map((o) => o.assignedPacker);
  s = run(s, "assign-package", {
    ...ninja,
    group: packageGroups(s.orders)[1].key,
    packers: ["Sample Packer B"],
    allocation_0: 8,
  });
  assert.deepEqual(
    s.orders.filter((o) => o.courier === "Ninja Van").map((o) => o.assignedPacker),
    before,
  );
  assert.ok(
    s.orders
      .filter((o) => o.courier === "SPX")
      .every((o) => o.assignedPacker === "Sample Packer B"),
  );
});
test("orders without a recorded courier share one group, listed after recorded couriers", () => {
  let s = fixture();
  s.orders.forEach((o, i) => {
    if (i < 5) o.courier = "Other";
    else if (i < 10) o.courier = "J&T";
    else if (i < 14) delete o.courier;
    else if (i < 17) o.courier = "";
    else o.courier = "  ";
  });
  const groups = packageGroups(s.orders);
  assert.deepEqual(
    groups.map((g) => [g.courier, g.orders.length]),
    [
      ["J&T", 5],
      ["Other", 5],
      ["", 10],
    ],
  );
  // Assignment by key still works for the fallback group and touches only its parcels.
  s = run(s, "assign-package", {
    date,
    group: groups[2].key,
    packers: ["Sample Packer A"],
    allocation_0: 10,
    pic: "Supervisor",
  });
  for (const o of s.orders)
    assert.equal(
      o.assignedPacker,
      (o.courier ?? "").trim() ? undefined : "Sample Packer A",
    );
});
