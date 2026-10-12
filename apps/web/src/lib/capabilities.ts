// Role capabilities and command rules. Mirrors the reference tables seeded by
// supabase/migrations/20261005090000_operator_trusted_commands.sql and changed by later
// migrations; tests/capabilities checks that both stay identical. The database copy is authoritative for writes.
export type Capability =
  | "production.plan"
  | "stage.record"
  | "stage.correct"
  | "machines.manage"
  | "stock.receive"
  | "stock.adjust"
  | "orders.enter"
  | "orders.import"
  | "outbound.fulfil"
  | "outbound.correct"
  | "sources.read"
  | "review.comment"
  | "feedback.post"
  | "day.close"
  | "members.manage"
  | "trips.log"
  | "trips.read"
  | "packing.record";
export type MemberRole =
  | "production"
  | "intake"
  | "outbound"
  | "admin"
  | "hr"
  | "management"
  | "packer"
  | "driver";
export const memberRoles: MemberRole[] = [
  "production",
  "intake",
  "outbound",
  "admin",
  "hr",
  "management",
  "packer",
  "driver",
];
/** Only these roles may hold an all-sites membership. */
export const crossSiteRoles: MemberRole[] = ["admin", "hr", "management"];
export const roleCapabilities: Record<MemberRole, Capability[]> = {
  production: [
    "production.plan",
    "stage.record",
    "stage.correct",
    "machines.manage",
    "day.close",
    "feedback.post",
    "members.manage",
  ],
  intake: [
    "stage.record",
    "stage.correct",
    "machines.manage",
    "stock.receive",
    "stock.adjust",
    "day.close",
    "feedback.post",
    "members.manage",
  ],
  outbound: [
    "orders.enter",
    "outbound.fulfil",
    "outbound.correct",
    "sources.read",
    "day.close",
    "feedback.post",
    "members.manage",
    "trips.read",
  ],
  admin: ["orders.import", "orders.enter", "sources.read", "feedback.post"],
  hr: ["members.manage", "feedback.post"],
  management: ["review.comment", "sources.read", "feedback.post", "trips.read"],
  // Packers share one sign-in per site and record their own packed counts after unlocking
  // their profile with a PIN (see apps/web/src/lib/packer-session.ts).
  packer: ["feedback.post", "packing.record"],
  // Drivers log their own trips (assistant, pickup/arrival time, photo). One role covers
  // the whole crew: the assistant is recorded by name on the trip, not as a separate login.
  driver: ["trips.log", "feedback.post"],
};
export const commandRules: Record<
  string,
  { capability: Capability; stateKeys: string[] }
> = {
  batch: { capability: "production.plan", stateKeys: ["batches", "events"] },
  "route-review": { capability: "production.plan", stateKeys: ["batches", "events"] },
  step: { capability: "production.plan", stateKeys: ["batches", "events"] },
  transfer: { capability: "production.plan", stateKeys: ["batches", "events"] },
  machine: { capability: "stage.record", stateKeys: ["batches", "events"] },
  "stage-rework": { capability: "stage.record", stateKeys: ["batches", "events"] },
  "change-step-pic": { capability: "stage.correct", stateKeys: ["batches", "events"] },
  "stage-correct": { capability: "stage.correct", stateKeys: ["batches", "events"] },
  "machine-create": { capability: "machines.manage", stateKeys: ["machines", "events"] },
  "machine-update": { capability: "machines.manage", stateKeys: ["machines", "events"] },
  "machine-deactivate": { capability: "machines.manage", stateKeys: ["machines", "events"] },
  "machine-reactivate": { capability: "machines.manage", stateKeys: ["machines", "events"] },
  receive: { capability: "stock.receive", stateKeys: ["cartons", "events"] },
  "receive-ady": { capability: "stock.receive", stateKeys: ["adypocideReceipts", "events"] },
  "stock-in-ady": {
    capability: "stock.receive",
    stateKeys: ["cartons", "adypocideReceipts", "events"],
  },
  count: { capability: "stock.receive", stateKeys: ["counts", "events"] },
  return: { capability: "stock.receive", stateKeys: ["returns", "events"] },
  adjust: { capability: "stock.adjust", stateKeys: ["adjustments", "counts", "events"] },
  order: { capability: "orders.enter", stateKeys: ["orders", "events"] },
  "edit-order": { capability: "orders.enter", stateKeys: ["orders", "events"] },
  "review-order": { capability: "orders.enter", stateKeys: ["orders", "events"] },
  "split-order": { capability: "orders.enter", stateKeys: ["orders", "events"] },
  // PDF uploads live in operator_imports since 20261012090000: saving and receiving use
  // their own functions (/api/imports); these three carry their upload effects in the
  // signed commit and change only orders and audit entries in the document.
  "remove-order": { capability: "orders.enter", stateKeys: ["orders", "events"] },
  "import-release": { capability: "orders.import", stateKeys: ["orders", "events"] },
  "import-delete": { capability: "orders.import", stateKeys: ["orders", "events"] },
  "sort-count": { capability: "outbound.fulfil", stateKeys: ["sortCounts", "events"] },
  "assign-package": { capability: "outbound.fulfil", stateKeys: ["orders", "events"] },
  "assign-orders": { capability: "outbound.fulfil", stateKeys: ["orders", "events"] },
  "print-orders": { capability: "outbound.fulfil", stateKeys: ["orders", "events"] },
  "move-orders": { capability: "outbound.fulfil", stateKeys: ["orders", "events"] },
  print: { capability: "outbound.fulfil", stateKeys: ["orders", "events"] },
  "issue-orders": { capability: "outbound.fulfil", stateKeys: ["issues", "events"] },
  issue: { capability: "outbound.fulfil", stateKeys: ["issues", "events"] },
  pack: { capability: "outbound.fulfil", stateKeys: ["orders", "events"] },
  "pack-own": { capability: "packing.record", stateKeys: ["orders", "events"] },
  dispatch: { capability: "outbound.fulfil", stateKeys: ["orders", "events"] },
  correct: { capability: "outbound.correct", stateKeys: ["orders", "events"] },
  review: { capability: "review.comment", stateKeys: ["notes", "events"] },
  feedback: { capability: "feedback.post", stateKeys: ["notes"] },
  close: { capability: "day.close", stateKeys: ["closedDays", "events"] },
  trip: { capability: "trips.log", stateKeys: ["trips", "events"] },
  "trip-update": { capability: "trips.log", stateKeys: ["trips", "events"] },
  "trip-dropoff": { capability: "trips.log", stateKeys: ["trips", "events"] },
  "staff-profile-create": {
    capability: "members.manage",
    stateKeys: ["staffProfiles", "events"],
  },
  "staff-profile-update": {
    capability: "members.manage",
    stateKeys: ["staffProfiles", "events"],
  },
};
/**
 * Order commands on a site whose orders are table rows (operator_workspaces.order_store =
 * 'tables', since migration 20261014090000_operator_order_records): what each command may
 * change through operator_commit_records. Mirrors the operator_record_rules seed;
 * tests/capabilities.test.mjs checks they stay identical. Column names are the
 * operator_orders columns (snake_case). The database copy is authoritative for writes.
 */
export type RecordRule = {
  capability: Capability;
  /** May insert AWB rows. */
  orderInsert: boolean;
  /** May delete AWB rows. */
  orderDelete: boolean;
  /** Columns an update may set (server-time columns in this list are stamped by the database). */
  orderColumns: string[];
  /** May insert stock issues. */
  issues: boolean;
  /** May insert supervisor sort counts. */
  sortCounts: boolean;
  /** The upload effect the command carries (operator_private.apply_import_effects). */
  importEffects: "release" | "delete" | "rows" | null;
};
const rule = (
  capability: Capability,
  scope: Partial<Omit<RecordRule, "capability">> = {},
): RecordRule => ({
  capability,
  orderInsert: false,
  orderDelete: false,
  orderColumns: [],
  issues: false,
  sortCounts: false,
  importEffects: null,
  ...scope,
});
const assignColumns = ["assigned_packer", "assigned_at"];
const packColumns = [
  "actual",
  "lines",
  "packer",
  "label_pic",
  "packed_at",
  "pack_recorded_at",
  "pack_recorded_by",
];
export const recordRules: Record<string, RecordRule> = {
  order: rule("orders.enter", { orderInsert: true }),
  "edit-order": rule("orders.enter", {
    orderColumns: [
      "awb",
      "product",
      "channel",
      "package",
      "expected",
      "original_expected",
      "lines",
      "fulfil_date",
    ],
  }),
  "review-order": rule("orders.enter", { orderColumns: ["review_state", "reviewed_by"] }),
  "remove-order": rule("orders.enter", { orderDelete: true, importEffects: "rows" }),
  "split-order": rule("orders.enter", {
    orderInsert: true,
    orderColumns: [
      "awb",
      "product",
      "package",
      "expected",
      "original_expected",
      "lines",
      "review_state",
      "reviewed_by",
      "assigned_packer",
      "assigned_at",
      "printed",
      "packer",
      "label_pic",
      "note",
    ],
  }),
  "assign-package": rule("outbound.fulfil", { orderColumns: assignColumns }),
  "assign-orders": rule("outbound.fulfil", { orderColumns: assignColumns }),
  print: rule("outbound.fulfil", { orderColumns: ["printed"] }),
  "print-orders": rule("outbound.fulfil", { orderColumns: ["printed"] }),
  "move-orders": rule("outbound.fulfil", { orderColumns: ["fulfil_date"] }),
  issue: rule("outbound.fulfil", { issues: true }),
  "issue-orders": rule("outbound.fulfil", { issues: true }),
  pack: rule("outbound.fulfil", { orderColumns: packColumns }),
  "pack-own": rule("packing.record", { orderColumns: packColumns }),
  correct: rule("outbound.correct", { orderColumns: ["expected", "actual", "lines"] }),
  dispatch: rule("outbound.fulfil", { orderColumns: ["dispatched", "handover_ref"] }),
  "sort-count": rule("outbound.fulfil", { sortCounts: true }),
  "import-release": rule("orders.import", { orderInsert: true, importEffects: "release" }),
  "import-delete": rule("orders.import", { orderDelete: true, importEffects: "delete" }),
};
export const grantableRoles: Partial<Record<MemberRole, MemberRole[]>> = {
  hr: [...memberRoles],
  production: ["packer", "driver"],
  intake: ["packer", "driver"],
  outbound: ["packer", "driver"],
};
/** Role ceiling, optionally narrowed by the site's policy for that role. */
export function effectiveCapabilities(
  role: string,
  sitePolicy?: unknown,
): Capability[] {
  const ceiling = roleCapabilities[role as MemberRole] ?? [];
  const policy = (sitePolicy ?? {}) as Record<string, unknown>;
  const narrowed = policy[role];
  return Array.isArray(narrowed)
    ? ceiling.filter((c) => narrowed.includes(c))
    : [...ceiling];
}
