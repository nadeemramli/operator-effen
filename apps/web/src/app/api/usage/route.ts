import { NextRequest, NextResponse } from "next/server";
import { commitSecret } from "@/lib/access";
import { openPackerSession, PACKER_COOKIE } from "@/lib/packer-session";
import { sameOrigin } from "@/lib/request-origin";
import { resolveAccess, type Membership } from "@/lib/supabase/server";
import { isUsageView, usagePeriod, usageSince, type UsageRow } from "@/lib/usage";
import { logUsage } from "@/lib/usage-log";

// Feature usage (20261116090000_operator_usage.sql). POST counts a screen view for the
// signed-in member; GET returns the site's usage report to Management and HR. The database
// decides who may do either; the role is never taken from the request.
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
const site = (memberships: Membership[], requested: unknown) =>
  typeof requested === "string" && requested
    ? memberships.find((m) => m.workspaceId === requested)
    : memberships[0];
type ReportRow = {
  role: string;
  user_id: string;
  display_name: string;
  profile_id: string;
  kind: UsageRow["kind"];
  detail: string;
  uses: number;
  active_days: number;
  last_at: string | null;
};

export async function GET(request: NextRequest) {
  const access = await resolveAccess();
  if (access.status !== 200) return json({ error: access.error }, access.status);
  const params = request.nextUrl.searchParams;
  const m = site(access.memberships, params.get("workspace"));
  if (!m) return json({ error: "You do not have access to that site." }, 403);
  const days = usagePeriod(params.get("days")),
    since = usageSince(days);
  const { data, error } = await access.db.rpc("operator_usage_report", {
    p_workspace: m.workspaceId,
    p_since: since,
  });
  if (error)
    return error.code === "42501"
      ? json({ error: "Only Management and HR can read the usage report." }, 403)
      : error.code === "PGRST202" || error.code === "42883"
        ? json(
            { error: "Usage tracking is not set up on this backend yet.", code: "not-set-up" },
            503,
          )
        : json({ error: "Unable to load the usage report." }, 503);
  const rows: UsageRow[] = ((data ?? []) as ReportRow[]).map((r) => ({
    role: r.role,
    userId: r.user_id,
    name: r.display_name,
    profileId: r.profile_id,
    kind: r.kind,
    detail: r.detail,
    uses: Number(r.uses),
    activeDays: Number(r.active_days),
    lastAt: r.last_at,
  }));
  return json({ rows, days, since });
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return json({ error: "Request not allowed." }, 403);
  const access = await resolveAccess();
  if (access.status !== 200) return json({ error: access.error }, access.status);
  const body = await request.json().catch(() => null);
  if (!isUsageView(body?.view)) return json({ error: "Invalid request." }, 400);
  // The fictional preview has no site and no roles to report on.
  const m = site(access.memberships, body.workspaceId);
  if (!m) return json({ recorded: false });
  // A packer's views count under the profile their PIN unlocked on this device.
  const secret = m.capabilities.includes("packing.record") ? commitSecret() : null;
  const packer = secret
    ? openPackerSession(secret, request.cookies.get(PACKER_COOKIE)?.value, {
        userId: access.user.id,
        workspaceId: m.workspaceId,
      })
    : null;
  return json({
    recorded: await logUsage(access.db, m.workspaceId, "view", body.view, packer?.profileId),
  });
}
