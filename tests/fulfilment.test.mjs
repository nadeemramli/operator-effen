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
        "outbound",
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
    "outbound",
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
    "outbound",
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
test("role, count and assignment gates remain enforced without a printing gate", () => {
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
        "outbound",
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
  s = run(s, "sort-count", { date, product: "cav", counted: 100, pic: "X" });
  s = run(s, "assign-orders", { ids, packer: "Sample Packer A", pic: "X" });
  assert.equal(s.orders[0].printed, false);
  assert.equal(s.orders[0].assignedPacker, "Sample Packer A");
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
  s = run(s, "sort-count", {
    date,
    product: "cav",
    counted: 100,
    pic: "staff-supervisor-1",
  });
  const ids = [s.orders[0].id];
  assert.throws(
    () =>
      run(s, "assign-orders", {
        ids,
        packer: "staff-supervisor-1",
        pic: "staff-supervisor-1",
      }),
    /packer profile/,
  );
  s = run(s, "assign-orders", {
    ids,
    packer: "staff-packer-1",
    pic: "staff-supervisor-1",
  });
  assert.throws(
    () =>
      run(
        s,
        "pack",
        {
          id: ids[0],
          actual: 50,
          pic: "Same display name",
          labelPic: "staff-packer-1",
        },
        "outbound",
      ),
    /packer's profile/,
  );
  s = run(
    s,
    "pack",
    {
      id: ids[0],
      actual: 50,
      pic: "staff-packer-1",
      labelPic: "staff-packer-1",
    },
    "outbound",
  );
  assert.equal(s.orders[0].packer, "staff-packer-1");
});

// WP5: the daily tally's inventory block, derived from stock movements by Malaysia day.
test("daily inventory assigns movements to Malaysia days and closes on the rack balance", async () => {
  const { dailyInventory, available, applyCommand, createDraft, today } = await import(
    "../apps/web/src/lib/draft.ts"
  );
  let s = createDraft();
  const cav = s.cartons.find((c) => c.id === "c-cav");
  // Put every existing cav movement on a known earlier day.
  cav.at = "2026-10-01T02:00:00.000Z";
  for (const i of s.issues) if (i.cartonId === cav.id) i.at = "2026-10-01T03:00:00.000Z";
  const issuedBefore = s.issues.filter((i) => i.cartonId === cav.id).reduce((n, i) => n + i.qty, 0);
  // 23:59 MYT on 2 Oct is still 2 Oct; 00:00 MYT on 3 Oct is the next day.
  s.issues.push(
    { id: "late", cartonId: cav.id, orderId: "x", qty: 5, pic: "P", at: "2026-10-02T15:59:00.000Z" },
    { id: "midnight", cartonId: cav.id, orderId: "x", qty: 7, pic: "P", at: "2026-10-02T16:00:00.000Z" },
  );
  s.returns = [{ id: "r1", cartonId: cav.id, qty: 3, reason: "Courier", pic: "R", at: "2026-10-02T04:00:00.000Z" }];
  s.adjustments.push({ id: "a1", cartonId: cav.id, delta: -1, reason: "Broken", at: "2026-10-03T01:00:00.000Z" });
  const day = (date) => dailyInventory(s, date).find((r) => r.product === "cav");
  const d1 = day("2026-10-01");
  assert.deepEqual(
    [d1.opening, d1.received, d1.issued, d1.returned, d1.adjusted, d1.closing],
    [0, 120, issuedBefore, 0, 0, 120 - issuedBefore],
  );
  const d2 = day("2026-10-02");
  assert.equal(d2.opening, d1.closing);
  assert.equal(d2.issued, 5);
  assert.equal(d2.returned, 3);
  assert.equal(d2.closing, d1.closing - 5 + 3);
  const d3 = day("2026-10-03");
  assert.equal(d3.opening, d2.closing);
  assert.equal(d3.issued, 7);
  assert.equal(d3.adjusted, -1);
  // Today's closing is what is on the racks now.
  s = applyCommand(s, {
    type: "return",
    role: "intake",
    input: { cartonId: cav.id, qty: 2, reason: "Courier", pic: "R" },
  });
  for (const r of dailyInventory(s, today())) {
    const rack = s.cartons
      .filter((c) => c.product === r.product && c.unit === "bottle")
      .reduce((n, c) => n + available(s, c), 0);
    assert.equal(r.closing, rack, r.product);
  }
  assert.equal(dailyInventory(s, today()).find((r) => r.product === "cav").returned, 2);
});
