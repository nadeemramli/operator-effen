// Audit entries of operational sites live in operator_events (20261013090000, order volume
// plan WP B). Commands still log into Draft.events; these helpers serve /api/events and
// mirror the database appender's shape checks.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyCommand, createDraft } from "../apps/web/src/lib/draft.ts";
import {
  eventFromRow,
  eventProblem,
  mytDayRange,
  parseEventsQuery,
} from "../apps/web/src/lib/events.ts";

const user = "00000000-0000-4000-8000-000000000001";
const entry = (extra = {}) => ({
  id: "5d0c7f43-1f9a-4c55-9b0c-2f3c0d6a1e01",
  entity: "b1",
  action: "Batch planned",
  detail: "SYN-1",
  actor: "SV · Production",
  at: "2026-10-12T01:00:00.000Z",
  recorder: { kind: "member", role: "production", name: "SV", userId: user },
  ...extra,
});

test("a Malaysia day is the UTC range from 16:00 the day before", () => {
  assert.deepEqual(mytDayRange("2026-10-12"), {
    from: "2026-10-11T16:00:00.000Z",
    to: "2026-10-12T16:00:00.000Z",
  });
  // Month and year boundaries.
  assert.deepEqual(mytDayRange("2027-01-01"), {
    from: "2026-12-31T16:00:00.000Z",
    to: "2027-01-01T16:00:00.000Z",
  });
  assert.equal(mytDayRange("2028-02-29")?.from, "2028-02-28T16:00:00.000Z");
  for (const bad of ["2026-02-30", "2027-02-29", "2026-13-01", "2026-1-01", "12/10/2026", "", "2026-10-12T00:00"])
    assert.equal(mytDayRange(bad), null, bad);
});

test("an entry at 23:59 Malaysia time belongs to that day; 00:00 to the next", () => {
  const { from, to } = mytDayRange("2026-10-12");
  const inDay = (iso) => iso >= from && iso < to;
  assert.ok(inDay(new Date("2026-10-12T23:59:59.999+08:00").toISOString()));
  assert.ok(inDay(new Date("2026-10-12T00:00:00+08:00").toISOString()));
  assert.ok(!inDay(new Date("2026-10-13T00:00:00+08:00").toISOString()));
  assert.ok(!inDay(new Date("2026-10-11T23:59:59.999+08:00").toISOString()));
});

test("events queries: exactly one of entity, date or recent, with paging", () => {
  const q = (s) => parseEventsQuery(new URLSearchParams(s));
  assert.deepEqual(q("workspace=w&entity=o-1&entity=b-1&entity=o-1"), {
    kind: "entity",
    entities: ["o-1", "b-1"],
    limit: 200,
  });
  assert.deepEqual(q("date=2026-10-12&before=42&limit=50"), {
    kind: "date",
    date: "2026-10-12",
    from: "2026-10-11T16:00:00.000Z",
    to: "2026-10-12T16:00:00.000Z",
    before: 42,
    limit: 50,
  });
  assert.deepEqual(q("recent=1&limit=4"), { kind: "recent", limit: 4 });
  for (const bad of [
    "",
    "recent=0",
    "entity=a&recent=1",
    "date=2026-10-12&entity=a",
    "date=2026-02-30",
    "recent=1&limit=201",
    "recent=1&limit=0",
    "recent=1&before=-1",
    "recent=1&before=x",
    "entity=",
    "entity=" + "x".repeat(201),
    Array.from({ length: 21 }, (_, i) => "entity=e" + i).join("&"),
  ])
    assert.ok("error" in q(bad), bad);
});

test("table rows come back in the app's Event shape", () => {
  const row = {
    id: entry().id,
    seq: "17",
    entity: "o-1",
    action: "Parcel quantity recorded",
    detail: "x",
    actor: "Ali · Packer",
    at: "2026-10-12T01:00:00.5+00:00",
    occurred_at: "2026-10-12T00:58:00+00:00",
    performer: "p-ali",
    recorder: entry().recorder,
  };
  assert.deepEqual(eventFromRow(row), {
    id: row.id,
    seq: 17,
    entity: "o-1",
    action: "Parcel quantity recorded",
    detail: "x",
    actor: "Ali · Packer",
    at: "2026-10-12T01:00:00.500Z",
    recorder: entry().recorder,
    performer: "p-ali",
    occurredAt: "2026-10-12T00:58:00.000Z",
  });
  // Backfilled history may have no recorder, performer or occurrence time.
  const bare = eventFromRow({ ...row, recorder: {}, performer: null, occurred_at: null });
  assert.equal("recorder" in bare || "performer" in bare || "occurredAt" in bare, false);
});

test("eventProblem mirrors operator_private.append_events", () => {
  assert.equal(eventProblem([entry()], user), null);
  assert.equal(eventProblem([entry({ performer: "p-1", occurredAt: "2026-10-12T00:00:00.000Z" })], user), null);
  assert.match(eventProblem([entry({ recorder: { ...entry().recorder, userId: "someone" } })], user), /attributed to the signed-in user/);
  assert.match(eventProblem([entry({ recorder: undefined })], user), /Invalid audit entry/);
  assert.match(eventProblem([entry({ id: "seed" })], user), /Invalid audit entry/);
  assert.match(eventProblem([entry({ at: "t" })], user), /Invalid audit entry/);
  assert.match(eventProblem([entry({ occurredAt: "soon" })], user), /Invalid audit entry/);
  assert.match(eventProblem([entry({ detail: "x".repeat(100001) })], user), /Invalid audit entry/);
  assert.match(eventProblem([entry({ entity: "x".repeat(201) })], user), /Invalid audit entry/);
  assert.match(eventProblem([entry(), entry()], user), /Duplicate/);
  const many = Array.from({ length: 2001 }, () => entry({ id: crypto.randomUUID() }));
  assert.match(eventProblem(many, user), /at most 2000/);
  assert.equal(eventProblem(many.slice(1), user), null);
});

test("operational commands log only their own entries; every one passes the appender's checks", () => {
  const recorder = { kind: "member", role: "production", name: "SV", userId: user, siteId: "site-a" };
  // The server loads a site document without entries (events: []).
  const site = { ...createDraft(), events: [] };
  const next = applyCommand(site, {
    type: "batch",
    role: "production",
    actor: recorder,
    input: { product: "cav", code: "SYN-EV-1", date: "2026-10-12", target: 10 },
  });
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].recorder.userId, user);
  assert.equal(eventProblem(next.events, user), null);
  // The sandbox keeps its document history (seed entry first logged, newest first).
  const preview = applyCommand(createDraft(), {
    type: "batch",
    role: "production",
    input: { product: "cav", code: "SYN-EV-2", date: "2026-10-12", target: 10 },
  });
  assert.equal(preview.events.length, 2);
  assert.equal(preview.events[1].id, "seed");
});

test("the operational size ceiling no longer counts audit entries; the sandbox one does", () => {
  const old = Array.from({ length: 4001 }, (_, i) => ({ ...entry(), id: "old-" + i }));
  const input = { product: "cav", code: "SYN-EV-3", date: "2026-10-12", target: 10 };
  const recorder = { kind: "member", role: "production", name: "SV", userId: user, siteId: "site-a" };
  assert.doesNotThrow(() =>
    applyCommand({ ...createDraft(), events: old }, { type: "batch", role: "production", actor: recorder, input }),
  );
  assert.throws(
    () => applyCommand({ ...createDraft(), events: old }, { type: "batch", role: "production", input }),
    /workspace is full/,
  );
});

test("the migration keeps the contract the API and work package C rely on", () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/20261013090000_operator_events.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /create function operator_private\.append_events\(\s*p_workspace uuid,\s*p_events jsonb,\s*p_uid uuid,\s*p_command text,\s*p_operation uuid\s*\)\s*returns integer/);
  assert.match(sql, /grant select on public\.operator_events to authenticated;/);
  assert.doesNotMatch(sql, /grant (insert|update|delete)[^;]*operator_events/);
  assert.match(sql, /using \(public\.operator_active_role\(workspace_id\) is not null\)/);
  // Shape limits shared with eventProblem.
  for (const limit of ["char_length(e ->> 'entity') <= 200", "char_length(e ->> 'detail') <= 100000", "> 2000"])
    assert.ok(sql.includes(limit), limit);
  // The document keeps no events, and the commit appends them after the commit row.
  assert.match(sql, /v_new := v_new - 'events';/);
  assert.ok(sql.indexOf("insert into public.operator_commits") < sql.indexOf("perform operator_private.append_events"));
  assert.ok(sql.indexOf("perform operator_private.append_events") < sql.indexOf("perform operator_private.apply_import_effects"));
});
