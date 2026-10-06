import { sameOrigin } from "@/lib/request-origin";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { SESSION_ONLY_COOKIE } from "@/lib/supabase/remember";
import { supabaseServer } from "@/lib/supabase/server";
export async function POST(request: NextRequest) {
  if (!sameOrigin(request))
    return NextResponse.json(
      { error: "Request not allowed." },
      { status: 403 },
    );
  const { error } = await (
    await supabaseServer()
  ).auth.signOut({ scope: "local" });
  if (error)
    return NextResponse.json(
      { error: "Unable to sign out. Please retry." },
      { status: 503 },
    );
  (await cookies()).delete(SESSION_ONLY_COOKIE);
  return NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
