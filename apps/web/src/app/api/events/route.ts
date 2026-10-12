import { NextRequest } from "next/server";
import { resolveAccess } from "@/lib/supabase/server";
import { json, pick } from "@/lib/imports-server";
import {
  EVENT_COLUMNS,
  eventFromRow,
  parseEventsQuery,
  SANDBOX_EVENTS,
  type EventRow,
} from "@/lib/events";

/**
 * GET /api/events?workspace=<id>&entity=<id>[&entity=<id>…]   entries of those records
 * GET /api/events?workspace=<id>&date=YYYY-MM-DD[&before=<seq>] entries of a Malaysia day
 * GET /api/events?workspace=<id>&recent=1[&limit=n]            the site's latest entries
 * Newest first, at most 200 per page; `next` is the `before` value of the following page.
 * Audit entries of operational sites live in operator_events (20261013090000); the read
 * uses the member's own client, so the table's policy decides (every active member of the
 * site). The preview sandbox keeps its entries in its document and gets 403.
 */
export async function GET(request: NextRequest) {
  const access = await resolveAccess();
  if (access.status !== 200)
    return json({ error: access.error }, access.status);
  const { db, memberships } = access;
  if (!memberships.length)
    return json({ error: SANDBOX_EVENTS, code: "sandbox" }, 403);
  const params = request.nextUrl.searchParams;
  const m = pick(memberships, params.get("workspace"));
  if (!m) return json({ error: "You do not have access to that site." }, 403);
  const q = parseEventsQuery(params);
  if ("error" in q) return json({ error: q.error }, 400);
  let query = db
    .from("operator_events")
    .select(EVENT_COLUMNS)
    .eq("workspace_id", m.workspaceId);
  if (q.kind === "entity") query = query.in("entity", q.entities);
  if (q.kind === "date") query = query.gte("at", q.from).lt("at", q.to);
  if (q.before !== undefined) query = query.lt("seq", q.before);
  const { data, error } = await query
    .order("seq", { ascending: false })
    .limit(q.limit);
  if (error)
    return json({ error: "Unable to load the activity log. Try again shortly." }, 503);
  const events = (data as unknown as EventRow[]).map(eventFromRow);
  return json({
    events,
    next: events.length === q.limit ? events[events.length - 1].seq : null,
  });
}
