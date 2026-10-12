import { NextRequest } from "next/server";
import { resolveAccess } from "@/lib/supabase/server";
import { sameOrigin } from "@/lib/request-origin";
import {
  can,
  json,
  pick,
  rpcFailure,
  SANDBOX_UPLOADS,
  UUID,
} from "@/lib/imports-server";

/** POST /api/imports/<id>/receive { workspace, pic }: stock-out acknowledges a handoff once. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!sameOrigin(request)) return json({ error: "Request not allowed." }, 403);
  const { id } = await params;
  const access = await resolveAccess();
  if (access.status !== 200)
    return json({ error: access.error }, access.status);
  const { db, memberships } = access;
  const raw = await request.text();
  if (raw.length > 10_000) return json({ error: "Request too large." }, 413);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  if (!memberships.length) return json({ error: SANDBOX_UPLOADS }, 403);
  const m = pick(memberships, body?.workspace);
  if (!m) return json({ error: "You do not have access to that site." }, 403);
  if (!can(m, "outbound.fulfil"))
    return json({ error: "Only stock-out can acknowledge a released batch." }, 403);
  if (!UUID.test(id)) return json({ error: "Upload batch not found." }, 404);
  const pic = typeof body.pic === "string" ? body.pic.trim() : "";
  if (!pic || pic.length > 100)
    return json({ error: "Choose the receiving PIC." }, 400);
  const { data, error } = await db.rpc("operator_import_receive", {
    p_workspace: m.workspaceId,
    p_import: id,
    p_pic: pic,
  });
  if (error) return rpcFailure(error);
  return json({ import: data });
}
