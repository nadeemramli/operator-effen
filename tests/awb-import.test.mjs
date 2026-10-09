import test from "node:test";
import assert from "node:assert/strict";
import {
  OCR_NOTE,
  detectReferences,
  isLabelPage,
  needsOcr,
  parseImport,
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
test("multiple labels on one page do not all inherit the same contents; OCR is a note, not a block", () => {
  const b = batch([page(ninja() + "\nNVMYTEST000002")]);
  assert.equal(b.rows.length, 2);
  assert.equal(b.rows[0].lines.length, 0);
  const o = batch([page(ninja(), 1, "ocr")]);
  assert.deepEqual(o.rows[0].notes, [OCR_NOTE]);
  assert.deepEqual(rowProblems(o.rows[0]), []);
  assert.equal(rowStatus(o.rows[0], o, createDraft()), "ready");
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
test("mixed brands stay in review until each actual parcel has a separate AWB", () => {
  const b = batch([page(ninja() + "\n2x Adipocyde [adipocyde1]")]);
  b.rows[0].reviewed = true;
  b.rows[0].reviewNote = "Checked source";
  assert.match(rowProblems(b.rows[0]).join(), /own parcel/);
  let s = run(createDraft(), "import-save", { batch: b });
  assert.throws(() => run(s, "import-release", { id: b.id }), /Resolve/);
  b.updatedAt = s.awbImports[0].updatedAt;
  const original = b.rows[0];
  b.rows = original.lines.map((line, i) => ({
    ...original,
    id: crypto.randomUUID(),
    awb: `NVMYBRAND00000${i}`,
    lines: [line],
  }));
  s = run(s, "import-save", { batch: b });
  s = run(s, "import-release", { id: b.id });
  const parcels = s.orders.filter((o) => o.importId === b.id);
  assert.equal(parcels.length, 2);
  assert.ok(parcels.every((o) => o.lines.length === 1));
  assert.equal(new Set(parcels.map((o) => o.awb)).size, 2);
});
test("historical mixed-brand quantities retain independent variance", () => {
  const o = {
    ...createDraft().orders[0],
    lines: [
      { product: "cav", expected: 4, originalExpected: 4, actual: 3 },
      { product: "ady", expected: 2, originalExpected: 2, actual: 3 },
    ],
  };
  assert.notEqual(variance(o), 0);
});
test("review and exclusion require notes, roles are enforced and split orders need allocation review", () => {
  const b = batch([page(ninja()), page(ninja("NVMYTEST000002"), 2)]);
  assert.equal(rowStatus(b.rows[0], b, createDraft()), "review");
  b.rows[0].reviewed = true;
  // Marking a label checked needs no note; excluding one does.
  validateImport(b);
  b.rows[1].excluded = true;
  assert.throws(() => validateImport(b), /Explain why the label is excluded/);
  b.rows[1].excluded = false;
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
    /stock-out/i,
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

// WP7: cover pages are skipped, OCR is automatic and informational.
test("a cover or title page without references produces no row and is listed as skipped", () => {
  const cover = page("Daily orders\nNuvital HQ MY\nPrinted 9 Oct 2026", 1);
  const label = page(ninja(), 2);
  const { rows, skipped } = parseImport([cover, label], "Luxana", "Store");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].awb, "NVMYTEST000001");
  assert.deepEqual(skipped, [{ file: file.id, page: 1 }]);
  // Not special to page 1: a separator page in the middle is skipped the same way.
  const middle = parseImport([label, page("— end of batch —", 2), page(ninja("NVMYTEST000003"), 3)], "Luxana", "Store");
  assert.deepEqual(middle.skipped.map((p) => p.page), [2]);
  // A packing list (order reference and SKU, no AWB) and an unreadable page are kept.
  assert.ok(isLabelPage(page("Order ID: TEST-1\nSKU: cave01 Qty: 1")));
  assert.ok(isLabelPage(page("cave02 x 2")));
  assert.ok(isLabelPage({ ...page(""), error: "Page could not be read; review original PDF" }));
  assert.equal(isLabelPage(page("")), false);
  // The skipped page list is validated on save.
  const b = batch([label]);
  b.files = [{ ...file, skippedPages: [1] }];
  validateImport(b);
  b.files[0].skippedPages = [99];
  assert.throws(() => validateImport(b), /Invalid source file/);
});

test("OCR runs when the text has no AWB and no order reference, even if it has some text", () => {
  const storeHeader = "Nuvital HQ MY ".repeat(10); // plenty of text, no references
  assert.equal(needsOcr(storeHeader), true);
  assert.equal(needsOcr(""), true);
  assert.equal(needsOcr(ninja()), false);
  assert.equal(needsOcr("Order ID: TEST-9"), false);
  assert.equal(needsOcr(ninja(), true), true, "forced OCR reads every page");
  assert.deepEqual(detectReferences(ninja()).knownSkus, ["cave04"]);
});

test("an OCR-read label with no other issue is ready without a check or a note", () => {
  const b = batch([page(ninja(), 1, "ocr")]);
  let s = run(createDraft(), "import-save", { batch: b });
  s = run(s, "import-release", { id: b.id });
  assert.ok(s.orders.some((o) => o.awb === "NVMYTEST000001"));
});
