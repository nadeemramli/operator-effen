import { NextRequest, NextResponse } from "next/server";
import { resolveAccess, type Membership } from "@/lib/supabase/server";
import { pick } from "@/lib/imports-server";
import { readsOrders } from "@/lib/capabilities";
import { notModified } from "@/lib/order-reads";

/**
 * Shared steps of the /api/orders/* read endpoints (order volume WP C, PR C3). Every read
 * uses the signed-in member's own client, so the order tables' policies decide what they
 * see (office admin and stock-out: the site's AWBs; a packer's client carrying the sealed
 * packer session: the AWBs assigned to the profile it unlocked). The capability checks
 * here only turn "no access" into a clear answer before the database is asked.
 */
type Db = Awaited<ReturnType<typeof resolveAccess>>["db"];
const NO_STORE = { "Cache-Control": "private, no-store" };
export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });
export const SANDBOX_ORDERS =
  "Order records are read on operational sites. The preview sandbox keeps its orders in its own workspace.";
export const READER_DENIED = "Your role at this site cannot open AWBs.";

/**
 * The signed-in operational member for `?workspace=` (or the first site), after `allow`
 * accepted their capabilities; otherwise the response to send. The preview sandbox gets
 * 403 with code "sandbox".
 */
export async function orderMember(
  request: NextRequest,
  allow: (m: Membership) => string | null = (m) =>
    readsOrders(m.capabilities) ? null : READER_DENIED,
): Promise<
  | { db: Db; userId: string; m: Membership; response?: undefined }
  | { response: NextResponse }
> {
  const access = await resolveAccess();
  if (access.status !== 200) return { response: json({ error: access.error }, access.status) };
  const { db, user, memberships } = access;
  if (!memberships.length)
    return { response: json({ error: SANDBOX_ORDERS, code: "sandbox" }, 403) };
  const m = pick(memberships, request.nextUrl.searchParams.get("workspace"));
  if (!m) return { response: json({ error: "You do not have access to that site." }, 403) };
  const denied = allow(m);
  if (denied) return { response: json({ error: denied }, 403) };
  return { db, userId: user.id, m };
}

/** Maps the read functions' error codes (see 20261014090000) to responses. */
export function readFailure(error: { code?: string; message: string }) {
  switch (error.code) {
    case "42501":
      return json({ error: error.message }, 403);
    case "28000":
      return json({ error: "Please sign in again." }, 401);
    case "22023":
    case "22007":
    case "22008":
      return json({ error: error.message }, 400);
    // Before 20261014090000 is applied the read functions do not exist.
    case "PGRST202":
    case "42883":
    case "PGRST205":
    case "42P01":
      return json({ error: "AWB records are not available on this server yet." }, 503);
    default:
      return json({ error: "Unable to load AWB records. Try again shortly." }, 503);
  }
}

/** 304 when the request's If-None-Match names `tag`, else the body with the tag. */
export function marked(request: NextRequest, tag: string, body: () => unknown) {
  if (notModified(request.headers.get("if-none-match"), tag))
    return new NextResponse(null, { status: 304, headers: { ...NO_STORE, ETag: tag } });
  return json(body(), 200, { ETag: tag });
}
/** Whether the request asks for a conditional read (the endpoint may probe first). */
export const conditional = (request: NextRequest) => !!request.headers.get("if-none-match");
/** The site's document revision and stored document (one row, the member's own client). */
export async function siteDocument(db: Db, workspaceId: string, columns = "state,revision") {
  const { data, error } = await db
    .from("operator_workspaces")
    .select(columns)
    .eq("id", workspaceId)
    .single();
  return { data: data as unknown as { state?: unknown; revision: number } | null, error };
}
