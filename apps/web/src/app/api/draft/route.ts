import { randomUUID } from "node:crypto";
import { sameOrigin } from "@/lib/request-origin";
import { NextRequest, NextResponse } from "next/server";
import { resolveAccess, type Membership } from "@/lib/supabase/server";
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
  type Draft,
  type Recorder,
  type Role,
  WORKSPACE_BYTES,
  WORKSPACE_FULL,
} from "@/lib/draft";
import {
  AccessDenied,
  attest,
  authorizeMember,
  commitSecret,
  factoryDenial,
  fingerprint,
  OPERATION_ID,
  outOfFactory,
  outOfScopeKeys,
} from "@/lib/access";
import { validateImport } from "@/lib/awb-import";
import { rebaseLoop, STALE_MESSAGE, type RebaseStep } from "@/lib/rebase";
import { commandRules } from "@/lib/capabilities";
import {
  openPackerSession,
  PACKER_COOKIE,
  PACKER_IDLE_MS,
  packerCookieOptions,
  sealPackerSession,
  type PackerSession,
} from "@/lib/packer-session";
import {
  clientState,
  commitPayload,
  entityEvents,
  legacyDocument,
  legacyOrders,
  loadOrders,
  orderNeeds,
  dayNeeds,
  orderOps,
  addLoaded,
  viewDates,
  hydrateIssues,
  addedIssues,
  importAwbs,
  type HydratedIssues,
  type LoadedOrders,
  type OrderOp,
  archivedByAwb,
  archiveOrders,
  needsArchive,
  searchArchive,
  loadImport,
  StoreError,
  touchedImport,
} from "@/lib/workspace-store";
import { normalizeAwb, type AwbImport } from "@/lib/awb-import";
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
const sandboxPdf = (userId: string, file: { id: string; path: string }) =>
  new RegExp(`^${userId}/[a-f0-9]{64}\\.pdf$`).test(file.path) &&
  file.path === `${userId}/${file.id}.pdf`;

export async function GET(request: NextRequest) {
  const access = await resolveAccess();
  if (access.status !== 200)
    return json({ error: access.error }, access.status);
  const { db, user, memberships } = access;
  const params = request.nextUrl.searchParams;
  const importId = params.get("import"),
    entities = params.get("events")?.split(",").filter(Boolean),
    archiveQuery = params.get("archive")?.trim();
  if (
    (entities && (entities.length > 50 || entities.some((e) => e.length > 200))) ||
    (archiveQuery !== undefined && (archiveQuery.length < 3 || archiveQuery.length > 40))
  )
    return json({ error: "Invalid request." }, 400);
  if (memberships.length) {
    const m = pick(memberships, params.get("workspace"));
    if (!m) return json({ error: "You do not have access to that site." }, 403);
    const load = () =>
      db
        .from("operator_workspaces")
        .select("state,revision")
        .eq("id", m.workspaceId)
        .maybeSingle();
    let { data, error } = await load();
    if (error || !data)
      return json({ error: "Unable to load your site workspace." }, 503);
    // Orders past the archive cutoff leave the document before it is shown.
    if (
      !legacyDocument(data.state as Draft) &&
      needsArchive(data.state as Draft) &&
      (await archiveOrders(db, m.workspaceId)) > 0
    ) {
      ({ data, error } = await load());
      if (error || !data)
        return json({ error: "Unable to load your site workspace." }, 503);
    }
    const doc = data.state as Draft;
    let state: Draft;
    try {
      // One upload with its label rows, or the audit entries about some records.
      if (importId) {
        const found = legacyDocument(doc)
          ? doc.awbImports!.find((b) => b.id === importId)
          : await loadImport(db, m.workspaceId, importId);
        if (!found) return json({ error: "Upload batch not found." }, 404);
        // With the orders it may duplicate, from any work day: the screen holds the
        // orders of the dates on screen only, and the review shows each label's status.
        const orders = legacyOrders(doc)
          ? []
          : (
              await loadOrders(db, m.workspaceId, {
                ids: [],
                awbs: importAwbs(found),
                dates: [],
                imports: [],
              })
            ).orders;
        return json({ import: found, orders });
      }
      if (archiveQuery)
        return json({
          orders: await searchArchive(db, m.workspaceId, normalizeAwb(archiveQuery)),
        });
      if (entities)
        return json({
          events: legacyDocument(doc)
            ? doc.events.filter((e) => entities.includes(e.entity))
            : await entityEvents(db, m.workspaceId, entities),
        });
      state = await clientState(db, m.workspaceId, doc, undefined, viewDates(params.get("dates")));
    } catch (e) {
      if (e instanceof StoreError) return json({ error: e.message }, 503);
      throw e;
    }
    return json({
      state: withBatchReferences(state),
      revision: data.revision,
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
  const sandbox = data.state as Draft;
  if (importId) {
    const found = sandbox.awbImports?.find((b) => b.id === importId);
    return found
      ? json({ import: found })
      : json({ error: "Upload batch not found." }, 404);
  }
  if (entities)
    return json({ events: sandbox.events.filter((e) => entities.includes(e.entity)) });
  if (archiveQuery) return json({ orders: [] });
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
    input: Record<string, unknown> = body.command.input,
    dates = viewDates(body.dates);
  const print = fingerprint(type, input);

  // Fictional sandbox: per-account JSON, preview roles. Never an operational workspace.
  if (!memberships.length) {
    if (process.env.OPERATOR_PREVIEW_WRITES === "off")
      return json({ error: "The preview sandbox is read-only." }, 403);
    if (!roles.some((r) => r.id === body.command.role))
      return json({ error: "Choose a valid test role." }, 400);
    const role: Role = body.command.role;
    const operationId: string | undefined = body.operationId;
    try {
      if (type === "import-save")
        for (const file of validateImport(input.batch).files) {
          if (!sandboxPdf(user.id, file))
            throw new Error("Invalid source file ownership.");
          await requireStored(db, "awb-draft-sources", user.id, file.id);
        }
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
        if (new TextEncoder().encode(JSON.stringify(state)).length > WORKSPACE_BYTES)
          throw new Error(WORKSPACE_FULL);
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
    if (type === "import-save")
      for (const file of validateImport(input.batch).files) {
        if (file.path !== `${membership.workspaceId}/${file.id}.pdf`)
          throw new Error("This PDF was not uploaded to this site.");
        await requireStored(db, "operator-sources", membership.workspaceId, file.id);
      }
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
  // Load the latest state, apply, commit with its revision; repeat if someone saved first.
  // The operation-ID replay check is the first step of every attempt.
  let archiveChecked = false;
  return rebaseLoop(async (): Promise<RebaseStep<NextResponse>> => {
    const prior = await db
      .from("operator_commits")
      .select("command,fingerprint,result_revision")
      .eq("workspace_id", membership.workspaceId)
      .eq("operation_id", operationId)
      .maybeSingle();
    const load = () =>
      db
        .from("operator_workspaces")
        .select("state,revision")
        .eq("id", membership.workspaceId)
        .single();
    let loaded = await load();
    // Orders past the archive cutoff leave the document first (once per save).
    if (
      !archiveChecked &&
      loaded.data &&
      !legacyDocument(loaded.data.state as Draft) &&
      needsArchive(loaded.data.state as Draft)
    ) {
      archiveChecked = true;
      if ((await archiveOrders(db, membership.workspaceId)) > 0) loaded = await load();
    }
    if (prior.error || !loaded.data)
      return { done: json({ error: "Unable to load your site workspace." }, 503) };
    const loadedData = loaded.data;
    if (prior.data)
      return {
        done:
          prior.data.fingerprint === print && prior.data.command === type
            ? json({
                state: withBatchReferences(
                  await clientState(db, membership.workspaceId, loadedData.state as Draft, undefined, dates).catch(
                    () => ({ ...(loadedData.state as Draft), orders: (loadedData.state as Draft).orders ?? [] }),
                  ),
                ),
                revision: loadedData.revision,
                replayed: true,
                resultRevision: prior.data.result_revision,
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
    const current = loaded.data.state as Draft;
    // The orders this command reads or changes come from their table (WP C), with the
    // versions the commit is checked against.
    const ordersInTable = !legacyOrders(current);
    const loadedOrders: LoadedOrders = { orders: [], versions: new Map() };
    if (ordersInTable) {
      try {
        addLoaded(loadedOrders, await loadOrders(db, membership.workspaceId, orderNeeds(type, input)));
        addLoaded(
          loadedOrders,
          await loadOrders(db, membership.workspaceId, dayNeeds(type, loadedOrders.orders)),
        );
      } catch {
        return { done: json({ error: "Unable to load your site workspace." }, 503) };
      }
      current.orders = loadedOrders.orders;
    }
    // The upload this command reads or changes comes from its table (WP A).
    const legacy = legacyDocument(current),
      importId = legacy ? undefined : touchedImport(type, input, current);
    let existed = false;
    if (importId) {
      let found: AwbImport | undefined;
      try {
        found = await loadImport(db, membership.workspaceId, importId);
      } catch {
        return { done: json({ error: "Unable to load your site workspace." }, 503) };
      }
      existed = !!found;
      current.awbImports = found ? [found] : [];
      // A release checks its labels' AWBs against existing orders.
      if (ordersInTable && type === "import-release")
        try {
          addLoaded(
            loadedOrders,
            await loadOrders(db, membership.workspaceId, orderNeeds(type, input, current)),
          );
        } catch {
          return { done: json({ error: "Unable to load your site workspace." }, 503) };
        }
    }
    // Stock issues: the real issues of the loaded orders, totals for the rest (WP C2).
    let hydrated: HydratedIssues | null = null;
    if (ordersInTable) {
      try {
        hydrated = await hydrateIssues(db, membership.workspaceId, {
          ids: loadedOrders.orders.map((o) => o.id),
          dates: [],
        });
      } catch {
        return { done: json({ error: "Unable to load your site workspace." }, 503) };
      }
      if (hydrated) current.issues = hydrated.issues;
    }
    // Archived orders take part in the duplicate-AWB checks without returning to the
    // document: they are added for the command and removed from what is saved.
    const archivedIds = new Set<string>();
    if (!legacy && !ordersInTable && (type === "order" || type === "import-release")) {
      const awbs =
        type === "order"
          ? [normalizeAwb(String(input.awb ?? ""))]
          : (current.awbImports?.[0]?.rows ?? []).map((r) => normalizeAwb(r.awb));
      try {
        for (const o of await archivedByAwb(db, membership.workspaceId, awbs.filter(Boolean)))
          if (!current.orders.some((x) => x.id === o.id)) {
            archivedIds.add(o.id);
            current.orders.push(o);
          }
      } catch {
        return { done: json({ error: "Unable to load your site workspace." }, 503) };
      }
    }
    // A production supervisor limited to one factory never changes the other factory's
    // batches; the database re-checks the signed state (operator_private.assert_factory_scope).
    const outside = factoryDenial(membership.factory, type, input, current.batches ?? []);
    if (outside) return { done: json({ error: outside }, 403) };
    let stateText: string,
      touched: AwbImport | undefined,
      ops: OrderOp[] | undefined;
    try {
      const state = applyCommand(current, {
        type,
        role: recorder.role,
        input,
        actor: recorder,
        capabilities: membership.capabilities,
        performer: packer?.profileId,
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
      if (archivedIds.size)
        state.orders = state.orders.filter((o) => !archivedIds.has(o.id));
      touched = importId ? state.awbImports?.find((b) => b.id === importId) : undefined;
      ops = ordersInTable ? orderOps(loadedOrders, state.orders) : undefined;
      stateText = JSON.stringify(
        legacy
          ? state
          : commitPayload(
              state,
              importId,
              existed,
              ops,
              hydrated ? addedIssues(hydrated, state.issues) : undefined,
            ),
      );
      if (new TextEncoder().encode(stateText).length > WORKSPACE_BYTES)
        throw new Error(WORKSPACE_FULL);
    } catch (e) {
      return { done: domainError(e) };
    }
    const result = await db.rpc("operator_commit_workspace", {
      p_workspace: membership.workspaceId,
      p_expected_revision: loaded.data.revision,
      p_command: type,
      p_operation: operationId,
      p_fingerprint: print,
      p_state: stateText,
      p_attestation: attest(secret, {
        workspaceId: membership.workspaceId,
        revision: loaded.data.revision,
        userId: user.id,
        operationId,
        command: type,
        fingerprint: print,
        stateText,
      }),
    });
    if (result.error) {
      const code = result.error.code;
      return {
        done:
          code === "42501"
            ? json({ error: result.error.message }, 403)
            : code === "28000"
              ? json({ error: "Please sign in again." }, 401)
              : code === "PT409"
                ? json({ error: result.error.message, code: "operation-mismatch" }, 409)
                : code === "23514"
                  ? json({ error: result.error.message, code: "invariant" }, 409)
                  : code === "23505"
                    ? json({ error: "This AWB is already recorded." }, 409)
                  : code === "55000"
                    ? json({ error: result.error.message }, 503)
                    : json(
                        { error: "Unable to save. Your change has not been recorded." },
                        503,
                      ),
      };
    }
    const saved = (
      result.data as { new_state: Draft; new_revision: number; replayed: boolean }[]
    )?.[0];
    if (!saved) return { stale: true };
    // With orders in their table the screen gets only the orders this save changed, plus,
    // for an upload, the orders its labels may duplicate (any work day), for the review.
    const related = (() => {
      if (!ops || !touched) return [];
      const awbs = new Set(importAwbs(touched));
      const changed = new Set(ops.map((op) => (op.op === "put" ? op.order.id : op.id)));
      return loadedOrders.orders.filter(
        (o) => awbs.has(normalizeAwb(o.awb)) && !changed.has(o.id),
      );
    })();
    const response = json({
      state: withBatchReferences(
        await clientState(
          db,
          membership.workspaceId,
          saved.new_state,
          touched,
          ops ? [] : dates,
          {
            dates,
            ids: (ops ?? []).flatMap((op) => (op.op === "put" ? [op.order.id] : [])),
          },
        ).catch(() => ({
          ...saved.new_state,
          orders: saved.new_state.orders ?? [],
          awbImports: touched ? [touched] : [],
        })),
      ),
      ...(ops
        ? {
            ordersDelta: {
              put: [...ops.flatMap((op) => (op.op === "put" ? [op.order] : [])), ...related],
              removed: ops.flatMap((op) => (op.op === "delete" ? [op.id] : [])),
            },
          }
        : {}),
      revision: saved.new_revision,
      replayed: saved.replayed,
      ...(packer ? { packerExpiresAt: Date.now() + PACKER_IDLE_MS } : {}),
    });
    // Each save keeps the packer's session open for another idle period.
    if (packer)
      response.cookies.set(
        PACKER_COOKIE,
        sealPackerSession(secret, { ...packer, expiresAt: Date.now() + PACKER_IDLE_MS }),
        packerCookieOptions(PACKER_IDLE_MS),
      );
    return { done: response };
  }, staleResponse);
}

const staleResponse = () =>
  json({ error: STALE_MESSAGE, code: "revision" }, 409);

function domainError(e: unknown) {
  if (e instanceof AccessDenied) return json({ error: e.message }, 403);
  if (e instanceof ConflictError)
    return json({ error: e.message, code: "record", conflict: e.conflict }, 409);
  return json({ error: e instanceof Error ? e.message : "Unable to save." }, 400);
}
async function requireStored(
  db: Awaited<ReturnType<typeof resolveAccess>>["db"],
  bucket: string,
  folder: string,
  id: string,
) {
  const listed = await db.storage
    .from(bucket)
    .list(folder, { search: id + ".pdf", limit: 1 });
  if (listed.error || !listed.data.some((f) => f.name === id + ".pdf"))
    throw new Error("Source PDF was not saved. Upload it again before confirming.");
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
