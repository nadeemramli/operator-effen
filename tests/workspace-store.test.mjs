import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  commitPayload,
  legacyDocument,
  touchedImport,
} from "../apps/web/src/lib/workspace-store.ts";
import { applyCommand, createDraft, previewCapabilities } from "../apps/web/src/lib/draft.ts";

const route = readFileSync(
  new URL("../apps/web/src/app/api/draft/route.ts", import.meta.url),
  "utf8",
);
const upload = (id, rows = []) => ({
  id,
  date: "2026-10-14",
  name: "Synthetic upload",
  files: [],
  rows,
  createdAt: "",
  updatedAt: "",
});

test("each upload command names the one upload it touches", () => {
  const s = createDraft();
  s.orders = [{ id: "o1", importId: "imp1" }, { id: "o2" }];
  assert.equal(touchedImport("import-save", { batch: { id: "imp1" } }, s), "imp1");
  assert.equal(touchedImport("import-save", { batch: "imp1" }, s), undefined);
  for (const type of ["import-release", "import-receive", "import-delete"])
    assert.equal(touchedImport(type, { id: "imp2" }, s), "imp2");
  assert.equal(touchedImport("remove-order", { id: "o1" }, s), "imp1");
  assert.equal(touchedImport("remove-order", { id: "o2" }, s), undefined);
  assert.equal(touchedImport("issue", { id: "imp1" }, s), undefined);
});

test("the signed commit carries only the touched upload, or its removal", () => {
  const s = { ...createDraft(), awbImports: [upload("imp1"), upload("imp9")] };
  assert.deepEqual(commitPayload(s, "imp1", true).awbImports, [upload("imp1")]);
  assert.deepEqual(commitPayload(s, "gone", true).awbImports, [{ id: "gone", deleted: true }]);
  // Nothing existed and nothing was made: the payload names no upload at all.
  assert.equal("awbImports" in commitPayload(s, "never", false), false);
  assert.equal("awbImports" in commitPayload(s, undefined, false), false);
  assert.deepEqual(commitPayload(s, undefined, false).events, s.events);
});

test("a document that still holds uploads is saved as before (migration not applied)", () => {
  assert.equal(legacyDocument({ ...createDraft(), awbImports: [] }), true);
  const { awbImports: _, ...doc } = createDraft();
  assert.equal(legacyDocument(doc), false);
  assert.match(route, /JSON\.stringify\(legacy \? state : commitPayload\(state, importId, existed, ops\)\)/);
});

test("saving an opened list entry drops its summary counts", () => {
  const b = upload("imp1");
  b.rowCount = 0;
  b.releasedCount = 0;
  const s = applyCommand(createDraft(), {
    type: "import-save",
    role: "admin",
    input: { batch: b },
    capabilities: previewCapabilities("admin"),
    actor: { kind: "preview", role: "admin", name: "Admin (test view)", userId: "u" },
  });
  const saved = s.awbImports.find((x) => x.id === "imp1");
  assert.equal("rowCount" in saved, false);
  assert.equal("releasedCount" in saved, false);
});

test("orders older than 7 days by Malaysia time are due for the archive", async () => {
  const { archiveCutoff, needsArchive } = await import("../apps/web/src/lib/workspace-store.ts");
  // 2026-10-16 01:30 in Kuala Lumpur is still 2026-10-15 in UTC.
  const now = new Date("2026-10-15T17:30:00Z");
  assert.equal(archiveCutoff(now), "2026-10-09");
  const doc = (dates) => ({ ...createDraft(), orders: dates.map((date, i) => ({ id: "o" + i, date })) });
  assert.equal(needsArchive(doc(["2026-10-09", "2026-10-16"]), now), false);
  assert.equal(needsArchive(doc(["2026-10-08"]), now), true);
  assert.equal(needsArchive(doc(["", "not-a-date"]), now), false);
  assert.match(route, /needsArchive\(loaded\.data\.state as Draft\)/);
  assert.match(route, /state\.orders = state\.orders\.filter\(\(o\) => !archivedIds\.has\(o\.id\)\)/);
});

test("each order command loads the orders it reads: by ID, AWB, work date or upload", async () => {
  const { orderNeeds } = await import("../apps/web/src/lib/workspace-store.ts");
  assert.deepEqual(orderNeeds("order", { awb: " nvmy 1 " }), { ids: [], awbs: ["NVMY1"], dates: [], imports: [] });
  assert.deepEqual(orderNeeds("edit-order", { id: "o1", awb: "x2" }).ids, ["o1"]);
  assert.deepEqual(orderNeeds("split-order", { id: "o1", awb_cav: "a1", awb_ady: "a2", pic: "p" }).awbs, ["A1", "A2"]);
  for (const type of ["review-order", "remove-order", "print", "pack", "pack-own", "correct", "dispatch"])
    assert.deepEqual(orderNeeds(type, { id: "o9" }).ids, ["o9"], type);
  assert.deepEqual(orderNeeds("issue", { orderId: "o3", cartonId: "c" }).ids, ["o3"]);
  assert.deepEqual(orderNeeds("assign-orders", { ids: ["a", "b", 3] }).ids, ["a", "b"]);
  assert.deepEqual(orderNeeds("assign-package", { date: "2026-10-16" }).dates, ["2026-10-16"]);
  assert.deepEqual(orderNeeds("sort-count", { date: "nope" }).dates, []);
  assert.deepEqual(orderNeeds("import-delete", { id: "imp1" }).imports, ["imp1"]);
  const state = { ...createDraft(), awbImports: [upload("imp1", [{ awb: "nv 1" }, { awb: "nv2" }])] };
  assert.deepEqual(orderNeeds("import-release", { id: "imp1" }, state).awbs, ["NV1", "NV2"]);
  assert.deepEqual(orderNeeds("batch", { id: "b1" }), { ids: [], awbs: [], dates: [], imports: [] });
});

test("a save sends only created, changed and removed orders, each with the version it read", async () => {
  const { orderOps, mergeOrders } = await import("../apps/web/src/lib/workspace-store.ts");
  const a = { id: "a", awb: "A", actual: null }, b = { id: "b", awb: "B" }, c = { id: "c", awb: "C" };
  const before = { orders: [a, b, c], versions: new Map([["a", 3], ["b", 1], ["c", 7]]) };
  const ops = orderOps(before, [{ ...a, actual: 2 }, b, { id: "d", awb: "D" }]);
  assert.deepEqual(ops, [
    { op: "put", order: { ...a, actual: 2 }, expected: 3 },
    { op: "put", order: { id: "d", awb: "D" }, expected: null },
    { op: "delete", id: "c", expected: 7 },
  ]);
  assert.deepEqual(orderOps(before, [a, b, c]), []);
  assert.deepEqual(
    mergeOrders([a, b, c], { put: [{ ...a, actual: 2 }, { id: "d", awb: "D" }], removed: ["c"] }).map((o) => o.id),
    ["a", "d", "b"],
  );
});

test("screens ask for at most 7 work dates, today in Malaysia by default", async () => {
  const { viewDates, todayMyt } = await import("../apps/web/src/lib/workspace-store.ts");
  const now = new Date("2026-10-15T17:30:00Z");
  assert.equal(todayMyt(now), "2026-10-16");
  assert.deepEqual(viewDates(null, now), ["2026-10-16"]);
  assert.deepEqual(viewDates("2026-10-15,bad,2026-10-15", now), ["2026-10-15"]);
  assert.equal(viewDates(Array.from({ length: 9 }, (_, i) => `2026-10-0${i + 1}`), now).length, 7);
});

test("assigning or issuing selected AWBs also loads their work dates for the supervisor count", async () => {
  const { dayNeeds } = await import("../apps/web/src/lib/workspace-store.ts");
  const orders = [{ id: "a", date: "2026-10-16" }, { id: "b", date: "2026-10-16" }, { id: "c", date: "2026-10-15" }];
  assert.deepEqual(dayNeeds("assign-orders", orders).dates, ["2026-10-16", "2026-10-15"]);
  assert.deepEqual(dayNeeds("issue-orders", orders).dates.length, 2);
  assert.deepEqual(dayNeeds("print-orders", orders).dates, []);
  assert.match(route, /dayNeeds\(type, loadedOrders\.orders\)/);
});
