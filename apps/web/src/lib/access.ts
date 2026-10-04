import { createHash } from "node:crypto";
import type { Role, WritePolicy } from "./draft.ts";

/**
 * Server-side write policy for authenticated workspace members (OPER-2).
 * Membership roles come from `operator_memberships`, never from the client.
 * Keep `roleStateKeys` aligned with `public.operator_writable_keys` in
 * supabase/migrations/20261004090000_operator_memberships.sql.
 */
export type MemberRole = Role | "driver" | "assistant";
export const memberRoles: MemberRole[] = [
  "production",
  "intake",
  "outbound",
  "admin",
  "management",
  "packer",
  "driver",
  "assistant",
];
export const supervisorRoles: Role[] = ["production", "intake", "outbound"];
/** Default for operational workspaces: the two exceptions stay off until the owner decides. */
export const defaultWritePolicy: WritePolicy = {
  adminImports: false,
  managementComments: false,
};
export const readWritePolicy = (raw: unknown): WritePolicy => {
  const value = (raw ?? {}) as Record<string, unknown>;
  return {
    adminImports: value.admin_imports === true,
    managementComments: value.management_comments === true,
  };
};

const sachetEntry = [
  "change-step-pic",
  "machine",
  "stage-rework",
  "stage-correct",
  "machine-create",
  "machine-update",
  "machine-deactivate",
  "machine-reactivate",
];
const memberCommands: Record<Role, string[]> = {
  production: [
    "batch",
    "route-review",
    "step",
    "transfer",
    ...sachetEntry,
    "close",
    "feedback",
  ],
  intake: [
    ...sachetEntry,
    "receive",
    "receive-ady",
    "stock-in-ady",
    "count",
    "adjust",
    "close",
    "feedback",
  ],
  outbound: [
    "order",
    "edit-order",
    "review-order",
    "split-order",
    "sort-count",
    "assign-package",
    "assign-orders",
    "print-orders",
    "move-orders",
    "issue-orders",
    "print",
    "issue",
    "pack",
    "correct",
    "dispatch",
    "import-receive",
    "close",
    "feedback",
  ],
  admin: [
    "import-save",
    "import-release",
    "order",
    "edit-order",
    "review-order",
    "split-order",
    "feedback",
  ],
  management: ["review", "feedback"],
  packer: [],
};
export const roleStateKeys: Record<string, string[]> = {
  production: ["batches", "machines", "events", "notes", "closedDays", "operations"],
  intake: [
    "batches",
    "machines",
    "cartons",
    "adypocideReceipts",
    "counts",
    "adjustments",
    "events",
    "notes",
    "closedDays",
    "operations",
  ],
  outbound: [
    "orders",
    "issues",
    "sortCounts",
    "awbImports",
    "events",
    "notes",
    "closedDays",
    "operations",
  ],
  admin: ["orders", "awbImports", "events", "notes", "operations"],
  management: ["notes", "events", "operations"],
};

/** Returns a denial message, or null when the member may run the command. */
export function authorizeMember(
  role: MemberRole,
  type: string,
  policy: WritePolicy,
): string | null {
  if (role === "admin" && !policy.adminImports)
    return "Office-admin imports are not enabled for this workspace. Ask a supervisor to record this.";
  if (role === "management" && !policy.managementComments)
    return "Management comments are not enabled for this workspace. Operational entry is supervisor-only.";
  const allowed = memberCommands[role as Role];
  if (!allowed?.length)
    return "Operational records are entered by your supervisor. This account can view only.";
  if (!allowed.includes(type))
    return "Your signed-in role does not permit this action.";
  return null;
}

/** Defence in depth: mirrors the database commit guard for the role's state scope. */
export function outOfScopeKeys(
  role: MemberRole,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  const scope = new Set(roleStateKeys[role] ?? []);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter(
    (key) =>
      !scope.has(key) &&
      JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value as object)
            .sort()
            .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
        )
      : value;
/** Stable payload fingerprint so a reused operation ID with different input is rejected. */
export const fingerprint = (type: string, input: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical({ type, input })))
    .digest("hex");
export const OPERATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
