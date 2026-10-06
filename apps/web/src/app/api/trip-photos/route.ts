import { NextRequest, NextResponse } from "next/server";
import { resolveAccess, type Membership } from "@/lib/supabase/server";
import { sameOrigin } from "@/lib/request-origin";

// Driver trip photos. Operational: <workspace id>/<driver user id>/<sha256>.jpg in
// operator-trip-photos; a driver uploads and reads only their own folder, colleagues with
// trips.read read the whole site (storage RLS enforces the same rules). The fictional
// sandbox keeps a per-account trip-draft-photos folder.
const operational = "operator-trip-photos",
  sandbox = "trip-draft-photos";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SITE_PHOTO = new RegExp(`^(${UUID})/(${UUID})/[a-f0-9]{64}\\.jpg$`);
const SANDBOX_PHOTO = new RegExp(`^(${UUID})/[a-f0-9]{64}\\.jpg$`);
const MAX_BYTES = 5242880;
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
    body.size < 100 ||
    body.size > MAX_BYTES
  )
    return json({ error: "Use a photo up to 5 MB." }, 400);
  let bucket: string, folder: string;
  if (memberships.length) {
    const site =
      typeof body.workspace === "string"
        ? memberships.find((m) => m.workspaceId === body.workspace)
        : memberships[0];
    if (!can(site, "trips.log"))
      return json({ error: "Only drivers can add trip photos at this site." }, 403);
    bucket = operational;
    folder = site!.workspaceId + "/" + user.id;
  } else {
    bucket = sandbox;
    folder = user.id;
  }
  const name = body.hash + ".jpg",
    path = folder + "/" + name;
  const existing = await db.storage
    .from(bucket)
    .list(folder, { search: name, limit: 1 });
  if (existing.error)
    return json({ error: "Photo storage is unavailable. Please retry." }, 503);
  if (existing.data.some((f) => f.name === name))
    return json({ path, exists: true });
  const { data, error } = await db.storage
    .from(bucket)
    .createSignedUploadUrl(path);
  if (error) return json({ error: "Unable to prepare the photo upload." }, 503);
  return json({ path, url: data.signedUrl });
}

export async function GET(request: NextRequest) {
  const access = await resolveAccess();
  if (access.status !== 200)
    return json({ error: access.error }, access.status);
  const { db, user, memberships } = access;
  const path = request.nextUrl.searchParams.get("path") ?? "";
  // Unknown, malformed and unauthorized paths all look the same to the caller.
  const unavailable = () => json({ error: "Photo not available." }, 404);
  let bucket: string;
  if (memberships.length) {
    const match = SITE_PHOTO.exec(path);
    if (!match) return unavailable();
    const site = memberships.find((m) => m.workspaceId === match[1]);
    const own = match[2] === user.id && can(site, "trips.log");
    if (!own && !can(site, "trips.read")) return unavailable();
    bucket = operational;
  } else {
    const match = SANDBOX_PHOTO.exec(path);
    if (!match || match[1] !== user.id) return unavailable();
    bucket = sandbox;
  }
  // Signed only after authorization; storage RLS re-checks with the caller's own JWT.
  const { data, error } = await db.storage
    .from(bucket)
    .createSignedUrl(path, SIGNED_URL_SECONDS);
  if (error) {
    const status = (error as { status?: number }).status;
    return status && status >= 500
      ? json({ error: "Photo storage is unavailable. Please retry." }, 503)
      : unavailable();
  }
  return json({ url: data.signedUrl, expiresIn: SIGNED_URL_SECONDS });
}
