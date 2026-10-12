import test from "node:test";
import assert from "node:assert/strict";
import {
  OCR_NOTE,
  detectReferences,
  importLimit,
  isLabelPage,
  pageLimit,
  needsOcr,
  parseImport,
  parsePages,
  rowProblems,
  rowStatus,
  validateImport,
  defaultFor,
  fileLimit,
  importEffects,
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
// Uploads live in operator_imports; the API server hands the loaded upload to the command.
const release = (s, b, role = "admin") =>
  applyCommand(s, { type: "import-release", input: { id: b.id }, role, context: { import: b } });
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
  assert.throws(() => release(s, b), /Resolve/);
});
test("release and retry create one parcel and no stock, print or packing side effects", () => {
  const initial = createDraft(),
    b = batch([page(ninja()), page(ninja(), 2)]);
  const loaded = structuredClone(b);
  const s = release(initial, b);
  assert.equal(s.orders.length, initial.orders.length + 1);
  const o = s.orders[0];
  assert.equal(o.expected, 4);
  assert.equal(o.actual, null);
  assert.equal(o.printed, false);
  assert.equal(o.dispatched, false);
  assert.equal(o.importId, b.id);
  assert.equal(o.importRowId, b.rows[0].id);
  assert.deepEqual(s.issues, initial.issues);
  assert.deepEqual(s.cartons, initial.cartons);
  // The document no longer carries uploads, and the loaded upload is not mutated.
  assert.equal(s.awbImports, undefined);
  assert.deepEqual(b, loaded);
  assert.match(s.events[0].detail, /Handoff confirmed · 1 new AWBs/);
  assert.equal(s.events[1].action, "AWB imported");
  // The database marks the upload confirmed; a retry on it is refused, and a retry before it
  // finds every label already in the list.
  assert.throws(() => release(s, { ...b, confirmedAt: "2026-09-21T10:00:00.000Z" }), /already/);
  assert.throws(() => release(s, b), /No new complete labels/);
  // The upload must be the one named in the command, and must come from the server.
  assert.throws(() => applyCommand(initial, { type: "import-release", input: { id: crypto.randomUUID() }, role: "admin", context: { import: b } }), /not found/);
  assert.throws(() => run(initial, "import-release", { id: b.id }), /not found/);
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
  assert.throws(() => release(createDraft(), b), /Resolve/);
  const original = b.rows[0];
  b.rows = original.lines.map((line, i) => ({
    ...original,
    id: crypto.randomUUID(),
    awb: `NVMYBRAND00000${i}`,
    lines: [line],
  }));
  const s = release(createDraft(), b);
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
  assert.throws(() => release(createDraft(), b, "management"), /admin/);
  assert.throws(() => release(createDraft(), b, "outbound"), /admin/);
  b.rows[1].excluded = true;
  b.rows[1].reviewNote = "Duplicate label supplied";
  const s = release(createDraft(), b);
  assert.equal(s.orders.filter((o) => o.importId === b.id).length, 1);
  assert.equal(s.orders[0].printed, false);
});

// Saving, receiving and the stale-review check moved to operator_import_save /
// operator_import_receive (supabase/tests/operator_access.test.sql, section 13).
test("saving and receiving uploads are no longer document commands", () => {
  const b = batch([page(ninja())]);
  assert.throws(() => run(createDraft(), "import-save", { batch: b }), /Unknown action/);
  assert.throws(() => run(createDraft(), "import-receive", { id: b.id, pic: "X" }, "outbound"), /Unknown action/);
});

test("upload effects: release, delete, and the label of a removed AWB", () => {
  const b = batch([page(ninja())]);
  const s = release(createDraft(), b);
  assert.deepEqual(importEffects("import-release", { id: b.id }, s), { release: b.id });
  assert.deepEqual(
    importEffects("import-delete", { id: b.id, reason: "  Wrong day  " }, s),
    { delete: b.id, reason: "Wrong day" },
  );
  const o = s.orders.find((x) => x.importId === b.id);
  assert.deepEqual(importEffects("remove-order", { id: o.id, reason: " Cancelled " }, s), {
    rows: [{ id: b.rows[0].id, excluded: true, reviewNote: "Removed: Cancelled" }],
  });
  // A manual AWB, an unknown AWB and other commands change no upload.
  const manual = s.orders.find((x) => !x.importId);
  assert.equal(importEffects("remove-order", { id: manual.id, reason: "x" }, s), null);
  assert.equal(importEffects("remove-order", { id: "missing", reason: "x" }, s), null);
  assert.equal(importEffects("pack", { id: o.id }, s), null);
  assert.equal(importEffects("order", {}, s), null);
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
  const s = release(createDraft(), b);
  assert.ok(s.orders.some((o) => o.awb === "NVMYTEST000001"));
});
test("upload limits: 10 PDFs, 2,500 pages and 1,200 labels per upload, enforced by the validator", () => {
  assert.equal(importLimit, 1200);
  assert.equal(pageLimit, 2500);
  assert.equal(fileLimit, 10);
  const big = batch(
    Array.from({ length: importLimit + 1 }, (_, i) =>
      page(ninja(`NVMYBIG${String(i).padStart(7, "0")}`, `BIG-${i}`), i + 1),
    ),
  );
  big.files = [{ ...file, pages: importLimit + 1 }];
  assert.equal(big.rows.length, importLimit + 1);
  assert.throws(() => validateImport(big), /Use up to 10 PDFs and 1200 labels/);
  big.rows.pop();
  validateImport(big);
  const wide = batch([page(ninja())]);
  wide.files = [{ ...file, pages: pageLimit + 1 }];
  assert.throws(() => validateImport(wide), /Invalid source file/);
  wide.files = [{ ...file, pages: pageLimit }];
  validateImport(wide);
  // Pages count across the files of one upload.
  const second = { ...file, id: "b".repeat(64), path: "tester/" + "b".repeat(64) + ".pdf" };
  wide.files = [{ ...file, pages: 1300 }, { ...second, pages: 1201 }];
  assert.throws(() => validateImport(wide), /Use up to 2500 PDF pages/);
  wide.files = [{ ...file, pages: 1300 }, { ...second, pages: 1200 }];
  validateImport(wide);
  const many = batch([page(ninja())]);
  many.files = Array.from({ length: fileLimit + 1 }, (_, i) => ({
    ...file, id: String(i).padStart(64, "c"), pages: 1,
  }));
  assert.throws(() => validateImport(many), /Use up to 10 PDFs/);
  // Upload and label identifiers are UUIDs (the tables' primary keys).
  assert.throws(() => validateImport({ ...batch([page(ninja())]), id: "imp1" }), /Invalid import/);
  const odd = batch([page(ninja())]);
  odd.rows[0].id = "row-1";
  assert.throws(() => validateImport(odd), /Invalid label record/);
});
