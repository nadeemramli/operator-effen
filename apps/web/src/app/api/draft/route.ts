import { sameOrigin } from "@/lib/request-origin";
import { NextRequest, NextResponse } from "next/server";
import { tester } from "@/lib/supabase/server";
import {
  applyCommand,
  createDraft,
  type Command,
  type Draft,
} from "@/lib/draft";
import { validateImport } from "@/lib/awb-import";
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
export async function GET() {
  const { db, user } = await tester();
  if (!user) return json({ error: "Please sign in again." }, 401);
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
  return json(data);
}
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return json({ error: "Request not allowed." }, 403);
  const { db, user } = await tester();
  if (!user) return json({ error: "Please sign in again." }, 401);
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
    Array.isArray(body.command.input)
  )
    return json({ error: "Invalid action." }, 400);
  const { data: row, error } = await db
    .from("ui_draft_workspaces")
    .select("state,revision")
    .eq("user_id", user.id)
    .single();
  if (error || !row)
    return json({ error: "Unable to load the test workspace." }, 503);
  if (row.revision !== body.revision)
    return json(
      {
        error:
          "A teammate changed the shared draft. Refresh to load their changes before trying again.",
      },
      409,
    );
  let state: Draft;
  try {
    if (body.command.type === "import-save") {
      const batch = validateImport(body.command.input.batch);
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
    state = applyCommand(row.state as Draft, body.command as Command);
    if (new TextEncoder().encode(JSON.stringify(state)).length > 1800000)
      throw new Error(
        "The shared test workspace is full. This batch has not been saved.",
      );
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "Unable to save." },
      400,
    );
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
      },
      409,
    );
  return json(result.data);
}
