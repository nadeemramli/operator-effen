import { NextRequest, NextResponse } from "next/server";
import { resolveAccess, type Membership } from "@/lib/supabase/server";
import { sameOrigin } from "@/lib/request-origin";

// Operational sources: <workspace id>/<sha256>.pdf in operator-sources, shared by site
// capability (storage RLS enforces the same rules). The fictional sandbox keeps its
// per-account awb-draft-sources folder.
const operational = "operator-sources",
  sandbox = "awb-draft-sources";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SOURCE = new RegExp(`^(${UUID})/([a-f0-9]{64})\\.pdf$`);
const SIGNED_URL_SECONDS = 60;
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
const can = (m: Membership | undefined, ...caps: string[]) =>
  !!m && caps.some((c) => m.capabilities.includes(c as never));

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return json({ error: "Request not allowed." }, 403);
  const access = await resolveAccess();
  if (access.status !== 200)
    return json({ error: access.error }, access.status);
  const { db, user, memberships } = access;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  if (
    !/^[a-f0-9]{64}$/.test(body?.hash) ||
    !Number.isInteger(body?.size) ||
    body.size < 5 ||
    body.size > 20971520
  )
    return json({ error: "Use a PDF up to 20 MB." }, 400);
  let bucket: string, folder: string;
  if (memberships.length) {
    const site =
      typeof body.workspace === "string"
        ? memberships.find((m) => m.workspaceId === body.workspace)
        : memberships[0];
    if (!can(site, "orders.import"))
      return json(
        { error: "Your role cannot upload order sources for this site." },
        403,
      );
    bucket = operational;
    folder = site!.workspaceId;
  } else {
    bucket = sandbox;
    folder = user.id;
  }
  const name = body.hash + ".pdf",
    path = folder + "/" + name;
  const existing = await db.storage
    .from(bucket)
    .list(folder, { search: name, limit: 1 });
  if (existing.error)
    return json({ error: "PDF storage is unavailable. Please retry." }, 503);
  if (existing.data.some((f) => f.name === name))
    return json({ path, exists: true });
  const { data, error } = await db.storage
    .from(bucket)
    .createSignedUploadUrl(path);
  if (error) return json({ error: "Unable to prepare the PDF upload." }, 503);
  return json({ path, url: data.signedUrl });
}

export async function GET(request: NextRequest) {
  const access = await resolveAccess();
  if (access.status !== 200)
    return json({ error: access.error }, access.status);
  const { db, user, memberships } = access;
  const path = request.nextUrl.searchParams.get("path") ?? "";
  const match = SOURCE.exec(path);
  // Unknown, malformed and unauthorized paths all look the same to the caller.
  const unavailable = () => json({ error: "File not available." }, 404);
  if (!match) return unavailable();
  let bucket: string;
  if (memberships.length) {
    const site = memberships.find((m) => m.workspaceId === match[1]);
    if (!can(site, "sources.read", "orders.import")) return unavailable();
    bucket = operational;
  } else {
    if (match[1] !== user.id) return unavailable();
    bucket = sandbox;
  }
  // Signed only after authorization; storage RLS re-checks with the caller's own JWT.
  const { data, error } = await db.storage
    .from(bucket)
    .createSignedUrl(path, SIGNED_URL_SECONDS);
  if (error) {
    const status = (error as { statusCode?: string; status?: number }).status;
    return status && status >= 500
      ? json({ error: "PDF storage is unavailable. Please retry." }, 503)
      : unavailable();
  }
  return json({ url: data.signedUrl, expiresIn: SIGNED_URL_SECONDS });
}
