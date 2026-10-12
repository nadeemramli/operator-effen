// Order records (order volume plan WP C, PR C2; 20261014090000_operator_order_records.sql):
// the slice spec and loader, the change sets operator_commit_records accepts (one case per
// command family, shaped like the C1 database tests' change sets), the AWB reuse rule, the
// date and product-line fixes, and the records signature.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import {
  applyCommand,
  available,
  ConflictError,
  createDraft,
  dailyInventory,
  demandFingerprint,
  demandKey,
  tallyGate,
} from "../apps/web/src/lib/draft.ts";
import {
  awbReuseAllowed,
  importEffects,
  parsePages,
  recordedAwb,
  rowStatus,
} from "../apps/web/src/lib/awb-import.ts";
import { attestRecords, effectiveCapabilities } from "../apps/web/src/lib/access.ts";
import {
  buildSlice,
  demandText,
  documentView,
  EMPTY_DEMAND_HASH,
  loadSlice,
  orderFromRow,
  orderToRow,
  sliceDelta,
  sliceSpec,
  stripTransient,
} from "../apps/web/src/lib/order-records.ts";
import { actor, dayDemand, documentOf, memorySource, sha } from "./order-slices.mjs";

const D = "2026-10-20";
const ALI = "20000000-0000-4000-8000-0000000000a1";
const BEA = "20000000-0000-4000-8000-0000000000a2";
const [O1, O2, O3, O4] = [1, 2, 3, 4].map((n) => `40000000-0000-4000-8000-0000000000d${n}`);
const order = (id, awb, extra = {}) => ({
  id, awb, channel: "Luxana", product: "cav", package: "P", expected: 1, originalExpected: 1, actual: null,
  packer: "", labelPic: "", printed: false, dispatched: false, handoverRef: "", date: D, note: "",
  reviewState: "confirmed", version: 1, ...extra,
});
/** A site like the C1 database tests' site C, as a slice with every row loaded. */
function siteC() {
  const doc = documentOf(createDraft());
  doc.staffProfiles = [
    { id: ALI, name: "Synthetic Ali C", role: "packer", active: true },
    { id: BEA, name: "Synthetic Bea C", role: "packer", active: true },
  ];
  const orders = [
    order(O1, "NVMYC1", { expected: 4, originalExpected: 4, package: "P4", channel: "TikTok", assignedPacker: ALI, assignedAt: "2026-10-20T01:00:00.000Z", version: 3 }),
    order(O2, "NVMYC2", { expected: 2, originalExpected: 2, package: "P2", channel: "Shopee" }),
    order(O3, "NVMYC3", {
      expected: 3, originalExpected: 3, package: "Mixed", reviewState: "pending",
      lines: [{ product: "cav", expected: 2, originalExpected: 2, actual: null }, { product: "lip", expected: 1, originalExpected: 1, actual: null }],
    }),
    order(O4, "NVMYC4", { reviewState: "pending" }),
  ];
  const demand = { [demandKey(D, "cav")]: dayDemand(orders, D, "cav") };
  const sortCounts = [{ id: "60000000-0000-4000-8000-0000000000f1", date: D, product: "cav", expected: 6, counted: 6, fingerprint: demand[demandKey(D, "cav")].hash, pic: "SO", note: "", at: "2026-10-20T01:10:00.000Z" }];
  return buildSlice(doc, { orders, issues: [], sortCounts, cartonIssued: { "c-cav": 5 }, demand });
}
const run = (slice, role, type, input, extra = {}) => {
  const after = applyCommand(slice, {
    type, role, input, actor: actor(role), capabilities: effectiveCapabilities(role), scope: "slice", ...extra,
  });
  return { after, changes: sliceDelta(type, slice, after, { effects: extra.effects ?? null, recorder: actor(role) }) };
};
const only = (changes, keys) => assert.deepEqual(Object.keys(changes).sort(), keys.sort());

// --- Slice spec ------------------------------------------------------------------------

test("each order command names the rows it needs", () => {
  const spec = (type, input) => sliceSpec(type, input);
  assert.deepEqual(spec("order", { awb: " nvmy c1 " }).awbs, ["NVMYC1"]);
  assert.deepEqual(spec("edit-order", { id: O1, awb: "x1" }), { ...spec("print", { id: O1 }), awbs: ["X1"] });
  for (const type of ["review-order", "print", "pack", "pack-own", "correct", "dispatch"])
    assert.deepEqual(spec(type, { id: O1 }), { ids: [O1], awbs: [], upload: null, issues: false, cartonIssued: false, demand: [], day: null, releasedFrom: false }, type);
  assert.deepEqual(spec("remove-order", { id: O1 }), { ...spec("print", { id: O1 }), issues: true, releasedFrom: true });
  assert.deepEqual(spec("split-order", { id: O3, awb_cav: "a 1", awb_lip: "B2", package_cav: "P" }), { ...spec("print", { id: O3 }), awbs: ["A1", "B2"], issues: true });
  assert.deepEqual(spec("assign-orders", { ids: [O1, O1, O2, 7] }), { ...spec("print", { id: O1 }), ids: [O1, O2], demand: "targets" });
  assert.deepEqual(spec("move-orders", { ids: [O1] }).ids, [O1]);
  assert.deepEqual(spec("issue-orders", { ids: [O1] }), { ...spec("print", { id: O1 }), issues: true, cartonIssued: true, demand: "targets" });
  assert.deepEqual(spec("issue", { orderId: O1, cartonId: "c" }), { ...spec("print", { id: O1 }), issues: true, cartonIssued: true });
  assert.deepEqual(spec("assign-package", { date: D, group: JSON.stringify(["cav", "P", 2]) }), {
    ...spec("order", {}), day: { date: D, product: "cav" }, demand: [{ date: D, product: "cav" }],
  });
  assert.deepEqual(spec("assign-package", { date: D, group: "not json" }).day, null);
  assert.deepEqual(spec("sort-count", { date: D, product: "lip" }).demand, [{ date: D, product: "lip" }]);
  assert.deepEqual(spec("import-release", { id: "u" }).upload, { id: "u", rows: "awbs" });
  assert.deepEqual(spec("import-delete", { id: "u" }), { ...spec("order", {}), upload: { id: "u", rows: "orders" }, issues: true });
  assert.throws(() => spec("batch", {}), /not available for order records/);
});

test("the loader reads only the spec's rows and fills the transient totals", async () => {
  const whole = createDraft();
  for (const o of whole.orders) o.version = 1;
  whole.sortCounts = [{ id: "sc-1", date: whole.orders[0].date, product: "gly", expected: 2, counted: 2, fingerprint: "x", pic: "S", note: "", at: "" }];
  const log = [];
  // issue-orders: targets, their issues, carton totals minus loaded issues, the targets' days.
  const { draft } = await loadSlice(memorySource(whole, [], log), documentOf(whole), "issue-orders", { ids: ["o-3"] });
  assert.deepEqual(draft.orders.map((o) => o.id), ["o-3"]);
  assert.deepEqual(draft.issues.map((i) => i.id), ["i-3"]);
  assert.deepEqual(draft.cartonIssued, { "c-cav": 6, "c-gly": 0, "c-syn": 2 });
  assert.equal(available(draft, draft.cartons.find((c) => c.id === "c-gly")), available(whole, whole.cartons.find((c) => c.id === "c-gly")));
  assert.equal(available(draft, draft.cartons.find((c) => c.id === "c-cav")), available(whole, whole.cartons.find((c) => c.id === "c-cav")));
  assert.deepEqual(Object.keys(draft.demand), [demandKey(whole.orders[0].date, "gly")]);
  assert.deepEqual(draft.sortCounts.map((c) => c.id), ["sc-1"]);
  assert.deepEqual(log.map(([name]) => name), ["ordersById", "issuesOf", "cartonTotals", "day"]);
  assert.deepEqual(draft.events, []);
  // A product without reviewed AWBs that day has the empty demand.
  const count = await loadSlice(memorySource(whole), documentOf(whole), "sort-count", { date: "2026-12-01", product: "cav" });
  assert.deepEqual(count.draft.demand, { [demandKey("2026-12-01", "cav")]: { awbs: 0, expected: 0, hash: EMPTY_DEMAND_HASH } });
  assert.deepEqual(count.draft.orders, []);
  // assign-package: the reviewed AWBs of the day containing the group's product.
  whole.orders.push(order("o-pending", "PEND-1", { date: whole.orders[0].date, reviewState: "pending" }));
  const pkg = await loadSlice(memorySource(whole), documentOf(whole), "assign-package", { date: whole.orders[0].date, group: JSON.stringify(["cav", "Sample 2-bottle package", 2]) });
  assert.deepEqual(pkg.draft.orders.map((o) => o.id).sort(), ["o-1", "o-2"]);
});

test("an upload release loads every AWB and order reference on its open labels", async () => {
  const whole = createDraft();
  whole.orders.push(order("o-old", "NVMYREL0001", { date: "2026-08-01", dispatched: true, actual: 1, handoverRef: "M", orderRef: "REL-1", dispatchedAt: "2026-08-01T04:00:00.000Z" }));
  const file = { id: "e".repeat(64), name: "r.pdf", path: "site-a/" + "e".repeat(64) + ".pdf", pages: 1, size: 1 };
  const upload = {
    id: "30000000-0000-4000-8000-0000000000e1", name: "Release", date: D, files: [file], createdAt: "", updatedAt: "",
    rows: parsePages([{ file: file.id, page: 1, method: "text", text: "Ninja Van\nNVMYREL0001\nOrder: #REL-1\nProducts:\n1x Cavernosil [cave04]" }], "Luxana", "REL STORE"),
  };
  const log = [];
  const loaded = await loadSlice(memorySource(whole, [upload], log), documentOf(whole), "import-release", { id: upload.id });
  assert.deepEqual(log, [["upload", upload.id], ["ordersByAwb", ["NVMYREL0001"]], ["ordersByRef", ["REL-1"]]]);
  assert.deepEqual(loaded.draft.orders.map((o) => o.id), ["o-old"]);
  assert.equal(loaded.context.import.id, upload.id);
  assert.equal(loaded.keepEffects, true);
  // The AWB was handed over more than 30 days before the upload's day: reusable on a
  // tables-mode site, still a duplicate in a document-mode site's rules.
  assert.equal(rowStatus(upload.rows[0], upload, loaded.draft, { reuse: true }), "ready");
  assert.equal(rowStatus(upload.rows[0], upload, loaded.draft), "conflict");
  const released = run(loaded.draft, "admin", "import-release", { id: upload.id }, { context: loaded.context, effects: importEffects("import-release", { id: upload.id }, loaded.draft) });
  assert.equal(released.changes.orders.insert.length, 1);
  const row = released.changes.orders.insert[0];
  assert.equal(row.awb, "NVMYREL0001");
  assert.equal(row.import_id, upload.id);
  assert.equal(row.import_row_id, upload.rows[0].id);
  assert.equal(row.review_state, "confirmed");
  assert.deepEqual(row.lines, [{ product: "cav", expected: 4, originalExpected: 4, actual: null }]);
  assert.deepEqual(released.changes.importEffects, { release: upload.id });
  assert.deepEqual(released.changes.events.map((e) => e.entity), [upload.id, row.id]);
});

// --- Change sets, one per family (shaped like the C1 database tests) --------------------

test("order: one pending AWB, the full row without database-stamped columns", () => {
  const { after, changes } = run(siteC(), "outbound", "order", { awb: "nvmy c5", product: "cav", channel: "Luxana", package: "P1", expected: 1, date: D });
  only(changes, ["orders", "events"]);
  const created = after.orders.find((o) => o.awb === "NVMYC5");
  assert.deepEqual(changes.orders, {
    insert: [{
      id: created.id, awb: "NVMYC5", channel: "Luxana", store: null, order_ref: null, courier: null, import_id: null,
      import_row_id: null, product: "cav", package: "P1", expected: 1, original_expected: 1, actual: null, lines: null,
      fulfil_date: D, note: "", review_state: "pending", reviewed_by: null, printed: false, assigned_packer: null,
      packer: "", label_pic: "", packed_at: null, pack_recorded_by: null, dispatched: false, handover_ref: "",
    }],
  });
  assert.deepEqual(changes.events.map((e) => [e.entity, e.action]), [[created.id, "AWB recorded"]]);
  assert.equal(changes.events[0].recorder.userId, "u-outbound");
});

test("edit-order: only the edited columns, with the version read; a stale form is a conflict", () => {
  const { changes } = run(siteC(), "outbound", "edit-order", { id: O4, awb: "NVMYC4B", product: "cav", channel: "Luxana", package: "P", expected: 2, date: D, expectedVersion: 1 });
  assert.deepEqual(changes.orders, { update: [{ id: O4, version: 1, set: { awb: "NVMYC4B", expected: 2, original_expected: 2 } }] });
  assert.equal(changes.events[0].action, "Pending order edited");
  assert.throws(
    () => run(siteC(), "outbound", "edit-order", { id: O4, awb: "NVMYC4B", product: "cav", channel: "Luxana", package: "P", expected: 3, date: D, expectedVersion: 0 }),
    (e) => e instanceof ConflictError && e.conflict.currentVersion === 1 && e.conflict.current.id === O4,
  );
});

test("review-order: review state and reviewer", () => {
  const { changes } = run(siteC(), "outbound", "review-order", { id: O4, pic: "SO C" });
  assert.deepEqual(changes.orders, { update: [{ id: O4, version: 1, set: { review_state: "confirmed", reviewed_by: "SO C" } }] });
});

test("split-order: the original becomes one parcel and the others are inserted", () => {
  const { after, changes } = run(siteC(), "outbound", "split-order", { id: O3, pic: "SO C", reason: "Two brands", awb_cav: "NVMYC3A", awb_lip: "NVMYC3B", package_cav: "P cav", package_lip: "P lip" });
  const [update] = changes.orders.update;
  assert.equal(update.id, O3);
  assert.deepEqual(Object.keys(update.set).sort(), ["awb", "expected", "lines", "note", "original_expected", "package", "review_state", "reviewed_by"]);
  assert.equal(update.set.lines, null);
  assert.equal(update.set.expected, 2);
  const [parcel] = changes.orders.insert;
  assert.equal(parcel.awb, "NVMYC3B");
  assert.equal(parcel.product, "lip");
  assert.equal(parcel.expected, 1);
  assert.equal(parcel.review_state, "confirmed");
  assert.equal(parcel.version, undefined);
  assert.equal(changes.events.length, 2);
  assert.equal(after.orders.length, 5);
});

test("sort-count: the count with the database's demand", () => {
  const slice = siteC();
  const d = slice.demand[demandKey(D, "cav")];
  const { changes } = run(slice, "outbound", "sort-count", { date: D, product: "cav", counted: 6, pic: "SO C", note: "Recount" });
  only(changes, ["sortCounts", "events"]);
  const [count] = changes.sortCounts;
  assert.deepEqual({ ...count, id: undefined, recorder: undefined }, {
    id: undefined, fulfil_date: D, product: "cav", counted: 6, pic: "SO C", note: "Recount", expected: 6,
    demand_awbs: 2, demand_hash: d.hash, recorder: undefined,
  });
  assert.equal(changes.events[0].entity, D);
});

test("assign-orders, print: only those columns", () => {
  const assigned = run(siteC(), "outbound", "assign-orders", { ids: [O2], packer: BEA, pic: "SO C" });
  assert.deepEqual(Object.keys(assigned.changes.orders.update[0].set).sort(), ["assigned_at", "assigned_packer"]);
  assert.equal(assigned.changes.orders.update[0].set.assigned_packer, BEA);
  const printed = run(siteC(), "outbound", "print", { id: O2, pic: "SO C" });
  assert.deepEqual(printed.changes.orders, { update: [{ id: O2, version: 1, set: { printed: true } }] });
});

test("issue: an insert-only stock issue against the carton balance", () => {
  const slice = siteC();
  const { changes } = run(slice, "outbound", "issue", { cartonId: "c-cav", orderId: O2, qty: 2, pic: "SO C" });
  only(changes, ["issues", "events"]);
  assert.deepEqual({ ...changes.issues[0], id: undefined, recorder: undefined }, { id: undefined, order_id: O2, carton_id: "c-cav", qty: 2, pic: "SO C", recorder: undefined });
  // 120 received, 5 issued in the tables outside the slice.
  assert.equal(available(slice, slice.cartons.find((c) => c.id === "c-cav")), 115);
  assert.throws(() => run(slice, "outbound", "issue", { cartonId: "c-cav", orderId: O2, qty: 116, pic: "SO C" }), /Not enough stock/);
});

test("pack and pack-own: the count columns; pack-own's packer is the unlocked profile", () => {
  const packed = run(siteC(), "outbound", "pack", { id: O1, actual: 4, pic: ALI, labelPic: ALI });
  const [u] = packed.changes.orders.update;
  assert.equal(u.version, 3);
  assert.deepEqual(Object.keys(u.set).sort(), ["actual", "label_pic", "pack_recorded_at", "pack_recorded_by", "packed_at", "packer"]);
  assert.equal(u.set.pack_recorded_by.userId, "u-outbound");
  const slice = siteC();
  slice.orders.find((o) => o.id === O2).assignedPacker = BEA;
  const own = run(slice, "packer", "pack-own", { id: O2, actual: 2 }, { performer: BEA });
  assert.equal(own.changes.orders.update[0].set.packer, BEA);
  assert.equal(own.changes.orders.update[0].set.label_pic, BEA);
  assert.throws(() => run(slice, "packer", "pack-own", { id: O2, actual: 2 }, { performer: ALI }), /assigned to another packer/);
});

test("correct, dispatch, move-orders: their columns; the handover time is left to the database", () => {
  const slice = siteC();
  Object.assign(slice.orders.find((o) => o.id === O1), { actual: 4, packer: ALI, labelPic: ALI });
  assert.deepEqual(run(slice, "outbound", "correct", { id: O1, field: "actual", qty: 3, reason: "Recount" }).changes.orders,
    { update: [{ id: O1, version: 3, set: { actual: 3 } }] });
  const handed = run(slice, "outbound", "dispatch", { id: O1, reference: "M-1", pic: "SO C" });
  assert.deepEqual(handed.changes.orders, { update: [{ id: O1, version: 3, set: { dispatched: true, handover_ref: "M-1" } }] });
  assert.ok(handed.after.orders.find((o) => o.id === O1).dispatchedAt);
  assert.deepEqual(run(siteC(), "outbound", "move-orders", { ids: [O2], date: "2026-10-21", pic: "SO C", reason: "Tomorrow" }).changes.orders,
    { update: [{ id: O2, version: 1, set: { fulfil_date: "2026-10-21" } }] });
});

test("remove-order and import-delete: deletes with versions and their upload effects", () => {
  const slice = siteC();
  const removed = run(slice, "outbound", "remove-order", { id: O4, reason: "Mistake" });
  assert.deepEqual(removed.changes.orders, { delete: [{ id: O4, version: 1 }] });
  const U = "30000000-0000-4000-8000-0000000000c1", R = "31000000-0000-4000-8000-0000000000c1";
  Object.assign(slice.orders.find((o) => o.id === O2), { importId: U, importRowId: R });
  const effects = importEffects("remove-order", { id: O2, reason: "cancelled" }, slice);
  assert.deepEqual(effects, { rows: [{ id: R, excluded: true, reviewNote: "Removed: cancelled" }] });
  assert.deepEqual(run(slice, "outbound", "remove-order", { id: O2, reason: "cancelled" }, { effects }).changes.importEffects, effects);
  const upload = { id: U, name: "U", date: D, files: [], rows: [], createdAt: "", updatedAt: "" };
  const deleted = run(slice, "admin", "import-delete", { id: U, reason: "Wrong day" }, {
    context: { import: upload }, effects: importEffects("import-delete", { id: U, reason: "Wrong day" }, slice),
  });
  assert.deepEqual(deleted.changes.orders, { delete: [{ id: O2, version: 1 }] });
  assert.deepEqual(deleted.changes.importEffects, { delete: U, reason: "Wrong day" });
  assert.deepEqual(deleted.changes.events.map((e) => e.entity), [U]);
});

test("the differ refuses anything outside the command's record rule", () => {
  const slice = siteC();
  const after = structuredClone(slice);
  after.cartons[0].qty = 1;
  assert.throws(() => sliceDelta("print", slice, after), /outside your role's records/);
  const note = structuredClone(slice);
  note.orders.find((o) => o.id === O2).note = "x";
  assert.throws(() => sliceDelta("print", slice, note), /outside your role's records/);
  const removed = structuredClone(slice);
  removed.orders = removed.orders.filter((o) => o.id !== O2);
  assert.throws(() => sliceDelta("print", slice, removed), /outside your role's records/);
  const withIssue = { ...slice, issues: [{ id: "i", cartonId: "c-cav", orderId: O2, qty: 1, pic: "S", at: "" }] };
  const changedIssue = structuredClone(withIssue);
  changedIssue.issues[0].qty = 2;
  assert.throws(() => sliceDelta("issue", withIssue, changedIssue), /outside your role's records/);
  const unversioned = structuredClone(slice);
  delete unversioned.orders.find((o) => o.id === O2).version;
  const printed = structuredClone(unversioned);
  printed.orders.find((o) => o.id === O2).printed = true;
  assert.throws(() => sliceDelta("print", unversioned, printed), /with its version/);
  assert.throws(() => sliceDelta("batch", slice, slice), /not available for order records/);
  assert.throws(() => applyCommand(slice, { type: "count", role: "intake", input: {}, scope: "slice" }), /not available/);
});

test("rows map to orders and back", () => {
  const row = {
    id: O1, awb: "NVMYC1", channel: "TikTok", store: null, order_ref: "R-1", courier: null, import_id: null, import_row_id: null,
    product: "cav", package: "P", expected: 4, original_expected: 4, actual: null, lines: null, fulfil_date: D, note: "",
    review_state: "confirmed", reviewed_by: "S", printed: false, assigned_packer: ALI, assigned_at: "2026-10-20T01:00:00+00:00",
    packer: "", label_pic: "", packed_at: null, pack_recorded_at: null, pack_recorded_by: null, dispatched: false,
    dispatched_at: null, handover_ref: "", version: 3,
  };
  const o = orderFromRow(row);
  assert.equal(o.assignedAt, "2026-10-20T01:00:00.000Z");
  assert.equal(o.version, 3);
  assert.equal("store" in o, false);
  const { version, ...columns } = row;
  assert.equal(version, 3);
  assert.deepEqual(orderToRow(o), { ...columns, assigned_at: "2026-10-20T01:00:00.000Z" });
});

// --- Demand, gate and stock on a slice ------------------------------------------------

test("the demand text hashes like operator_private.day_demand", () => {
  // Reference values computed by day_demand on a local cluster with 20261014090000 applied.
  const orders = [
    order("b0000000-0000-4000-8000-000000000002", "DEM2", { expected: 4 }),
    order("40000000-0000-4000-8000-0000000000d1", "DEM1", { expected: 3, lines: [{ product: "cav", expected: 2, originalExpected: 2, actual: null }, { product: "lip", expected: 1, originalExpected: 1, actual: null }] }),
    order("a0000000-0000-4000-8000-000000000003", "DEM3", { expected: 5, reviewState: "pending" }),
    order("c0000000-0000-4000-8000-000000000004", "DEM4", { expected: 7, date: "2026-10-21" }),
  ];
  assert.equal(sha(demandText(orders, D, "cav")), "4fb59d9a4edcb1329ecdb3e7a9dd1ad51cd9bd3c05a297fc9b4436c5994b0bd8");
  assert.equal(sha(demandText(orders, D, "lip")), "dab5740606a1c399f101e97cdb43daa3fda973cf7c1dc3d7fd084dfe20ac4f18");
  assert.equal(sha(demandText(orders, D, "gly")), EMPTY_DEMAND_HASH);
  assert.deepEqual(dayDemand(orders, D, "cav").awbs, 2);
});

test("the count gate and stock read the database's totals on a slice", () => {
  const slice = siteC();
  assert.deepEqual(tallyGate(slice, D, "cav"), { awbs: 2, expected: 6, count: slice.sortCounts[0], stale: false });
  assert.equal(demandFingerprint(slice, D, "cav"), slice.demand[demandKey(D, "cav")].hash);
  slice.demand[demandKey(D, "cav")] = { awbs: 3, expected: 7, hash: "f".repeat(64) };
  assert.equal(tallyGate(slice, D, "cav").stale, true);
  assert.throws(() => run(slice, "outbound", "assign-orders", { ids: [O2], packer: BEA, pic: "S" }), /current supervisor count/);
  // Without demand the document's own orders decide, as before.
  const doc = createDraft();
  assert.equal(tallyGate(doc, doc.orders[0].date, "cav").awbs, 2);
  assert.match(demandFingerprint(doc, doc.orders[0].date, "cav"), /^\[\["o-1",2\],\["o-2",2\]\]$/);
  // Table issues outside the slice are older than the day's movements.
  const inv = (s) => dailyInventory(s, "2999-01-01").find((r) => r.product === "cav");
  assert.equal(inv({ ...doc, cartonIssued: { "c-cav": 10 } }).opening, inv(doc).opening - 10);
});

// --- AWB reuse rule ----------------------------------------------------------------------

test("an AWB may return only after more than 30 days since its handover (Malaysia days)", () => {
  // Handed over 2026-09-10 20:00 UTC = 2026-09-11 in Malaysia.
  const old = { date: "2026-09-08", dispatched: true, dispatchedAt: "2026-09-10T20:00:00.000Z" };
  assert.equal(awbReuseAllowed(old, { date: "2026-10-12", dispatched: false }), true);
  assert.equal(awbReuseAllowed(old, { date: "2026-10-11", dispatched: false }), false);
  assert.equal(awbReuseAllowed({ date: "2026-10-12", dispatched: false }, old), true, "symmetric");
  // Without a handover time (backfilled history) the earlier order's day counts.
  assert.equal(awbReuseAllowed({ date: "2026-09-08", dispatched: true }, { date: "2026-10-09", dispatched: false }), true);
  assert.equal(awbReuseAllowed({ date: "2026-09-08", dispatched: true }, { date: "2026-10-08", dispatched: false }), false);
  assert.equal(awbReuseAllowed({ ...old, dispatched: false }, { date: "2026-12-31", dispatched: false }), false, "never handed over");
  assert.equal(awbReuseAllowed({ date: D, dispatched: true }, { date: D, dispatched: false }), false, "same day");
  assert.equal(awbReuseAllowed({ date: "2026-12-31", dispatched: true }, { date: "2026-01-01", dispatched: false }), false, "later one first");
  const orders = [order("x", "NVMYREUSE1", old)];
  assert.equal(recordedAwb(orders, "NVMYREUSE1", "2026-10-12", { reuse: true }), undefined);
  assert.equal(recordedAwb(orders, "NVMYREUSE1", "2026-10-12")?.id, "x");
  assert.equal(recordedAwb(orders, "NVMYREUSE1", "2026-10-11", { reuse: true })?.id, "x");
  assert.equal(recordedAwb(orders, "NVMYREUSE1", "2026-10-11", { except: "x" }), undefined);
});

test("order, edit-order and split-order apply the reuse rule on tables-mode sites only", () => {
  const slice = siteC();
  slice.orders.push(order("o-reused", "NVMYREUSE1", { date: "2026-09-08", dispatched: true, actual: 1, handoverRef: "M", dispatchedAt: "2026-09-10T20:00:00.000Z" }));
  const input = { awb: "NVMYREUSE1", product: "cav", channel: "Luxana", package: "P", expected: 1 };
  assert.ok(run(slice, "outbound", "order", { ...input, date: "2026-10-12" }).changes.orders.insert);
  assert.throws(() => run(slice, "outbound", "order", { ...input, date: "2026-10-11" }), /already recorded/);
  assert.throws(() => applyCommand(slice, { type: "order", role: "outbound", input: { ...input, date: "2026-10-12" } }), /already recorded/, "document mode is unchanged");
  assert.ok(run(slice, "outbound", "edit-order", { ...input, id: O4, date: "2026-10-12" }).changes.orders.update);
  assert.throws(() => run(slice, "outbound", "edit-order", { ...input, id: O4, date: "2026-10-11" }), /already recorded/);
  slice.orders.find((o) => o.id === O3).date = "2026-10-12";
  const split = { id: O3, pic: "S", reason: "x", awb_cav: "NVMYREUSE1", awb_lip: "NVMYC3B", package_cav: "P", package_lip: "Q" };
  assert.ok(run(slice, "outbound", "split-order", split).changes.orders.insert);
  slice.orders.find((o) => o.id === O3).date = "2026-10-11";
  assert.throws(() => run(slice, "outbound", "split-order", split), /distinct actual AWB/);
});

// --- Date and product-line fixes ------------------------------------------------------

test("order and edit-order accept only a real YYYY-MM-DD fulfilment day", () => {
  const input = { awb: "NVMYDATE1", product: "cav", channel: "Luxana", package: "P", expected: 1 };
  for (const date of ["2026-10-20T05:00", "20/10/2026", "2026-02-30", "2026-1-5"]) {
    assert.throws(() => applyCommand(createDraft(), { type: "order", role: "admin", input: { ...input, date } }), /valid fulfilment date/, date);
    assert.throws(() => run(siteC(), "outbound", "edit-order", { ...input, id: O4, date }), /valid fulfilment date/, date);
  }
  assert.equal(applyCommand(createDraft(), { type: "order", role: "admin", input: { ...input, date: "2026-02-28" } }).orders[0].date, "2026-02-28");
});

test("edit-order replaces stale product lines with the edited product", () => {
  const slice = siteC();
  const { after, changes } = run(slice, "outbound", "edit-order", { id: O3, awb: "NVMYC3", product: "lip", channel: "Luxana", package: "P", expected: 2, date: D });
  assert.deepEqual(after.orders.find((o) => o.id === O3).lines, [{ product: "lip", expected: 2, originalExpected: 2, actual: null }]);
  assert.deepEqual(changes.orders.update[0].set.lines, [{ product: "lip", expected: 2, originalExpected: 2, actual: null }]);
  // Document mode gets the same fix.
  const doc = createDraft();
  doc.orders.push(order("o-lines", "NVMYLINES", { reviewState: "pending", lines: [{ product: "cav", expected: 1, originalExpected: 1, actual: null }] }));
  const edited = applyCommand(doc, { type: "edit-order", role: "admin", input: { id: "o-lines", awb: "NVMYLINES", product: "gly", channel: "Luxana", package: "P", expected: 3, date: D } });
  assert.deepEqual(edited.orders.find((o) => o.id === "o-lines").lines, [{ product: "gly", expected: 3, originalExpected: 3, actual: null }]);
});

test("a document-mode handover keeps the document's shape", () => {
  const doc = createDraft();
  const handed = applyCommand(doc, { type: "dispatch", role: "outbound", input: { id: "o-5", reference: "M-2", pic: "S" } });
  assert.equal("dispatchedAt" in handed.orders.find((o) => o.id === "o-5"), false);
});

// --- Signing and document views -------------------------------------------------------

test("records are signed with the operator-records-v1 message", () => {
  const secret = Buffer.alloc(32, 7);
  const changesText = JSON.stringify({ orders: { update: [{ id: O1, version: 1, set: { printed: true } }] } });
  const t = { workspaceId: "w", userId: "u", operationId: "op", command: "print", fingerprint: "f".repeat(64), changesText };
  const hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
  const expected = createHmac("sha256", secret)
    .update(["operator-records-v1", "w", "u", "op", "print", "f".repeat(64), hex(changesText), hex("")].join("\n"), "utf8")
    .digest("hex");
  assert.equal(attestRecords(secret, t), expected);
  assert.equal(attestRecords(secret, { ...t, packerSession: null }), expected);
  assert.notEqual(attestRecords(secret, { ...t, packerSession: "v1.a.b.c.1.d" }), expected);
  assert.notEqual(attestRecords(secret, { ...t, changesText: changesText + " " }), expected);
});

test("a tables-mode document view runs document commands and is stored without order keys", () => {
  const doc = documentOf(createDraft());
  const view = documentView(doc, { "c-cav": 118 });
  assert.equal(available(view, view.cartons.find((c) => c.id === "c-cav")), 2);
  const counted = applyCommand(view, { type: "count", role: "intake", input: { cartonId: "c-cav", actual: 2, pic: "R" } });
  assert.equal(counted.counts[0].book, 2);
  assert.deepEqual(Object.keys(stripTransient(counted)).filter((k) => ["orders", "issues", "sortCounts", "cartonIssued", "demand"].includes(k)), []);
});
