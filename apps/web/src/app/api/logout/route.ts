import { sameOrigin } from "@/lib/request-origin";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { PACKER_COOKIE } from "@/lib/packer-session";
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
  const jar = await cookies();
  jar.delete(SESSION_ONLY_COOKIE);
  jar.delete({ name: PACKER_COOKIE, path: "/api" });
  return NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
