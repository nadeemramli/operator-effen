import { NextRequest } from "next/server";
import { json, orderMember, readFailure } from "@/lib/orders-api";
import { realDate } from "@/lib/order-reads";

/**
 * GET /api/orders/packer-counts?workspace&date
 * The packer unlock screen: unpacked AWBs of the day assigned to each packer profile
 * (public.operator_packer_counts), counts only, no AWBs. Packers and stock-out.
 */
export async function GET(request: NextRequest) {
  const who = await orderMember(request, (m) =>
    m.capabilities.includes("packing.record") || m.capabilities.includes("outbound.fulfil")
      ? null
      : "Your role at this site cannot open the packing station.",
  );
  if (who.response) return who.response;
  const date = request.nextUrl.searchParams.get("date");
  if (!realDate(date)) return json({ error: "Use a date in the form YYYY-MM-DD." }, 400);
  const { data, error } = await who.db.rpc("operator_packer_counts", {
    p_workspace: who.m.workspaceId,
    p_date: date,
  });
  if (error) return readFailure(error);
  return json({ counts: data ?? [] });
}
