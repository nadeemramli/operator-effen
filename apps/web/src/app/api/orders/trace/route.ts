import { NextRequest } from "next/server";
import { readsOrders } from "@/lib/capabilities";
import { json, orderMember, READER_DENIED, readFailure } from "@/lib/orders-api";
import { realDate } from "@/lib/order-reads";
import { UUID } from "@/lib/imports-server";

/**
 * GET /api/orders/trace?workspace&q=<AWB or order reference>
 * GET /api/orders/trace?workspace&order=<AWB id>
 * GET /api/orders/trace?workspace&batch=<batch id>        [&afterDate&afterAwb: next page]
 * Trace on a tables-mode site (public.operator_orders_trace): an exact AWB (every
 * occurrence, newest first: couriers reuse numbers), an AWB prefix of at least 6
 * characters, an exact order reference, an AWB id, or a batch (its cartons, then the AWBs
 * that received stock from them). Answers {cartons, parcels, orders, issues, events, next},
 * at most 100 AWBs per page. Members without AWB access may trace a batch and get its
 * cartons and issued totals with `parcels: false`; their AWB lookups are refused.
 */
export async function GET(request: NextRequest) {
  const who = await orderMember(request, () => null);
  if (who.response) return who.response;
  const params = request.nextUrl.searchParams;
  const q = params.get("q")?.trim() || null,
    order = params.get("order")?.trim() || null,
    batch = params.get("batch")?.trim() || null;
  if ([q, order, batch].filter(Boolean).length !== 1)
    return json({ error: "Give one AWB, order reference, AWB id or batch." }, 400);
  if ((q || order) && !readsOrders(who.m.capabilities))
    return json({ error: READER_DENIED }, 403);
  if ((q && q.length > 200) || (batch && batch.length > 100) || (order && !UUID.test(order)))
    return json({ error: "Invalid trace request." }, 400);
  const afterDate = params.get("afterDate"),
    afterAwb = params.get("afterAwb");
  if ((afterDate || afterAwb) && (!realDate(afterDate) || !afterAwb || afterAwb.length > 60))
    return json({ error: "Invalid page." }, 400);
  const { data, error } = await who.db.rpc("operator_orders_trace", {
    p_workspace: who.m.workspaceId,
    p_q: q,
    p_order: order,
    p_batch: batch,
    p_after_date: afterDate || null,
    p_after_awb: afterAwb || null,
  });
  if (error) return readFailure(error);
  return json(data);
}
