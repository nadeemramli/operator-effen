import { NextRequest, NextResponse } from "next/server";
import { tester } from "@/lib/supabase/server";
import { sameOrigin } from "@/lib/request-origin";
const bucket = "awb-draft-sources";
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return json({ error: "Request not allowed." }, 403);
  const { db, user } = await tester();
  if (!user) return json({ error: "Please sign in again." }, 401);
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
  const name = body.hash + ".pdf",
    path = user.id + "/" + name;
  const existing = await db.storage
    .from(bucket)
    .list(user.id, { search: name, limit: 1 });
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
  const { db, user } = await tester();
  if (!user) return json({ error: "Please sign in again." }, 401);
  const path = request.nextUrl.searchParams.get("path") ?? "";
  if (
    !path.startsWith(user.id + "/") ||
    !new RegExp(`^${user.id}/[a-f0-9]{64}\\.pdf$`).test(path)
  )
    return json({ error: "File not available." }, 404);
  const { data, error } = await db.storage
    .from(bucket)
    .createSignedUrl(path, 120);
  if (error) return json({ error: "Unable to open this PDF." }, 404);
  return json({ url: data.signedUrl });
}
