import { NextRequest, NextResponse } from "next/server";
import { staffName, type StaffProfile } from "@/lib/draft";
import { json, orderMember, readFailure } from "@/lib/orders-api";
import {
  csvLine,
  EXPORT_COLUMNS,
  exportRows,
  issuedUnits,
  parseExportRange,
  type ListedOrder,
} from "@/lib/order-reads";

type Page = { orders: ListedOrder[]; next: { date: string; awb: string } | null };
/**
 * GET /api/orders/export?workspace&from&to
 * The parcel CSV of a tables-mode site for at most 31 days (owner decision 2026-10-12),
 * one row per product line of each AWB, the same columns as the document-mode export.
 * Read in keyset pages of 1,000 AWBs (public.operator_orders_export) and streamed, so a
 * month (about 62,000 AWBs) never sits in memory. Office admin and stock-out only.
 */
export async function GET(request: NextRequest) {
  const who = await orderMember(request);
  if (who.response) return who.response;
  const range = parseExportRange(request.nextUrl.searchParams);
  if ("error" in range) return json({ error: range.error }, 400);
  const { db, m } = who;
  const read = (after: Page["next"]) =>
    db.rpc("operator_orders_export", {
      p_workspace: m.workspaceId,
      p_from: range.from,
      p_to: range.to,
      p_after_date: after?.date ?? null,
      p_after_awb: after?.awb ?? null,
    });
  const [first, site] = await Promise.all([
    read(null),
    db.from("operator_workspaces").select("staffProfiles:state->staffProfiles").eq("id", m.workspaceId).single(),
  ]);
  if (first.error) return readFailure(first.error);
  const people = { staffProfiles: (site.data as { staffProfiles?: StaffProfile[] } | null)?.staffProfiles ?? undefined };
  const name = (ref: string) => staffName(people, ref);
  const issued = (o: ListedOrder, p: string) => issuedUnits({ issues: [], cartons: [] }, o, p);
  const encoder = new TextEncoder();
  let page: Page | null = first.data as Page;
  let started = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(encoder.encode("﻿" + csvLine(EXPORT_COLUMNS)));
      }
      if (!page) {
        controller.close();
        return;
      }
      const lines = page.orders.flatMap((o) => exportRows(o, issued, name)).map(csvLine);
      if (lines.length) controller.enqueue(encoder.encode("\r\n" + lines.join("\r\n")));
      if (!page.next) {
        page = null;
        return;
      }
      const more = await read(page.next);
      if (more.error) {
        controller.error(new Error(more.error.message));
        return;
      }
      page = more.data as Page;
    },
  });
  const file = `operator-awbs-${range.from}${range.to === range.from ? "" : "_" + range.to}.csv`;
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${file}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
