// Package SKU catalogue records: the office admin adds a new SKU once and later AWB imports
// resolve it like a built-in default. Synthetic SKUs and labels only (see also
// package-catalog.test.mjs for built-in overrides and the catalogue view).
import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultFor,
  detectReferences,
  isLabelPage,
  packageDefaults,
  parseImport,
  rowProblems,
  rowStatus,
  skuAliasProblem,
} from "../apps/web/src/lib/awb-import.ts";
import { applyCommand, createDraft } from "../apps/web/src/lib/draft.ts";
import { effectiveCapabilities, outOfScopeKeys } from "../apps/web/src/lib/access.ts";

const file = {
  id: "b".repeat(64),
  name: "synthetic.pdf",
  path: "tester/" + "b".repeat(64) + ".pdf",
  pages: 10,
  size: 1000,
};
const page = (text, n = 1) => ({ file: file.id, page: n, text, method: "text" });
const run = (s, type, input, role = "admin") =>
  applyCommand(s, { type, input, role });
const member = (role, capabilities = effectiveCapabilities(role)) => (s, type, input) =>
  applyCommand(s, {
    type,
    input,
    role,
    actor: { kind: "member", role, name: "Synthetic " + role, userId: "u-" + role, siteId: "site-a" },
    capabilities,
  });
// "8botolsg" does not look like a built-in SKU (it starts with a digit), so only the mapping
// can find it in the label text.
const synLabel = (awb = "NVMYTEST000801", ref = "SKU-ORDER-1") =>
  `Ninja Van\n${awb}\nOrder: #${ref}\nProducts:\n2x Synovil 8botolsg`;
const withAlias = () =>
  run(createDraft(), "sku-alias-save", {
    sku: " 8BOTOLSG ",
    product: "syn",
    units: 8,
    canonical: "SYN-SG-PK8",
  });

test("an admin maps a new SKU once; a label with that SKU then parses completely", () => {
  const s = withAlias();
  const alias = s.skuAliases[0];
  assert.equal(alias.sku, "8botolsg");
  assert.equal(alias.product, "syn");
  assert.equal(alias.units, 8);
  assert.equal(alias.canonical, "SYN-SG-PK8");
  assert.equal(alias.active, true);
  assert.equal(alias.version, 1);
  assert.equal(alias.history[0].kind, "created");
  assert.equal(s.events[0].action, "Package SKU added");
  assert.equal(s.events[0].entity, "sku-alias:" + alias.id);
  // The catalogue: built-ins, plus the site's own SKUs.
  assert.equal(defaultFor("8botolsg"), undefined);
  assert.equal(defaultFor("8BotolSG", s.skuAliases).units, 8);
  assert.equal(defaultFor("cave01", s.skuAliases).canonical, "CAV-MY-PK1");

  const { rows } = parseImport([page(synLabel())], "Luxana", "", s.skuAliases);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].lines, [
    {
      sku: "8botolsg",
      product: "syn",
      packages: 2,
      units: 8,
      originalUnits: 8,
      canonical: "SYN-SG-PK8",
    },
  ]);
  assert.deepEqual(rowProblems(rows[0]), []);
  // Without the mapping the same label has no product line.
  const before = parseImport([page(synLabel())], "Luxana", "").rows[0];
  assert.deepEqual(before.lines, []);
  assert.match(rowProblems(before).join(), /Product details missing/);
});

test("a mapped SKU is found like a built-in: label pages, references, packing tables and parent SKUs", () => {
  const s = withAlias();
  const aliases = s.skuAliases;
  assert.equal(isLabelPage(page("8botolsg x 2")), false);
  assert.ok(isLabelPage(page("8botolsg x 2"), aliases));
  assert.deepEqual(detectReferences(synLabel(), aliases).knownSkus, ["8botolsg"]);
  // Packing-table quantity: the right-most integer before two prices.
  const table = parseImport(
    [
      page(
        "SPX Shopee\nSPXMYTEST000801\nOrder ID: 0000800001\nPacking List\n1 Synovil 8botolsg 3 196.00 588.00",
      ),
    ],
    "Shopee",
    "",
    aliases,
  ).rows[0];
  assert.equal(table.lines.length, 1);
  assert.equal(table.lines[0].packages, 3);
  assert.equal(table.lines[0].units, 8);
  // A mapped variation printed beside its parent SKU gives one line, not two.
  const variation = run(s, "sku-alias-save", { sku: "synpk8", product: "syn", units: 8 });
  const parent = parseImport(
    [page("Ninja Van\nNVMYTEST000802\nOrder: #SKU-ORDER-2\nSeller SKU: synpk\n1 x synpk8")],
    "Luxana",
    "",
    variation.skuAliases,
  ).rows[0];
  assert.deepEqual(
    parent.lines.map((l) => [l.sku, l.packages, l.units]),
    [["synpk8", 1, 8]],
  );
  assert.deepEqual(rowProblems(parent), []);
});

test("a mapped SKU flows through review and release into the order quantity", () => {
  let s = withAlias();
  const rows = parseImport([page(synLabel())], "Luxana", "", s.skuAliases).rows;
  const batch = {
    id: crypto.randomUUID(),
    name: "Synthetic mapped SKU",
    date: "2026-10-16",
    files: [file],
    rows,
    createdAt: "",
    updatedAt: "",
  };
  s = run(s, "import-save", { batch });
  const saved = s.awbImports.find((b) => b.id === batch.id);
  assert.equal(rowStatus(saved.rows[0], saved, s), "ready");
  s = run(s, "import-release", { id: batch.id });
  const order = s.orders.find((o) => o.awb === "NVMYTEST000801");
  assert.equal(order.product, "syn");
  assert.equal(order.expected, 16);
  assert.equal(order.package, "2 × 8botolsg (8)");
});

test("a retired mapping no longer resolves; reactivating it restores it", () => {
  let s = withAlias();
  const id = s.skuAliases[0].id;
  assert.throws(() => run(s, "sku-alias-retire", { id }), /reason/);
  s = run(s, "sku-alias-retire", { id, reason: "Package discontinued", expectedVersion: 1 });
  assert.equal(s.skuAliases.length, 1, "retired mappings are kept");
  assert.equal(s.skuAliases[0].active, false);
  assert.equal(s.skuAliases[0].version, 2);
  assert.equal(s.events[0].action, "Package SKU retired");
  assert.equal(defaultFor("8botolsg", s.skuAliases), undefined);
  // The retired SKU stays on the label as a line without a product, for review.
  const retired = parseImport([page(synLabel())], "Luxana", "", s.skuAliases).rows[0];
  assert.deepEqual(retired.lines, [
    { sku: "8botolsg", product: "", packages: 2, units: null, originalUnits: null, canonical: "Manual mapping" },
  ]);
  assert.match(rowProblems(retired).join(), /Complete product, SKU and package quantities/);
  // A declared SKU stays visible for review, without a product.
  const declared = parseImport(
    [page("AWB: TEST-RETIRED1\nOrder ID: TEST-R1\nSKU: 8botolsg Qty: 1")],
    "Luxana",
    "",
    s.skuAliases,
  ).rows[0];
  assert.equal(declared.lines[0].product, "");
  assert.equal(declared.lines[0].canonical, "Manual mapping");
  assert.throws(() => run(s, "sku-alias-retire", { id, reason: "again" }), /already retired/);
  assert.throws(
    () => run(s, "sku-alias-save", { sku: "8botolsg", product: "syn", units: 8 }),
    /retired in the catalogue/,
  );
  s = run(s, "sku-alias-reactivate", { id, reason: "Back in the catalogue" });
  assert.equal(defaultFor("8botolsg", s.skuAliases).units, 8);
  assert.deepEqual(
    s.skuAliases[0].history.map((h) => h.kind),
    ["created", "retired", "reactivated"],
  );
});

test("unknown products, invalid units and unsafe SKUs are refused; a built-in SKU is edited with a reason", () => {
  const s = createDraft();
  const save = (input) =>
    run(s, "sku-alias-save", { sku: "lip09sg", product: "lip", units: 9, ...input });
  // Saving a built-in SKU edits it (an override record), so it needs a reason like any edit.
  assert.throws(() => save({ sku: " CAVE01 " }), /reason/);
  for (const p of packageDefaults.slice(0, 5))
    assert.throws(() => save({ sku: p.sku }), /reason/);
  const edited = save({ sku: " CAVE01 ", product: "cav", units: 2, reason: "Box count changed" });
  assert.equal(edited.skuAliases.length, 1);
  assert.equal(edited.skuAliases[0].sku, "cave01");
  assert.equal(edited.skuAliases[0].origin, "built-in");
  assert.equal(defaultFor("cave01", edited.skuAliases).units, 2);
  assert.throws(() => save({ product: "nurokids" }), /Choose the product/);
  assert.throws(() => save({ product: "" }), /Choose the product/);
  for (const units of [0, -1, 1001, 2.5, "", null, "abc"])
    assert.throws(() => save({ units }), /whole number from 1 to 1000/, String(units));
  assert.equal(save({ units: "1000" }).skuAliases[0].units, 1000);
  for (const sku of ["", "ab", "lip 09", "lip/09", "-lip09", "lip09-", "12345", "lipidri", "SYN", "x".repeat(41)]) {
    assert.ok(skuAliasProblem(sku), sku);
    assert.throws(() => save({ sku }), Error, sku);
  }
  assert.equal(skuAliasProblem("ady-pakej_9"), null);
  assert.throws(() => save({ canonical: "x".repeat(61) }), /shorter package label/);
  // Without a label the SKU itself names the package.
  assert.equal(save({}).skuAliases[0].canonical, "LIP09SG");
  // One mapping per SKU.
  const once = save({});
  assert.throws(
    () => run(once, "sku-alias-save", { sku: "LIP09SG", product: "lip", units: 9 }),
    /already in the catalogue/,
  );
});

test("only the import capability maps SKUs", () => {
  const s = createDraft();
  const input = { sku: "lip09sg", product: "lip", units: 9 };
  for (const role of ["outbound", "production", "intake", "hr", "management", "packer", "driver"]) {
    assert.throws(() => run(s, "sku-alias-save", input, role), Error, role);
    assert.throws(() => member(role)(s, "sku-alias-save", input), /does not permit/, role);
  }
  // An admin whose site policy removes PDF imports cannot map SKUs either.
  assert.throws(
    () => member("admin", ["orders.enter", "sources.read"])(s, "sku-alias-save", input),
    /does not permit/,
  );
  const next = member("admin")(s, "sku-alias-save", input);
  assert.equal(next.skuAliases[0].history[0].recordedBy.userId, "u-admin");
  assert.equal(next.events[0].recorder.userId, "u-admin");
  assert.deepEqual(outOfScopeKeys("sku-alias-save", s, next), []);
});

test("an edit needs a reason, records history and refuses a stale version", () => {
  let s = run(createDraft(), "sku-alias-save", { sku: "ady09", product: "ady", units: 8 });
  const id = s.skuAliases[0].id;
  const edit = { id, sku: "ady09", product: "ady", units: 9, expectedVersion: 1 };
  assert.throws(() => run(s, "sku-alias-save", edit), /reason/);
  assert.throws(
    () => run(s, "sku-alias-save", { ...edit, units: 8, reason: "x" }),
    /No package SKU details changed/,
  );
  s = run(s, "sku-alias-save", { ...edit, canonical: "ADI-MY-PK9", reason: "Box count confirmed" });
  const alias = s.skuAliases[0];
  assert.equal(alias.units, 9);
  assert.equal(alias.canonical, "ADI-MY-PK9");
  assert.equal(alias.version, 2);
  assert.deepEqual(alias.history[1].changes, {
    units: ["8", "9"],
    canonical: ["ADY09", "ADI-MY-PK9"],
  });
  assert.equal(alias.history[1].reason, "Box count confirmed");
  assert.equal(alias.history[1].recordedBy.role, "admin");
  assert.equal(s.events[0].action, "Package SKU edited");
  assert.match(s.events[0].detail, /units: 8 → 9/);
  assert.throws(
    () => run(s, "sku-alias-save", { ...edit, units: 7, reason: "late", expectedVersion: 1 }),
    /changed by someone else/,
  );
  // Renaming onto another catalogue SKU or onto a built-in is refused.
  s = run(s, "sku-alias-save", { sku: "ady09sg", product: "ady", units: 9 });
  assert.throws(
    () => run(s, "sku-alias-save", { id, sku: "ady09sg", product: "ady", units: 9, reason: "x" }),
    /already in the catalogue/,
  );
  assert.throws(
    () => run(s, "sku-alias-save", { id, sku: "adipocyde8", product: "ady", units: 9, reason: "x" }),
    /built-in/,
  );
  assert.throws(() => run(s, "sku-alias-retire", { id: "missing", reason: "x" }), /could not be found/);
});
