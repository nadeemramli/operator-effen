import {
  commandRules,
  memberRoles,
  roleCapabilities,
  type Capability,
  type MemberRole,
} from "./capabilities.ts";
import { allowedViews, views, type View } from "./landing.ts";

/**
 * Feature usage per role: what a role is meant to use (its screens and the commands its
 * capabilities permit) against what was actually used. The rows come from
 * public.operator_usage_report (20261116090000_operator_usage.sql): the site's members,
 * saved actions from the commit log, screen views and refused saves from the usage log, and
 * the days each person did anything (`active`).
 */
export type UsageKind =
  | "member"
  | "active"
  | "command"
  | "view"
  | "failed"
  | "open"
  | "sign-in";
export type UsageRow = {
  role: string;
  userId: string;
  name: string;
  /** Packer profile unlocked by PIN on the shared packer sign-in; "" otherwise. */
  profileId: string;
  kind: UsageKind;
  detail: string;
  uses: number;
  activeDays: number;
  lastAt: string | null;
};

/** Screens the usage log accepts; mirrored by operator_private.usage_view. */
export const usageViews: View[] = views.map((v) => v.id);
export const isUsageView = (value: unknown): value is View =>
  usageViews.some((v) => v === value);

export const USAGE_PERIODS = [7, 30, 90] as const;
export const usagePeriod = (value: unknown): number =>
  USAGE_PERIODS.find((d) => String(d) === String(value)) ?? 30;

/** The Malaysia day `days` days before `now`, counting today as the first day. */
export function usageSince(days: number, now = new Date()): string {
  const shifted = new Date(now.getTime() + 8 * 3600000 - (days - 1) * 86400000);
  return shifted.toISOString().slice(0, 10);
}

/** What a role is meant to use: its screens and the commands each capability permits. */
export function expectedUsage(role: MemberRole): {
  views: View[];
  capabilities: { capability: Capability; commands: string[] }[];
} {
  return {
    views: allowedViews(role),
    capabilities: (roleCapabilities[role] ?? []).map((capability) => ({
      capability,
      commands: Object.entries(commandRules)
        .filter(([, rule]) => rule.capability === capability)
        .map(([command]) => command),
    })),
  };
}

export type UsageCount = {
  uses: number;
  /** People who used it; a packer profile counts as its own person. */
  people: number;
  lastAt: string | null;
};
export type UsagePerson = {
  key: string;
  userId: string;
  name: string;
  profileId: string;
  views: number;
  commands: number;
  failed: number;
  activeDays: number;
  lastAt: string | null;
};
export type RoleUsage = {
  role: MemberRole;
  people: UsagePerson[];
  activePeople: number;
  views: ({ view: View } & UsageCount)[];
  capabilities: {
    capability: Capability;
    commands: ({ command: string; failed: number } & UsageCount)[];
  }[];
  usedViews: number;
  usedCommands: number;
  totalCommands: number;
  failed: number;
};

const later = (a: string | null, b: string | null) =>
  !a ? b : !b ? a : a > b ? a : b;
const personKey = (r: Pick<UsageRow, "userId" | "profileId">) =>
  r.userId + "|" + r.profileId;

/**
 * One role's usage. Activity is counted under the role it was recorded with, so a person
 * who changed role keeps their earlier activity under the earlier role.
 */
export function summarizeRole(role: MemberRole, rows: readonly UsageRow[]): RoleUsage {
  const mine = rows.filter((r) => r.role === role);
  const expected = expectedUsage(role);
  const count = (kind: UsageKind, detail: string): UsageCount => {
    const hits = mine.filter((r) => r.kind === kind && r.detail === detail);
    return {
      uses: hits.reduce((n, r) => n + r.uses, 0),
      people: new Set(hits.map(personKey)).size,
      lastAt: hits.reduce<string | null>((at, r) => later(at, r.lastAt), null),
    };
  };
  const people = new Map<string, UsagePerson>();
  for (const r of mine) {
    const key = personKey(r);
    const p = people.get(key) ?? {
      key,
      userId: r.userId,
      name: r.name,
      profileId: r.profileId,
      views: 0,
      commands: 0,
      failed: 0,
      activeDays: 0,
      lastAt: null,
    };
    if (!p.name) p.name = r.name;
    if (r.kind === "view") p.views += r.uses;
    if (r.kind === "command") p.commands += r.uses;
    if (r.kind === "failed") p.failed += r.uses;
    if (r.kind === "active") {
      p.activeDays = r.activeDays;
      p.lastAt = later(p.lastAt, r.lastAt);
    }
    people.set(key, p);
  }
  const viewRows = expected.views.map((view) => ({ view, ...count("view", view) }));
  const capabilities = expected.capabilities.map(({ capability, commands }) => ({
    capability,
    commands: commands.map((command) => ({
      command,
      ...count("command", command),
      failed: count("failed", command).uses,
    })),
  }));
  const commands = capabilities.flatMap((c) => c.commands);
  const list = [...people.values()].sort(
    (a, b) =>
      (b.lastAt ?? "").localeCompare(a.lastAt ?? "") || a.name.localeCompare(b.name),
  );
  return {
    role,
    people: list,
    activePeople: list.filter((p) => p.lastAt).length,
    views: viewRows,
    capabilities,
    usedViews: viewRows.filter((v) => v.uses > 0).length,
    usedCommands: commands.filter((c) => c.uses > 0).length,
    totalCommands: commands.length,
    failed: mine.filter((r) => r.kind === "failed").reduce((n, r) => n + r.uses, 0),
  };
}

/** Every role that has a member or any activity at the site, in the usual role order. */
export const summarizeUsage = (rows: readonly UsageRow[]): RoleUsage[] =>
  memberRoles
    .filter((role) => rows.some((r) => r.role === role))
    .map((role) => summarizeRole(role, rows));

// ---------------------------------------------------------------------------------------
// Per person and day (public.operator_usage_days, 20261117090000_operator_usage_detail.sql)
// ---------------------------------------------------------------------------------------

/** One person's use of one feature on one Malaysia day. */
export type UsageDay = {
  day: string;
  role: string;
  userId: string;
  profileId: string;
  kind: Exclude<UsageKind, "member" | "active">;
  detail: string;
  uses: number;
  firstAt: string;
  lastAt: string;
};
const dayKinds = ["command", "view", "failed", "open", "sign-in"] as const;

/** Reads the report's compact rows; anything malformed is dropped. */
export function parseUsageDays(value: unknown): UsageDay[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((e): UsageDay[] => {
    if (!Array.isArray(e) || e.length < 9) return [];
    const [day, role, userId, profileId, kind, detail, uses, firstAt, lastAt] = e;
    const known = dayKinds.find((k) => k === kind);
    return known &&
      [day, role, userId, profileId, detail, firstAt, lastAt].every(
        (v) => typeof v === "string",
      ) &&
      Number.isFinite(Number(uses))
      ? [{ day, role, userId, profileId, kind: known, detail, uses: Number(uses), firstAt, lastAt }]
      : [];
  });
}

/**
 * The per-period rows the role summary reads, built from the per-day rows: one row per
 * person and feature, plus each person's active days. `members` are the report's `member`
 * rows (people with access, active or not); names come from them.
 */
export function usageRowsFromDays(
  days: readonly UsageDay[],
  members: readonly UsageRow[],
): UsageRow[] {
  const names = new Map(members.map((m) => [m.userId, m.name]));
  const features = new Map<string, UsageRow & { days: Set<string> }>();
  const active = new Map<string, UsageRow & { days: Set<string> }>();
  const bump = (
    into: Map<string, UsageRow & { days: Set<string> }>,
    key: string,
    d: UsageDay,
    kind: UsageKind,
    detail: string,
    uses: number,
  ) => {
    const row = into.get(key) ?? {
      role: d.role,
      userId: d.userId,
      name: names.get(d.userId) ?? "",
      profileId: d.profileId,
      kind,
      detail,
      uses: 0,
      activeDays: 0,
      lastAt: null,
      days: new Set<string>(),
    };
    row.uses += uses;
    row.days.add(d.day);
    row.activeDays = row.days.size;
    row.lastAt = later(row.lastAt, d.lastAt);
    into.set(key, row);
  };
  for (const d of days) {
    const who = [d.role, d.userId, d.profileId].join("|");
    bump(features, [who, d.kind, d.detail].join("|"), d, d.kind, d.detail, d.uses);
    bump(active, who, d, "active", "", 0);
  }
  return [...members, ...active.values(), ...features.values()].map((row) => ({
    role: row.role,
    userId: row.userId,
    name: row.name,
    profileId: row.profileId,
    kind: row.kind,
    detail: row.detail,
    uses: row.uses,
    activeDays: row.activeDays,
    lastAt: row.lastAt,
  }));
}

/**
 * The intended process of each role, in order. A step is done on a day when the person
 * saved one of its commands or opened one of its screens that day. Owner-reviewed list:
 * change it here and the usage report follows.
 */
export type WorkflowStep = {
  id: string;
  en: string;
  ms: string;
  commands?: string[];
  views?: View[];
};
export const workflows: Record<MemberRole, WorkflowStep[]> = {
  production: [
    { id: "plan", en: "Plan the batch", ms: "Rancang kelompok", commands: ["batch"] },
    {
      id: "stages",
      en: "Record stages and PICs",
      ms: "Rekod peringkat dan PIC",
      commands: ["machine", "step"],
    },
    { id: "send", en: "Send to warehouse", ms: "Hantar ke gudang", commands: ["transfer"] },
    { id: "close", en: "Close the day", ms: "Tutup hari", commands: ["close"] },
  ],
  intake: [
    {
      id: "receive",
      en: "Receive from the factory",
      ms: "Terima dari kilang",
      commands: ["receive", "receive-ady"],
    },
    {
      id: "stages",
      en: "Record warehouse stages",
      ms: "Rekod peringkat gudang",
      commands: ["machine", "stage-skip", "wrapping-count"],
    },
    {
      id: "count",
      en: "Count boxes into stock",
      ms: "Kira kotak ke dalam stok",
      commands: ["wrapping-count", "stock-in-ady", "stock-add", "recount", "recount-ady"],
    },
    { id: "close", en: "Close the day", ms: "Tutup hari", commands: ["close"] },
  ],
  outbound: [
    {
      id: "orders",
      en: "Take in the day's orders",
      ms: "Terima pesanan hari ini",
      commands: ["import-receive", "order", "review-order"],
    },
    { id: "count", en: "Supervisor count", ms: "Kiraan penyelia", commands: ["sort-count"] },
    {
      id: "issue",
      en: "Issue stock from the racks",
      ms: "Keluarkan stok dari rak",
      commands: ["issue", "issue-orders"],
    },
    {
      id: "assign",
      en: "Assign packers",
      ms: "Tugaskan pembungkus",
      commands: ["assign-orders", "assign-package"],
    },
    {
      id: "handover",
      en: "Courier handover",
      ms: "Serahan kurier",
      commands: ["dispatch"],
    },
    { id: "close", en: "Close the day", ms: "Tutup hari", commands: ["close"] },
  ],
  admin: [
    { id: "upload", en: "Upload AWB PDFs", ms: "Muat naik PDF AWB", commands: ["import-save"] },
    {
      id: "release",
      en: "Review and release orders",
      ms: "Semak dan lepaskan pesanan",
      commands: ["import-release", "review-order"],
    },
    { id: "check", en: "Check order management", ms: "Semak pengurusan pesanan", views: ["orders"] },
  ],
  hr: [
    { id: "reports", en: "Open Reports & people", ms: "Buka Laporan & pasukan", views: ["reports"] },
    {
      id: "profiles",
      en: "Maintain team profiles",
      ms: "Selenggara profil pasukan",
      commands: ["staff-profile-create", "staff-profile-update"],
    },
  ],
  management: [
    { id: "overview", en: "Open Overview", ms: "Buka Gambaran", views: ["overview"] },
    { id: "tally", en: "Check the daily tally", ms: "Semak jumlah akhir hari", views: ["tally"] },
    { id: "trips", en: "Review driver trips", ms: "Semak perjalanan pemandu", views: ["trips"] },
    { id: "reports", en: "Open Reports & people", ms: "Buka Laporan & pasukan", views: ["reports"] },
    { id: "review", en: "Request follow-up", ms: "Minta susulan", commands: ["review"] },
  ],
  packer: [
    { id: "open", en: "Open the packing station", ms: "Buka stesen pembungkusan", views: ["packing"] },
    { id: "pack", en: "Record what was packed", ms: "Rekod apa yang dibungkus", commands: ["pack-own"] },
  ],
  driver: [
    { id: "trip", en: "Log the trip", ms: "Rekod perjalanan", commands: ["trip"] },
    {
      id: "arrive",
      en: "Add arrival, drop-offs and photo",
      ms: "Tambah ketibaan, hentian dan gambar",
      commands: ["trip-update", "trip-dropoff"],
    },
  ],
};

export type PersonDay = {
  day: string;
  firstAt: string;
  lastAt: string;
  signIns: number;
  views: number;
  commands: number;
  failed: number;
  /** Forms opened more often than saved that day, by command. */
  unsaved: string[];
  /** One flag per workflow step of the role. */
  done: boolean[];
};
export type PersonUsage = {
  key: string;
  days: PersonDay[];
  steps: { step: WorkflowStep; days: number }[];
  /** Days every step was done. */
  fullDays: number;
  /** The step most often not reached on days the process was left unfinished. */
  stoppedAt: WorkflowStep | null;
  usedViews: View[];
  unusedViews: View[];
  usedCommands: string[];
  unusedCommands: string[];
  forms: { command: string; opened: number; saved: number; failed: number }[];
};

/** One person's days in a role: what they did each day and how far the process got. */
export function personUsage(
  role: MemberRole,
  person: Pick<UsageRow, "userId" | "profileId">,
  days: readonly UsageDay[],
): PersonUsage {
  const mine = days.filter(
    (d) => d.role === role && d.userId === person.userId && d.profileId === person.profileId,
  );
  const steps = workflows[role] ?? [];
  const expected = expectedUsage(role);
  const commands = expected.capabilities.flatMap((c) => c.commands);
  const total = (kind: UsageDay["kind"], detail?: string, rows: readonly UsageDay[] = mine) =>
    rows
      .filter((d) => d.kind === kind && (detail === undefined || d.detail === detail))
      .reduce((n, d) => n + d.uses, 0);
  const byDay = [...new Set(mine.map((d) => d.day))]
    .sort()
    .reverse()
    .map((day): PersonDay => {
      const rows = mine.filter((d) => d.day === day);
      const opened = [...new Set(rows.filter((d) => d.kind === "open").map((d) => d.detail))];
      return {
        day,
        firstAt: rows.reduce((at, d) => (d.firstAt < at ? d.firstAt : at), rows[0].firstAt),
        lastAt: rows.reduce((at, d) => (d.lastAt > at ? d.lastAt : at), rows[0].lastAt),
        signIns: total("sign-in", undefined, rows),
        views: total("view", undefined, rows),
        commands: total("command", undefined, rows),
        failed: total("failed", undefined, rows),
        unsaved: opened.filter(
          (c) => total("open", c, rows) > total("command", c, rows),
        ),
        done: steps.map((step) =>
          rows.some(
            (d) =>
              (d.kind === "command" && !!step.commands?.includes(d.detail)) ||
              (d.kind === "view" && !!step.views?.some((v) => v === d.detail)),
          ),
        ),
      };
    });
  const stops = new Map<number, number>();
  for (const d of byDay) {
    if (d.done.every(Boolean)) continue;
    // The first step not done after the furthest step reached that day.
    const next = d.done.lastIndexOf(true) + 1;
    const stop = next < steps.length ? next : d.done.indexOf(false);
    stops.set(stop, (stops.get(stop) ?? 0) + 1);
  }
  const stopped = [...stops].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  const usedViews = expected.views.filter((v) => total("view", v) > 0);
  const usedCommands = commands.filter((c) => total("command", c) > 0);
  return {
    key: personKey(person),
    days: byDay,
    steps: steps.map((step, i) => ({ step, days: byDay.filter((d) => d.done[i]).length })),
    fullDays: steps.length ? byDay.filter((d) => d.done.every(Boolean)).length : 0,
    stoppedAt: stopped ? (steps[stopped[0]] ?? null) : null,
    usedViews,
    unusedViews: expected.views.filter((v) => !usedViews.includes(v)),
    usedCommands,
    unusedCommands: commands.filter((c) => !usedCommands.includes(c)),
    forms: commands
      .map((command) => ({
        command,
        opened: total("open", command),
        saved: total("command", command),
        failed: total("failed", command),
      }))
      .filter((f) => f.opened > 0 || f.failed > 0),
  };
}
