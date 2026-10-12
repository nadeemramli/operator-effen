import { NextRequest } from "next/server";
import { json, marked, orderMember, readFailure } from "@/lib/orders-api";
import { etag, realDate } from "@/lib/order-reads";

/**
 * GET /api/orders/summary?workspace&date[&scope=all]
 * Overview figures (public.operator_orders_summary): AWBs of the chosen day by status, and
 * those still open from earlier days. scope=all counts across every hot AWB of the site
 * (owner decision 2026-10-12: per day by default, all-time on request). The day scope
 * carries the day marker as its ETag.
 */
export async function GET(request: NextRequest) {
  const who = await orderMember(request);
  if (who.response) return who.response;
  const params = request.nextUrl.searchParams;
  const date = params.get("date");
  if (!realDate(date)) return json({ error: "Use a date in the form YYYY-MM-DD." }, 400);
  const all = params.get("scope") === "all";
  const { data, error } = await who.db.rpc("operator_orders_summary", {
    p_workspace: who.m.workspaceId,
    p_date: date,
    p_all: all,
  });
  if (error) return readFailure(error);
  const summary = data as { marker: string | null };
  return all || !summary.marker
    ? json(summary)
    : marked(request, etag("s", summary.marker), () => summary);
}
