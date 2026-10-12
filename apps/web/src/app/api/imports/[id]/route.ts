import { NextRequest } from "next/server";
import { resolveAccess } from "@/lib/supabase/server";
import {
  can,
  ImportLoadError,
  json,
  loadImport,
  pick,
  rpcFailure,
  SANDBOX_UPLOADS,
} from "@/lib/imports-server";

/** GET /api/imports/<id>?workspace=<id>: one upload with its rows, in review order. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const access = await resolveAccess();
  if (access.status !== 200)
    return json({ error: access.error }, access.status);
  const { db, memberships } = access;
  if (!memberships.length) return json({ error: SANDBOX_UPLOADS }, 403);
  const m = pick(memberships, request.nextUrl.searchParams.get("workspace"));
  if (!m) return json({ error: "You do not have access to that site." }, 403);
  if (!can(m, "orders.import", "sources.read"))
    return json({ error: "Your role at this site cannot open PDF uploads." }, 403);
  try {
    const batch = await loadImport(db, m.workspaceId, id);
    if (!batch) return json({ error: "Upload batch not found." }, 404);
    return json({ import: batch });
  } catch (e) {
    if (e instanceof ImportLoadError) return rpcFailure(e.failure);
    throw e;
  }
}
