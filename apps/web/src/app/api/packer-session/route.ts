import { NextRequest, NextResponse } from "next/server";
import { commitSecret } from "@/lib/access";
import {
  openPackerSession,
  PACKER_COOKIE,
  PACKER_IDLE_MS,
  packerCookieOptions,
  sealPackerSession,
} from "@/lib/packer-session";
import { sameOrigin } from "@/lib/request-origin";
import { resolveAccess, type Membership } from "@/lib/supabase/server";

// Unlocks one packer profile on the shared packer sign-in after the database accepts its
// PIN (operator_verify_staff_pin, which also counts wrong PINs and locks the profile).
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const site = (memberships: Membership[], requested: unknown) =>
  typeof requested === "string" && requested
    ? memberships.find((m) => m.workspaceId === requested)
    : memberships[0];
const packerSite = (m?: Membership) =>
  m && m.capabilities.includes("packing.record") ? m : undefined;

/** The profile currently unlocked on this device, if any. */
export async function GET(request: NextRequest) {
  const access = await resolveAccess();
  if (access.status !== 200) return json({ error: access.error }, access.status);
  const m = packerSite(
    site(access.memberships, request.nextUrl.searchParams.get("workspace")),
  );
  const secret = commitSecret();
  const session =
    m && secret
      ? openPackerSession(secret, request.cookies.get(PACKER_COOKIE)?.value, {
          userId: access.user.id,
          workspaceId: m.workspaceId,
        })
      : null;
  return json(
    session
      ? { profileId: session.profileId, expiresAt: session.expiresAt }
      : { profileId: null },
  );
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return json({ error: "Request not allowed." }, 403);
  const access = await resolveAccess();
  if (access.status !== 200) return json({ error: access.error }, access.status);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  const m = packerSite(site(access.memberships, body?.workspaceId));
  if (!m)
    return json(
      { error: "Only the packer sign-in can unlock a packer profile." },
      403,
    );
  if (typeof body?.profileId !== "string" || !UUID.test(body.profileId))
    return json({ error: "Choose your name." }, 400);
  if (typeof body?.pin !== "string" || !/^[0-9]{4,6}$/.test(body.pin))
    return json({ error: "Enter your 4 to 6 digit PIN." }, 400);
  const secret = commitSecret();
  if (!secret)
    return json({ error: "Packer sign-in is not configured on this server." }, 503);
  const { data, error } = await access.db.rpc("operator_verify_staff_pin", {
    p_workspace: m.workspaceId,
    p_profile: body.profileId,
    p_pin: body.pin,
  });
  if (error)
    return error.code === "42501"
      ? json({ error: error.message }, 403)
      : json({ error: "Unable to check your PIN. Try again." }, 503);
  if (data === "locked")
    return json(
      {
        error:
          "Too many wrong PINs. Try again in 15 minutes, or ask your supervisor to set a new PIN.",
        code: "locked",
      },
      423,
    );
  if (data === "unset")
    return json(
      { error: "No PIN is set for this name yet. Ask your supervisor.", code: "unset" },
      403,
    );
  if (data !== "ok")
    return json({ error: "Wrong PIN. Try again.", code: "wrong" }, 403);
  const expiresAt = Date.now() + PACKER_IDLE_MS;
  const response = json({ profileId: body.profileId, expiresAt });
  response.cookies.set(
    PACKER_COOKIE,
    sealPackerSession(secret, {
      workspaceId: m.workspaceId,
      userId: access.user.id,
      profileId: body.profileId,
      expiresAt,
    }),
    packerCookieOptions(PACKER_IDLE_MS),
  );
  return response;
}

/** Done: locks the packer profile on this device. */
export async function DELETE(request: NextRequest) {
  if (!sameOrigin(request)) return json({ error: "Request not allowed." }, 403);
  const response = json({ profileId: null });
  response.cookies.set(PACKER_COOKIE, "", packerCookieOptions(0));
  return response;
}
