import { createHash, createHmac } from "node:crypto";
import {
  commandRules,
  effectiveCapabilities,
  type Capability,
  type MemberRole,
} from "./capabilities.ts";
import { products, type Batch } from "./draft.ts";

/**
 * Server-side authorization and commit signing for workspace members (OPER-2/4/5).
 * Roles and sites come from `operator_memberships`, never from the client. The database
 * re-checks everything in `operator_commit_workspace`; this module fails fast and signs
 * the validated transition.
 */
export { effectiveCapabilities, type Capability, type MemberRole };

/** Returns a denial message, or null when the capabilities allow the command. */
export function authorizeMember(
  type: string,
  capabilities: readonly string[],
): string | null {
  const rule = commandRules[type];
  if (!rule) return "This action is not available in operational workspaces.";
  if (!capabilities.includes(rule.capability))
    return capabilities.every((c) => c === "feedback.post" || c === "trips.log")
      ? "Operational records are entered by your supervisor. You can view records" +
          (capabilities.includes("trips.log") ? ", log your own trips" : "") +
          " and post feedback."
      : "Your role at this site does not permit this action.";
  return null;
}

/** Top-level records a command changed outside its declared scope (mirrors the database). */
export function outOfScopeKeys(
  type: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  const scope = new Set(commandRules[type]?.stateKeys ?? []);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter(
    (key) =>
      !scope.has(key) &&
      JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}

export const factories = ["bottle", "sachet"] as const;
/** A production supervisor's factory scope; absent = both factories. */
export type Factory = (typeof factories)[number];
export const asFactory = (value: unknown): Factory | undefined =>
  factories.find((f) => f === value);
const productFactory = (productId: unknown) =>
  products.find((p) => p.id === productId)?.factory;
const factoryName = (factory: Factory) =>
  factory === "sachet" ? "sachet" : "bottle (capsule)";
export class AccessDenied extends Error {}

/**
 * Fails fast, before the domain rules run, when a factory-scoped member targets the other
 * factory: the batch being planned (`product`) or changed (`id`), or the machine register
 * (sachet route equipment). outOfFactory() re-checks the resulting state.
 */
export function factoryDenial(
  factory: Factory | undefined,
  type: string,
  input: Record<string, unknown>,
  batches: readonly Batch[],
): string | null {
  if (!factory) return null;
  const denial = `Your access covers the ${factoryName(factory)} factory only. Ask that factory's supervisor to record this.`;
  if (commandRules[type]?.stateKeys.includes("machines") && factory !== "sachet")
    return "Machines belong to the sachet factory. " + denial;
  if (!commandRules[type]?.stateKeys.includes("batches")) return null;
  if (type === "batch")
    return productFactory(input.product) === factory ? null : denial;
  // An unknown batch is reported by the domain rules ("could not be found").
  const batch = batches.find((b) => b.id === input.id);
  return !batch || productFactory(batch.product) === factory ? null : denial;
}

/**
 * Batch codes a transition added, changed or removed outside the member's factory, plus
 * "machines" when a bottle-scoped member changed the machine register. Mirrors
 * operator_private.assert_factory_scope; fails closed on unknown products.
 */
export function outOfFactory(
  factory: Factory | undefined,
  before: { batches?: Batch[]; machines?: unknown[] },
  after: { batches?: Batch[]; machines?: unknown[] },
): string[] {
  if (!factory) return [];
  const versions = (list?: Batch[]) =>
    new Map((list ?? []).map((b) => [JSON.stringify(b), b]));
  const old = versions(before.batches),
    next = versions(after.batches);
  const changed = [
    ...[...next].filter(([text]) => !old.has(text)),
    ...[...old].filter(([text]) => !next.has(text)),
  ].map(([, b]) => b);
  const outside = changed
    .filter((b) => productFactory(b?.product) !== factory)
    .map((b) => String(b?.code ?? b?.id));
  if (
    factory !== "sachet" &&
    JSON.stringify(before.machines ?? []) !== JSON.stringify(after.machines ?? [])
  )
    outside.push("machines");
  return [...new Set(outside)];
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

/** Server key shared with operator_private.server_keys ('commit'); hex, at least 32 bytes. */
export function commitSecret(): Buffer | null {
  const hex = process.env.OPERATOR_COMMIT_SECRET ?? "";
  return /^[0-9a-f]{64,}$/i.test(hex) && hex.length % 2 === 0
    ? Buffer.from(hex, "hex")
    : null;
}
/**
 * Signs a validated transition for one user, workspace revision, command and operation.
 * Must match the message built in public.operator_commit_workspace.
 */
export function attest(
  secret: Buffer,
  t: {
    workspaceId: string;
    revision: number;
    userId: string;
    operationId: string;
    command: string;
    fingerprint: string;
    stateText: string;
  },
) {
  const stateHash = createHash("sha256").update(t.stateText, "utf8").digest("hex");
  const message = [
    "operator-commit-v1",
    t.workspaceId,
    String(t.revision),
    t.userId,
    t.operationId,
    t.command,
    t.fingerprint,
    stateHash,
  ].join("\n");
  return createHmac("sha256", secret).update(message, "utf8").digest("hex");
}
