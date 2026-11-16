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
export type UsageKind = "member" | "active" | "command" | "view" | "failed";
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
