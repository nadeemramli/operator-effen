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
  assert.match(route, /JSON\.stringify\(legacy \? state : commitPayload\(state, importId, existed\)\)/);
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
