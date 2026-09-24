import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePages,
  rowProblems,
  rowStatus,
  validateImport,
  defaultFor,
} from "../apps/web/src/lib/awb-import.ts";
import {
  createDraft,
  applyCommand,
  variance,
  orderIssued,
} from "../apps/web/src/lib/draft.ts";
const file = {
  id: "a".repeat(64),
  name: "synthetic.pdf",
  path: "tester/" + "a".repeat(64) + ".pdf",
  pages: 10,
  size: 1000,
};
const page = (text, n = 1, method = "text") => ({
  file: file.id,
  page: n,
  text,
  method,
});
const ninja = (awb = "NVMYTEST000001", ref = "TEST-ORDER-1") =>
  `Ninja Van\n${awb}\nOrder: #${ref}\nProducts:\n1x Cavernosil [cave04]`;
const batch = (pages) => ({
  id: crypto.randomUUID(),
  name: "Synthetic test",
  date: "2026-09-21",
  files: [file],
  rows: parsePages(pages, "Luxana", "TEST STORE"),
  createdAt: "",
  updatedAt: "",
});
const run = (s, type, input, role = "admin") =>
  applyCommand(s, { type, input, role });
test("native label package count expands defaults including free bottles, retaining IDs as strings", () => {
  const b = batch([page(ninja())]);
  assert.equal(b.rows[0].lines[0].packages, 1);
  assert.equal(b.rows[0].lines[0].units, 4);
  assert.deepEqual(rowProblems(b.rows[0]), []);
  assert.equal(defaultFor("SYN6NSG").units, 6);
  assert.equal(defaultFor("adipocyde1").product, "ady");
  assert.equal(defaultFor("lip02").units, 2);
});
test("Shopee table quantity is separate from 3 free 1 variation", () => {
  const b = batch([
    page(
      "SPX Shopee\nSPXMYTEST000001\nOrder ID: 0000123456\nPacking List\n1 Cavernosil cave04 Cavernosil 3 Free 1 2 196.00 392.00",
    ),
  ]);
  assert.equal(b.rows[0].orderRef, "0000123456");
  assert.equal(b.rows[0].lines[0].packages, 2);
});
test("TikTok quantity and LEX quantity are parsed without using offer digits", () => {
  const t = batch([
    page(
      "TikTok Shop J&T EXPRESS\n6800000000011\nOrder ID: 5860000000000001\nProduct SKU Seller SKU Qty\nLipidri 2 Set | 14 Hari lip02 1",
    ),
  ]);
  assert.equal(t.rows[0].awb, "6800000000011");
  assert.equal(t.rows[0].lines[0].packages, 1);
  const l = batch([
    page(
      "Lazada LEX\nMYMPATEST00001\nO/N: 000123456\nSKU/Item Description Qty\ncave01 1",
    ),
  ]);
  assert.equal(l.rows[0].lines[0].packages, 1);
});
test("separate packing list joins only an unambiguous referenced AWB", () => {
  const b = batch([
    page("Shopee SPX\nSPXMYTEST000001\nOrder ID: 000100"),
    page(
      "Packing List\nOrder ID: 000100\n1 Cavernosil cave04 3 Free 1 1 196.00 196.00",
      2,
    ),
  ]);
  // Channel supplied on the upload is retained for product-only pages.
  const rows = parsePages(
    [
      page("Shopee SPX\nSPXMYTEST000001\nOrder ID: 000100"),
      page(
        "Packing List\nOrder ID: 000100\n1 Cavernosil cave04 3 Free 1 1 196.00 196.00",
        2,
      ),
    ],
    "Shopee",
    "TEST STORE",
  );
  assert.equal(rows[0].lines[0].units, 4);
  assert.equal(rows[0].sources.length, 2);
  assert.equal(rows[1].excluded, true);
  assert.equal(b.rows[1].excluded, true);
});
test("unknown/missing details never become a complete zero or default single package", () => {
  const b = batch([page("SPX Shopee\nSG000000000001A\nOrder ID: 000100")]);
  assert.match(rowProblems(b.rows[0]).join(), /Product details/);
  const q = batch([
    page("Ninja Van\nNVMYTEST000001\nOrder: #0001\nProducts: cave04"),
  ]);
  assert.equal(q.rows[0].lines[0].packages, null);
  const u = batch([
    page("AWB: TEST-UNKNOWN\nOrder ID: TEST-1\nSKU: UNKNOWN99 Qty: 2"),
  ]);
  assert.equal(u.rows[0].lines[0].units, null);
});
test("multiple labels on one page do not all inherit the same contents; OCR requires review", () => {
  const b = batch([page(ninja() + "\nNVMYTEST000002")]);
  assert.equal(b.rows.length, 2);
  assert.equal(b.rows[0].lines.length, 0);
  const o = batch([page(ninja(), 1, "ocr")]);
  assert.match(rowProblems(o.rows[0]).join(), /OCR/);
  o.rows[0].reviewed = true;
  o.rows[0].reviewNote = "Checked against source";
  assert.deepEqual(rowProblems(o.rows[0]), []);
});
test("reprint duplicates are skipped; conflicting labels block handoff", () => {
  const b = batch([page(ninja()), page(ninja(), 2)]),
    s = createDraft();
  assert.equal(rowStatus(b.rows[1], b, s), "duplicate");
  b.rows[1].lines[0].packages = 2;
  assert.equal(rowStatus(b.rows[0], b, s), "conflict");
  const saved = run(s, "import-save", { batch: b });
  assert.throws(() => run(saved, "import-release", { id: b.id }), /Resolve/);
});
test("save, release and retry create one parcel and no stock, print or packing side effects", () => {
  const initial = createDraft(),
    b = batch([page(ninja()), page(ninja(), 2)]);
  let s = run(initial, "import-save", { batch: b });
  assert.equal(s.orders.length, initial.orders.length);
  s = run(s, "import-release", { id: b.id });
  assert.equal(s.orders.length, initial.orders.length + 1);
  const o = s.orders[0];
  assert.equal(o.expected, 4);
  assert.equal(o.actual, null);
  assert.equal(o.printed, false);
  assert.equal(o.dispatched, false);
  assert.deepEqual(s.issues, initial.issues);
  assert.deepEqual(s.cartons, initial.cartons);
  assert.throws(() => run(s, "import-release", { id: b.id }), /already/);
  const again = batch([page(ninja())]);
  assert.equal(rowStatus(again.rows[0], again, s), "duplicate");
  const conflict = batch([page(ninja())]);
  conflict.rows[0].lines[0].units = 6;
  assert.equal(rowStatus(conflict.rows[0], conflict, s), "conflict");
});
test("mixed parcel records separate counts and cannot cancel opposite product variances", () => {
  const b = batch([page(ninja() + "\n2x Adipocyde [adipocyde1]")]);
  let s = run(createDraft(), "import-save", { batch: b });
  s = run(s, "import-release", { id: b.id });
  const o = s.orders[0];
  assert.equal(o.lines.length, 2);
  o.assignedPacker = "TEST PACKER";
  s = run(
    s,
    "pack",
    {
      id: o.id,
      actual_cav: 3,
      actual_ady: 3,
      pic: "TEST PACKER",
      labelPic: "TEST LABEL",
    },
    "packer",
  );
  assert.notEqual(variance(s.orders[0]), 0);
  assert.throws(
    () =>
      run(
        s,
        "dispatch",
        { id: o.id, reference: "TEST-MANIFEST", pic: "TEST" },
        "outbound",
      ),
    /note/,
  );
  s = run(
    s,
    "correct",
    {
      id: o.id,
      product: "cav",
      field: "expected",
      qty: 3,
      reason: "Source reviewed",
    },
    "outbound",
  );
  assert.equal(
    s.orders[0].lines.find((l) => l.product === "cav").originalExpected,
    4,
  );
  s = run(
    s,
    "issue",
    { orderId: o.id, cartonId: "c-cav", qty: 3, pic: "TEST" },
    "outbound",
  );
  assert.equal(orderIssued(s, s.orders[0], "cav"), 3);
  assert.equal(orderIssued(s, s.orders[0], "ady"), 0);
});
test("review and exclusion require notes, roles are enforced and split orders need allocation review", () => {
  const b = batch([page(ninja()), page(ninja("NVMYTEST000002"), 2)]);
  assert.equal(rowStatus(b.rows[0], b, createDraft()), "review");
  b.rows[0].reviewed = true;
  assert.throws(() => validateImport(b), /Explain/);
  b.rows[0].reviewNote = "First parcel allocation checked";
  assert.throws(
    () => run(createDraft(), "import-save", { batch: b }, "management"),
    /admin/,
  );
  b.rows[1].excluded = true;
  b.rows[1].reviewNote = "Duplicate label supplied";
  let s = run(createDraft(), "import-save", { batch: b });
  s = run(s, "import-release", { id: b.id });
  assert.throws(
    () => run(s, "import-receive", { id: b.id, pic: "TEST" }),
    /stock-out/,
  );
  s = run(s, "import-receive", { id: b.id, pic: "TEST" }, "outbound");
  assert.ok(s.awbImports[0].receivedAt);
  assert.equal(s.orders[0].printed, false);
});

test("a stale review cannot overwrite a teammate's saved batch", () => {
  const b = batch([page(ninja())]);
  const s = run(createDraft(), "import-save", { batch: b });
  const stale = structuredClone(s.awbImports[0]);
  s.awbImports[0].updatedAt = "2026-09-21T23:59:59.000Z";
  assert.throws(
    () => run(s, "import-save", { batch: stale }),
    /teammate updated/,
  );
});
