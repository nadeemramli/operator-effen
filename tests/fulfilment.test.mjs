import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCommand,
  createDraft,
  dailyTally,
  orderIssued,
  available,
} from "../apps/web/src/lib/draft.ts";
const run = (s, type, input, role = "outbound") =>
  applyCommand(s, { type, input, role });
const date = "2026-09-24";
function fixture() {
  let s = createDraft();
  s.orders = [];
  s.issues = [];
  s.sortCounts = [];
  for (const awb of ["TEST-A", "TEST-B"]) {
    s = run(s, "order", {
      awb,
      product: "cav",
      channel: "TikTok",
      package: "PK50",
      expected: 50,
      date,
    });
    s = run(s, "review-order", { id: s.orders[0].id, pic: "Reviewer" });
  }
  s = run(s, "print-orders", {
    ids: s.orders.map((o) => o.id),
    pic: "Supervisor",
  });
  return s;
}
test("100 required, 98 supervisor count and 98 packed remain independent with an AWB-level mismatch", () => {
  let s = fixture();
  const ids = s.orders.map((o) => o.id);
  assert.throws(
    () =>
      run(s, "sort-count", {
        date,
        product: "cav",
        counted: 98,
        pic: "Supervisor",
      }),
    /note/,
  );
  s = run(s, "sort-count", {
    date,
    product: "cav",
    counted: 98,
    pic: "Supervisor",
    note: "Counted from sorted labels",
  });
  s = run(s, "issue-orders", {
    ids,
    cartonId: "c-cav",
    qty: 98,
    pic: "Supervisor",
  });
  s = run(s, "assign-orders", {
    ids: [ids[0]],
    packer: "Sample Packer A",
    pic: "Supervisor",
  });
  s = run(s, "assign-orders", {
    ids: [ids[1]],
    packer: "Sample Packer B",
    pic: "Supervisor",
  });
  assert.throws(
    () =>
      run(
        s,
        "pack",
        { id: ids[0], pic: "Sample Packer B", actual: 50, labelPic: "X" },
        "packer",
      ),
    /assigned packer/,
  );
  s = run(
    s,
    "pack",
    {
      id: ids[0],
      pic: "Sample Packer A",
      actual: 50,
      labelPic: "Sample Packer A",
    },
    "packer",
  );
  s = run(
    s,
    "pack",
    {
      id: ids[1],
      pic: "Sample Packer B",
      actual: 48,
      labelPic: "Sample Packer B",
    },
    "packer",
  );
  const t = dailyTally(s, date).find((t) => t.product === "cav");
  assert.deepEqual(
    [
      t.expected,
      t.count.counted,
      t.issued,
      t.packed,
      t.missing,
      t.mismatched,
      t.stale,
    ],
    [100, 98, 98, 98, 0, 1, false],
  );
  assert.equal(orderIssued(s, s.orders[0], "cav"), 50);
  assert.equal(orderIssued(s, s.orders[1], "cav"), 48);
  assert.equal(
    available(
      s,
      s.cartons.find((c) => c.id === "c-cav"),
    ),
    22,
  );
  assert.equal(s.orders[1].originalExpected, 50);
});
test("late reviewed orders invalidate the count; recount history and missing declarations survive", () => {
  let s = fixture();
  s = run(s, "sort-count", {
    date,
    product: "cav",
    counted: 100,
    pic: "Supervisor",
  });
  s = run(s, "order", {
    awb: "TEST-LATE",
    product: "cav",
    channel: "TikTok",
    package: "PK1",
    expected: 1,
    date,
  });
  assert.equal(dailyTally(s, date)[0].stale, false);
  assert.equal(dailyTally(s, date)[0].expected, 100);
  s = run(s, "review-order", { id: s.orders[0].id, pic: "Reviewer" });
  assert.equal(dailyTally(s, date)[0].stale, true);
  s = run(s, "print-orders", { ids: [s.orders[0].id], pic: "Supervisor" });
  assert.throws(
    () =>
      run(s, "assign-orders", {
        ids: [s.orders[0].id],
        packer: "Sample Packer A",
        pic: "Supervisor",
      }),
    /current supervisor count/,
  );
  s = run(s, "sort-count", {
    date,
    product: "cav",
    counted: 101,
    pic: "Supervisor",
    note: "One late order",
  });
  assert.equal(s.sortCounts.length, 2);
  assert.equal(s.sortCounts[1].expected, 100);
  assert.equal(dailyTally(s, date)[0].stale, false);
  assert.equal(dailyTally(s, date)[0].missing, 3);
});
test("bulk issue is atomic, conserves stock and cannot over-allocate selected demand", () => {
  let s = fixture();
  const ids = s.orders.map((o) => o.id);
  s = run(s, "sort-count", {
    date,
    product: "cav",
    counted: 100,
    pic: "Supervisor",
  });
  assert.throws(
    () =>
      run(s, "issue-orders", {
        ids,
        cartonId: "c-cav",
        qty: 101,
        pic: "Supervisor",
      }),
    /remaining demand/,
  );
  assert.throws(
    () =>
      run(s, "issue-orders", {
        ids: [ids[0], "missing"],
        cartonId: "c-cav",
        qty: 1,
        pic: "Supervisor",
      }),
    /Select reviewed/,
  );
  assert.throws(
    () =>
      run(s, "issue-orders", {
        ids: [ids[0], ids[0]],
        cartonId: "c-cav",
        qty: 1,
        pic: "Supervisor",
      }),
    /distinct/,
  );
  assert.equal(s.issues.length, 0);
  s = run(s, "issue-orders", {
    ids,
    cartonId: "c-cav",
    qty: 100,
    pic: "Supervisor",
  });
  assert.throws(
    () =>
      run(s, "issue-orders", {
        ids,
        cartonId: "c-cav",
        qty: 1,
        pic: "Supervisor",
      }),
    /remaining demand/,
  );
});
test("manual entry normalizes duplicate scans and allows pending review edits without creating stock", () => {
  let s = fixture();
  s = run(s, "order", {
    awb: " test- new ",
    product: "ady",
    channel: "TikTok",
    package: "BOX2",
    expected: 2,
    date,
  });
  const id = s.orders[0].id;
  assert.equal(s.orders[0].awb, "TEST-NEW");
  assert.equal(
    dailyTally(s, date).find((t) => t.product === "ady").expected,
    0,
  );
  assert.throws(
    () =>
      run(s, "order", {
        awb: "TEST-NEW",
        product: "ady",
        channel: "TikTok",
        package: "BOX2",
        expected: 2,
        date,
      }),
    /already/,
  );
  assert.throws(
    () => run(s, "print-orders", { ids: [id], pic: "X" }),
    /reviewed/,
  );
  s = run(
    s,
    "edit-order",
    {
      id,
      awb: "TEST-NEW",
      product: "ady",
      channel: "TikTok",
      package: "BOX3",
      expected: 3,
      date,
    },
    "admin",
  );
  s = run(s, "review-order", { id, pic: "Reviewer" }, "admin");
  assert.equal(
    dailyTally(s, date).find((t) => t.product === "ady").expected,
    3,
  );
  assert.equal(s.issues.length, 0);
  assert.throws(
    () => run(s, "edit-order", { id }, "admin"),
    /supervisor correction/,
  );
});
test("carry-over retains issued stock and assignment; historical checkpoint is flagged", () => {
  let s = fixture();
  const ids = s.orders.map((o) => o.id);
  s = run(s, "sort-count", {
    date,
    product: "cav",
    counted: 100,
    pic: "Supervisor",
  });
  s = run(s, "issue-orders", {
    ids: [ids[0]],
    cartonId: "c-cav",
    qty: 50,
    pic: "Supervisor",
  });
  s = run(s, "assign-orders", {
    ids: [ids[0]],
    packer: "Sample Packer A",
    pic: "Supervisor",
  });
  s = run(s, "move-orders", {
    ids: [ids[0]],
    date: "2026-09-25",
    pic: "Supervisor",
    reason: "Carry over",
  });
  assert.equal(dailyTally(s, date)[0].expected, 50);
  assert.equal(dailyTally(s, date)[0].stale, true);
  assert.equal(dailyTally(s, "2026-09-25")[0].issued, 50);
  assert.equal(s.orders[0].assignedPacker, "Sample Packer A");
  assert.equal(s.issues.length, 1);
});
test("role, print, count and assignment gates cannot be skipped", () => {
  let s = fixture();
  const ids = s.orders.map((o) => o.id);
  assert.throws(
    () => run(s, "assign-orders", { ids, packer: "Sample Packer A", pic: "X" }),
    /current supervisor count/,
  );
  assert.throws(
    () =>
      run(
        s,
        "pack",
        { id: ids[0], pic: "Sample Packer A", actual: 50, labelPic: "X" },
        "packer",
      ),
    /assigned packer/,
  );
  for (const role of ["admin", "packer", "production", "intake", "management"])
    assert.throws(
      () =>
        run(
          s,
          "sort-count",
          { date, product: "cav", counted: 100, pic: "X" },
          role,
        ),
      /supervisor/,
    );
  s.orders[0].printed = false;
  assert.throws(
    () =>
      run(s, "sort-count", { date, product: "cav", counted: 100, pic: "X" }),
    /printed labels/,
  );
});
test("opposite AWB variances do not disappear when total packed matches demand", () => {
  const s = fixture();
  s.orders[0].actual = 49;
  s.orders[1].actual = 51;
  const t = dailyTally(s, date)[0];
  assert.equal(t.packed, t.expected);
  assert.equal(t.mismatched, 2);
});

test("future staff assignments use stable profile IDs and require a packer role", () => {
  let s = fixture();
  s.staffProfiles = [
    { id: "staff-packer-1", name: "Same display name", role: "packer" },
    { id: "staff-supervisor-1", name: "Same display name", role: "outbound" },
  ];
  s = run(s, "sort-count", { date, product: "cav", counted: 100, pic: "staff-supervisor-1" });
  const ids = [s.orders[0].id];
  assert.throws(() => run(s, "assign-orders", { ids, packer: "staff-supervisor-1", pic: "staff-supervisor-1" }), /packer profile/);
  s = run(s, "assign-orders", { ids, packer: "staff-packer-1", pic: "staff-supervisor-1" });
  assert.throws(() => run(s, "pack", { id: ids[0], actual: 50, pic: "Same display name", labelPic: "staff-packer-1" }, "packer"), /assigned packer/);
  s = run(s, "pack", { id: ids[0], actual: 50, pic: "staff-packer-1", labelPic: "staff-packer-1" }, "packer");
  assert.equal(s.orders[0].packer, "staff-packer-1");
});
