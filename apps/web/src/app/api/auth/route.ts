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
    return NextResponse.json(
      {
        error:
          "The username or password is incorrect, or this account does not have Operator access.",
      },
      { status: 401 },
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
