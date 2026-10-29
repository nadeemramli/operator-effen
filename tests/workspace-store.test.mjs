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
/**
 * A database whose set-returning functions answer like PostgREST: `rows(name, args)` gives
 * the whole result (or an error object), and each request gets at most PAGE_ROWS of it
 * from the range it asked for, in order.
 */
function fakeDb(rows, cap = 1000) {
  const requests = [];
  const db = {
    requests,
    rpc(name, args) {
      const req = { name, args, order: [], from: 0, to: cap - 1 };
      requests.push(req);
      const builder = {
        order(column, opts) {
          req.order.push([column, opts]);
          return builder;
        },
        range(from, to) {
          req.from = from;
          req.to = to;
          return builder;
        },
        then(resolve, reject) {
          const all = rows(name, args);
          const result =
            Array.isArray(all)
              ? { data: all.slice(req.from, Math.min(req.to + 1, req.from + cap)), error: null }
              : { data: null, error: all };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return db;
}
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
  assert.match(route, /legacy\s+\? state\s+: commitPayload\(/);
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

test("stock issues: real issues of loaded orders, plus each carton's totals per day and before the window", async () => {
  const { hydrateIssues, addedIssues, commitPayload } = await import("../apps/web/src/lib/workspace-store.ts");
  const now = new Date("2026-10-16T02:00:00Z"); // window starts 2026-08-15
  const calls = [];
  const db = fakeDb((name, args) => {
    calls.push([name, args]);
    if (name === "operator_issue_totals")
      return [
        { carton_id: "c1", day: "2026-10-16", qty: 5 },
        { carton_id: "c1", day: null, qty: 7 },
        { carton_id: "c2", day: "2026-10-15", qty: 2 },
      ];
    return [{ body: { id: "i1", cartonId: "c1", orderId: "o1", qty: 3, pic: "P", at: "2026-10-16T01:00:00Z" } }];
  });
  const h = await hydrateIssues(db, "w", { ids: ["o1"], dates: [] }, now);
  assert.equal(calls[0][1].p_since, "2026-08-15");
  const byId = Object.fromEntries(h.issues.map((i) => [i.id, i]));
  assert.equal(byId.i1.qty, 3);
  assert.equal(byId["total:c1:2026-10-16"].qty, 2); // 5 that day, 3 of them loaded
  assert.equal(byId["total:c1:before"].qty, 7);
  assert.equal(byId["total:c1:before"].at, "2026-08-14T04:00:00.000Z");
  assert.equal(byId["total:c2:2026-10-15"].qty, 2);
  // Every unit is counted exactly once per carton.
  const sum = (c) => h.issues.filter((i) => i.cartonId === c).reduce((n, i) => n + i.qty, 0);
  assert.deepEqual([sum("c1"), sum("c2")], [12, 2]);
  const added = { id: "i9", cartonId: "c2", orderId: "o1", qty: 1, pic: "P", at: "t" };
  assert.deepEqual(addedIssues(h, [added, ...h.issues]), [added]);
  assert.deepEqual(commitPayload({ ...createDraft(), issues: h.issues }, undefined, false, [], [added]).issues, [added]);
  // Before the migration (no such function) the document keeps every issue.
  const old = fakeDb(() => ({ code: "PGRST202" }));
  assert.equal(await hydrateIssues(old, "w", { ids: [], dates: [] }, now), null);
});

test("a work day of more than 1,000 AWBs loads whole: every read pages past PostgREST's row cap", async () => {
  const { loadOrders, hydrateIssues, PAGE_ROWS } = await import("../apps/web/src/lib/workspace-store.ts");
  // The page size is the cap itself: a larger page would be cut short and end the loop early.
  const config = readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8");
  assert.equal(PAGE_ROWS, Number(config.match(/^max_rows = (\d+)$/m)[1]));
  // 2026-10-29 on the operator site: 1,745 AWBs, and the screen showed 1,000 of them.
  const day = Array.from({ length: 1745 }, (_, i) => ({
    doc: { id: "o" + String(i).padStart(4, "0"), awb: "A" + i, date: "2026-10-29", product: i < 832 ? "ady" : "cav", expected: 7 },
    version: i % 3,
  }));
  const db = fakeDb((name) => (name === "operator_orders_for" ? day : []));
  const loaded = await loadOrders(db, "w", { ids: [], awbs: [], dates: ["2026-10-29"], imports: [] });
  assert.equal(loaded.orders.length, 1745);
  assert.equal(loaded.orders.filter((o) => o.product === "ady").length, 832);
  assert.equal(loaded.versions.get("o1744"), 1744 % 3);
  assert.deepEqual(db.requests.map((r) => [r.from, r.to]), [[0, 999], [1000, 1999]]);
  // Exactly a full page still asks once more, and finds nothing.
  const full = fakeDb(() => day.slice(0, 1000));
  assert.equal((await loadOrders(full, "w", { ids: ["x"], awbs: [], dates: [], imports: [] })).orders.length, 1000);
  assert.equal(full.requests.length, 2);
  // A failed page is the whole read failing, never a short result.
  const broken = fakeDb(() => ({ code: "XX000" }));
  await assert.rejects(loadOrders(broken, "w", { ids: ["x"], awbs: [], dates: [], imports: [] }), /Unable to load/);
  // Stock issues and carton totals page the same way; totals, grouped in SQL, ask for an order.
  const issues = Array.from({ length: 1200 }, (_, i) => ({ body: { id: "i" + i, cartonId: "c" + (i % 40), orderId: "o" + i, qty: 1, pic: "P", at: "2026-10-29T01:00:00Z" } }));
  // 40 cartons with one total on each of 60 earlier days: 2,400 rows, three pages.
  const dayAt = (n) => new Date(Date.UTC(2026, 7, 29) + n * 86400000).toISOString().slice(0, 10);
  const totals = Array.from({ length: 2400 }, (_, i) => ({ carton_id: "c" + Math.floor(i / 60), day: dayAt(i % 60), qty: 1 }));
  const stock = fakeDb((name) => (name === "operator_issue_totals" ? totals : issues));
  const h = await hydrateIssues(stock, "w", { ids: ["o1"], dates: ["2026-10-29"] }, new Date("2026-10-29T02:00:00Z"));
  assert.equal(h.issues.filter((i) => !i.id.startsWith("total:")).length, 1200);
  assert.equal(h.issues.reduce((n, i) => n + i.qty, 0), 1200 + 2400);
  const totalRequests = stock.requests.filter((r) => r.name === "operator_issue_totals");
  assert.deepEqual(totalRequests.map((r) => [r.from, r.to]), [[0, 999], [1000, 1999], [2000, 2999]]);
  assert.deepEqual(totalRequests[0].order.map(([c]) => c), ["carton_id", "day"]);
  assert.deepEqual(stock.requests.filter((r) => r.name === "operator_issues_for").map((r) => [r.from, r.to]), [[0, 999], [1000, 1999]]);
});
