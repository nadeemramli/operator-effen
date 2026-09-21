import { sameOrigin } from "@/lib/request-origin";
import { NextRequest, NextResponse } from "next/server";
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
  return NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
