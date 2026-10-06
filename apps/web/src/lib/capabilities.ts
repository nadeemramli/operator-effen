// Role capabilities and command rules. Mirrors the reference tables seeded by
// supabase/migrations/20261005090000_operator_trusted_commands.sql; tests/capabilities
// checks that both stay identical. The database copy is authoritative for writes.
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
  | "trips.read";
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
  packer: ["feedback.post"],
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
  adjust: { capability: "stock.adjust", stateKeys: ["adjustments", "counts", "events"] },
  order: { capability: "orders.enter", stateKeys: ["orders", "events"] },
  "edit-order": { capability: "orders.enter", stateKeys: ["orders", "events"] },
  "review-order": { capability: "orders.enter", stateKeys: ["orders", "events"] },
  "split-order": { capability: "orders.enter", stateKeys: ["orders", "events"] },
  "import-save": { capability: "orders.import", stateKeys: ["awbImports", "events"] },
  "import-release": {
    capability: "orders.import",
    stateKeys: ["awbImports", "orders", "events"],
  },
  "import-receive": {
    capability: "outbound.fulfil",
    stateKeys: ["awbImports", "orders", "events"],
  },
  "sort-count": { capability: "outbound.fulfil", stateKeys: ["sortCounts", "events"] },
  "assign-package": { capability: "outbound.fulfil", stateKeys: ["orders", "events"] },
  "assign-orders": { capability: "outbound.fulfil", stateKeys: ["orders", "events"] },
  "print-orders": { capability: "outbound.fulfil", stateKeys: ["orders", "events"] },
  "move-orders": { capability: "outbound.fulfil", stateKeys: ["orders", "events"] },
  print: { capability: "outbound.fulfil", stateKeys: ["orders", "events"] },
  "issue-orders": { capability: "outbound.fulfil", stateKeys: ["issues", "events"] },
  issue: { capability: "outbound.fulfil", stateKeys: ["issues", "events"] },
  pack: { capability: "outbound.fulfil", stateKeys: ["orders", "events"] },
  dispatch: { capability: "outbound.fulfil", stateKeys: ["orders", "events"] },
  correct: { capability: "outbound.correct", stateKeys: ["orders", "events"] },
  review: { capability: "review.comment", stateKeys: ["notes", "events"] },
  feedback: { capability: "feedback.post", stateKeys: ["notes"] },
  close: { capability: "day.close", stateKeys: ["closedDays", "events"] },
  trip: { capability: "trips.log", stateKeys: ["trips", "events"] },
  "trip-update": { capability: "trips.log", stateKeys: ["trips", "events"] },
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
