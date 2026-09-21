import { sameOrigin } from "@/lib/request-origin";
import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

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
    input.password.length > 200
  )
    return NextResponse.json(
      { error: "Enter your test username and password." },
      { status: 400 },
    );
  const db = await supabaseServer();
  const { data, error } = await db.auth.signInWithPassword({
    email: input.username.trim().toLowerCase(),
    password: input.password,
  });
  if (error || data.user?.app_metadata?.ui_draft_access !== true) {
    if (data.session) await db.auth.signOut();
    return NextResponse.json(
      {
        error:
          "The username or password is incorrect, or this account does not have draft access.",
      },
      { status: 401 },
    );
  }
  return NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
