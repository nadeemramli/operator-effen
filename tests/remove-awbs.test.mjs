// Removing a mistaken AWB or a whole PDF upload: allowed only while nothing has moved for
// the AWBs, always with a reason, and never taking stock movements or audit entries along.
import test from "node:test";
import assert from "node:assert/strict";
import { parsePages } from "../apps/web/src/lib/awb-import.ts";
import {
  applyCommand,
  createDraft,
  orderHasActivity,
} from "../apps/web/src/lib/draft.ts";
import { outOfScopeKeys } from "../apps/web/src/lib/access.ts";

const member = (role) => ({
  kind: "member",
  role,
  name: "Synthetic " + role,
  userId: "u-" + role,
  siteId: "site-a",
});
const as = (s, role, type, input) =>
  applyCommand(s, { type, role, input, actor: member(role) });
const file = {
  id: "b".repeat(64),
  name: "synthetic.pdf",
  path: "site-a/" + "b".repeat(64) + ".pdf",
  pages: 3,
  size: 1000,
};
const label = (awb, ref, n) => ({
  file: file.id,
  page: n,
  text: `Ninja Van\n${awb}\nOrder: #${ref}\nProducts:\n1x Cavernosil [cave04]`,
  method: "text",
});
const upload = (awbs) => ({
  id: crypto.randomUUID(),
  name: "Synthetic upload",
  date: "2026-10-06",
  files: [file],
  rows: parsePages(
    awbs.map((awb, i) => label(awb, "ORD-" + i, i + 1)),
    "Luxana",
    "TEST STORE",
  ),
  createdAt: "",
  updatedAt: "",
});
/** A fresh workspace with one released upload of the given AWBs. */
function released(awbs = ["NVMYRM0000001", "NVMYRM0000002", "NVMYRM0000003"]) {
  const b = upload(awbs);
  let s = as(createDraft(), "admin", "import-save", { batch: b });
  s = as(s, "admin", "import-release", { id: b.id });
  return { s, b };
}
const fromUpload = (s, b) => s.orders.filter((o) => o.importId === b.id);

test("deleting an upload removes it and every AWB it released, in one audit entry", () => {
  const { s, b } = released();
  const before = s.orders.length;
  assert.equal(fromUpload(s, b).length, 3);
  const next = as(s, "admin", "import-delete", { id: b.id, reason: "Uploaded the wrong day's labels" });
  assert.equal(next.orders.length, before - 3);
  assert.equal(fromUpload(next, b).length, 0);
  assert.ok(!next.awbImports.some((x) => x.id === b.id));
  assert.equal(next.events[0].action, "Upload batch deleted");
  assert.equal(next.events[0].entity, b.id);
  assert.match(next.events[0].detail, /3 AWBs removed: /);
  for (const awb of ["NVMYRM0000001", "NVMYRM0000002", "NVMYRM0000003"])
    assert.match(next.events[0].detail, new RegExp(awb));
  assert.match(next.events[0].detail, /wrong day's labels/);
  assert.equal(next.events[0].recorder.userId, "u-admin");
  // Earlier audit entries and stock records are untouched.
  assert.deepEqual(next.events.slice(1), s.events);
  assert.deepEqual(next.issues, s.issues);
  assert.deepEqual(next.cartons, s.cartons);
  assert.deepEqual(outOfScopeKeys("import-delete", s, next), []);
});

test("a draft upload that released nothing can be deleted too", () => {
  const b = upload(["NVMYRM0000009"]);
  const s = as(createDraft(), "admin", "import-save", { batch: b });
  const next = as(s, "admin", "import-delete", { id: b.id, reason: "Duplicate upload" });
  assert.ok(!next.awbImports.some((x) => x.id === b.id));
  assert.equal(next.orders.length, s.orders.length);
  assert.match(next.events[0].detail, /0 AWBs removed · Duplicate upload/);
});

test("an upload with any issued, packed or handed-over AWB cannot be deleted", () => {
  const { s, b } = released();
  const [first] = fromUpload(s, b);
  let moved = as(s, "outbound", "issue", { cartonId: "c-cav", orderId: first.id, qty: 1, pic: "S" });
  assert.ok(orderHasActivity(moved, moved.orders.find((o) => o.id === first.id)));
  assert.throws(
    () => as(moved, "admin", "import-delete", { id: b.id, reason: "Mistake" }),
    new RegExp(`1 of the 3 AWBs .*${first.awb}.*stay for traceability`),
  );
  // The other two can still go one by one.
  const [, second] = fromUpload(moved, b);
  moved = as(moved, "admin", "remove-order", { id: second.id, reason: "Cancelled" });
  assert.equal(fromUpload(moved, b).length, 2);
});

test("deleting needs the office admin role, a reason and an existing upload", () => {
  const { s, b } = released();
  assert.throws(() => as(s, "outbound", "import-delete", { id: b.id, reason: "x" }), /does not permit/);
  assert.throws(() => as(s, "admin", "import-delete", { id: b.id }), /reason/);
  assert.throws(() => as(s, "admin", "import-delete", { id: crypto.randomUUID(), reason: "x" }), /could not be found/);
});

test("removing one AWB takes it off the list and marks its PDF label excluded", () => {
  const { s, b } = released();
  const [, target] = fromUpload(s, b);
  const next = as(s, "outbound", "remove-order", { id: target.id, reason: "Customer cancelled" });
  assert.ok(!next.orders.some((o) => o.id === target.id));
  assert.equal(fromUpload(next, b).length, 2);
  const batch = next.awbImports.find((x) => x.id === b.id);
  const row = batch.rows.find((r) => r.id === target.importRowId);
  assert.equal(row.excluded, true);
  assert.equal(row.releasedOrderId, undefined);
  assert.match(row.reviewNote, /Removed: Customer cancelled/);
  assert.equal(batch.confirmedAt, s.awbImports.find((x) => x.id === b.id).confirmedAt);
  assert.equal(next.events[0].action, "AWB removed");
  assert.equal(next.events[0].entity, target.id);
  assert.match(next.events[0].detail, new RegExp(target.awb + ".*from Synthetic upload.*Customer cancelled"));
  assert.deepEqual(outOfScopeKeys("remove-order", s, next), []);
});

test("a removed label can be uploaded again without counting as a duplicate", () => {
  const { s, b } = released(["NVMYRM0000011"]);
  const [target] = fromUpload(s, b);
  const cleared = as(s, "admin", "remove-order", { id: target.id, reason: "Wrong store" });
  const again = upload(["NVMYRM0000011"]);
  let next = as(cleared, "admin", "import-save", { batch: again });
  next = as(next, "admin", "import-release", { id: again.id });
  assert.equal(next.orders.filter((o) => o.awb === "NVMYRM0000011").length, 1);
  assert.equal(next.orders.find((o) => o.awb === "NVMYRM0000011").importId, again.id);
});

test("a manually entered AWB is removed with its reason and no upload change", () => {
  const s = as(createDraft(), "admin", "order", {
    awb: "MAN-REMOVE-1", product: "cav", channel: "TikTok", package: "P", expected: 1, date: "2026-10-06",
  });
  const o = s.orders[0];
  const next = as(s, "admin", "remove-order", { id: o.id, reason: "Typed twice" });
  assert.ok(!next.orders.some((x) => x.id === o.id));
  assert.deepEqual(next.awbImports, s.awbImports);
  assert.match(next.events[0].detail, /MAN-REMOVE-1 .* Typed twice/);
  assert.deepEqual(outOfScopeKeys("remove-order", s, next), []);
});

test("an AWB with stock, packing or handover records cannot be removed", () => {
  const { s, b } = released();
  const [first, second] = fromUpload(s, b);
  const issued = as(s, "outbound", "issue", { cartonId: "c-cav", orderId: first.id, qty: 1, pic: "S" });
  assert.throws(
    () => as(issued, "outbound", "remove-order", { id: first.id, reason: "x" }),
    /stock, packing or handover records/,
  );
  const counted = as(s, "outbound", "sort-count", { date: "2026-10-06", product: "cav", counted: 3, pic: "S", note: "Synthetic count" });
  let packed = as(counted, "outbound", "assign-orders", { ids: [second.id], packer: "Sample Packer A", pic: "S" });
  packed = as(packed, "outbound", "pack", { id: second.id, actual_cav: 4, pic: "Sample Packer A", labelPic: "X" });
  assert.throws(
    () => as(packed, "admin", "remove-order", { id: second.id, reason: "x" }),
    /stock, packing or handover records/,
  );
  // Assigned but untouched parcels can still be removed; the entry says who held it.
  const assigned = as(counted, "outbound", "assign-orders", { ids: [second.id], packer: "Sample Packer A", pic: "S" });
  const next = as(assigned, "outbound", "remove-order", { id: second.id, reason: "Cancelled" });
  assert.match(next.events[0].detail, /was assigned to Sample Packer A/);
});

test("removing needs admin or stock-out, a reason and an existing AWB", () => {
  const { s, b } = released();
  const [o] = fromUpload(s, b);
  assert.throws(() => as(s, "production", "remove-order", { id: o.id, reason: "x" }), /does not permit/);
  assert.throws(() => as(s, "management", "remove-order", { id: o.id, reason: "x" }), /does not permit/);
  assert.throws(() => as(s, "admin", "remove-order", { id: o.id }), /reason/);
  assert.throws(() => as(s, "admin", "remove-order", { id: crypto.randomUUID(), reason: "x" }), /could not be found/);
});
