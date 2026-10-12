import { NextRequest } from "next/server";
import type { Draft } from "@/lib/draft";
import {
  conditional,
  json,
  marked,
  orderMember,
  readFailure,
  siteDocument,
} from "@/lib/orders-api";
import {
  cartonDigest,
  dayDrafts,
  daySummary,
  etag,
  notModified,
  realDate,
} from "@/lib/order-reads";
import { readDay, recordSource, RecordLoadError } from "@/lib/order-records-server";

/**
 * GET /api/orders/day?workspace&date
 * The aggregates of a day on a tables-mode site, computed on the server from the slim day
 * rows (public.operator_orders_day) with the same functions the document-mode screens use:
 * package groups (without their AWBs), the tally per product, the tally per packer and
 * product, the day's inventory, the day's supervisor counts and the package names, plus
 * the day's counts (public.operator_orders_summary). The client receives aggregates only.
 * ETag: the day marker, the document revision (cartons, returns, adjustments, names) and
 * the per-carton issued totals; If-None-Match gets 304 without reading the day.
 */
export async function GET(request: NextRequest) {
  const who = await orderMember(request);
  if (who.response) return who.response;
  const date = request.nextUrl.searchParams.get("date");
  if (!realDate(date)) return json({ error: "Use a date in the form YYYY-MM-DD." }, 400);
  const { db, m } = who;
  const ws = m.workspaceId;
  const summary = () => db.rpc("operator_orders_summary", { p_workspace: ws, p_date: date, p_all: false });
  try {
    if (conditional(request)) {
      const [site, counts, totals] = await Promise.all([
        siteDocument(db, ws, "revision"),
        summary(),
        recordSource(db, ws).cartonTotals(),
      ]);
      if (site.data && counts.data) {
        const tag = etag("d", (counts.data as { marker: string }).marker, site.data.revision, cartonDigest(totals));
        if (notModified(request.headers.get("if-none-match"), tag))
          return marked(request, tag, () => null);
      }
    }
    const [site, read, counts, totals] = await Promise.all([
      siteDocument(db, ws),
      readDay(db, ws, date),
      summary(),
      recordSource(db, ws).cartonTotals(),
    ]);
    if (site.error || !site.data)
      return json({ error: "Unable to load your site workspace." }, 503);
    if (counts.error) return readFailure(counts.error);
    const doc = { ...(site.data.state as Draft), events: [] } as Draft;
    const drafts = dayDrafts(doc, { ...read, date });
    const tag = etag("d", read.marker, site.data.revision, cartonDigest(totals));
    return marked(request, tag, () => ({
      ...daySummary(drafts.tally, date, { inventory: drafts.inventory }),
      counts: counts.data,
      marker: read.marker,
    }));
  } catch (e) {
    if (e instanceof RecordLoadError) return readFailure(e.failure);
    throw e;
  }
}
