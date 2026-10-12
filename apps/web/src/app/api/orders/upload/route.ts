import { NextRequest } from "next/server";
import { normalizeAwb } from "@/lib/awb-import";
import type { Order } from "@/lib/draft";
import { ImportLoadError, UUID } from "@/lib/imports-server";
import { json, orderMember, readFailure } from "@/lib/orders-api";
import { recordSource, RecordLoadError } from "@/lib/order-records-server";

/**
 * GET /api/orders/upload?workspace&id=<upload id>
 * The AWB rows a PDF review needs on a tables-mode site: every recorded AWB (any day) with
 * the AWB or order reference of one of the upload's open labels (duplicates, the AWB reuse
 * rule and split parcels: rowStatus), the AWBs the upload released, and the stock issues
 * to those (whether each can still be removed). The same rows the release command loads.
 */
export async function GET(request: NextRequest) {
  const who = await orderMember(request);
  if (who.response) return who.response;
  const id = request.nextUrl.searchParams.get("id") ?? "";
  if (!UUID.test(id)) return json({ error: "Unknown upload." }, 400);
  const source = recordSource(who.db, who.m.workspaceId);
  try {
    const upload = await source.upload(id);
    if (!upload) return json({ orders: [], issues: [] });
    const open = upload.rows.filter((r) => !r.releasedOrderId && !r.excluded);
    const [byAwb, byRef, released] = await Promise.all([
      source.ordersByAwb([...new Set(open.map((r) => normalizeAwb(r.awb)).filter(Boolean))]),
      source.ordersByRef([...new Set(open.map((r) => r.orderRef).filter(Boolean))]),
      source.ordersOfUpload(id),
    ]);
    const orders = new Map<string, Order>();
    for (const o of [...released, ...byAwb, ...byRef]) if (!orders.has(o.id)) orders.set(o.id, o);
    const issues = released.length ? await source.issuesOf(released.map((o) => o.id)) : [];
    return json({ orders: [...orders.values()], issues });
  } catch (e) {
    if (e instanceof RecordLoadError || e instanceof ImportLoadError) return readFailure(e.failure);
    throw e;
  }
}
