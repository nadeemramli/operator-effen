import { NextRequest } from "next/server";
import { products } from "@/lib/draft";
import { json, orderMember, readFailure } from "@/lib/orders-api";
import { dayOrder, openIdsFor, realDate } from "@/lib/order-reads";
import { readDay, RecordLoadError } from "@/lib/order-records-server";

/**
 * GET /api/orders/open?workspace&date&product[&package]
 * The AWB ids "Issue stock" allocates to on a tables-mode site: the pending parcels of the
 * day's package groups for one product (optionally one package), in the order the order
 * screen lists them. The day aggregates carry no AWB ids, so the screen asks when the
 * supervisor opens the form.
 */
export async function GET(request: NextRequest) {
  const who = await orderMember(request);
  if (who.response) return who.response;
  const params = request.nextUrl.searchParams;
  const date = params.get("date"),
    productId = params.get("product") ?? "",
    pkg = params.get("package") ?? undefined;
  if (!realDate(date) || !products.some((p) => p.id === productId))
    return json({ error: "Choose a day and a product." }, 400);
  try {
    const read = await readDay(who.db, who.m.workspaceId, date);
    return json({ ids: openIdsFor(read.orders.map(dayOrder), productId, pkg) });
  } catch (e) {
    if (e instanceof RecordLoadError) return readFailure(e.failure);
    throw e;
  }
}
