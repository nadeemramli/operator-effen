import { NextRequest } from "next/server";
import { readsOrders } from "@/lib/capabilities";
import { supabaseServer } from "@/lib/supabase/server";
import {
  conditional,
  json,
  marked,
  orderMember,
  READER_DENIED,
  readFailure,
} from "@/lib/orders-api";
import { etag, notModified, packerRow, realDate } from "@/lib/order-reads";
import type { Order } from "@/lib/draft";
import { ordersOfPacker, RecordLoadError } from "@/lib/order-records-server";
import { PACKER_COOKIE } from "@/lib/packer-session";

const LOCKED = "Your packer session ended. Choose your name and enter your PIN again.";
/**
 * GET /api/orders/packer?workspace&date            the unlocked packer's own AWBs
 * GET /api/orders/packer?workspace&date&profile=id  a packer's AWBs, for a supervisor
 * On the shared packer sign-in the server copies the HttpOnly packer cookie into the
 * x-operator-packer header of the member's own client, exactly as the write path does;
 * public.operator_packer_page and the second select policy then return only the AWBs
 * assigned to the profile that PIN unlocked. Office admin and stock-out read any packer's
 * AWBs of the day (`profile`). ETag: the day marker.
 */
export async function GET(request: NextRequest) {
  const who = await orderMember(request, (m) =>
    m.capabilities.includes("packing.record") || readsOrders(m.capabilities)
      ? null
      : "Your role at this site cannot open the packing station.",
  );
  if (who.response) return who.response;
  const params = request.nextUrl.searchParams;
  const date = params.get("date");
  if (!realDate(date)) return json({ error: "Use a date in the form YYYY-MM-DD." }, 400);
  const { db, m } = who;
  const profile = params.get("profile")?.trim();
  if (profile) {
    if (!readsOrders(m.capabilities)) return json({ error: READER_DENIED }, 403);
    if (profile.length > 100) return json({ error: "Unknown packer." }, 400);
    const summary = () =>
      db.rpc("operator_orders_summary", { p_workspace: m.workspaceId, p_date: date, p_all: false });
    if (conditional(request)) {
      const probe = await summary();
      const tag = probe.data ? etag("p", (probe.data as { marker: string }).marker, profile) : null;
      if (tag && notModified(request.headers.get("if-none-match"), tag))
        return marked(request, tag, () => null);
    }
    try {
      const [orders, counts] = await Promise.all([
        ordersOfPacker(db, m.workspaceId, date, profile),
        summary(),
      ]);
      if (counts.error) return readFailure(counts.error);
      const marker = (counts.data as { marker: string }).marker;
      return marked(request, etag("p", marker, profile), () => ({ profileId: profile, orders, marker }));
    } catch (e) {
      if (e instanceof RecordLoadError) return readFailure(e.failure);
      throw e;
    }
  }
  if (!m.capabilities.includes("packing.record")) return json({ error: READER_DENIED }, 403);
  const seal = request.cookies.get(PACKER_COOKIE)?.value;
  if (!seal) return json({ error: LOCKED, code: "packer-locked" }, 403);
  const reader = await supabaseServer(undefined, { "x-operator-packer": seal });
  const { data, error } = await reader.rpc("operator_packer_page", {
    p_workspace: m.workspaceId,
    p_date: date,
  });
  if (error)
    return error.code === "42501" && /packer session/i.test(error.message)
      ? json({ error: LOCKED, code: "packer-locked" }, 403)
      : readFailure(error);
  const page = data as { profileId: string; orders: Order[]; marker: string };
  return marked(request, etag("p", page.marker, page.profileId), () => ({
    ...page,
    orders: page.orders.map(packerRow),
  }));
}
