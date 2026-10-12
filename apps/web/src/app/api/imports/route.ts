import { NextRequest } from "next/server";
import { resolveAccess } from "@/lib/supabase/server";
import { sameOrigin } from "@/lib/request-origin";
import { validateImport } from "@/lib/awb-import";
import {
  can,
  json,
  pick,
  requireStored,
  rpcFailure,
  SANDBOX_UPLOADS,
} from "@/lib/imports-server";

// PDF uploads of a site (operator_imports). Saving a review goes through
// operator_import_save; releasing and deleting are document commands (/api/draft).
// A 1,200-label review is about 1.5 MB of JSON; 6 MB leaves room for long label text.
const BODY_LIMIT = 6_000_000;

/** GET /api/imports?workspace=<id>: the site's uploads without their rows. */
export async function GET(request: NextRequest) {
  const access = await resolveAccess();
  if (access.status !== 200)
    return json({ error: access.error }, access.status);
  const { db, memberships } = access;
  if (!memberships.length) return json({ error: SANDBOX_UPLOADS }, 403);
  const m = pick(memberships, request.nextUrl.searchParams.get("workspace"));
  if (!m) return json({ error: "You do not have access to that site." }, 403);
  if (!can(m, "orders.import", "sources.read"))
    return json({ error: "Your role at this site cannot open PDF uploads." }, 403);
  const { data, error } = await db.rpc("operator_import_list", {
    p_workspace: m.workspaceId,
  });
  if (error) return rpcFailure(error);
  return json({ imports: data ?? [] });
}

/**
 * POST /api/imports { workspace, batch, expectedUpdatedAt }: creates or replaces a draft
 * upload. expectedUpdatedAt is the updatedAt the review was opened with (null for a new
 * upload); a teammate's newer save answers 409 code 'record'.
 */
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return json({ error: "Request not allowed." }, 403);
  const access = await resolveAccess();
  if (access.status !== 200)
    return json({ error: access.error }, access.status);
  const { db, memberships } = access;
  const raw = await request.text();
  if (raw.length > BODY_LIMIT) return json({ error: "Request too large." }, 413);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  if (!memberships.length) return json({ error: SANDBOX_UPLOADS }, 403);
  const m = pick(memberships, body?.workspace);
  if (!m) return json({ error: "You do not have access to that site." }, 403);
  if (!can(m, "orders.import"))
    return json(
      { error: "Your role at this site cannot upload or review PDF batches." },
      403,
    );
  const expected = body.expectedUpdatedAt;
  if (
    expected !== undefined &&
    expected !== null &&
    expected !== "" &&
    (typeof expected !== "string" || !Number.isFinite(Date.parse(expected)))
  )
    return json({ error: "Invalid request." }, 400);
  let batch;
  try {
    batch = validateImport(body.batch);
    // Stored files do not depend on the review; the database re-checks the paths.
    for (const file of batch.files) {
      if (file.path !== `${m.workspaceId}/${file.id}.pdf`)
        throw new Error("This PDF was not uploaded to this site.");
      await requireStored(db, "operator-sources", m.workspaceId, file.id);
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Invalid upload." }, 400);
  }
  const { data, error } = await db.rpc("operator_import_save", {
    p_workspace: m.workspaceId,
    p_import: {
      id: batch.id,
      name: batch.name,
      date: batch.date,
      files: batch.files,
    },
    p_rows: batch.rows,
    p_expected_updated_at: expected || null,
  });
  if (error) return rpcFailure(error);
  return json({ import: data });
}
