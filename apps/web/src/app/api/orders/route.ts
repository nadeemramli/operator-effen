import { NextRequest } from "next/server";
import {
  conditional,
  json,
  marked,
  orderMember,
  readFailure,
} from "@/lib/orders-api";
import { etag, listArgs, notModified, parseListQuery } from "@/lib/order-reads";

/**
 * GET /api/orders?workspace&date[&product&package&q&status&group&after&limit]
 * One page of a day's AWBs on a tables-mode site (public.operator_orders_page): at most
 * 200 by AWB, `next` is the `after` of the following page, `total` counts every match.
 * `marker` (also the ETag) changes whenever the day's rows change; a request carrying
 * If-None-Match is answered 304 from the cheap day summary when nothing changed.
 * Office admin and stock-out only (owner decision 2026-10-12).
 */
export async function GET(request: NextRequest) {
  const who = await orderMember(request);
  if (who.response) return who.response;
  const q = parseListQuery(request.nextUrl.searchParams);
  if ("error" in q) return json({ error: q.error }, 400);
  const { db, m } = who;
  if (conditional(request)) {
    const probe = await db.rpc("operator_orders_summary", {
      p_workspace: m.workspaceId,
      p_date: q.date,
      p_all: false,
    });
    const tag = probe.data ? etag("l", (probe.data as { marker: string }).marker) : null;
    if (tag && notModified(request.headers.get("if-none-match"), tag))
      return marked(request, tag, () => null);
  }
  const { data, error } = await db.rpc("operator_orders_page", listArgs(m.workspaceId, q));
  if (error) return readFailure(error);
  const page = data as { marker: string };
  return marked(request, etag("l", page.marker), () => page);
}
