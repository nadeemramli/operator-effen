import type { resolveAccess } from "@/lib/supabase/server";
import type { AwbImport } from "@/lib/awb-import";
import type { Order } from "@/lib/draft";
import { loadImport, UUID } from "@/lib/imports-server";
import {
  ISSUE_COLUMNS,
  issueFromRow,
  ORDER_COLUMNS,
  orderFromDay,
  orderFromRow,
  sortCountFromDay,
  type DayOrderRow,
  type DayRead,
  type DaySortCount,
  type IssueRow,
  type OrderRow,
  type RecordSource,
} from "@/lib/order-records";

/**
 * Server reads for order records (20261014090000_operator_order_records.sql). Every read
 * uses the signed-in member's own client, so the tables' row-level security decides what
 * they see: office admin and stock-out read the site's AWBs; a packer's client carries the
 * sealed packer session in `x-operator-packer` and reads only the AWBs assigned to the
 * profile it unlocked. Nothing is cached across requests.
 */
type Db = Awaited<ReturnType<typeof resolveAccess>>["db"];
type Failure = { code?: string; message: string };
export class RecordLoadError extends Error {
  failure: Failure;
  constructor(failure: Failure) {
    super(failure.message);
    this.failure = failure;
  }
}
type Page<T> = PromiseLike<{ data: T[] | null; error: Failure | null }>;
/** Every row of a query, 1,000 at a time (the Data API's row limit). */
async function all<T>(query: (from: number, to: number) => Page<T>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await query(from, from + 999);
    if (error) throw new RecordLoadError(error);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}
const chunks = <T>(list: T[], size = 150) =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) =>
    list.slice(i * size, (i + 1) * size),
  );
// `in.(…)` lists cannot carry quotes or backslashes; such values are matched one by one.
const listable = (value: string) => !/["\\]/.test(value);

export function recordSource(db: Db, workspaceId: string): RecordSource {
  const orders = () =>
    db.from("operator_orders").select(ORDER_COLUMNS).eq("workspace_id", workspaceId);
  /** Rows whose `column` is one of `values`: lists of 150, single matches for odd values. */
  const ordersWhere = async (column: string, values: string[]) => {
    const out: Order[] = [];
    const lists = chunks(values.filter(listable));
    const singles = values.filter((v) => !listable(v));
    for (const list of lists)
      out.push(
        ...(
          await all<OrderRow>((from, to) =>
            orders().in(column, list).order("id").range(from, to) as unknown as Page<OrderRow>,
          )
        ).map(orderFromRow),
      );
    for (const value of singles)
      out.push(
        ...(
          await all<OrderRow>((from, to) =>
            orders().eq(column, value).order("id").range(from, to) as unknown as Page<OrderRow>,
          )
        ).map(orderFromRow),
      );
    return out;
  };
  return {
    // Identifiers that are not UUIDs cannot name a row (the domain reports "not found").
    ordersById: (ids) => ordersWhere("id", ids.filter((id) => UUID.test(id))),
    // AWBs are normalized and at most 60 characters in the table.
    ordersByAwb: (awbs) => ordersWhere("awb", awbs.filter((a) => a && a.length <= 60)),
    ordersByRef: (refs) => ordersWhere("order_ref", refs.filter((r) => r && r.length <= 200)),
    ordersOfUpload: async (importId) =>
      UUID.test(importId)
        ? (
            await all<OrderRow>((from, to) =>
              orders()
                .eq("import_id", importId)
                .order("created_at", { ascending: false })
                .order("id")
                .range(from, to) as unknown as Page<OrderRow>,
            )
          ).map(orderFromRow)
        : [],
    issuesOf: async (orderIds) => {
      const out = [];
      for (const list of chunks(orderIds.filter((id) => UUID.test(id))))
        out.push(
          ...(
            await all<IssueRow>((from, to) =>
              db
                .from("operator_issues")
                .select(ISSUE_COLUMNS)
                .eq("workspace_id", workspaceId)
                .in("order_id", list)
                .order("at", { ascending: false })
                .order("id")
                .range(from, to) as unknown as Page<IssueRow>,
            )
          ).map(issueFromRow),
        );
      return out;
    },
    cartonTotals: async () =>
      Object.fromEntries(
        (
          await all<{ carton_id: string; issued: number | string }>((from, to) =>
            db
              .from("operator_carton_issued")
              .select("carton_id,issued")
              .eq("workspace_id", workspaceId)
              .order("carton_id")
              .range(from, to) as unknown as Page<{ carton_id: string; issued: number | string }>,
          )
        ).map((r) => [r.carton_id, Number(r.issued)]),
      ),
    day: async (date): Promise<DayRead> => {
      const { data, error } = await db.rpc("operator_orders_day", {
        p_workspace: workspaceId,
        p_date: date,
      });
      if (error) throw new RecordLoadError(error);
      const day = data as {
        orders: DayOrderRow[];
        sortCounts: DaySortCount[];
        demand: Record<string, { awbs: number; expected: number; hash: string }>;
      };
      return {
        orders: day.orders.map(orderFromDay),
        sortCounts: day.sortCounts.map(sortCountFromDay),
        demand: Object.fromEntries(
          Object.entries(day.demand).map(([product, d]) => [
            product,
            { awbs: Number(d.awbs), expected: Number(d.expected), hash: d.hash },
          ]),
        ),
      };
    },
    upload: (id) => loadImport(db, workspaceId, id),
    releasedFrom: (order) => releasedFrom(db, workspaceId, order),
  };
}

/**
 * remove-order: the upload and label the AWB came from, when that label is still the AWB's
 * released label in the tables (its effect then marks the label excluded); otherwise null
 * and the AWB is removed without an upload change. Same rule as the document path.
 */
export async function releasedFrom(
  db: Db,
  workspaceId: string,
  order: Order,
): Promise<AwbImport | null> {
  if (!order.importId || !order.importRowId) return null;
  if (!UUID.test(order.importId) || !UUID.test(order.importRowId)) return null;
  const [header, row] = await Promise.all([
    db
      .from("operator_imports")
      .select("id,name,date,files,created_at,updated_at")
      .eq("id", order.importId)
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
    db
      .from("operator_import_rows")
      .select("id,released_order_id")
      .eq("id", order.importRowId)
      .eq("import_id", order.importId)
      .maybeSingle(),
  ]);
  if (header.error || row.error)
    throw new RecordLoadError({ message: "Unable to load the PDF upload." });
  if (!header.data || row.data?.released_order_id !== order.id) return null;
  return {
    id: header.data.id,
    name: header.data.name,
    date: header.data.date,
    files: header.data.files,
    rows: [],
    createdAt: header.data.created_at,
    updatedAt: header.data.updated_at,
  };
}
