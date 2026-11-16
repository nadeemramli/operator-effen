// Feature usage per role: what a role is meant to use against the usage report rows, and
// the screen list the database accepts (20261116090000_operator_usage.sql).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  expectedUsage,
  isUsageView,
  parseUsageDays,
  personUsage,
  usageRowsFromDays,
  workflows,
  summarizeRole,
  summarizeUsage,
  usagePeriod,
  usageSince,
  usageViews,
} from "../apps/web/src/lib/usage.ts";
import { commandRules, memberRoles, roleCapabilities } from "../apps/web/src/lib/capabilities.ts";
import { allowedViews } from "../apps/web/src/lib/landing.ts";

const sql = readFileSync(
  new URL("../supabase/migrations/20261116090000_operator_usage.sql", import.meta.url),
  "utf8",
);
const row = (over) => ({
  role: "outbound",
  userId: "u1",
  name: "SO A",
  profileId: "",
  kind: "command",
  detail: "dispatch",
  uses: 1,
  activeDays: 1,
  lastAt: "2026-11-10T02:00:00Z",
  ...over,
});

test("the database accepts exactly the app's screens", () => {
  const body = sql.slice(sql.indexOf("create function operator_private.usage_view"));
  const list = body.slice(body.indexOf("p_view in ("), body.indexOf("$$;"));
  const inSql = [...list.matchAll(/'([a-z]+)'/g)].map(([, v]) => v).sort();
  assert.deepEqual(inSql, [...usageViews].sort());
  assert.ok(isUsageView("reports"));
  assert.ok(!isUsageView("outbound"));
  assert.ok(!isUsageView(undefined));
});

test("only Management and HR read the report, and nobody reads the table", () => {
  assert.match(sql, /operator_active_role\(p_workspace\) in \('management', 'hr'\)\) is not true/);
  assert.match(sql, /revoke all on public\.operator_usage_daily from public, anon, authenticated;/);
  assert.doesNotMatch(sql, /grant (select|insert|update|delete|all)[^;]*operator_usage_daily/);
  // The roles that read the report are the roles that can open the Reports screen.
  assert.deepEqual(
    memberRoles.filter((r) => allowedViews(r).includes("reports")).sort(),
    ["hr", "management"],
  );
});

test("a role is expected to use its screens and every command its capabilities permit", () => {
  for (const role of memberRoles) {
    const expected = expectedUsage(role);
    assert.deepEqual(expected.views, allowedViews(role), role);
    assert.deepEqual(
      expected.capabilities.map((c) => c.capability),
      roleCapabilities[role],
      role,
    );
    for (const { capability, commands } of expected.capabilities)
      for (const command of commands)
        assert.equal(commandRules[command].capability, capability, command);
  }
  const packer = expectedUsage("packer").capabilities.flatMap((c) => c.commands);
  assert.deepEqual(packer.sort(), ["feedback", "pack-own"]);
});

test("used and unused features are counted per role", () => {
  const usage = summarizeRole("outbound", [
    row({ kind: "member", detail: "", uses: 0, activeDays: 0, lastAt: null }),
    row({ kind: "member", userId: "u2", name: "SO B", detail: "", uses: 0, activeDays: 0, lastAt: null }),
    row({ uses: 4, activeDays: 3 }),
    row({ detail: "pack", uses: 2 }),
    row({ kind: "failed", detail: "pack", uses: 5 }),
    row({ kind: "view", detail: "orders", uses: 9, lastAt: "2026-11-12T02:00:00Z" }),
    row({ kind: "active", detail: "", uses: 0, activeDays: 6, lastAt: "2026-11-12T02:00:00Z" }),
    // Another role's activity never counts here.
    row({ role: "intake", userId: "u3", detail: "receive", uses: 50 }),
  ]);
  assert.equal(usage.people.length, 2);
  assert.equal(usage.activePeople, 1);
  assert.deepEqual(
    usage.people.map((p) => [p.name, p.activeDays, p.views, p.commands, p.failed, p.lastAt]),
    [
      ["SO A", 6, 9, 6, 5, "2026-11-12T02:00:00Z"],
      ["SO B", 0, 0, 0, 0, null],
    ],
  );
  assert.equal(usage.usedViews, 1);
  assert.equal(usage.views.find((v) => v.view === "orders").uses, 9);
  assert.equal(usage.usedCommands, 2);
  assert.ok(usage.totalCommands > 10);
  assert.equal(usage.failed, 5);
  const fulfil = usage.capabilities.find((c) => c.capability === "outbound.fulfil");
  assert.deepEqual(
    fulfil.commands.find((c) => c.command === "pack"),
    { command: "pack", uses: 2, people: 1, lastAt: "2026-11-10T02:00:00Z", failed: 5 },
  );
  assert.equal(fulfil.commands.find((c) => c.command === "dispatch").uses, 4);
  assert.equal(fulfil.commands.find((c) => c.command === "sort-count").uses, 0);
});

test("packer profiles on the shared sign-in count as separate people", () => {
  const packer = { role: "packer", userId: "shared", name: "Packers" };
  const usage = summarizeRole("packer", [
    row({ ...packer, kind: "member", detail: "", uses: 0, activeDays: 0, lastAt: null }),
    row({ ...packer, kind: "view", detail: "packing", profileId: "p1", uses: 3 }),
    row({ ...packer, kind: "view", detail: "packing", profileId: "p2", uses: 1 }),
    row({ ...packer, kind: "command", detail: "pack-own", uses: 7 }),
  ]);
  assert.deepEqual(usage.people.map((p) => p.profileId).sort(), ["", "p1", "p2"]);
  assert.equal(usage.views.find((v) => v.view === "packing").people, 2);
  assert.equal(usage.usedCommands, 1);
});

test("only roles present at the site are listed, in the usual order", () => {
  const usage = summarizeUsage([
    row({ role: "management", kind: "view", detail: "reports" }),
    row({ role: "production", kind: "member", detail: "", lastAt: null }),
    row({ role: "assistant", kind: "view", detail: "trips" }),
  ]);
  assert.deepEqual(usage.map((u) => u.role), ["production", "management"]);
});

test("the period is one of the offered lengths and starts on a Malaysia day", () => {
  assert.equal(usagePeriod("7"), 7);
  assert.equal(usagePeriod("90"), 90);
  assert.equal(usagePeriod("3650"), 30);
  assert.equal(usagePeriod(null), 30);
  // 17:00 UTC on the 15th is already the 16th in Kuala Lumpur.
  assert.equal(usageSince(1, new Date("2026-11-15T17:00:00Z")), "2026-11-16");
  assert.equal(usageSince(7, new Date("2026-11-15T17:00:00Z")), "2026-11-10");
  assert.equal(usageSince(30, new Date("2026-11-15T15:00:00Z")), "2026-10-17");
});

// Per person and day (20261117090000_operator_usage_detail.sql).
const detailSql = readFileSync(
  new URL("../supabase/migrations/20261117090000_operator_usage_detail.sql", import.meta.url),
  "utf8",
);
const dayRow = (day, kind, detail, uses = 1, over = {}) => [
  day,
  over.role ?? "outbound",
  over.userId ?? "u1",
  over.profileId ?? "",
  kind,
  detail,
  uses,
  over.firstAt ?? day + "T01:00:00Z",
  over.lastAt ?? day + "T09:00:00Z",
];

test("the per-day report is one JSON value for Management and HR, with the kinds the app reads", () => {
  assert.match(detailSql, /create function public\.operator_usage_days\(p_workspace uuid, p_since date\)\s+returns jsonb/);
  assert.match(detailSql, /operator_active_role\(p_workspace\) in \('management', 'hr'\)\) is not true/);
  assert.match(detailSql, /check \(kind in \('view', 'failed', 'open', 'sign-in'\)\)/);
  assert.doesNotMatch(detailSql, /grant (select|insert|update|delete|all)[^;]*operator_usage_daily/);
});

test("every workflow step uses commands and screens its role is permitted", () => {
  for (const role of memberRoles) {
    assert.ok(workflows[role].length > 0, role);
    const expected = expectedUsage(role);
    const commands = expected.capabilities.flatMap((c) => c.commands);
    assert.equal(new Set(workflows[role].map((s) => s.id)).size, workflows[role].length, role);
    for (const step of workflows[role]) {
      assert.ok((step.commands?.length ?? 0) + (step.views?.length ?? 0) > 0, step.id);
      for (const c of step.commands ?? []) assert.ok(commands.includes(c), `${role}: ${c}`);
      for (const v of step.views ?? []) assert.ok(expected.views.includes(v), `${role}: ${v}`);
    }
  }
});

test("malformed per-day rows are dropped", () => {
  const days = parseUsageDays([
    dayRow("2026-11-10", "command", "dispatch", 3),
    dayRow("2026-11-10", "payroll", "x"),
    ["2026-11-10", "outbound"],
    "nonsense",
  ]);
  assert.equal(days.length, 1);
  assert.deepEqual(days[0], {
    day: "2026-11-10",
    role: "outbound",
    userId: "u1",
    profileId: "",
    kind: "command",
    detail: "dispatch",
    uses: 3,
    firstAt: "2026-11-10T01:00:00Z",
    lastAt: "2026-11-10T09:00:00Z",
  });
  assert.deepEqual(parseUsageDays(null), []);
});

test("a person's days show how far the process got and where it stopped", () => {
  const days = parseUsageDays([
    // 10th: everything.
    dayRow("2026-11-10", "sign-in", "sign-in"),
    dayRow("2026-11-10", "command", "import-receive"),
    dayRow("2026-11-10", "command", "sort-count"),
    dayRow("2026-11-10", "command", "issue-orders", 4),
    dayRow("2026-11-10", "command", "assign-orders"),
    dayRow("2026-11-10", "command", "dispatch"),
    dayRow("2026-11-10", "command", "close"),
    // 11th and 12th: stops after issuing stock; a count form opened twice, saved once.
    dayRow("2026-11-11", "command", "order"),
    dayRow("2026-11-11", "command", "sort-count"),
    dayRow("2026-11-11", "open", "sort-count", 2),
    dayRow("2026-11-11", "command", "issue"),
    dayRow("2026-11-11", "failed", "issue", 3),
    dayRow("2026-11-12", "command", "order"),
    dayRow("2026-11-12", "command", "sort-count"),
    dayRow("2026-11-12", "command", "issue"),
    dayRow("2026-11-12", "view", "orders", 6, { firstAt: "2026-11-12T00:30:00Z" }),
    // Someone else and another role never count.
    dayRow("2026-11-12", "command", "dispatch", 1, { userId: "u2" }),
    dayRow("2026-11-12", "command", "receive", 1, { role: "intake" }),
  ]);
  const p = personUsage("outbound", { userId: "u1", profileId: "" }, days);
  assert.deepEqual(p.days.map((d) => d.day), ["2026-11-12", "2026-11-11", "2026-11-10"]);
  assert.deepEqual(
    p.steps.map((s) => [s.step.id, s.days]),
    [["orders", 3], ["count", 3], ["issue", 3], ["assign", 1], ["handover", 1], ["close", 1]],
  );
  assert.equal(p.fullDays, 1);
  assert.equal(p.stoppedAt.id, "assign");
  const eleventh = p.days[1];
  assert.deepEqual(eleventh.done, [true, true, true, false, false, false]);
  assert.equal(eleventh.failed, 3);
  assert.deepEqual(eleventh.unsaved, ["sort-count"]);
  assert.equal(p.days[0].firstAt, "2026-11-12T00:30:00Z");
  assert.equal(p.days[0].views, 6);
  assert.equal(p.days[2].signIns, 1);
  assert.deepEqual(p.usedViews, ["orders"]);
  assert.ok(p.unusedViews.includes("tally"));
  assert.ok(p.usedCommands.includes("issue-orders"));
  assert.ok(p.unusedCommands.includes("correct"));
  assert.deepEqual(
    p.forms.find((f) => f.command === "sort-count"),
    { command: "sort-count", opened: 2, saved: 3, failed: 0 },
  );
  assert.deepEqual(
    p.forms.find((f) => f.command === "issue"),
    { command: "issue", opened: 0, saved: 2, failed: 3 },
  );
});

test("someone with access and no activity has no days and no stopping point", () => {
  const p = personUsage("intake", { userId: "nobody", profileId: "" }, []);
  assert.deepEqual(p.days, []);
  assert.equal(p.fullDays, 0);
  assert.equal(p.stoppedAt, null);
  assert.equal(p.usedCommands.length, 0);
});

test("the role summary is built from the per-day rows and the member list", () => {
  const days = parseUsageDays([
    dayRow("2026-11-10", "command", "dispatch", 2),
    dayRow("2026-11-11", "command", "dispatch", 1),
    dayRow("2026-11-11", "view", "orders", 5),
    dayRow("2026-11-11", "sign-in", "sign-in"),
  ]);
  const members = [
    row({ kind: "member", detail: "", uses: 0, activeDays: 0, lastAt: null }),
    row({ kind: "member", userId: "u2", name: "SO B", detail: "", uses: 0, activeDays: 0, lastAt: null }),
  ];
  const usage = summarizeRole("outbound", usageRowsFromDays(days, members));
  assert.deepEqual(
    usage.people.map((p) => [p.name, p.activeDays, p.views, p.commands]),
    [["SO A", 2, 5, 3], ["SO B", 0, 0, 0]],
  );
  assert.equal(usage.activePeople, 1);
  const dispatch = usage.capabilities
    .flatMap((c) => c.commands)
    .find((c) => c.command === "dispatch");
  assert.equal(dispatch.uses, 3);
  assert.equal(dispatch.lastAt, "2026-11-11T09:00:00Z");
});
