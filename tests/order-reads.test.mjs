// Reading order records (order volume plan WP C, PR C3; design sections 5 and 6): query
// parsing, the day marker as an ETag, CSV lines, the day summary the server computes from
// operator_orders_day (parity with the document-mode screens), the issue-stock AWB ids, the
// packer projection and the AWB reader list against the migration.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  applyCommand,
  createDraft,
  demandFingerprint,
  orderHasActivity,
  orderIssued,
  orderLines,
  orderReady,
  product,
  products,
  recorderLabel,
  today,
} from "../apps/web/src/lib/draft.ts";
import { orderReaderCapabilities, readsOrders } from "../apps/web/src/lib/capabilities.ts";
import { demandText } from "../apps/web/src/lib/order-records.ts";
import {
  cartonDigest,
  csvCell,
  csvDocument,
  csvLine,
  dayDrafts,
  daySpan,
  daySummary,
  etag,
  EXPORT_COLUMNS,
  exportRows,
  hasActivity,
  issuedUnits,
  listArgs,
  notModified,
  openIdsFor,
  packerOnly,
  packerProjection,
  packerRow,
  parseExportRange,
  parseListQuery,
} from "../apps/web/src/lib/order-reads.ts";

const params = (o) => new URLSearchParams(o);

test("list queries: date required, known filters, keyset page and limit up to 200", () => {
  assert.deepEqual(parseListQuery(params({ date: "2026-10-20" })), { date: "2026-10-20", limit: 200 });
  const q = parseListQuery(
    params({
      date: "2026-10-20",
      product: "cav",
      package: "CAV 4",
      q: "  nvmy ",
      status: "handover",
      group: JSON.stringify(["cav", "CAV 4", 4]),
      after: "NVMY0001",
      limit: "50",
    }),
  );
  assert.deepEqual(q, {
    date: "2026-10-20",
    product: "cav",
    package: "CAV 4",
    q: "nvmy",
    status: "handover",
    group: { product: "cav", package: "CAV 4", perParcel: 4 },
    after: "NVMY0001",
    limit: 50,
  });
  assert.deepEqual(listArgs("ws", q), {
    p_workspace: "ws",
    p_date: "2026-10-20",
    p_product: "cav",
    p_package: "CAV 4",
    p_q: "nvmy",
    p_status: "handover",
    p_group: { product: "cav", package: "CAV 4", perParcel: 4 },
    p_after: "NVMY0001",
    p_limit: 50,
  });
  for (const bad of [
    {},
    { date: "2026-02-30" },
    { date: "20-10-2026" },
    { date: "2026-10-20", status: "lost" },
    { date: "2026-10-20", product: "xyz" },
    { date: "2026-10-20", limit: "201" },
    { date: "2026-10-20", limit: "0" },
    { date: "2026-10-20", group: "not json" },
    { date: "2026-10-20", group: JSON.stringify(["cav", "x"]) },
    { date: "2026-10-20", after: "x".repeat(61) },
  ])
    assert.ok("error" in parseListQuery(params(bad)), JSON.stringify(bad));
});

test("export ranges: at most 31 days, both ends included, in order", () => {
  assert.equal(daySpan("2026-10-01", "2026-10-31"), 31);
  assert.deepEqual(parseExportRange(params({ from: "2026-10-01", to: "2026-10-31" })), {
    from: "2026-10-01",
    to: "2026-10-31",
  });
  assert.deepEqual(parseExportRange(params({ from: "2026-10-20", to: "2026-10-20" })), {
    from: "2026-10-20",
    to: "2026-10-20",
  });
  assert.match(parseExportRange(params({ from: "2026-10-01", to: "2026-11-01" })).error, /at most 31 days/);
  assert.match(parseExportRange(params({ from: "2026-10-05", to: "2026-10-04" })).error, /before/);
  assert.ok("error" in parseExportRange(params({ from: "2026-10-05" })));
});

test("day markers as ETags: If-None-Match comparison, weak tags, lists and '*'", () => {
  const tag = etag("d", "abc123", 7, "2x10");
  assert.equal(tag, '"d.abc123.7.2x10"');
  assert.equal(etag("l", "m", null, undefined, ""), '"l.m"');
  assert.ok(notModified(tag, tag));
  assert.ok(notModified("W/" + tag, tag));
  assert.ok(notModified(`"other", ${tag}`, tag));
  assert.ok(notModified("*", tag));
  assert.ok(!notModified(null, tag));
  assert.ok(!notModified('"d.abc123.8.2x10"', tag), "a new revision changes the tag");
  assert.equal(cartonDigest({}), "0x0");
  assert.equal(cartonDigest({ a: 3, b: "4" }), "2x7");
});

test("CSV: quoted cells, formula characters neutralized, BOM and CRLF lines", () => {
  assert.equal(csvCell('He said "hi"'), '"He said ""hi"""');
  for (const lead of ["=", "+", "-", "@", "\t", "\r"])
    assert.equal(csvCell(lead + "1"), `"'${lead}1"`);
  assert.equal(csvCell(null), '""');
  assert.equal(csvLine(["a", 1, ""]), '"a","1",""');
  const doc = csvDocument([["x", 2]]);
  assert.ok(doc.startsWith("﻿" + csvLine(EXPORT_COLUMNS) + "\r\n"));
  assert.ok(doc.endsWith('"x","2"'));
});

// The export the Reports screen built before C3 (kept here to prove the shared helper
// produces the same file).
function legacyExport(state) {
  const rows = [EXPORT_COLUMNS];
  state.orders.forEach((o) =>
    orderLines(o).forEach((line) =>
      rows.push([
        o.awb,
        o.channel,
        o.date,
        product(line.product).name,
        product(line.product).unit,
        o.package,
        line.expected,
        orderIssued(state, o, line.product),
        line.actual ?? "",
        line.actual === null ? "" : line.actual - line.expected,
        o.packer,
        o.packedAt ?? "",
        recorderLabel(o.packRecordedBy),
        o.labelPic,
        o.dispatched ? "Yes" : "No",
        o.handoverRef,
      ]),
    ),
  );
  return (
    "﻿" +
    rows
      .map((row) =>
        row
          .map((value) => {
            let x = String(value);
            if (/^[=+@\-\t\r]/.test(x)) x = "'" + x;
            return '"' + x.replaceAll('"', '""') + '"';
          })
          .join(","),
      )
      .join("\r\n")
  );
}

test("CSV export rows: document mode unchanged; table rows use their issued units", () => {
  const s = createDraft();
  const doc = csvDocument(s.orders.flatMap((o) => exportRows(o, (x, p) => issuedUnits(s, x, p))));
  assert.equal(doc, legacyExport(s));
  // The same AWBs read from the tables (issued per product on the row) give the same file.
  const listed = s.orders.map((o) => ({
    ...o,
    issued: Object.fromEntries(orderLines(o).map((l) => [l.product, orderIssued(s, o, l.product)])),
  }));
  const fromRows = csvDocument(
    listed.flatMap((o) => exportRows(o, (x, p) => issuedUnits({ issues: [], cartons: [] }, x, p))),
  );
  assert.equal(fromRows, doc);
  // Names: a stored performer reference shown through the caller's resolver.
  const [row] = exportRows({ ...s.orders[0], packer: "p-1", labelPic: "p-2" }, () => 0, (r) => "Name " + r);
  assert.equal(row[10], "Name p-1");
  assert.equal(row[13], "Name p-2");
});

test("activity on a read row matches orderHasActivity on the document", () => {
  const s = createDraft();
  for (const o of s.orders) {
    const issued = Object.fromEntries(
      orderLines(o).map((l) => [l.product, orderIssued(s, o, l.product)]),
    );
    assert.equal(hasActivity({ issues: [] }, { ...o, issued }), orderHasActivity(s, o), o.awb);
    assert.equal(hasActivity(s, o), orderHasActivity(s, o));
  }
});

// --- Day summary parity -----------------------------------------------------------------

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const dayStart = (date) => Date.parse(date + "T00:00:00+08:00");
/** What public.operator_orders_day returns for `draft` (a tables-mode site holding the
 * same records), built the way the SQL builds it. */
function simulatedDayRead(draft, date) {
  const day = draft.orders.filter((o) => o.date === date);
  const ids = new Set(day.map((o) => o.id));
  const carton = (id) => draft.cartons.find((c) => c.id === id);
  const start = dayStart(date),
    end = start + 86400000;
  const before = {},
    within = {},
    total = {};
  for (const i of draft.issues) {
    const at = Date.parse(i.at);
    total[i.cartonId] = (total[i.cartonId] ?? 0) + i.qty;
    if (at < start) before[i.cartonId] = (before[i.cartonId] ?? 0) + i.qty;
    else if (at < end) within[i.cartonId] = (within[i.cartonId] ?? 0) + i.qty;
  }
  for (const c of Object.keys(total)) before[c] ??= 0;
  const demand = {};
  for (const p of products) {
    const reviewed = day.filter(
      (o) => orderReady(o) && orderLines(o).some((l) => l.product === p.id),
    );
    if (!reviewed.length) continue;
    demand[p.id] = {
      awbs: reviewed.length,
      expected: reviewed.reduce(
        (n, o) => n + orderLines(o).filter((l) => l.product === p.id).reduce((m, l) => m + l.expected, 0),
        0,
      ),
      hash: sha(demandText(draft.orders, date, p.id)),
    };
  }
  return {
    date,
    orders: day
      .map((o) => ({
        id: o.id,
        awb: o.awb,
        date: o.date,
        product: o.product,
        package: o.package,
        lines: o.lines ?? null,
        expected: o.expected,
        actual: o.actual,
        reviewState: o.reviewState ?? "confirmed",
        assignedPacker: o.assignedPacker ?? null,
        packer: o.packer,
        packedAt: o.packedAt ?? null,
        recordedRole: o.packRecordedBy?.role ?? null,
        printed: o.printed,
        dispatched: o.dispatched,
        version: 1,
      }))
      .sort((a, b) => (a.awb < b.awb ? -1 : 1)),
    issues: draft.issues
      .filter((i) => ids.has(i.orderId))
      .map((i) => ({ orderId: i.orderId, cartonId: i.cartonId, product: carton(i.cartonId)?.product, qty: i.qty, at: i.at })),
    // A count still current in the document carries the database's demand hash.
    sortCounts: (draft.sortCounts ?? [])
      .filter((c) => c.date === date)
      .map((c) => ({
        ...c,
        demandHash:
          c.fingerprint === demandFingerprint(draft, date, c.product)
            ? sha(demandText(draft.orders, date, c.product))
            : "0".repeat(64),
      })),
    demand,
    cartonIssued: { before, within },
    marker: "m",
  };
}
const withoutIds = (groups) => groups.map(({ ids, openIds, ...g }) => (void ids, void openIds, g));
const tallyView = (tally) =>
  tally.map(({ count, ...r }) => ({ ...r, count: count ? [count.counted, count.expected, count.pic] : null }));

function busyDay() {
  let s = createDraft();
  const date = today();
  const outbound = { role: "outbound" };
  const run = (type, input, role = outbound.role) => {
    s = applyCommand(s, { type, role, input });
  };
  run("staff-profile-create", { profileId: "11111111-1111-4111-8111-111111111111", name: "Synthetic Ali" });
  for (const p of products) {
    const t = s.orders.filter((o) => o.date === date && orderReady(o) && orderLines(o).some((l) => l.product === p.id));
    if (!t.length) continue;
    const expected = t.reduce((n, o) => n + orderLines(o).filter((l) => l.product === p.id).reduce((m, l) => m + l.expected, 0), 0);
    run("sort-count", { date, product: p.id, counted: expected, pic: "S", note: "" });
  }
  const single = s.orders.filter(
    (o) => o.date === date && orderReady(o) && !o.dispatched && o.actual === null && new Set(orderLines(o).map((l) => l.product)).size === 1,
  );
  if (single[0])
    run("assign-orders", { ids: [single[0].id], packer: "11111111-1111-4111-8111-111111111111", pic: "S" });
  return { s, date };
}

test("day summary: the server's aggregates from slim day rows equal the document's", () => {
  for (const { s, date } of [{ s: createDraft(), date: today() }, busyDay()]) {
    const doc = daySummary(s, date, { ids: true });
    assert.ok(doc.groups.length, "the fixture has package groups today");
    const { tally, inventory } = dayDrafts({ ...s, orders: undefined, issues: undefined, sortCounts: undefined }, simulatedDayRead(s, date));
    const remote = daySummary(tally, date, { inventory });
    assert.deepEqual(withoutIds(remote.groups), withoutIds(doc.groups));
    assert.equal(remote.groups[0].ids, undefined, "the server sends no AWB ids");
    assert.deepEqual(tallyView(remote.tally), tallyView(doc.tally));
    assert.deepEqual(remote.packerTally, doc.packerTally);
    assert.deepEqual(remote.inventory, doc.inventory);
    assert.deepEqual(
      [remote.awbs, remote.review, remote.multi, remote.packages],
      [doc.awbs, doc.review, doc.multi, doc.packages],
    );
    assert.deepEqual(
      remote.sortCounts.map((c) => [c.id, c.counted]),
      doc.sortCounts.map((c) => [c.id, c.counted]),
    );
    // "Issue stock" reads the pending AWB ids of a product's groups in the listed order.
    for (const p of products)
      assert.deepEqual(
        openIdsFor(tally.orders, p.id),
        doc.groups.filter((g) => g.product === p.id).flatMap((g) => g.openIds),
      );
  }
});

test("day summary of another day leaves out later issues and keeps earlier ones as opening", () => {
  const s = createDraft();
  const tomorrow = new Date(dayStart(today()) + 86400000 + 8 * 3600000).toISOString().slice(0, 10);
  const doc = daySummary(s, tomorrow);
  const { tally, inventory } = dayDrafts({ ...s }, simulatedDayRead(s, tomorrow));
  assert.deepEqual(daySummary(tally, tomorrow, { inventory }).inventory, doc.inventory);
  assert.equal(doc.awbs, 0);
});

// --- Who reads what -----------------------------------------------------------------------

test("AWB readers mirror operator_private.order_reader_workspaces", () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/20261014090000_operator_order_records.sql", import.meta.url),
    "utf8",
  );
  const body = sql.slice(sql.indexOf("function operator_private.order_reader_workspaces()"));
  const list = /&& array\[([^\]]+)\]/.exec(body)[1].match(/'([a-z.]+)'/g).map((x) => x.slice(1, -1));
  assert.deepEqual([...list].sort(), [...orderReaderCapabilities].sort());
  assert.ok(readsOrders(["orders.import", "feedback.post"]));
  assert.ok(!readsOrders(["review.comment", "sources.read", "trips.read"]), "management reads no AWBs");
  assert.ok(!readsOrders(["packing.record", "feedback.post"]));
});

test("packer projection: only staff profiles and notes reach the shared packer phone", () => {
  assert.ok(packerOnly(["feedback.post", "packing.record"]));
  assert.ok(!packerOnly(["feedback.post"]));
  assert.ok(!packerOnly(["packing.record", "outbound.fulfil"]));
  const s = createDraft();
  s.staffProfiles = [
    { id: "a", name: "Synthetic A", role: "packer", createdAt: "2026-10-01", createdBy: { kind: "member", role: "outbound", name: "SV", userId: "u" } },
    { id: "b", name: "Synthetic B", role: "packer", active: false },
  ];
  s.notes = [{ id: "n", kind: "feedback", text: "hello", role: "packer", at: "2026-10-01" }];
  const p = packerProjection(s);
  assert.deepEqual(p.staffProfiles, [
    { id: "a", name: "Synthetic A", role: "packer" },
    { id: "b", name: "Synthetic B", role: "packer", active: false },
  ]);
  assert.deepEqual(p.notes, s.notes);
  for (const key of ["batches", "cartons", "orders", "issues", "boxing", "counts", "adjustments", "returns", "events", "closedDays"])
    assert.deepEqual(p[key], [], key);
  assert.ok(JSON.stringify(p).length < JSON.stringify(s).length / 5);
});

test("packer rows keep what the packing card and trace sheet show", () => {
  const o = { ...createDraft().orders[0], importId: "i", importRowId: "r", store: "S", orderRef: "R", courier: "C",
    assignedAt: "t", packRecordedAt: "t", reviewedBy: "x", assignedPacker: "p", version: 3 };
  const slim = packerRow(o);
  for (const k of ["importId", "importRowId", "store", "orderRef", "courier", "assignedAt", "packRecordedAt", "reviewedBy"])
    assert.equal(slim[k], undefined, k);
  for (const k of ["id", "awb", "channel", "product", "package", "expected", "actual", "date", "assignedPacker", "version", "dispatched"])
    assert.deepEqual(slim[k], o[k], k);
  assert.equal(o.store, "S", "the row read is not changed");
});
