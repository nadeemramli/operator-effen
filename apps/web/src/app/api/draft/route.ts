import { sameOrigin } from "@/lib/request-origin";
import { NextRequest, NextResponse } from "next/server";
import { resolveAccess, type Membership } from "@/lib/supabase/server";
import {
  applyCommand,
  ConflictError,
  createDraft,
  findOperation,
  previewPolicy,
  recordOperation,
  roleLabel,
  roles,
  withBatchReferences,
  type Draft,
  type Recorder,
  type Role,
  type WritePolicy,
} from "@/lib/draft";
import {
  authorizeMember,
  fingerprint,
  OPERATION_ID,
  outOfScopeKeys,
  readWritePolicy,
  type MemberRole,
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
        name: m.displayName,
        staffProfileId: m.staffProfileId,
        siteId: m.siteId,
        workspaceId: m.workspaceId,
        workspaceName: m.workspaceName,
        policy: readWritePolicy(m.writePolicy),
      }
    : { kind: "preview" as const, userId, policy: previewPolicy };

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
    input: Record<string, unknown> = body.command.input,
    operationId: string | undefined = body.operationId;

  // Identity, role and site come from the server session; client role/actor fields are ignored.
  let role: Role,
    recorder: Recorder,
    policy: WritePolicy,
    membership: Membership | undefined,
    row: { state: unknown; revision: number } | null;
  if (memberships.length) {
    membership = pick(memberships, body.workspaceId);
    if (!membership)
      return json({ error: "You do not have access to that site." }, 403);
    policy = readWritePolicy(membership.writePolicy);
    const denied = authorizeMember(
      membership.role as MemberRole,
      type,
      policy,
    );
    if (denied) return json({ error: denied }, 403);
    role = membership.role as Role;
    recorder = {
      kind: "member",
      role,
      name: membership.displayName,
      userId: user.id,
      staffProfileId: membership.staffProfileId,
      siteId: membership.siteId,
    };
    const loaded = await db
      .from("operator_workspaces")
      .select("state,revision")
      .eq("id", membership.workspaceId)
      .single();
    row = loaded.data;
  } else {
    // Fictional sandbox only. It is never an operational workspace.
    if (process.env.OPERATOR_PREVIEW_WRITES === "off")
      return json({ error: "The preview sandbox is read-only." }, 403);
    if (!roles.some((r) => r.id === body.command.role))
      return json({ error: "Choose a valid test role." }, 400);
    role = body.command.role;
    policy = previewPolicy;
    recorder = {
      kind: "preview",
      role,
      name: roleLabel(role) + " (test view)",
      userId: user.id,
    };
    const loaded = await db
      .from("ui_draft_workspaces")
      .select("state,revision")
      .eq("user_id", user.id)
      .single();
    row = loaded.data;
  }
  if (!row) return json({ error: "Unable to load the workspace." }, 503);
  const current = row.state as Draft;

  // A retry of an operation that already committed returns the saved result once.
  const print = fingerprint(type, input);
  if (operationId) {
    const prior = findOperation(current, operationId);
    if (prior) {
      if (prior.fingerprint !== print || prior.userId !== user.id)
        return json(
          {
            error:
              "This save ID was already used for a different change. Nothing new was saved; refresh and review.",
            code: "operation-mismatch",
          },
          409,
        );
      return json({
        state: withBatchReferences(current),
        revision: row.revision,
        replayed: true,
      });
    }
  }
  if (row.revision !== body.revision)
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
    if (type === "import-save") {
      const batch = validateImport(input.batch);
      for (const file of batch.files) {
        if (
          !new RegExp(`^${user.id}/[a-f0-9]{64}\\.pdf$`).test(file.path) ||
          file.path !== `${user.id}/${file.id}.pdf`
        )
          throw new Error("Invalid source file ownership.");
        const listed = await db.storage
          .from("awb-draft-sources")
          .list(user.id, { search: file.id + ".pdf", limit: 1 });
        if (
          listed.error ||
          !listed.data.some((f) => f.name === file.id + ".pdf")
        )
          throw new Error(
            "Source PDF was not saved. Upload it again before confirming.",
          );
      }
    }
    if (type === "reset" && membership)
      throw new Error("Operational records cannot be reset.");
    state = applyCommand(current, { type, role, input, actor: recorder, policy });
    if (membership) {
      const outside = outOfScopeKeys(
        role,
        current as unknown as Record<string, unknown>,
        state as unknown as Record<string, unknown>,
      );
      if (outside.length)
        throw new Error("This change is outside your role's records.");
    }
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
        "The shared workspace is full. This change has not been saved.",
      );
  } catch (e) {
    if (e instanceof ConflictError)
      return json({ error: e.message, code: "record", conflict: e.conflict }, 409);
    return json(
      { error: e instanceof Error ? e.message : "Unable to save." },
      400,
    );
  }
  if (membership) {
    const result = await db.rpc("operator_commit_workspace", {
      p_workspace: membership.workspaceId,
      p_expected_revision: row.revision,
      p_state: state,
    });
    if (result.error)
      return result.error.code === "42501"
        ? json({ error: result.error.message }, 403)
        : result.error.code === "28000"
          ? json({ error: "Please sign in again." }, 401)
          : json(
              { error: "Unable to save. Your change has not been recorded." },
              503,
            );
    const saved = (result.data as { new_state: Draft; new_revision: number }[])?.[0];
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
    });
  }
  const result = await db
    .from("ui_draft_workspaces")
    .update({
      state,
      revision: row.revision + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", user.id)
    .eq("revision", row.revision)
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
