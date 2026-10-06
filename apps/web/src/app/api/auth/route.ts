import { sameOrigin } from "@/lib/request-origin";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { resolveAccess, supabaseServer } from "@/lib/supabase/server";
import { SESSION_ONLY_COOKIE } from "@/lib/supabase/remember";

export async function POST(request: NextRequest) {
  if (!sameOrigin(request))
    return NextResponse.json(
      { error: "Request not allowed." },
      { status: 403 },
    );
  const input = await request.json().catch(() => null);
  if (
    !input ||
    typeof input.username !== "string" ||
    typeof input.password !== "string" ||
    input.username.length > 254 ||
    input.password.length > 200 ||
    (input.remember !== undefined && typeof input.remember !== "boolean")
  )
    return NextResponse.json(
      { error: "Enter your test username and password." },
      { status: 400 },
    );
  const remember = input.remember === true;
  const db = await supabaseServer(!remember);
  const { data, error } = await db.auth.signInWithPassword({
    email: input.username.trim().toLowerCase(),
    password: input.password,
  });
  // Sign-in requires an active workspace membership or the fictional preview flag.
  const access = error ? null : await resolveAccess(db);
  if (error || access?.status !== 200) {
    if (data.session) await db.auth.signOut({ scope: "local" });
    // Only a caller who already proved the password learns why access was refused,
    // so these reasons do not reveal which accounts exist.
    const [reason, status] = error
      ? error.status === 429
        ? (["rate-limited", 429] as const)
        : error.code === "email_not_confirmed"
          ? (["unconfirmed", 403] as const)
          : (["invalid", 401] as const)
      : access?.status === 403
        ? (["no-access", 403] as const)
        : (["unavailable", 503] as const);
    return NextResponse.json(
      { error: "Sign-in was not completed.", reason },
      { status },
    );
  }
  const jar = await cookies();
  if (remember) jar.delete(SESSION_ONLY_COOKIE);
  else
    jar.set(SESSION_ONLY_COOKIE, "1", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    });
  return NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
