import { randomUUID } from "node:crypto";
import { sameOrigin } from "@/lib/request-origin";
import { NextRequest, NextResponse } from "next/server";
import {
  resolveAccess,
  supabaseServer,
  type Membership,
} from "@/lib/supabase/server";
import {
  applyCommand,
  ConflictError,
  createDraft,
  findOperation,
  previewCapabilities,
  recordOperation,
  roleLabel,
  roles,
  withBatchReferences,
  type Command,
  type Draft,
  type Recorder,
  type Role,
} from "@/lib/draft";
import {
  AccessDenied,
  attest,
  attestRecords,
  authorizeMember,
  commitSecret,
  factoryDenial,
  fingerprint,
  OPERATION_ID,
  outOfFactory,
  outOfScopeKeys,
} from "@/lib/access";
import { importEffects, type ImportEffects } from "@/lib/awb-import";
import {
  ImportLoadError,
  loadImport,
  rpcFailure,
  SANDBOX_UPLOADS,
} from "@/lib/imports-server";
import { rebaseLoop, STALE_MESSAGE, type RebaseStep } from "@/lib/rebase";
import { eventProblem } from "@/lib/events";
import { commandRules, recordRules } from "@/lib/capabilities";
import {
  documentView,
  loadSlice,
  sliceDelta,
  stripTransient,
  type LoadedSlice,
} from "@/lib/order-records";
import {
  afterRecordsCommit,
  recordSource,
  RecordLoadError,
  releasedFrom,
} from "@/lib/order-records-server";
import { packerOnly, packerProjection } from "@/lib/order-reads";
import {
  openPackerSession,
  PACKER_COOKIE,
  PACKER_IDLE_MS,
  packerCookieOptions,
  sealPackerSession,
  type PackerSession,
} from "@/lib/packer-session";
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
const pick = (memberships: Membership[], requested?: unknown) =>
  typeof requested === "string" && requested
    ? memberships.find((m) => m.workspaceId === requested)
    : memberships[0];
const actorView = (userId: string, m?: Membership) =>
  m
    ? {
        kind: "member" as const,
        userId,
        role: m.role,
        scope: m.scope,
        name: m.displayName,
        staffProfileId: m.staffProfileId,
        siteId: m.siteId,
        workspaceId: m.workspaceId,
        workspaceName: m.workspaceName,
        capabilities: m.capabilities,
        factory: m.factory,
      }
    : { kind: "preview" as const, userId };
// Commands whose upload lives in operator_imports (20261012090000_operator_imports.sql).
const uploadCommands = ["import-release", "import-delete"];
/**
 * A site document as the domain code and the screens use it. Audit entries live in
 * operator_events since 20261013090000 and the stored document has no `events` key: the
 * list starts empty, a command logs its new entries into it, and the commit RPC moves them
 * to the table. Screens read the entries through /api/events.
 */
const siteState = (stored: unknown): Draft => ({ ...(stored as Draft), events: [] });
/**
 * The site document as a member's screens receive it. On a tables-mode site
 * (20261014090000) the document has no order lists: the screens read AWBs through
 * /api/orders/*, and get empty lists plus the per-carton issued totals (`cartonIssued`) so
 * stock balances count table issues. Members of the shared packer sign-in get only the
 * staff profiles and notes there (packer projection; their AWBs come from
 * /api/orders/packer). Document-mode sites get the document as before.
 */
const clientState = (
  stored: unknown,
  tables: boolean,
  m: Membership,
  cartonIssued?: Record<string, number>,
): Draft =>
  !tables
    ? withBatchReferences(siteState(stored))
    : packerOnly(m.capabilities)
      ? packerProjection(siteState(stored))
      : withBatchReferences(documentView(siteState(stored), cartonIssued ?? {}));

export async function GET(request: NextRequest) {
  const access = await resolveAccess();
  if (access.status !== 200)
    return json({ error: access.error }, access.status);
  const { db, user, memberships } = access;
  if (memberships.length) {
    const m = pick(memberships, request.nextUrl.searchParams.get("workspace"));
    if (!m) return json({ error: "You do not have access to that site." }, 403);
    const { data, error } = await loadSite(db, m.workspaceId);
    if (error || !data)
      return json({ error: "Unable to load your site workspace." }, 503);
    const tables = data.order_store === "tables";
    let cartonIssued: Record<string, number> | undefined;
    if (tables && !packerOnly(m.capabilities))
      try {
        cartonIssued = await recordSource(db, m.workspaceId).cartonTotals();
      } catch {
        return json({ error: "Unable to load your site workspace." }, 503);
      }
    return json({
      state: clientState(data.state, tables, m, cartonIssued),
      revision: data.revision,
      ...(tables ? { orderStore: "tables" } : {}),
      actor: actorView(user.id, m),
      workspaces: memberships.map((w) => ({
        id: w.workspaceId,
        name: w.workspaceName,
        role: w.role,
      })),
    });
  }
  let { data, error } = await db
    .from("ui_draft_workspaces")
    .select("state,revision")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) return json({ error: "Unable to load the test workspace." }, 503);
  if (!data) {
    const created = await db
      .from("ui_draft_workspaces")
      .insert({ user_id: user.id, state: createDraft(), revision: 0 })
      .select("state,revision")
      .single();
    if (created.error?.code === "23505") {
      const retry = await db
        .from("ui_draft_workspaces")
        .select("state,revision")
        .eq("user_id", user.id)
        .single();
      data = retry.data;
      error = retry.error;
    } else {
      data = created.data;
      error = created.error;
    }
  }
  if (error || !data)
    return json({ error: "Unable to prepare the test workspace." }, 503);
  return json({
    ...data,
    state: withBatchReferences(data.state as Draft),
    actor: actorView(user.id),
  });
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return json({ error: "Request not allowed." }, 403);
  const access = await resolveAccess();
  if (access.status !== 200)
    return json({ error: access.error }, access.status);
  const { db, user, memberships } = access;
  const raw = await request.text();
  if (raw.length > 1000000) return json({ error: "Request too large." }, 413);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  if (
    !body ||
    !Number.isInteger(body.revision) ||
    !body.command ||
    typeof body.command.type !== "string" ||
    typeof body.command.input !== "object" ||
    !body.command.input ||
    Array.isArray(body.command.input) ||
    (body.operationId !== undefined &&
      (typeof body.operationId !== "string" ||
        !OPERATION_ID.test(body.operationId)))
  )
    return json({ error: "Invalid action." }, 400);
  const type: string = body.command.type,
    input: Record<string, unknown> = body.command.input;
  const print = fingerprint(type, input);

  // Fictional sandbox: per-account JSON, preview roles. Never an operational workspace.
  if (!memberships.length) {
    if (process.env.OPERATOR_PREVIEW_WRITES === "off")
      return json({ error: "The preview sandbox is read-only." }, 403);
    if (!roles.some((r) => r.id === body.command.role))
      return json({ error: "Choose a valid test role." }, 400);
    const role: Role = body.command.role;
    const operationId: string | undefined = body.operationId;
    // The sandbox keeps the document shape and has no upload tables.
    if (uploadCommands.includes(type))
      return json({ error: SANDBOX_UPLOADS }, 403);
    try {
      if (type.startsWith("trip") && typeof input.photo === "string" && input.photo)
        await requireTripPhoto(db, "trip-draft-photos", user.id, input.photo);
    } catch (e) {
      return domainError(e);
    }
    // Load the latest state, apply, commit with its revision; repeat if someone saved first.
    return rebaseLoop(async (): Promise<RebaseStep<NextResponse>> => {
      const loaded = await db
        .from("ui_draft_workspaces")
        .select("state,revision")
        .eq("user_id", user.id)
        .single();
      if (!loaded.data)
        return { done: json({ error: "Unable to load the test workspace." }, 503) };
      const current = loaded.data.state as Draft;
      if (
        type === "remove-order" &&
        current.orders.some((o) => o.id === input.id && o.importId)
      )
        return {
          done: json(
            {
              error:
                "AWBs from a PDF upload are removed on the synthetic operational site. " +
                SANDBOX_UPLOADS,
            },
            403,
          ),
        };
      if (operationId) {
        const prior = findOperation(current, operationId);
        if (prior)
          return {
            done:
              prior.fingerprint === print && prior.userId === user.id
                ? json({
                    state: withBatchReferences(current),
                    revision: loaded.data.revision,
                    replayed: true,
                  })
                : json(
                    {
                      error:
                        "This save ID was already used for a different change. Nothing new was saved; refresh and review.",
                      code: "operation-mismatch",
                    },
                    409,
                  ),
          };
      }
      let state: Draft;
      try {
        state = applyCommand(current, {
          type,
          role,
          input,
          capabilities: previewCapabilities(role),
          actor: {
            kind: "preview",
            role,
            name: roleLabel(role) + " (test view)",
            userId: user.id,
          },
          // Fictional sandbox: no PINs; the previewed packer picks a sample profile.
          performer: typeof input.profile === "string" ? input.profile : undefined,
        });
        if (operationId)
          recordOperation(state, {
            id: operationId,
            type,
            fingerprint: print,
            userId: user.id,
            at: new Date().toISOString(),
          });
        if (new TextEncoder().encode(JSON.stringify(state)).length > 1800000)
          throw new Error(
            "The shared test workspace is full. This change has not been saved.",
          );
      } catch (e) {
        return { done: domainError(e) };
      }
      const result = await db
        .from("ui_draft_workspaces")
        .update({
          state,
          revision: loaded.data.revision + 1,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", user.id)
        .eq("revision", loaded.data.revision)
        .select("state,revision")
        .maybeSingle();
      if (result.error)
        return {
          done: json(
            { error: "Unable to save. Your change has not been recorded." },
            503,
          ),
        };
      if (!result.data) return { stale: true };
      return { done: json(result.data) };
    }, staleResponse);
  }

  // Operational workspace: identity, role, site and capabilities come from the server
  // session and memberships; any client-sent role or actor field is ignored.
  const membership = pick(memberships, body.workspaceId);
  if (!membership)
    return json({ error: "You do not have access to that site." }, 403);
  const denied = authorizeMember(type, membership.capabilities);
  if (denied) return json({ error: denied }, 403);
  const secret = commitSecret();
  if (!secret)
    return json(
      { error: "Operational saving is not configured on this server." },
      503,
    );
  const operationId: string = body.operationId ?? randomUUID();
  // Shared packer sign-in: a packer's own count is saved only for the profile their PIN
  // unlocked on this device (signed cookie), never for a profile named in the request.
  let packer: PackerSession | null = null;
  if (commandRules[type]?.capability === "packing.record") {
    packer = openPackerSession(secret, request.cookies.get(PACKER_COOKIE)?.value, {
      userId: user.id,
      workspaceId: membership.workspaceId,
    });
    if (!packer)
      return json(
        {
          error:
            "Your packer session ended. Choose your name and enter your PIN again. Nothing was saved.",
          code: "packer-locked",
        },
        403,
      );
  }
  const recorder: Recorder = {
    kind: "member",
    role: membership.role as Role,
    name: membership.displayName,
    userId: user.id,
    staffProfileId: membership.staffProfileId,
    siteId: membership.siteId,
  };
  // Stored files do not depend on the records; check them once, before any attempt.
  try {
    if (type.startsWith("trip") && typeof input.photo === "string" && input.photo)
      await requireTripPhoto(
        db,
        "operator-trip-photos",
        `${membership.workspaceId}/${user.id}`,
        input.photo,
      );
  } catch (e) {
    return domainError(e);
  }
  // Load the latest state (on a tables-mode site, for an order command: the rows it needs),
  // apply, commit with its revision (or the rows' versions); repeat if someone saved first.
  // The operation-ID replay check is the first step of every attempt.
  const workspaceId = membership.workspaceId;
  const packerSeal = packer ? request.cookies.get(PACKER_COOKIE)?.value ?? null : null;
  // Each save keeps the packer's session open for another idle period. The attempt that
  // committed is reported, so tests can tell a first-try save from a rebased one.
  const saved = (body: Record<string, unknown>, attempt: number) => {
    const response = json({
      ...body,
      ...(packer ? { packerExpiresAt: Date.now() + PACKER_IDLE_MS } : {}),
    });
    response.headers.set("X-Operator-Attempts", String(attempt));
    if (packer)
      response.cookies.set(
        PACKER_COOKIE,
        sealPackerSession(secret, { ...packer, expiresAt: Date.now() + PACKER_IDLE_MS }),
        packerCookieOptions(PACKER_IDLE_MS),
      );
    return response;
  };
  return rebaseLoop(async (attempt): Promise<RebaseStep<NextResponse>> => {
    const [prior, loaded] = await Promise.all([
      priorCommit(db, workspaceId, operationId),
      loadSite(db, workspaceId),
    ]);
    if (prior.error || loaded.error || !loaded.data)
      return { done: json({ error: "Unable to load your site workspace." }, 503) };
    // The site's order store, read with the member's client in every attempt: an owner may
    // move the site between attempts (20261014090000_operator_order_records.sql).
    const tables = loaded.data.order_store === "tables";
    // The site document as the member's screens receive it (with fresh carton totals on a
    // tables-mode site, after the commit when there is one).
    const view = async (stored: unknown = loaded.data!.state) =>
      clientState(
        stored,
        tables,
        membership,
        tables && !packerOnly(membership.capabilities)
          ? await recordSource(db, workspaceId).cartonTotals().catch(() => ({}))
          : undefined,
      );
    const store = tables ? { orderStore: "tables" } : {};
    if (prior.data)
      return {
        done:
          prior.data.fingerprint !== print || prior.data.command !== type
            ? mismatchResponse()
            : prior.data.result_revision == null && prior.data.result
              ? // A records commit: its stored result names the rows it changed.
                json({
                  state: await view(),
                  revision: loaded.data.revision,
                  replayed: true,
                  records: { replayed: true, result: prior.data.result },
                  orderStore: "tables",
                })
              : json({
                  state: await view(),
                  revision: loaded.data.revision,
                  replayed: true,
                  resultRevision: prior.data.result_revision,
                  ...store,
                }),
      };
    // A production supervisor limited to one factory never changes the other factory's
    // batches; the database re-checks the signed state (operator_private.assert_factory_scope).
    const batches = siteState(loaded.data.state).batches ?? [];
    const outside = factoryDenial(membership.factory, type, input, batches);
    if (outside) return { done: json({ error: outside }, 403) };
    if (tables && recordRules[type]) {
      // Order records: apply the command to a slice of the rows it needs and commit the
      // signed change set with the rows' versions; no document revision is involved.
      const reader = packerSeal
        ? await supabaseServer(undefined, { "x-operator-packer": packerSeal })
        : db;
      let slice: LoadedSlice;
      try {
        slice = await loadSlice(
          recordSource(reader, workspaceId),
          siteState(loaded.data.state),
          type,
          input,
        );
      } catch (e) {
        if (e instanceof RecordLoadError || e instanceof ImportLoadError)
          return { done: rpcFailure(e.failure) };
        throw e;
      }
      let changesText: string;
      try {
        const after = applyCommand(slice.draft, {
          type,
          role: recorder.role,
          input,
          actor: recorder,
          capabilities: membership.capabilities,
          performer: packer?.profileId,
          context: slice.context,
          scope: "slice",
        });
        const changes = sliceDelta(type, slice.draft, after, {
          effects: slice.keepEffects ? importEffects(type, input, slice.draft) : null,
          recorder,
        });
        const eventIssue = eventProblem(changes.events ?? [], user.id);
        if (eventIssue) throw new Error(eventIssue);
        changesText = JSON.stringify(changes);
        if (new TextEncoder().encode(changesText).length > 8000000)
          throw new Error("This change is too large. Select fewer AWBs and save again.");
      } catch (e) {
        return { done: domainError(e) };
      }
      const packerSession = type === "pack-own" ? packerSeal : null;
      const result = await db.rpc("operator_commit_records", {
        p_workspace: workspaceId,
        p_command: type,
        p_operation: operationId,
        p_fingerprint: print,
        p_changes: changesText,
        p_attestation: attestRecords(secret, {
          workspaceId,
          userId: user.id,
          operationId,
          command: type,
          fingerprint: print,
          changesText,
          packerSession,
        }),
        p_packer_session: packerSession,
      });
      if (result.error) {
        // A row changed after it was read: reload the slice and apply again. A form that
        // sent the version it showed gets a reviewable conflict from the domain rules then.
        if (result.error.code === "PT412") return { stale: true };
        return {
          done:
            result.error.code === "42501" && /packer session/i.test(result.error.message)
              ? json({ error: result.error.message, code: "packer-locked" }, 403)
              : commitFailure(result.error),
        };
      }
      const committed = result.data as {
        replayed: boolean;
        result: RecordsResult | null;
      };
      // A null result is an operation that was committed through the document path.
      if (committed.replayed && committed.result === null)
        return {
          done: json({
            state: await view(),
            revision: loaded.data.revision,
            replayed: true,
            ...store,
          }),
        };
      if (committed.result && !committed.replayed)
        afterRecordsCommit({
          workspaceId,
          days: committed.result.days,
          orderIds: committed.result.orders.map((o) => o.id),
        });
      return {
        done: saved(
          {
            state: await view(),
            revision: loaded.data.revision,
            replayed: committed.replayed,
            records: committed,
            orderStore: "tables",
          },
          attempt,
        ),
      };
    }
    // Document commands. On a tables-mode site the document has no order lists: the
    // shared rules see empty ones and the table's issued totals (stock balances), and
    // neither is signed or stored.
    let current = siteState(loaded.data.state);
    if (tables)
      try {
        current = documentView(current, await recordSource(db, workspaceId).cartonTotals());
      } catch (e) {
        if (e instanceof RecordLoadError) return { done: rpcFailure(e.failure) };
        throw e;
      }
    // Uploads live in operator_imports: load what the command needs with the member's own
    // client (the database checks their access), never from the request body.
    let context: Command["context"];
    let effects: ImportEffects | null = null;
    try {
      const upload = await uploadFor(db, workspaceId, type, input, current);
      context = upload.context;
      effects = upload.keepEffects
        ? importEffects(type, input, current)
        : null;
    } catch (e) {
      if (e instanceof ImportLoadError || e instanceof RecordLoadError)
        return { done: rpcFailure(e.failure) };
      throw e;
    }
    let stateText: string;
    try {
      const state = applyCommand(current, {
        type,
        role: recorder.role,
        input,
        actor: recorder,
        capabilities: membership.capabilities,
        performer: packer?.profileId,
        context,
      });
      if (
        outOfScopeKeys(
          type,
          current as unknown as Record<string, unknown>,
          state as unknown as Record<string, unknown>,
        ).length
      )
        throw new Error("This change is outside your role's records.");
      if (outOfFactory(membership.factory, current, state).length)
        throw new AccessDenied(
          `Your access covers the ${membership.factory} factory only. This change has not been saved.`,
        );
      // Every entry in the list is new (it started empty); the RPC appends them.
      const eventIssue = eventProblem(state.events, user.id);
      if (eventIssue) throw new Error(eventIssue);
      stateText = JSON.stringify(tables ? stripTransient(state) : state);
      if (new TextEncoder().encode(stateText).length > 1800000)
        throw new Error(
          "The shared workspace is full. This change has not been saved.",
        );
    } catch (e) {
      return { done: domainError(e) };
    }
    // The exact effects text is signed and sent; the database applies it with the state.
    const effectsText = effects ? JSON.stringify(effects) : null;
    const result = await db.rpc("operator_commit_workspace", {
      p_workspace: workspaceId,
      p_expected_revision: loaded.data.revision,
      p_command: type,
      p_operation: operationId,
      p_fingerprint: print,
      p_state: stateText,
      p_attestation: attest(secret, {
        workspaceId,
        revision: loaded.data.revision,
        userId: user.id,
        operationId,
        command: type,
        fingerprint: print,
        stateText,
        effectsText,
      }),
      p_import_effects: effectsText,
    });
    if (result.error) return { done: commitFailure(result.error) };
    const committed = (
      result.data as { new_state: Draft; new_revision: number; replayed: boolean }[]
    )?.[0];
    if (!committed) return { stale: true };
    return {
      done: saved(
        {
          state: tables
            ? clientState(committed.new_state, true, membership, current.cartonIssued)
            : withBatchReferences(siteState(committed.new_state)),
          revision: committed.new_revision,
          replayed: committed.replayed,
          ...store,
        },
        attempt,
      ),
    };
  }, staleResponse);
}

/** The result a records commit stores (operator_commit_records step 15). */
type RecordsResult = {
  orders: { id: string; op: "insert" | "update" | "delete"; version: number }[];
  issues: string[];
  sortCounts: string[];
  days: string[];
};
type Db = Awaited<ReturnType<typeof resolveAccess>>["db"];
type Failure = { code?: string; message: string };
// Before 20261014090000 is applied there is no order store or stored result: every site
// keeps its orders in the document.
const missingColumn = (error: Failure | null) => error?.code === "42703";
async function loadSite(db: Db, workspaceId: string) {
  const site = (columns: string) =>
    db.from("operator_workspaces").select(columns).eq("id", workspaceId).single();
  let result = await site("state,revision,order_store");
  if (missingColumn(result.error)) result = await site("state,revision");
  return result as unknown as {
    data: { state: unknown; revision: number; order_store?: string } | null;
    error: Failure | null;
  };
}
async function priorCommit(db: Db, workspaceId: string, operationId: string) {
  const commit = (columns: string) =>
    db
      .from("operator_commits")
      .select(columns)
      .eq("workspace_id", workspaceId)
      .eq("operation_id", operationId)
      .maybeSingle();
  let result = await commit("command,fingerprint,result_revision,result");
  if (missingColumn(result.error)) result = await commit("command,fingerprint,result_revision");
  return result as unknown as {
    data: {
      command: string;
      fingerprint: string;
      result_revision: number | null;
      result?: RecordsResult | null;
    } | null;
    error: Failure | null;
  };
}
const mismatchResponse = () =>
  json(
    {
      error:
        "This save ID was already used for a different change. Nothing new was saved; refresh and review.",
      code: "operation-mismatch",
    },
    409,
  );
/** Maps the commit functions' error codes (see the migration headers) to responses. */
function commitFailure(error: Failure) {
  switch (error.code) {
    case "42501":
      return json({ error: error.message }, 403);
    case "28000":
      return json({ error: "Please sign in again." }, 401);
    case "PT409":
      return json({ error: error.message, code: "operation-mismatch" }, 409);
    // The site's orders moved between the document and the tables during this request.
    case "PT428":
      return json({ error: error.message, code: "store" }, 409);
    case "23505":
      return json({ error: "This AWB is already recorded.", code: "duplicate" }, 409);
    case "22023":
      return json({ error: error.message }, 400);
    case "23514":
      return json({ error: error.message, code: "invariant" }, 409);
    case "55000":
      return json({ error: error.message }, 503);
    default:
      return json({ error: "Unable to save. Your change has not been recorded." }, 503);
  }
}

const staleResponse = () =>
  json({ error: STALE_MESSAGE, code: "revision" }, 409);

function domainError(e: unknown) {
  if (e instanceof AccessDenied) return json({ error: e.message }, 403);
  if (e instanceof ConflictError)
    return json({ error: e.message, code: "record", conflict: e.conflict }, 409);
  return json({ error: e instanceof Error ? e.message : "Unable to save." }, 400);
}
/**
 * The upload a document command needs (Command.context) and whether its upload effects
 * apply. import-release / import-delete: the site's upload with its rows (a missing or
 * deleted upload leaves the context empty, which the domain rules report). remove-order:
 * the upload and label the AWB came from, when that label is still the AWB's released label
 * in the tables; otherwise the AWB is removed without an upload change.
 */
async function uploadFor(
  db: Db,
  workspaceId: string,
  type: string,
  input: Record<string, unknown>,
  current: Draft,
): Promise<{ context?: Command["context"]; keepEffects: boolean }> {
  if (uploadCommands.includes(type)) {
    const id = typeof input.id === "string" ? input.id.trim() : "";
    const upload = await loadImport(db, workspaceId, id);
    return { context: upload ? { import: upload } : undefined, keepEffects: true };
  }
  if (type !== "remove-order") return { keepEffects: false };
  const order = current.orders.find(
    (o) => typeof input.id === "string" && o.id === input.id.trim(),
  );
  // Upload and label identifiers are UUIDs since 20261012090000 (the backfill mapped older ones).
  const upload = order ? await releasedFrom(db, workspaceId, order) : null;
  return upload
    ? { context: { import: upload }, keepEffects: true }
    : { keepEffects: false };
}
// A trip photo must be the signed-in driver's own upload in this site's folder.
async function requireTripPhoto(
  db: Awaited<ReturnType<typeof resolveAccess>>["db"],
  bucket: string,
  folder: string,
  path: string,
) {
  const name = path.slice(folder.length + 1);
  const listed =
    path.startsWith(folder + "/") && /^[a-f0-9]{64}\.jpg$/.test(name)
      ? await db.storage.from(bucket).list(folder, { search: name, limit: 1 })
      : null;
  if (!listed || listed.error || !listed.data.some((f) => f.name === name))
    throw new Error("The trip photo was not saved. Add it again before saving.");
}
