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
} from "@/lib/draft";
import {
  attest,
  authorizeMember,
  commitSecret,
  fingerprint,
  OPERATION_ID,
  outOfScopeKeys,
} from "@/lib/access";
import { validateImport } from "@/lib/awb-import";
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
  if (memberships.length) {
    const m = pick(memberships, request.nextUrl.searchParams.get("workspace"));
    if (!m) return json({ error: "You do not have access to that site." }, 403);
    const { data, error } = await db
      .from("operator_workspaces")
      .select("state,revision")
      .eq("id", m.workspaceId)
      .maybeSingle();
    if (error || !data)
      return json({ error: "Unable to load your site workspace." }, 503);
    return json({
      state: withBatchReferences(data.state as Draft),
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
    const loaded = await db
      .from("ui_draft_workspaces")
      .select("state,revision")
      .eq("user_id", user.id)
      .single();
    if (!loaded.data)
      return json({ error: "Unable to load the test workspace." }, 503);
    const current = loaded.data.state as Draft;
    const operationId: string | undefined = body.operationId;
    if (operationId) {
      const prior = findOperation(current, operationId);
      if (prior)
        return prior.fingerprint === print && prior.userId === user.id
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
            );
    }
    if (loaded.data.revision !== body.revision)
      return json(
        {
          error:
            "A teammate changed the shared records. Refresh to load their changes before trying again.",
          code: "revision",
        },
        409,
      );
    let state: Draft;
    try {
      if (type === "import-save")
        for (const file of validateImport(input.batch).files) {
          if (!sandboxPdf(user.id, file))
            throw new Error("Invalid source file ownership.");
          await requireStored(db, "awb-draft-sources", user.id, file.id);
        }
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
      return domainError(e);
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
      return json(
        { error: "Unable to save. Your change has not been recorded." },
        503,
      );
    if (!result.data)
      return json(
        {
          error: "A teammate saved a change first. Refresh before trying again.",
          code: "revision",
        },
        409,
      );
    return json(result.data);
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
  const prior = await db
    .from("operator_commits")
    .select("command,fingerprint,result_revision")
    .eq("workspace_id", membership.workspaceId)
    .eq("operation_id", operationId)
    .maybeSingle();
  const loaded = await db
    .from("operator_workspaces")
    .select("state,revision")
    .eq("id", membership.workspaceId)
    .single();
  if (prior.error || !loaded.data)
    return json({ error: "Unable to load your site workspace." }, 503);
  if (prior.data)
    return prior.data.fingerprint === print && prior.data.command === type
      ? json({
          state: withBatchReferences(loaded.data.state as Draft),
          revision: loaded.data.revision,
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
        );
  if (loaded.data.revision !== body.revision)
    return json(
      {
        error:
          "A teammate changed the shared records. Refresh to load their changes before trying again.",
        code: "revision",
      },
      409,
    );
  const current = loaded.data.state as Draft;
  const recorder: Recorder = {
    kind: "member",
    role: membership.role as Role,
    name: membership.displayName,
    userId: user.id,
    staffProfileId: membership.staffProfileId,
    siteId: membership.siteId,
  };
  let stateText: string;
  try {
    if (type === "import-save")
      for (const file of validateImport(input.batch).files) {
        if (file.path !== `${membership.workspaceId}/${file.id}.pdf`)
          throw new Error("This PDF was not uploaded to this site.");
        await requireStored(db, "operator-sources", membership.workspaceId, file.id);
      }
    const state = applyCommand(current, {
      type,
      role: recorder.role,
      input,
      actor: recorder,
      capabilities: membership.capabilities,
    });
    if (
      outOfScopeKeys(
        type,
        current as unknown as Record<string, unknown>,
        state as unknown as Record<string, unknown>,
      ).length
    )
      throw new Error("This change is outside your role's records.");
    stateText = JSON.stringify(state);
    if (new TextEncoder().encode(stateText).length > 1800000)
      throw new Error(
        "The shared workspace is full. This change has not been saved.",
      );
  } catch (e) {
    return domainError(e);
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
    return code === "42501"
      ? json({ error: result.error.message }, 403)
      : code === "28000"
        ? json({ error: "Please sign in again." }, 401)
        : code === "PT409"
          ? json({ error: result.error.message, code: "operation-mismatch" }, 409)
          : code === "23514"
            ? json({ error: result.error.message, code: "invariant" }, 409)
            : code === "55000"
              ? json({ error: result.error.message }, 503)
              : json(
                  { error: "Unable to save. Your change has not been recorded." },
                  503,
                );
  }
  const saved = (
    result.data as { new_state: Draft; new_revision: number; replayed: boolean }[]
  )?.[0];
  if (!saved)
    return json(
      {
        error: "A teammate saved a change first. Refresh before trying again.",
        code: "revision",
      },
      409,
    );
  return json({
    state: withBatchReferences(saved.new_state),
    revision: saved.new_revision,
    replayed: saved.replayed,
  });
}

function domainError(e: unknown) {
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
