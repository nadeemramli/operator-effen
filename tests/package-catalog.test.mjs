// The package SKU catalogue: built-in SKUs are the seed, and the office admin edits, retires
// and reactivates them (an override record in Draft.skuAliases) or adds new SKUs, without
// a developer. Synthetic SKUs and labels only.
import test from "node:test";
import assert from "node:assert/strict";
import {
  catalogSections,
  defaultFor,
  defaultPackageName,
  detectReferences,
  marketFor,
  packageCatalog,
  packageDefaults,
  parseImport,
  rowProblems,
  rowStatus,
  skuAliasLimit,
  skuAliasProblem,
} from "../apps/web/src/lib/awb-import.ts";
import { applyCommand, createDraft } from "../apps/web/src/lib/draft.ts";
import { outOfScopeKeys } from "../apps/web/src/lib/access.ts";

const file = {
  id: "c".repeat(64),
  name: "synthetic.pdf",
  path: "tester/" + "c".repeat(64) + ".pdf",
  pages: 10,
  size: 1000,
};
const page = (text, n = 1) => ({ file: file.id, page: n, text, method: "text" });
const run = (s, type, input, role = "admin") => applyCommand(s, { type, input, role });
const label = (sku, packages = 2, awb = "NVMYTEST000901", ref = "CAT-ORDER-1") =>
  `Ninja Van\n${awb}\nOrder: #${ref}\nProducts:\n${packages}x Product ${sku}`;
const parse = (s, text) => parseImport([page(text)], "Luxana", "", s.skuAliases).rows[0];
const entry = (s, sku) => packageCatalog(s).filter((e) => e.sku === sku);

test("the catalogue starts as the built-in seed: one active entry per SKU, named and placed by market", () => {
  const catalog = packageCatalog(createDraft());
  assert.equal(catalog.length, packageDefaults.length);
  assert.equal(new Set(catalog.map((e) => e.sku)).size, catalog.length);
  for (const e of catalog) {
    assert.equal(e.origin, "built-in");
    assert.equal(e.active, true);
    assert.equal(e.version, 0);
    assert.equal(e.id, undefined);
    assert.ok(e.name, e.sku);
    assert.equal(skuAliasProblem(e.sku), null, e.sku);
    // Every SG package code is in the SG market, every other one in MY.
    assert.equal(e.market, /(^|-)SG-/.test(e.canonical) ? "SG" : "MY", e.sku);
  }
  const by = (sku) => catalog.find((e) => e.sku === sku);
  assert.equal(by("cave04").name, "Cavernosil Pakej 3 Free 1");
  assert.equal(by("3free3mycaver").name, "Cavernosil Pakej 3 Free 3");
  assert.equal(by("3free3caver").name, "Cavernosil SG Pakej 3 Free 3");
  assert.equal(by("3free3caver").market, "SG");
  assert.equal(by("synovil03").market, "SG");
  assert.equal(by("syn01n").name, "Synovil Pakej 1N");
  assert.equal(by("lip04").name, "Lipidri Pakej 4 Free 2");
  // Sections per product and market, Malaysia first.
  const sections = catalogSections(catalog);
  assert.deepEqual(
    sections.slice(0, 2).map((x) => [x.key, x.title, x.entries.length]),
    [
      ["cav:MY", "Cavernosil", 4],
      ["cav:SG", "Cavernosil SG", 4],
    ],
  );
  assert.equal(
    sections.reduce((n, x) => n + x.entries.length, 0),
    catalog.length,
  );
  assert.equal(new Set(sections.map((x) => x.key)).size, sections.length);
});

test("editing a built-in's units creates an override, and labels with that SKU parse with the new units", () => {
  let s = createDraft();
  assert.equal(parse(s, label("syn04")).lines[0].units, 6);
  const input = { sku: "syn04", product: "syn", units: 7, expectedVersion: 0 };
  assert.throws(() => run(s, "sku-alias-save", input), /reason/);
  assert.throws(
    () => run(s, "sku-alias-save", { ...input, units: 6, reason: "x" }),
    /No package SKU details changed/,
  );
  const next = run(s, "sku-alias-save", { ...input, reason: "Box now holds 7" });
  assert.deepEqual(outOfScopeKeys("sku-alias-save", s, next), []);
  s = next;
  assert.equal(s.skuAliases.length, 1);
  const record = s.skuAliases[0];
  assert.equal(record.sku, "syn04");
  assert.equal(record.origin, "built-in");
  assert.equal(record.units, 7);
  assert.equal(record.canonical, "SYN-MY-PK42", "a blank package code keeps the built-in one");
  assert.equal(record.name, "Synovil Pakej 4 Free 2", "a blank name keeps the current one");
  assert.equal(record.market, "MY");
  assert.equal(record.version, 1);
  assert.deepEqual(
    record.history.map((h) => [h.kind, h.changes, h.reason]),
    [["edited", { units: ["6", "7"] }, "Box now holds 7"]],
  );
  assert.equal(s.events[0].action, "Built-in package SKU edited");
  assert.equal(s.events[0].entity, "sku-alias:" + record.id);
  // Resolution: the override wins over the built-in.
  assert.equal(defaultFor("SYN04", s.skuAliases).units, 7);
  const row = parse(s, label("syn04"));
  assert.deepEqual(row.lines, [
    { sku: "syn04", product: "syn", packages: 2, units: 7, originalUnits: 7, canonical: "SYN-MY-PK42" },
  ]);
  assert.deepEqual(rowProblems(row), []);
  // Still exactly one catalogue entry for the SKU, now carrying the record.
  const [e] = entry(s, "syn04");
  assert.equal(entry(s, "syn04").length, 1);
  assert.equal(packageCatalog(s).length, packageDefaults.length);
  assert.deepEqual(
    [e.origin, e.units, e.id, e.version, e.history.length, e.seed.units],
    ["built-in", 7, record.id, 1, 1, 6],
  );
  // A second admin who opened the untouched built-in is told it changed.
  assert.throws(
    () => run(s, "sku-alias-save", { ...input, units: 8, reason: "late" }),
    /changed by someone else/,
  );
  // Later edits go through the record; a built-in SKU keeps its SKU.
  s = run(s, "sku-alias-save", {
    id: record.id,
    expectedVersion: 1,
    sku: "syn04",
    product: "syn",
    units: 6,
    name: "Synovil Pakej 6",
    canonical: "SYN-MY-PK6",
    reason: "Back to 6, renamed",
  });
  assert.equal(defaultFor("syn04", s.skuAliases).canonical, "SYN-MY-PK6");
  assert.equal(entry(s, "syn04")[0].name, "Synovil Pakej 6");
  // Renaming the built-in: the new SKU takes over, the old code is kept retired and linked.
  s = run(s, "sku-alias-save", {
    id: record.id,
    expectedVersion: 2,
    sku: "syn6new",
    product: "syn",
    units: 6,
    reason: "Shop renamed the SKU",
  });
  assert.equal(defaultFor("syn6new", s.skuAliases).units, 6);
  assert.equal(defaultFor("syn6new", s.skuAliases).canonical, "SYN-MY-PK6");
  assert.equal(defaultFor("syn04", s.skuAliases), undefined);
  const [oldEntry] = entry(s, "syn04"), [newEntry] = entry(s, "syn6new");
  assert.equal(oldEntry.active, false);
  assert.equal(oldEntry.renamedTo, "syn6new");
  assert.equal(newEntry.renamedFrom, "syn04");
  assert.equal(newEntry.name, "Synovil Pakej 6");
  assert.equal(oldEntry.history.at(-1).kind, "renamed");
  assert.equal(s.events[0].action, "Package SKU renamed");
});

test("a built-in nobody changed yet can be renamed straight from the catalogue", () => {
  // The page names an untouched built-in by fromSku; a reason is required.
  const input = { fromSku: "cave04", expectedVersion: 0, sku: "cav-pk4", product: "cav", units: 4 };
  assert.throws(() => run(createDraft(), "sku-alias-save", input), /reason/);
  let s = run(createDraft(), "sku-alias-save", { ...input, reason: "Shop renamed it" });
  assert.equal(parse(s, label("cav-pk4")).lines[0].units, 4);
  assert.deepEqual(rowProblems(parse(s, label("cav-pk4"))), []);
  assert.equal(parse(s, label("cave04")).lines[0].product, "");
  const cav = catalogSections(packageCatalog(s)).find((x) => x.key === "cav:MY");
  assert.ok(cav.entries.some((e) => e.sku === "cav-pk4" && e.active && e.renamedFrom === "cave04"));
  assert.ok(cav.entries.some((e) => e.sku === "cave04" && !e.active && e.renamedTo === "cav-pk4"));
  // The old code can be accepted again while old labels are still printing it.
  s = run(s, "sku-alias-reactivate", { id: entry(s, "cave04")[0].id, reason: "Old labels still printing" });
  assert.equal(defaultFor("cave04", s.skuAliases).units, 4);
  // A rename cannot land on another built-in or an existing record, and a wrong fromSku fails.
  assert.throws(() => run(s, "sku-alias-save", { fromSku: "cave02", expectedVersion: 0, sku: "cave01", product: "cav", units: 1, reason: "x" }), /built-in package SKU/);
  assert.throws(() => run(s, "sku-alias-save", { fromSku: "cave02", expectedVersion: 0, sku: "cav-pk4", product: "cav", units: 4, reason: "x" }), /already in the catalogue/);
  assert.throws(() => run(s, "sku-alias-save", { fromSku: "nope99", expectedVersion: 0, sku: "cav-pk5", product: "cav", units: 5, reason: "x" }), /could not be found/);
});

test("an edited built-in flows through review and release with its new units", () => {
  let s = run(createDraft(), "sku-alias-save", {
    sku: "cave04",
    product: "cav",
    units: 5,
    reason: "Promotion box holds 5",
  });
  const rows = parseImport([page(label("cave04", 3))], "Luxana", "", s.skuAliases).rows;
  const batch = {
    id: crypto.randomUUID(),
    name: "Synthetic edited built-in",
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
  const order = s.orders.find((o) => o.awb === "NVMYTEST000901");
  assert.equal(order.expected, 15);
  assert.equal(order.package, "3 × cave04 (5)");
});

test("retiring a built-in hides it from parsing and shows it retired; reactivating restores it", () => {
  let s = createDraft();
  assert.throws(
    () => run(s, "sku-alias-reactivate", { sku: "cave04", reason: "x" }),
    /already active/,
  );
  assert.throws(() => run(s, "sku-alias-retire", { sku: "cave04" }), /reason/);
  assert.throws(
    () => run(s, "sku-alias-retire", { sku: "nosuchsku1", reason: "x" }),
    /could not be found/,
  );
  s = run(s, "sku-alias-retire", { sku: "cave04", reason: "Package withdrawn", expectedVersion: 0 });
  const record = s.skuAliases[0];
  assert.deepEqual(
    [record.sku, record.active, record.origin, record.units, record.version],
    ["cave04", false, "built-in", 4, 1],
  );
  assert.equal(s.events[0].action, "Package SKU retired");
  assert.equal(defaultFor("cave04", s.skuAliases), undefined);
  assert.deepEqual(detectReferences(label("cave04"), s.skuAliases).knownSkus, []);
  // The label keeps the SKU as a line without a product, so the review flags it.
  const row = parse(s, label("cave04"));
  assert.deepEqual(row.lines, [
    { sku: "cave04", product: "", packages: 2, units: null, originalUnits: null, canonical: "Manual mapping" },
  ]);
  assert.match(rowProblems(row).join(), /Complete product, SKU and package quantities/);
  const batch = { id: "b1", name: "x", date: "2026-10-16", files: [file], rows: [row], createdAt: "", updatedAt: "" };
  assert.equal(rowStatus(row, batch, s), "review");
  // Other built-ins are untouched.
  assert.equal(parse(s, label("cave02")).lines[0].units, 2);
  const [e] = entry(s, "cave04");
  assert.equal(e.active, false);
  assert.equal(entry(s, "cave04").length, 1);
  // Remembering the retired SKU from a label points to the catalogue instead.
  assert.throws(
    () => run(s, "sku-alias-save", { sku: "cave04", product: "cav", units: 4 }),
    /retired in the catalogue/,
  );
  assert.throws(
    () => run(s, "sku-alias-retire", { sku: "cave04", reason: "x", expectedVersion: 0 }),
    /changed by someone else/,
  );
  assert.throws(
    () => run(s, "sku-alias-retire", { id: record.id, reason: "again" }),
    /already retired/,
  );
  s = run(s, "sku-alias-reactivate", { id: record.id, reason: "Back on sale", expectedVersion: 1 });
  assert.equal(defaultFor("cave04", s.skuAliases).units, 4);
  assert.equal(parse(s, label("cave04")).lines[0].units, 4);
  assert.equal(entry(s, "cave04")[0].active, true);
  assert.deepEqual(
    s.skuAliases[0].history.map((h) => [h.kind, h.reason]),
    [
      ["retired", "Package withdrawn"],
      ["reactivated", "Back on sale"],
    ],
  );
  assert.equal(s.skuAliases.length, 1);
});

test("a renamed package SKU: add the new SKU and retire the old one", () => {
  let s = run(createDraft(), "sku-alias-save", {
    sku: "syn6pakej",
    product: "syn",
    units: 6,
    name: "Synovil Pakej 6",
  });
  s = run(s, "sku-alias-retire", { sku: "syn04", reason: "Shop renamed the SKU to syn6pakej" });
  assert.equal(parse(s, label("syn6pakej")).lines[0].units, 6);
  assert.deepEqual(rowProblems(parse(s, label("syn6pakej"))), []);
  assert.equal(parse(s, label("syn04")).lines[0].product, "");
  const syn = catalogSections(packageCatalog(s)).find((x) => x.key === "syn:MY");
  assert.ok(syn.entries.some((e) => e.sku === "syn6pakej" && e.origin === "custom"));
  assert.ok(syn.entries.some((e) => e.sku === "syn04" && !e.active));
});

test("a custom SKU lands in its product and market section with its name", () => {
  let s = run(createDraft(), "sku-alias-save", {
    sku: "cavpakej8",
    product: "cav",
    units: 8,
    name: "  Cavernosil   Pakej 8 ",
    market: "sg",
  });
  const record = s.skuAliases[0];
  assert.deepEqual(
    [record.name, record.market, record.origin, record.canonical],
    ["Cavernosil Pakej 8", "SG", "custom", "CAVPAKEJ8"],
  );
  assert.deepEqual(record.history[0].changes.market, ["", "SG"]);
  // Without a market or name, both are derived.
  s = run(s, "sku-alias-save", { sku: "lip10x", product: "lip", units: 10 });
  s = run(s, "sku-alias-save", { sku: "ady-pakej9-sg", product: "ady", units: 9, canonical: "ADI-SG-PK9" });
  s = run(s, "sku-alias-save", { sku: "glysg8", product: "gly", units: 8 });
  const by = (sku) => packageCatalog(s).find((e) => e.sku === sku);
  assert.deepEqual([by("lip10x").market, by("lip10x").name], ["MY", "Lipidri · lip10x"]);
  assert.deepEqual([by("ady-pakej9-sg").market, by("ady-pakej9-sg").name], ["SG", "Adypocide SG Pakej 9"]);
  assert.equal(by("glysg8").market, "SG");
  const sections = catalogSections(packageCatalog(s));
  const cavSg = sections.find((x) => x.key === "cav:SG");
  assert.equal(cavSg.entries.length, 5);
  assert.equal(cavSg.entries.at(-1).sku, "cavpakej8");
  assert.equal(cavSg.entries.at(-1).name, "Cavernosil Pakej 8");
  assert.equal(sections.find((x) => x.key === "cav:MY").entries.length, 4);
  assert.ok(sections.find((x) => x.key === "ady:SG").entries.some((e) => e.sku === "ady-pakej9-sg"));
  // One entry per SKU across built-ins and custom SKUs.
  const catalog = packageCatalog(s);
  assert.equal(catalog.length, packageDefaults.length + 4);
  assert.equal(new Set(catalog.map((e) => e.sku)).size, catalog.length);
  // A label with the custom SKU resolves.
  assert.equal(parse(s, label("cavpakej8")).lines[0].units, 8);
  // Bad markets and long names are refused; product names are still not SKUs.
  const base = { sku: "cav-pk9", product: "cav", units: 9 };
  assert.throws(() => run(s, "sku-alias-save", { ...base, market: "ID" }), /market/);
  assert.throws(() => run(s, "sku-alias-save", { ...base, name: "x".repeat(81) }), /shorter display name/);
  assert.throws(() => run(s, "sku-alias-save", { ...base, sku: "cavernosil" }), /product name/);
  // A custom SKU cannot be renamed onto a built-in one.
  assert.throws(
    () => run(s, "sku-alias-save", { ...base, id: record.id, sku: "cave02", reason: "x" }),
    /built-in package SKU/,
  );
});

test("records saved before the catalogue get a name and market when read", () => {
  const s = run(createDraft(), "sku-alias-save", {
    sku: "8botolsg",
    product: "syn",
    units: 8,
    canonical: "SYN-SG-PK8",
  });
  delete s.skuAliases[0].name;
  delete s.skuAliases[0].market;
  delete s.skuAliases[0].origin;
  const e = packageCatalog(s.skuAliases).find((x) => x.sku === "8botolsg");
  assert.deepEqual(
    [e.name, e.market, e.origin, e.active],
    ["Synovil SG Pakej 8", "SG", "custom", true],
  );
  assert.equal(marketFor("adiposg2"), "SG");
  assert.equal(marketFor("adipocyde2", "ADI-MY-PK2"), "MY");
  assert.equal(defaultPackageName({ sku: "x9", product: "gly", units: 5, canonical: "GLY-MY-PK32" }), "Glycoxil Pakej 3 Free 2");
});

test("built-in overrides count toward the record limit", () => {
  const s = createDraft();
  s.skuAliases = Array.from({ length: skuAliasLimit }, (_, i) => ({
    id: "r" + i,
    sku: "filler" + i,
    product: "cav",
    units: 1,
    canonical: "F" + i,
    active: true,
    createdAt: "",
    updatedAt: "",
    version: 1,
    history: [],
  }));
  assert.throws(
    () => run(s, "sku-alias-retire", { sku: "cave01", reason: "x" }),
    new RegExp(String(skuAliasLimit)),
  );
  assert.throws(
    () => run(s, "sku-alias-save", { sku: "cave01", product: "cav", units: 2, reason: "x" }),
    new RegExp(String(skuAliasLimit)),
  );
});
