// Test helpers for order records (20261014090000_operator_order_records.sql): an in-memory
// RecordSource over a whole Draft, and a simulated tables-mode site that runs every order
// command twice — on the slice loadSlice builds and on the whole document — and checks that
// both give the same change set and the same rows (design section 4, parity tests).
// Imported by tests/order-records.test.mjs and tests/capabilities.test.mjs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock } from "node:test";
import { applyCommand, demandKey, products } from "../apps/web/src/lib/draft.ts";
import { importEffects, normalizeAwb } from "../apps/web/src/lib/awb-import.ts";
import { effectiveCapabilities } from "../apps/web/src/lib/access.ts";
import { demandText, loadSlice, sliceDelta } from "../apps/web/src/lib/order-records.ts";

export const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const qtyOf = (o, product) =>
  o.lines ? o.lines.filter((l) => l.product === product).reduce((n, l) => n + l.expected, 0) : o.expected;
/** operator_private.day_demand over in-memory orders. */
export function dayDemand(orders, date, product) {
  const rows = orders.filter(
    (o) => o.date === date && o.reviewState !== "pending" && (o.lines ?? [o]).some((l) => l.product === product),
  );
  return {
    awbs: rows.length,
    expected: rows.reduce((n, o) => n + qtyOf(o, product), 0),
    hash: sha(demandText(orders, date, product)),
  };
}
/** The whole Draft with the database's demand for every day it mentions. */
export function withDemand(s) {
  const demand = {};
  for (const date of new Set([...s.orders.map((o) => o.date), ...(s.sortCounts ?? []).map((c) => c.date)]))
    for (const p of products) demand[demandKey(date, p.id)] = dayDemand(s.orders, date, p.id);
  return { ...structuredClone(s), demand };
}
/** What a tables-mode site keeps in its document: no order lists and no audit entries. */
export function documentOf(s) {
  const doc = structuredClone(s);
  delete doc.orders;
  delete doc.issues;
  delete doc.sortCounts;
  delete doc.demand;
  delete doc.cartonIssued;
  doc.events = [];
  return doc;
}
/** A RecordSource reading a whole Draft (the "tables") and a list of uploads. */
export function memorySource(full, uploads = [], log = []) {
  const clone = (x) => structuredClone(x);
  const note = (name, arg) => log.push([name, arg]);
  return {
    ordersById: async (ids) => (note("ordersById", ids), ids.map((id) => full.orders.find((o) => o.id === id)).filter(Boolean).map(clone)),
    ordersByAwb: async (awbs) => (note("ordersByAwb", awbs), full.orders.filter((o) => awbs.includes(normalizeAwb(o.awb))).map(clone)),
    ordersByRef: async (refs) => (note("ordersByRef", refs), full.orders.filter((o) => o.orderRef && refs.includes(o.orderRef)).map(clone)),
    ordersOfUpload: async (id) => (note("ordersOfUpload", id), full.orders.filter((o) => o.importId === id).map(clone)),
    issuesOf: async (ids) => (note("issuesOf", ids), full.issues.filter((i) => ids.includes(i.orderId)).map(clone)),
    cartonTotals: async () => {
      note("cartonTotals");
      const totals = {};
      for (const i of full.issues) totals[i.cartonId] = (totals[i.cartonId] ?? 0) + i.qty;
      return totals;
    },
    day: async (date) => {
      note("day", date);
      const demand = {};
      for (const p of products) {
        const d = dayDemand(full.orders, date, p.id);
        if (d.awbs) demand[p.id] = d;
      }
      return {
        orders: full.orders.filter((o) => o.date === date).map(clone),
        sortCounts: (full.sortCounts ?? []).filter((c) => c.date === date).map(clone),
        demand,
      };
    },
    upload: async (id) => (note("upload", id), clone(uploads.find((u) => u.id === id && !u.deleted) ?? null)),
    releasedFrom: async (o) => {
      note("releasedFrom", o.id);
      const u = uploads.find((x) => x.id === o.importId && !x.deleted);
      const row = u?.rows.find((r) => r.id === o.importRowId);
      return u && row?.releasedOrderId === o.id ? { ...clone(u), rows: [] } : null;
    },
  };
}
/** Deterministic record identifiers and a fixed clock, so two runs can be compared. */
export function frozen(now = Date.parse("2026-10-20T03:00:00.000Z")) {
  let n = 0;
  mock.timers.enable({ apis: ["Date"], now });
  mock.method(globalThis.crypto, "randomUUID", () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, "0")}`);
  let mark = 0;
  return {
    /** Start a run: identifiers continue from the last run's start (two runs, same ids). */
    mark: () => (mark = n),
    rewind: () => (n = mark),
    restore: () => {
      mock.timers.reset();
      mock.restoreAll();
    },
  };
}
export const actor = (role) => ({ kind: "member", role, name: role, userId: "u-" + role, siteId: "site-a" });
/**
 * A simulated tables-mode site over `initial`. step() runs a command on its slice and on
 * the whole document, asserts both agree, then applies it like the database would (row
 * versions bumped, upload effects applied) and returns the change set and the slice after.
 */
export function tablesSite(initial, uploads = [], clock) {
  let full = structuredClone(initial);
  for (const o of full.orders) o.version ??= 1;
  return {
    get state() {
      return full;
    },
    uploads,
    /** Both runs refuse the command with the same message (matching `pattern`). */
    async refused(role, type, input, pattern, { performer } = {}) {
      const cmd = { type, role, input, actor: actor(role), capabilities: effectiveCapabilities(role), performer, scope: "slice" };
      const loaded = await loadSlice(memorySource(full, uploads), documentOf(full), type, input);
      assert.throws(() => applyCommand(loaded.draft, { ...cmd, context: loaded.context }), pattern, type + " on its slice");
      assert.throws(() => applyCommand(withDemand(full), { ...cmd, context: loaded.context }), pattern, type + " on the document");
    },
    async step(role, type, input, { performer } = {}) {
      const cmd = { type, role, input, actor: actor(role), capabilities: effectiveCapabilities(role), performer, scope: "slice" };
      clock.mark();
      const loaded = await loadSlice(memorySource(full, uploads), documentOf(full), type, input);
      const after = applyCommand(loaded.draft, { ...cmd, context: loaded.context });
      const changes = sliceDelta(type, loaded.draft, after, {
        effects: loaded.keepEffects ? importEffects(type, input, loaded.draft) : null,
      });
      clock.rewind();
      const before = withDemand(full);
      const whole = applyCommand(before, { ...cmd, context: loaded.context });
      const wholeChanges = sliceDelta(type, before, whole, {
        effects: loaded.keepEffects ? importEffects(type, input, before) : null,
      });
      assert.deepEqual(changes, wholeChanges, type + ": slice and whole document give different changes");
      for (const o of after.orders)
        assert.deepEqual(o, whole.orders.find((x) => x.id === o.id), `${type}: row ${o.awb} differs`);
      // Commit like operator_commit_records: versions, then upload effects.
      const next = structuredClone(whole);
      delete next.demand;
      for (const u of changes.orders?.update ?? []) next.orders.find((o) => o.id === u.id).version = u.version + 1;
      for (const r of changes.orders?.insert ?? []) next.orders.find((o) => o.id === r.id).version = 1;
      const effect = changes.importEffects;
      if (effect?.release) {
        const u = uploads.find((x) => x.id === effect.release);
        u.confirmedAt = new Date().toISOString();
        for (const r of changes.orders.insert) u.rows.find((row) => row.id === r.import_row_id).releasedOrderId = r.id;
      }
      if (effect?.delete) uploads.find((x) => x.id === effect.delete).deleted = true;
      for (const row of effect?.rows ?? [])
        for (const u of uploads)
          for (const r of u.rows) if (r.id === row.id) Object.assign(r, { excluded: true, reviewNote: row.reviewNote });
      full = next;
      return { changes, after, loaded };
    },
  };
}
