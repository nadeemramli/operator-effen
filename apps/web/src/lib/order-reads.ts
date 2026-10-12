import { readsOrders } from "./capabilities.ts";
import {
  dailyInventory,
  dailyTally,
  demandKey,
  orderHasActivity,
  orderIssued,
  orderLines,
  orderReady,
  packageGroups,
  packEntrySource,
  product,
  products,
  recorderLabel,
  singleProductOrder,
  type DailyInventory,
  type DayDemand,
  type Draft,
  type Issue,
  type Order,
  type Recorder,
  type Role,
  type SortCount,
} from "./draft.ts";
import { mytDayRange } from "./events.ts";
import {
  orderFromDay,
  sortCountFromDay,
  type DayOrderRow,
  type DaySortCount,
} from "./order-records.ts";

/**
 * Reading order records (order volume plan WP C, PR C3; design
 * docs/order-volume-wp-c-design.md sections 5 and 6). On a site whose orders are table
 * rows the screens read them through /api/orders/* instead of the workspace document. This
 * module holds what the endpoints and the screens share: query parsing, the day marker as
 * an ETag, CSV lines, the day summary (package groups, tally, packer tally, inventory) that
 * the server computes from the slim day rows with the same domain functions the
 * document-mode screens use, and the packer projection of the document. Isomorphic.
 */

// --- Rows as the list, trace and export read them --------------------------------------

/** An AWB as the read functions return it: the Order plus its row version and the units
 * issued to it per product (operator_private.order_issued). */
export type ListedOrder = Order & { issued?: Record<string, number> };
/** Units issued to an AWB for a product: from the row when read from the tables, else from
 * the document's issues. */
export const issuedUnits = (
  s: Pick<Draft, "issues" | "cartons">,
  o: ListedOrder,
  productId: string,
) => (o.issued ? (o.issued[productId] ?? 0) : orderIssued(s as Draft, o, productId));
/** Stock, packing or handover recorded against the AWB (orderHasActivity for a read row). */
export const hasActivity = (s: Pick<Draft, "issues">, o: ListedOrder) =>
  o.issued
    ? o.actual !== null ||
      o.dispatched ||
      !!o.packedAt ||
      Object.values(o.issued).some((n) => Number(n) > 0)
    : orderHasActivity(s, o);

// --- Query parsing ------------------------------------------------------------------------

/** Status filters of operator_orders_page (operator_private.order_status_match). */
export const ORDER_STATUSES = [
  "review",
  "unassigned",
  "unpacked",
  "handover",
  "dispatched",
  "mismatch",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
/** AWBs per list page (operator_orders_page caps the limit at 200). */
export const PAGE_LIMIT = 200;
/** Days per CSV export (owner decision 2026-10-12; operator_orders_export). */
export const EXPORT_DAYS = 31;
/** A real YYYY-MM-DD calendar date. */
export const realDate = (value: unknown): value is string =>
  typeof value === "string" && mytDayRange(value) !== null;

export type ListQuery = {
  date: string;
  product?: string;
  package?: string;
  q?: string;
  status?: OrderStatus;
  group?: { product: string; package: string; perParcel: number };
  after?: string;
  limit: number;
};
/**
 * GET /api/orders search parameters: date (required), product, package, q, status, group
 * (a packageGroups key), after (the `next` AWB of the previous page) and limit (1..200).
 */
export function parseListQuery(params: URLSearchParams): ListQuery | { error: string } {
  const date = params.get("date") ?? "";
  if (!realDate(date)) return { error: "Use a date in the form YYYY-MM-DD." };
  const query: ListQuery = { date, limit: PAGE_LIMIT };
  const productId = params.get("product");
  if (productId) {
    if (!products.some((p) => p.id === productId)) return { error: "Unknown product." };
    query.product = productId;
  }
  const pkg = params.get("package");
  if (pkg) {
    if (pkg.length > 2000) return { error: "Invalid package." };
    query.package = pkg;
  }
  const q = params.get("q")?.trim();
  if (q) {
    if (q.length > 200) return { error: "Search for at most 200 characters." };
    query.q = q;
  }
  const status = params.get("status");
  if (status) {
    if (!(ORDER_STATUSES as readonly string[]).includes(status))
      return { error: "Unknown status filter." };
    query.status = status as OrderStatus;
  }
  const group = params.get("group");
  if (group) {
    let key: unknown;
    try {
      key = JSON.parse(group);
    } catch {
      key = null;
    }
    if (
      !Array.isArray(key) ||
      key.length !== 3 ||
      typeof key[0] !== "string" ||
      typeof key[1] !== "string" ||
      !Number.isSafeInteger(key[2])
    )
      return { error: "Unknown package group." };
    query.group = { product: key[0], package: key[1], perParcel: key[2] };
  }
  const after = params.get("after");
  if (after) {
    if (after.length > 60) return { error: "Invalid page." };
    query.after = after;
  }
  const limit = params.get("limit");
  if (limit !== null) {
    const n = Number(limit);
    if (!Number.isSafeInteger(n) || n < 1 || n > PAGE_LIMIT)
      return { error: `Use a limit from 1 to ${PAGE_LIMIT}.` };
    query.limit = n;
  }
  return query;
}
/** The arguments of public.operator_orders_page for a parsed query. */
export const listArgs = (workspaceId: string, q: ListQuery) => ({
  p_workspace: workspaceId,
  p_date: q.date,
  p_product: q.product ?? null,
  p_package: q.package ?? null,
  p_q: q.q ?? null,
  p_status: q.status ?? null,
  p_group: q.group ?? null,
  p_after: q.after ?? null,
  p_limit: q.limit,
});
/** Whole days from `from` to `to`, both included (YYYY-MM-DD). */
export const daySpan = (from: string, to: string) =>
  Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000) + 1;
/** GET /api/orders/export: from and to (YYYY-MM-DD), at most 31 days. */
export function parseExportRange(
  params: URLSearchParams,
): { from: string; to: string } | { error: string } {
  const from = params.get("from") ?? "",
    to = params.get("to") ?? "";
  if (!realDate(from) || !realDate(to)) return { error: "Use dates in the form YYYY-MM-DD." };
  if (to < from) return { error: "The end date is before the start date." };
  if (daySpan(from, to) > EXPORT_DAYS)
    return { error: `Export at most ${EXPORT_DAYS} days at a time.` };
  return { from, to };
}

// --- Day markers as ETags -----------------------------------------------------------------

/**
 * An ETag from the parts that decide a read: the day marker of the read functions
 * (operator_private.day_marker: counts and versions only grow, so any change of the day's
 * rows changes it), plus, for reads that also use the document, its revision and a digest
 * of the per-carton issued totals.
 */
export const etag = (...parts: (string | number | null | undefined)[]) =>
  `"${parts.filter((p) => p !== null && p !== undefined && p !== "").join(".")}"`;
/** Whether an If-None-Match header names this ETag (the read can answer 304). */
export function notModified(ifNoneMatch: string | null | undefined, tag: string) {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === "*") return true;
  return ifNoneMatch
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .includes(tag);
}
/** Per-carton issued totals as one short value: rows and units only grow. */
export const cartonDigest = (totals: Record<string, number>) => {
  const values = Object.values(totals);
  return `${values.length}x${values.reduce((n, v) => n + Number(v), 0)}`;
};

// --- CSV ----------------------------------------------------------------------------------

/** The columns of the parcel export (one row per product line of an AWB). */
export const EXPORT_COLUMNS = [
  "AWB",
  "Source",
  "Date",
  "Product",
  "Unit",
  "Package",
  "Expected",
  "Issued",
  "Packed",
  "Variance",
  "Packer",
  "Packed at",
  "Pack entered by",
  "AWB attached by",
  "Handed over",
  "Manifest",
];
/** One CSV value: quoted, quotes doubled, and a leading formula character neutralized. */
export function csvCell(value: string | number | null | undefined) {
  let x = String(value ?? "");
  if (/^[=+@\-\t\r]/.test(x)) x = "'" + x;
  return '"' + x.replaceAll('"', '""') + '"';
}
export const csvLine = (row: (string | number | null | undefined)[]) =>
  row.map(csvCell).join(",");
/** The export rows of one AWB. `name` shows a stored performer reference. */
export function exportRows(
  o: ListedOrder,
  issued: (o: ListedOrder, productId: string) => number,
  name: (ref: string) => string = (ref) => ref,
): (string | number)[][] {
  return orderLines(o).map((line) => [
    o.awb,
    o.channel,
    o.date,
    product(line.product).name,
    product(line.product).unit,
    o.package,
    line.expected,
    issued(o, line.product),
    line.actual ?? "",
    line.actual === null ? "" : line.actual - line.expected,
    name(o.packer),
    o.packedAt ?? "",
    recorderLabel(o.packRecordedBy),
    name(o.labelPic),
    o.dispatched ? "Yes" : "No",
    o.handoverRef,
  ]);
}
/** A whole CSV file as the browser saves it: byte order mark, CRLF lines. */
export const csvDocument = (rows: (string | number)[][]) =>
  "﻿" + [EXPORT_COLUMNS, ...rows].map(csvLine).join("\r\n");

// --- The day summary -----------------------------------------------------------------------

/** One package group of the day, without its AWBs (packageGroups, aggregated). */
export type GroupSummary = {
  key: string;
  product: string;
  package: string;
  perParcel: number;
  parcels: number;
  /** Parcels with a packed count. */
  recorded: number;
  /** Parcels neither packed nor handed over. */
  pending: number;
  /** Pending parcels without a packer. */
  unassigned: number;
  /** Units still to issue to the pending parcels. */
  remaining: number;
  /** Packers assigned to the group's parcels, in first-seen order, with their parcels. */
  packers: { id: string; parcels: number }[];
  /** Pending parcels per assigned packer. */
  pendingBy: Record<string, number>;
  /** Document mode only: the group's AWB ids and its pending ones. */
  ids?: string[];
  openIds?: string[];
};
export type PackerTally = {
  packer: string;
  product: string;
  awbs: number;
  expected: number;
  packed: number;
  unrecorded: number;
  entered: { packer: number; supervisor: number; unknown: number };
};
export type TallyRow = ReturnType<typeof dailyTally>[number];
export type DaySummary = {
  date: string;
  /** AWBs of the day, those awaiting review and those with more than one brand. */
  awbs: number;
  review: number;
  multi: number;
  /** Package names of the day with the products their AWBs contain. */
  packages: { package: string; products: string[] }[];
  groups: GroupSummary[];
  tally: TallyRow[];
  packerTally: PackerTally[];
  inventory: DailyInventory[];
  /** The day's supervisor counts, latest first. */
  sortCounts: SortCount[];
};
const sum = (list: number[]) => list.reduce((n, x) => n + x, 0);
/**
 * Everything the order and tally screens aggregate for one Malaysia day, from `s` (whose
 * orders, issues and counts cover at least that day). Document-mode screens call it on the
 * workspace document; on a tables-mode site the server calls it on the slim day rows
 * (dayDrafts) and sends only the result. `inventory` is the state dailyInventory reads
 * when it differs from `s`; `ids` keeps the AWB ids per group (document mode).
 */
export function daySummary(
  s: Draft,
  date: string,
  opts: { ids?: boolean; inventory?: Draft } = {},
): DaySummary {
  const day = s.orders.filter((o) => o.date === date);
  const groups = packageGroups(day).map((g): GroupSummary => {
    const pending = g.orders.filter((o) => !o.dispatched && o.actual === null);
    const packers = new Map<string, number>();
    for (const o of g.orders)
      if (o.assignedPacker) packers.set(o.assignedPacker, (packers.get(o.assignedPacker) ?? 0) + 1);
    const pendingBy: Record<string, number> = {};
    for (const o of pending)
      if (o.assignedPacker) pendingBy[o.assignedPacker] = (pendingBy[o.assignedPacker] ?? 0) + 1;
    return {
      key: g.key,
      product: g.product,
      package: g.package,
      perParcel: g.perParcel,
      parcels: g.orders.length,
      recorded: g.orders.filter((o) => o.actual !== null).length,
      pending: pending.length,
      unassigned: pending.filter((o) => !o.assignedPacker).length,
      remaining: sum(
        pending.map((o) =>
          Math.max(0, sum(orderLines(o).map((l) => l.expected)) - orderIssued(s, o, g.product)),
        ),
      ),
      packers: [...packers].map(([id, parcels]) => ({ id, parcels })),
      pendingBy,
      ...(opts.ids
        ? { ids: g.orders.map((o) => o.id), openIds: pending.map((o) => o.id) }
        : {}),
    };
  });
  const packages = new Map<string, Set<string>>();
  for (const o of day) {
    const set = packages.get(o.package) ?? new Set<string>();
    for (const l of orderLines(o)) set.add(l.product);
    packages.set(o.package, set);
  }
  const ready = day.filter(orderReady);
  const packerTally: PackerTally[] = [];
  for (const packer of [...new Set(ready.map((o) => o.assignedPacker ?? o.packer))])
    for (const p of products) {
      const orders = ready.filter(
        (o) =>
          (o.assignedPacker ?? o.packer) === packer &&
          orderLines(o).some((l) => l.product === p.id),
      );
      if (!orders.length) continue;
      const lines = orders.flatMap((o) => orderLines(o).filter((l) => l.product === p.id));
      const by = (k: string) => orders.filter((o) => packEntrySource(o) === k).length;
      packerTally.push({
        packer,
        product: p.id,
        awbs: orders.length,
        expected: sum(lines.map((l) => l.expected)),
        packed: sum(lines.map((l) => l.actual ?? 0)),
        unrecorded: lines.filter((l) => l.actual === null).length,
        entered: { packer: by("packer"), supervisor: by("supervisor"), unknown: by("unknown") },
      });
    }
  return {
    date,
    awbs: day.length,
    review: day.filter((o) => !orderReady(o)).length,
    multi: day.filter((o) => !singleProductOrder(o)).length,
    packages: [...packages]
      .map(([pkg, set]) => ({ package: pkg, products: [...set].sort() }))
      .sort((a, b) => a.package.localeCompare(b.package)),
    groups,
    tally: dailyTally(s, date),
    packerTally,
    inventory: dailyInventory(opts.inventory ?? s, date),
    sortCounts: (s.sortCounts ?? []).filter((c) => c.date === date),
  };
}

/** public.operator_orders_day as it returns the day (slim rows; see the migration). */
export type DayRead = {
  date: string;
  orders: (DayOrderRow & { recordedRole?: string | null })[];
  issues: { orderId: string; cartonId: string; product: string; qty: number | string; at: string }[];
  sortCounts: DaySortCount[];
  demand: Record<string, { awbs: number | string; expected: number | string; hash: string }>;
  cartonIssued: { before: Record<string, number | string>; within: Record<string, number | string> };
  marker: string;
};
/** A slim day row as an Order, with the role that keyed its count (packEntrySource). */
export function dayOrder(r: DayRead["orders"][number]): Order {
  const o = orderFromDay(r);
  if (r.recordedRole)
    o.packRecordedBy = { kind: "member", role: r.recordedRole as Role, name: "" } as Recorder;
  return o;
}
/**
 * The two states daySummary reads on a tables-mode site, built from the site document and
 * one operator_orders_day read: `tally` holds the day's AWBs, the issues to them, the day's
 * counts and the database's demand; `inventory` holds the stock cartons with the units
 * issued from each before the Malaysia day as `cartonIssued` and those issued within it as
 * one issue per carton at midday (issues after the day are in neither, as dailyInventory
 * leaves them out).
 */
export function dayDrafts(doc: Draft, read: DayRead): { tally: Draft; inventory: Draft } {
  const base: Draft = { ...doc, events: [] };
  delete base.cartonIssued;
  delete base.demand;
  const demand: Record<string, DayDemand> = {};
  for (const [productId, d] of Object.entries(read.demand ?? {}))
    demand[demandKey(read.date, productId)] = {
      awbs: Number(d.awbs),
      expected: Number(d.expected),
      hash: d.hash,
    };
  const issues: Issue[] = read.issues.map((i, n) => ({
    id: "day-issue-" + n,
    orderId: i.orderId,
    cartonId: i.cartonId,
    qty: Number(i.qty),
    pic: "",
    at: i.at,
  }));
  const midday = new Date(Date.parse(read.date + "T12:00:00+08:00")).toISOString();
  return {
    tally: {
      ...base,
      orders: read.orders.map(dayOrder),
      issues,
      sortCounts: read.sortCounts.map(sortCountFromDay),
      demand,
    },
    inventory: {
      ...base,
      orders: [],
      issues: Object.entries(read.cartonIssued?.within ?? {}).map(([cartonId, qty], n) => ({
        id: "day-within-" + n,
        orderId: "",
        cartonId,
        qty: Number(qty),
        pic: "",
        at: midday,
      })),
      cartonIssued: Object.fromEntries(
        Object.entries(read.cartonIssued?.before ?? {}).map(([c, n]) => [c, Number(n)]),
      ),
    },
  };
}
/** Pending AWB ids of a day's package groups for one product (issue-orders), optionally of
 * one package, in the order the order screen lists them. */
export function openIdsFor(orders: Order[], productId: string, pkg?: string) {
  return packageGroups(orders)
    .filter((g) => g.product === productId && (pkg === undefined || g.package === pkg))
    .flatMap((g) => g.orders.filter((o) => !o.dispatched && o.actual === null).map((o) => o.id));
}

/**
 * An AWB as the packer phone needs it: the packing card, the package summary and the trace
 * sheet. Upload references, the store, the order reference, the courier and the server
 * times the phone never shows are left out, which keeps a 250-AWB page near half its size.
 */
export function packerRow(o: Order): Order {
  const slim = { ...o };
  for (const key of [
    "importId",
    "importRowId",
    "store",
    "orderRef",
    "courier",
    "assignedAt",
    "packRecordedAt",
    "reviewedBy",
  ] as const)
    delete slim[key];
  return slim;
}

// --- Who reads what ---------------------------------------------------------------------

export { readsOrders };
/** Members who only record their own packed counts and post feedback (the shared packer
 * sign-in). On a tables-mode site their document is projected (packerProjection). */
export const packerOnly = (capabilities: readonly string[]) =>
  capabilities.includes("packing.record") &&
  capabilities.every((c) => c === "packing.record" || c === "feedback.post");
/**
 * The document a packer phone needs on a tables-mode site (design section 5, "packer
 * projection"): the staff profiles (id, name, role, active) and the notes; every other
 * list empty. The packer's AWBs come from /api/orders/packer.
 */
export function packerProjection(doc: Draft): Draft {
  return {
    version: 1,
    ...(doc.staffProfiles
      ? {
          staffProfiles: doc.staffProfiles.map((p) => ({
            id: p.id,
            name: p.name,
            role: p.role,
            ...(p.active === false ? { active: false } : {}),
          })),
        }
      : {}),
    batches: [],
    cartons: [],
    orders: [],
    issues: [],
    boxing: [],
    counts: [],
    adjustments: [],
    returns: [],
    events: [],
    notes: doc.notes ?? [],
    closedDays: [],
  };
}
