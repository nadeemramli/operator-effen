import test from "node:test";
import assert from "node:assert/strict";
import {
  OCR_NOTE,
  detectReferences,
  lastMileNote,
  importLimit,
  isLabelPage,
  pageLimit,
  needsOcr,
  mergeOcrText,
  pagesNeedingAwbOcr,
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
  // A released upload keeps its rows but no longer carries the raw extraction text.
  assert.ok(s.awbImports.find((x) => x.id === b.id).rows.every((r) => r.original === ""));
  assert.ok(run(initial, "import-save", { batch: b }).awbImports[0].rows.every((r) => r.original));
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

test("a source PDF over 1 MB and up to 20 MB is accepted on save", () => {
  const b = batch([page(ninja(), 1)]);
  b.files = [{ ...file, size: 1_500_000 }];
  validateImport(b);
  b.files[0].size = 20 * 1024 * 1024;
  validateImport(b);
  b.files[0].size = 20 * 1024 * 1024 + 1;
  assert.throws(() => validateImport(b), /Invalid source file/);
  b.files[0].size = 0;
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
test("upload limits: 300 labels and 600 pages per upload, enforced by the validator", () => {
  assert.equal(importLimit, 300);
  assert.equal(pageLimit, 600);
  const big = batch(
    Array.from({ length: importLimit + 1 }, (_, i) =>
      page(ninja(`NVMYBIG${String(i).padStart(7, "0")}`, `BIG-${i}`), i + 1),
    ),
  );
  big.files = [{ ...file, pages: importLimit + 1 }];
  assert.equal(big.rows.length, importLimit + 1);
  assert.throws(() => validateImport(big), /Use up to 10 PDFs and 300 labels/);
  big.rows.pop();
  validateImport(big);
  const wide = batch([page(ninja())]);
  wide.files = [{ ...file, pages: pageLimit + 1 }];
  assert.throws(() => validateImport(wide), /Invalid source file/);
  wide.files = [{ ...file, pages: pageLimit }];
  validateImport(wide);
});

// Shopee and TikTok prints often carry the order reference and products as text while the
// courier label (tracking number) is an image.
test("a page with an order reference but no tracking number anywhere in the file is read by OCR", () => {
  const label = page("Shopee\nOrder ID: 2410130ABCDEF1\nadipocyde2 1", 1);
  const packing = page("Order ID: 2410130ABCDEF1\nadipocyde2 1", 2);
  const tracked = page("SPX Shopee\nSPXMY04123456789A\nOrder ID: 2410130ABCDEF2", 3);
  const trackedPacking = page("Order ID: 2410130ABCDEF2\nadipocyde2 1", 4);
  const cover = page("Daily orders", 5);
  assert.deepEqual(
    pagesNeedingAwbOcr([label, packing, tracked, trackedPacking, cover]),
    [1, 2],
    "a packing list whose label was read is not OCR'd again",
  );
  assert.deepEqual(pagesNeedingAwbOcr([page("", 1, "ocr")]), []);
});

test("OCR adds the tracking number and courier but keeps the order and products from the text", () => {
  const text = "Order ID: 581234567890123456\nSeller SKU Qty\nsyn02 1";
  const ocr = "TikTok Shop J&T EXPRESS\n630012345678\nOrder ID: 58l234567890123456\nsyn03 1";
  const merged = mergeOcrText(text, ocr);
  const { rows } = parseImport([page(merged, 1, "ocr")], "Luxana", "");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].awb, "630012345678");
  assert.equal(rows[0].orderRef, "581234567890123456");
  assert.equal(rows[0].channel, "TikTok");
  assert.equal(rows[0].courier, "J&T");
  assert.deepEqual(rows[0].lines.map((l) => l.sku), ["syn02"]);
  assert.equal(mergeOcrText(text, "nothing useful"), text);
  // The label and its packing list now link into one ready row.
  const both = parseImport(
    [page(mergeOcrText("Shopee\nOrder ID: 2410130ABCDEF1", "SPXMY04123456789A"), 1, "ocr"),
      page("Order ID: 2410130ABCDEF1\nadipocyde2 1", 2)],
    "Shopee",
    "",
  );
  const live = both.rows.filter((r) => !r.excluded);
  assert.equal(live.length, 1);
  assert.equal(live[0].awb, "SPXMY04123456789A");
  assert.deepEqual(rowProblems(live[0]), []);
});

test("a parent SKU printed beside its variation is not a second product", () => {
  const rows = parsePages(
    [page("SPX Shopee\nSPXMY04123456789A\nOrder ID: 000100\nSKU: adipocyde\n[adipocyde6] 1", 1)],
    "Shopee",
    "",
  );
  assert.deepEqual(rows[0].lines.map((l) => l.sku), ["adipocyde6"]);
  // An unknown SKU that is not a parent of a known one still needs a decision.
  const other = parsePages([page("SPX Shopee\nSPXMY04123456789A\nOrder ID: 000100\nSKU: mystery9\nadipocyde6 1", 1)], "Shopee", "");
  assert.deepEqual(other[0].lines.map((l) => l.sku).sort(), ["adipocyde6", "mystery9"]);
});

test("TikTok's syn01 is the same 1-pack as syn01n", () => {
  assert.deepEqual(
    { ...defaultFor("syn01"), sku: "syn01n" },
    defaultFor("syn01n"),
  );
});

test("Glycoxil Singapore SKUs map to their box counts", () => {
  assert.deepEqual(
    ["gly01sg", "gly02sg", "gly05sg"].map((s) => [defaultFor(s)?.product, defaultFor(s)?.units, defaultFor(s)?.canonical]),
    [["gly", 1, "GLY-SG-PK1"], ["gly", 2, "GLY-SG-PK2"], ["gly", 5, "GLY-SG-PK32"]],
  );
  assert.equal(defaultFor("glycoxil05").canonical, "GLY-MY-PK32");
  const rows = parsePages([page("Ninja Van\nNVMYTEST000009\nOrder ID: 1234567\ngly05sg 1", 1)], "Luxana", "");
  assert.deepEqual(rowProblems(rows[0]), []);
});

test("SPX tracking printed as MY + digits + letter is read as the AWB", () => {
  const rows = parsePages(
    [page("Shopee SPX\nMY263140741048F\nSPX Express Website\nOrder ID: 261012F0E81C4A\nadipocyde2 1", 1)],
    "Shopee",
    "",
  );
  assert.equal(rows[0].awb, "MY263140741048F");
  assert.equal(rows[0].courier, "SPX");
  assert.equal(rows[0].orderRef, "261012F0E81C4A");
});

test("a TikTok label's bare tracking number is found by its repeats; the courier is Other", () => {
  const n = "680096552186413";
  const text = [n, "TT 500-C48-JH345 Z05", n, "Sender Synovil HQ", n, "Phone 601160912301",
    "Order ID: 581234567890123456", "Product Name SKU Seller SKU Qty",
    "Synovil Original Pakej 1 Botol syn01 1", n].join("\n");
  const rows = parsePages([page(text, 1)], "TikTok", "");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].awb, n);
  assert.equal(rows[0].courier, "Other");
  assert.equal(rows[0].orderRef, "581234567890123456");
  assert.deepEqual(rowProblems(rows[0]), []);
  // A long number printed once (a phone or order number) is not a tracking number.
  assert.deepEqual(detectReferences("Phone 601160912301\nOrder ID: 581234567890123456").tracking, []);
});

test("SPX tracking printed as MY + 13 digits with no letter is read as the AWB", () => {
  const rows = parsePages(
    [page("Shopee SPX\nMY2660933987983\nSPX Express Website\nShip By Date: 16-10-2026\nWeight (kg): 3.944000\nOrder ID: 261016QB741FC8\nSender Details (Pengirim)\nPhone: 601160912301\nPostcode:47150", 1)],
    "Shopee",
    "",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].awb, "MY2660933987983");
  assert.equal(rows[0].courier, "SPX");
  assert.equal(rows[0].orderRef, "261016QB741FC8");
  assert.ok(!rowProblems(rows[0]).some((p) => /AWB|Order reference/.test(p)));
});

test("a Ninja Van order keyed in by hand: Reference is the order reference, or the AWB stands in", () => {
  const withRef = parsePages(
    [page("Ninja Van\nNVMYEFISB000012797\nReference: LUX-7781\nProducts:\n1x Cavernosil [cave04]", 1)],
    "Luxana",
    "",
  );
  assert.equal(withRef[0].orderRef, "LUX-7781");
  assert.deepEqual(rowProblems(withRef[0]), []);
  const bare = parsePages(
    [page("Ninja Van\nNVMYEFISB000012804\nProducts:\n1x Cavernosil [cave04]", 1)],
    "Luxana",
    "",
  );
  assert.equal(bare[0].awb, "NVMYEFISB000012804");
  assert.equal(bare[0].orderRef, "NVMYEFISB000012804");
  assert.ok(bare[0].notes.includes("No order reference printed; the AWB stands in as the reference"));
  assert.deepEqual(rowProblems(bare[0]), []);
  // Two labels on one page still need review: the AWB cannot stand in for two parcels.
  const two = parsePages(
    [page("Ninja Van\nNVMYEFISB000012797\nNVMYEFISB000012799\nProducts:\n1x Cavernosil [cave04]", 1)],
    "Luxana",
    "",
  );
  assert.equal(two.length, 2);
  assert.ok(two.every((r) => r.orderRef === ""));
});

test("an SPX cross-border label keeps the Malaysia barcode number as the AWB and notes the Singapore last-mile number", () => {
  // Shopee Malaysia seller, Singapore buyer: MY number on the barcode and the label
  // edges, SG number printed once under the recipient (admin feedback, Oct 2026).
  const text =
    "MY2659094429639\nSPX EXPRESS\nATL #07-588\nOrder Details\nOrder ID: 261027Q03MJHTA\nAttempts 1 2 3\nRecipient Details\nName: Sazali Tumin\nAddress: BLOCK 294, TAMPINES STREET 22, #07-588\nPostcode: 520294\nCHN-52C-C18\nSG2680137171381\nMY2659094429639\nBuyer remark for seller\nTWJB JHB-SIP-WH-a\nShopee\nMY2659094429639\nMY2659094429639\nPacking List\nOrder ID: 261027Q03MJHTA package 1\nNo. Product Name SKU Variation Name Qty Unit Price Total\n1 Cavernosil cave04sg 3 Free 1 1 442.00 442.00";
  const refs = detectReferences(text);
  assert.deepEqual(refs.tracking, ["MY2659094429639"]);
  assert.deepEqual(refs.lastMile, ["SG2680137171381"]);
  const { rows } = parseImport([page(text)], "Shopee", "");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].awb, "MY2659094429639");
  assert.equal(rows[0].orderRef, "261027Q03MJHTA");
  assert.equal(rows[0].courier, "SPX");
  assert.equal(rows[0].channel, "Shopee");
  assert.equal(rows[0].lines.length, 1);
  assert.equal(rows[0].lines[0].sku, "cave04sg");
  assert.equal(rows[0].lines[0].packages, 1);
  assert.deepEqual(rows[0].warnings, []);
  assert.deepEqual(rows[0].notes, [lastMileNote("SG2680137171381")]);
  assert.deepEqual(rowProblems(rows[0]), []);
  // A text layer that OCR completes keeps the same single AWB.
  assert.equal(
    mergeOcrText("Order ID: 261027Q03MJHTA\n1 Cavernosil cave04sg 1", text),
    "Order ID: 261027Q03MJHTA\n1 Cavernosil cave04sg 1\nShopee\nTracking: MY2659094429639",
  );
  // A Singapore-only number (no Malaysia number on the page) is still the AWB.
  assert.deepEqual(detectReferences("SPX\nSG2680137171381\nOrder ID: 261027Q03MJHTA").tracking, [
    "SG2680137171381",
  ]);
});

test("an SPX Singapore tracking number (SPXSG…) is read like an SPX Malaysia one", () => {
  const { rows } = parseImport(
    [
      page(
        "Shopee SPX\nSPXSG012345678A\nOrder ID: 2510160SGTEST1\nPacking List\n1 Cavernosil cave04sg 3 Free 1 1 442.00 442.00",
      ),
    ],
    "Shopee",
    "",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].awb, "SPXSG012345678A");
  assert.equal(rows[0].courier, "SPX");
  assert.equal(rows[0].orderRef, "2510160SGTEST1");
  assert.equal(rows[0].lines.length, 1);
  assert.equal(rows[0].lines[0].sku, "cave04sg");
  assert.equal(rows[0].lines[0].units, 4);
  assert.deepEqual(rowProblems(rows[0]), []);
});
