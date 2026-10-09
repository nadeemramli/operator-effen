import { NextRequest, NextResponse } from "next/server";
import { sameOrigin } from "@/lib/request-origin";
import { resolveAccess, type Membership } from "@/lib/supabase/server";

// Packer PINs, set by the stock-out supervisor or HR. The database keeps only bcrypt hashes
// outside the workspace state and re-checks the caller (operator_set_staff_pin).
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
const site = (memberships: Membership[], requested: unknown) =>
  typeof requested === "string" && requested
    ? memberships.find((m) => m.workspaceId === requested)
    : memberships[0];
const manager = (m?: Membership) =>
  m &&
  (m.role === "outbound" || m.role === "hr") &&
  m.capabilities.includes("members.manage")
    ? m
    : undefined;
const denied = () =>
  json({ error: "Only the stock-out supervisor or HR can manage packer PINs." }, 403);

/** Which packer profiles have a PIN and which are locked after wrong PINs. */
export async function GET(request: NextRequest) {
  const access = await resolveAccess();
  if (access.status !== 200) return json({ error: access.error }, access.status);
  const m = manager(
    site(access.memberships, request.nextUrl.searchParams.get("workspace")),
  );
  if (!m) return denied();
  const { data, error } = await access.db.rpc("operator_staff_pin_status", {
    p_workspace: m.workspaceId,
  });
  if (error)
    return error.code === "42501"
      ? denied()
      : json({ error: "Unable to load packer PINs." }, 503);
  return json({
    pins: (
      (data ?? []) as {
        profile_id: string;
        set_at: string;
        locked_until: string | null;
      }[]
    ).map((p) => ({
      profileId: p.profile_id,
      setAt: p.set_at,
      lockedUntil: p.locked_until,
    })),
  });
}

/** Sets or replaces a packer's PIN; also clears a lockout. */
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
  const m = manager(site(access.memberships, body?.workspaceId));
  if (!m) return denied();
  if (typeof body?.profileId !== "string" || !body.profileId)
    return json({ error: "Choose the packer." }, 400);
  if (typeof body?.pin !== "string" || !/^[0-9]{4,6}$/.test(body.pin))
    return json({ error: "Use a PIN of 4 to 6 digits." }, 400);
  const { error } = await access.db.rpc("operator_set_staff_pin", {
    p_workspace: m.workspaceId,
    p_profile: body.profileId,
    p_pin: body.pin,
  });
  if (error)
    return error.code === "42501"
      ? denied()
      : error.code === "22023"
        ? json({ error: error.message }, 400)
        : json({ error: "Unable to save the PIN. Try again." }, 503);
  return json({ ok: true });
}
