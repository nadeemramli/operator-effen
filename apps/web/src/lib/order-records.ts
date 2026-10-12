import {
  normalizeAwb,
  type AwbImport,
  type ImportEffects,
} from "./awb-import.ts";
import { recordRules } from "./capabilities.ts";
import type {
  DayDemand,
  Draft,
  Event,
  Issue,
  Order,
  OrderLine,
  Recorder,
  SortCount,
} from "./draft.ts";

/**
 * Order records (order volume plan, work package C; design
 * docs/order-volume-wp-c-design.md section 4). On a site whose orders are table rows
 * (operator_workspaces.order_store = 'tables', 20261014090000_operator_order_records.sql)
 * an order command runs on a *slice*: the site document plus only the AWB rows, stock
 * issues and supervisor counts it needs. `applyCommand` keeps every order rule; this module
 * says which rows a command needs (sliceSpec), loads them through a RecordSource (loadSlice,
 * buildSlice) and turns the slice before and after the command into the change set that
 * public.operator_commit_records accepts (sliceDelta). Isomorphic: no server imports.
 */

// --- Rows <-> the app's Order shape ---------------------------------------------------

/** operator_orders as the Data API returns it (the columns ORDER_COLUMNS selects). */
export type OrderRow = {
  id: string;
  awb: string;
  channel: string;
  store: string | null;
  order_ref: string | null;
  courier: string | null;
  import_id: string | null;
  import_row_id: string | null;
  product: string;
  package: string;
  expected: number;
  original_expected: number;
  actual: number | null;
  lines: OrderLine[] | null;
  fulfil_date: string;
  note: string;
  review_state: "pending" | "confirmed";
  reviewed_by: string | null;
  printed: boolean;
  assigned_packer: string | null;
  assigned_at: string | null;
  packer: string;
  label_pic: string;
  packed_at: string | null;
  pack_recorded_at: string | null;
  pack_recorded_by: Recorder | null;
  dispatched: boolean;
  dispatched_at: string | null;
  handover_ref: string;
  version: number;
};
/** Every writable operator_orders column, in table order. */
const COLUMNS = [
  "id",
  "awb",
  "channel",
  "store",
  "order_ref",
  "courier",
  "import_id",
  "import_row_id",
  "product",
  "package",
  "expected",
  "original_expected",
  "actual",
  "lines",
  "fulfil_date",
  "note",
  "review_state",
  "reviewed_by",
  "printed",
  "assigned_packer",
  "assigned_at",
  "packer",
  "label_pic",
  "packed_at",
  "pack_recorded_at",
  "pack_recorded_by",
  "dispatched",
  "dispatched_at",
  "handover_ref",
] as const;
type Column = (typeof COLUMNS)[number];
export const ORDER_COLUMNS = [...COLUMNS, "version"].join(",");
/** Stamped by the database on insert; a change set leaves them out. */
const STAMPED_ON_INSERT: Column[] = ["assigned_at", "pack_recorded_at", "dispatched_at"];
/** Stamped by the database on handover, and in no command's columns: never sent. */
const STAMPED_ON_UPDATE: Column[] = ["dispatched_at"];

const iso = (value: string | null | undefined) => {
  if (value === null || value === undefined) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : value;
};
/** One table row in the app's Order shape (absent optional fields left out, as order_json). */
export function orderFromRow(r: OrderRow): Order {
  const o: Order = {
    id: r.id,
    awb: r.awb,
    channel: r.channel,
    product: r.product,
    package: r.package,
    expected: r.expected,
    originalExpected: r.original_expected,
    actual: r.actual,
    packer: r.packer,
    labelPic: r.label_pic,
    printed: r.printed,
    dispatched: r.dispatched,
    handoverRef: r.handover_ref,
    date: r.fulfil_date,
    note: r.note,
    reviewState: r.review_state,
    version: r.version,
  };
  const optional: Partial<Order> = {
    reviewedBy: r.reviewed_by ?? undefined,
    assignedPacker: r.assigned_packer ?? undefined,
    assignedAt: iso(r.assigned_at),
    packedAt: iso(r.packed_at),
    packRecordedAt: iso(r.pack_recorded_at),
    packRecordedBy: r.pack_recorded_by ?? undefined,
    lines: r.lines ?? undefined,
    store: r.store ?? undefined,
    orderRef: r.order_ref ?? undefined,
    courier: r.courier ?? undefined,
    importId: r.import_id ?? undefined,
    importRowId: r.import_row_id ?? undefined,
    dispatchedAt: iso(r.dispatched_at),
  };
  for (const [k, v] of Object.entries(optional))
    if (v !== undefined) (o as unknown as Record<string, unknown>)[k] = v;
  return o;
}
/** An Order as operator_orders columns (snake_case; absent optional fields as null). */
export function orderToRow(o: Order): Omit<OrderRow, "version"> {
  return {
    id: o.id,
    awb: o.awb,
    channel: o.channel,
    store: o.store ?? null,
    order_ref: o.orderRef ?? null,
    courier: o.courier ?? null,
    import_id: o.importId ?? null,
    import_row_id: o.importRowId ?? null,
    product: o.product,
    package: o.package,
    expected: o.expected,
    original_expected: o.originalExpected,
    actual: o.actual ?? null,
    lines: o.lines ?? null,
    fulfil_date: o.date,
    note: o.note ?? "",
    review_state: o.reviewState ?? "confirmed",
    reviewed_by: o.reviewedBy ?? null,
    printed: !!o.printed,
    assigned_packer: o.assignedPacker ?? null,
    assigned_at: o.assignedAt ?? null,
    packer: o.packer ?? "",
    label_pic: o.labelPic ?? "",
    packed_at: o.packedAt ?? null,
    pack_recorded_at: o.packRecordedAt ?? null,
    pack_recorded_by: o.packRecordedBy ?? null,
    dispatched: !!o.dispatched,
    dispatched_at: o.dispatchedAt ?? null,
    handover_ref: o.handoverRef ?? "",
  };
}
/** A slim day row of public.operator_orders_day (enough for package groups and the gate). */
export type DayOrderRow = {
  id: string;
  awb: string;
  date: string;
  product: string;
  package: string;
  lines: OrderLine[] | null;
  expected: number;
  actual: number | null;
  reviewState: "pending" | "confirmed";
  assignedPacker: string | null;
  packer: string;
  packedAt: string | null;
  printed: boolean;
  dispatched: boolean;
  version: number;
};
/**
 * A slim day row as an Order. Columns the day read leaves out (channel, store, note, …)
 * stay undefined: a command that needs them loads full rows instead, and the differ sends
 * only columns that changed.
 */
export function orderFromDay(r: DayOrderRow): Order {
  const o = {
    id: r.id,
    awb: r.awb,
    date: r.date,
    product: r.product,
    package: r.package,
    expected: r.expected,
    actual: r.actual,
    reviewState: r.reviewState,
    packer: r.packer,
    printed: r.printed,
    dispatched: r.dispatched,
    version: r.version,
  } as Order;
  if (r.lines) o.lines = r.lines;
  if (r.assignedPacker) o.assignedPacker = r.assignedPacker;
  if (r.packedAt) o.packedAt = iso(r.packedAt);
  return o;
}
/** A sort count of public.operator_orders_day; its demand hash is the count's fingerprint. */
export type DaySortCount = {
  id: string;
  date: string;
  product: string;
  expected: number;
  counted: number;
  demandHash: string;
  pic: string;
  note: string;
  at: string;
};
export const sortCountFromDay = (c: DaySortCount): SortCount => ({
  id: c.id,
  date: c.date,
  product: c.product,
  expected: c.expected,
  counted: c.counted,
  fingerprint: c.demandHash,
  pic: c.pic,
  note: c.note,
  at: iso(c.at) ?? c.at,
});
export type IssueRow = {
  id: string;
  order_id: string;
  carton_id: string;
  qty: number;
  pic: string;
  at: string;
};
export const ISSUE_COLUMNS = "id,order_id,carton_id,qty,pic,at";
export const issueFromRow = (r: IssueRow): Issue => ({
  id: r.id,
  cartonId: r.carton_id,
  orderId: r.order_id,
  qty: r.qty,
  pic: r.pic,
  at: iso(r.at) ?? r.at,
});

// --- Demand (mirrors operator_private.day_demand) --------------------------------------

/** sha256 hex of the empty text: the demand hash of a day without the product. */
export const EMPTY_DEMAND_HASH =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/**
 * The text whose sha256 hex is operator_private.day_demand's hash: "<id>:<units>" for each
 * reviewed AWB of the day containing the product, joined by "," in uuid byte order (the
 * lower-case text order of canonical uuids). Callers hash it (node:crypto on the server).
 */
export function demandText(orders: readonly Order[], date: string, productId: string) {
  return orders
    .filter(
      (o) =>
        o.date === date &&
        o.reviewState !== "pending" &&
        (o.lines ?? [o]).some((l) => l.product === productId),
    )
    .map((o) => ({
      id: o.id.toLowerCase(),
      qty: o.lines
        ? o.lines
            .filter((l) => l.product === productId)
            .reduce((n, l) => n + l.expected, 0)
        : o.expected,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((x) => `${x.id}:${x.qty}`)
    .join(",");
}

// --- What a command needs --------------------------------------------------------------

/**
 * The rows an order command needs (design section 4, "Slice spec per command"). Pure: from
 * the command input only. Steps that depend on loaded rows are named here and done by
 * loadSlice: the upload's AWBs and order references, the (day, product) pairs of the
 * targets, and the upload an AWB was released from.
 */
export type SliceSpec = {
  /** AWB rows by id: the command's targets. */
  ids: string[];
  /**
   * Every row with one of these normalized AWBs, on any day, with its handover time: the
   * duplicate check and the AWB reuse rule.
   */
  awbs: string[];
  /**
   * The upload the command acts on (operator_import_get). "awbs": also every row with one
   * of its labels' AWBs or order references (rowStatus); "orders": its released AWBs are
   * the targets (import-delete).
   */
  upload: { id: string; rows: "awbs" | "orders" } | null;
  /** The stock issues of the targets (activity, remaining demand). */
  issues: boolean;
  /** Units issued per carton by issues not loaded (operator_carton_issued). */
  cartonIssued: boolean;
  /**
   * Demand and the latest supervisor count for these (day, product) pairs; "targets": for
   * each product line of each target on its own day.
   */
  demand: "targets" | { date: string; product: string }[];
  /** assign-package: the reviewed AWBs of this day containing this product. */
  day: { date: string; product: string } | null;
  /** remove-order: the upload the AWB was released from, while its label still is. */
  releasedFrom: boolean;
};
const text = (input: Record<string, unknown>, key: string) =>
  typeof input[key] === "string" ? (input[key] as string).trim() : "";
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
const idList = (value: unknown) =>
  Array.isArray(value)
    ? unique(value.filter((v): v is string => typeof v === "string")).slice(0, 10000)
    : [];
export function sliceSpec(type: string, input: Record<string, unknown>): SliceSpec {
  const spec: SliceSpec = {
    ids: [],
    awbs: [],
    upload: null,
    issues: false,
    cartonIssued: false,
    demand: [],
    day: null,
    releasedFrom: false,
  };
  const awb = (key: string) => normalizeAwb(text(input, key));
  switch (type) {
    case "order":
      return { ...spec, awbs: unique([awb("awb")]) };
    case "edit-order":
      return { ...spec, ids: unique([text(input, "id")]), awbs: unique([awb("awb")]) };
    case "review-order":
    case "print":
    case "pack":
    case "pack-own":
    case "correct":
    case "dispatch":
      return { ...spec, ids: unique([text(input, "id")]) };
    case "remove-order":
      return { ...spec, ids: unique([text(input, "id")]), issues: true, releasedFrom: true };
    case "split-order":
      return {
        ...spec,
        ids: unique([text(input, "id")]),
        awbs: unique(
          Object.keys(input)
            .filter((k) => k.startsWith("awb_"))
            .map(awb),
        ),
        issues: true,
      };
    case "print-orders":
    case "move-orders":
      return { ...spec, ids: idList(input.ids) };
    case "assign-orders":
      return { ...spec, ids: idList(input.ids), demand: "targets" };
    case "issue-orders":
      return {
        ...spec,
        ids: idList(input.ids),
        issues: true,
        cartonIssued: true,
        demand: "targets",
      };
    case "issue":
      return {
        ...spec,
        ids: unique([text(input, "orderId")]),
        issues: true,
        cartonIssued: true,
      };
    case "assign-package": {
      const date = text(input, "date");
      let product = "";
      try {
        const key = JSON.parse(text(input, "group"));
        if (Array.isArray(key) && typeof key[0] === "string") product = key[0];
      } catch {
        /* an unknown group: the domain rules report it */
      }
      return date && product
        ? { ...spec, day: { date, product }, demand: [{ date, product }] }
        : spec;
    }
    case "sort-count": {
      const date = text(input, "date"),
        product = text(input, "product");
      return date && product ? { ...spec, demand: [{ date, product }] } : spec;
    }
    case "import-release":
      return { ...spec, upload: text(input, "id") ? { id: text(input, "id"), rows: "awbs" } : null };
    case "import-delete":
      return {
        ...spec,
        upload: text(input, "id") ? { id: text(input, "id"), rows: "orders" } : null,
        issues: true,
      };
    default:
      throw new Error("This action is not available for order records.");
  }
}

// --- Loading -------------------------------------------------------------------------

/** One day as public.operator_orders_day returns it, in the app's shapes. */
export type DayRead = {
  /** The day's AWBs (slim rows). */
  orders: Order[];
  /** The day's sort counts, latest first (as sort_count_current ranks them). */
  sortCounts: SortCount[];
  /** Per product with reviewed AWBs that day. */
  demand: Record<string, DayDemand>;
};
/**
 * Where a slice comes from. The server reads the tables with the member's own client (RLS
 * applies; a packer's client carries the sealed packer session); tests read a Draft.
 */
export interface RecordSource {
  ordersById(ids: string[]): Promise<Order[]>;
  /** Every row with one of these normalized AWBs, on any day. */
  ordersByAwb(awbs: string[]): Promise<Order[]>;
  /** Every row with one of these order references (exact). */
  ordersByRef(refs: string[]): Promise<Order[]>;
  /** The AWBs released from an upload, newest first. */
  ordersOfUpload(importId: string): Promise<Order[]>;
  issuesOf(orderIds: string[]): Promise<Issue[]>;
  /** Units issued per carton (operator_carton_issued). */
  cartonTotals(): Promise<Record<string, number>>;
  day(date: string): Promise<DayRead>;
  /** An upload of the site with its rows, or null when missing or deleted. */
  upload(id: string): Promise<AwbImport | null>;
  /** The upload `order` was released from, when its label is still that AWB's label. */
  releasedFrom(order: Order): Promise<AwbImport | null>;
}
export type LoadedSlice = {
  draft: Draft;
  /** Command.context: the upload the command needs. */
  context?: { import?: AwbImport };
  /** Whether the command's upload effects apply (importEffects). */
  keepEffects: boolean;
};
export type SliceRows = {
  orders: Order[];
  issues: Issue[];
  sortCounts: SortCount[];
  cartonIssued?: Record<string, number>;
  demand?: Record<string, DayDemand>;
};
/**
 * The slice Draft: the site document (its inventory, staff profiles, …) with the loaded
 * order rows, issues and counts in place of the document's lists, an empty audit list and
 * the transient totals the stock and count rules read.
 */
export function buildSlice(doc: Draft, rows: SliceRows): Draft {
  const slice: Draft = {
    ...doc,
    events: [],
    orders: rows.orders,
    issues: rows.issues,
    sortCounts: rows.sortCounts,
  };
  delete slice.cartonIssued;
  delete slice.demand;
  if (rows.cartonIssued) slice.cartonIssued = rows.cartonIssued;
  if (rows.demand) slice.demand = rows.demand;
  return slice;
}
/** Loads what `type` needs (sliceSpec plus its dependent steps) and builds the slice. */
export async function loadSlice(
  source: RecordSource,
  doc: Draft,
  type: string,
  input: Record<string, unknown>,
): Promise<LoadedSlice> {
  const spec = sliceSpec(type, input);
  const orders = new Map<string, Order>();
  const add = (list: Order[]) => {
    for (const o of list) if (!orders.has(o.id)) orders.set(o.id, o);
  };
  let targets: Order[] = [];
  let context: LoadedSlice["context"];
  let keepEffects = false;
  if (spec.upload) {
    const upload = await source.upload(spec.upload.id);
    context = upload ? { import: upload } : undefined;
    keepEffects = true;
    if (upload && spec.upload.rows === "orders") {
      targets = await source.ordersOfUpload(upload.id);
      add(targets);
    }
    if (upload && spec.upload.rows === "awbs") {
      const open = upload.rows.filter((r) => !r.releasedOrderId && !r.excluded);
      add(await source.ordersByAwb(unique(open.map((r) => normalizeAwb(r.awb)))));
      add(await source.ordersByRef(unique(open.map((r) => r.orderRef))));
    }
  }
  if (spec.ids.length) {
    targets = await source.ordersById(spec.ids);
    add(targets);
  }
  if (spec.awbs.length) add(await source.ordersByAwb(spec.awbs));
  const issues = spec.issues && targets.length
    ? await source.issuesOf(targets.map((o) => o.id))
    : [];
  let cartonIssued: Record<string, number> | undefined;
  if (spec.cartonIssued) {
    const totals = await source.cartonTotals();
    const loaded: Record<string, number> = {};
    for (const i of issues) loaded[i.cartonId] = (loaded[i.cartonId] ?? 0) + i.qty;
    cartonIssued = Object.fromEntries(
      Object.entries(totals).map(([carton, n]) => [carton, n - (loaded[carton] ?? 0)]),
    );
  }
  const pairs =
    spec.demand === "targets"
      ? targets.flatMap((o) => (o.lines ?? [o]).map((l) => ({ date: o.date, product: l.product })))
      : spec.demand;
  let demand: Record<string, DayDemand> | undefined;
  const sortCounts: SortCount[] = [];
  if (pairs.length) {
    demand = {};
    for (const date of unique(pairs.map((p) => p.date))) {
      const day = await source.day(date);
      const wanted = unique(pairs.filter((p) => p.date === date).map((p) => p.product));
      for (const product of wanted)
        demand[`${date}|${product}`] = day.demand[product] ?? {
          awbs: 0,
          expected: 0,
          hash: EMPTY_DEMAND_HASH,
        };
      sortCounts.push(...day.sortCounts.filter((c) => wanted.includes(c.product)));
      if (spec.day?.date === date)
        add(
          day.orders.filter(
            (o) =>
              o.reviewState !== "pending" &&
              (o.lines ?? [o]).some((l) => l.product === spec.day!.product),
          ),
        );
    }
  }
  if (spec.releasedFrom && targets[0]) {
    const upload = await source.releasedFrom(targets[0]);
    if (upload) {
      context = { import: upload };
      keepEffects = true;
    }
  }
  return {
    draft: buildSlice(doc, {
      orders: [...orders.values()],
      issues,
      sortCounts,
      cartonIssued,
      demand,
    }),
    context,
    keepEffects,
  };
}

// --- The change set --------------------------------------------------------------------

export type OrderUpdate = { id: string; version: number; set: Partial<Omit<OrderRow, "version">> };
export type RecordIssue = {
  id: string;
  order_id: string;
  carton_id: string;
  qty: number;
  pic: string;
  recorder?: Recorder;
};
export type RecordSortCount = {
  id: string;
  fulfil_date: string;
  product: string;
  counted: number;
  pic: string;
  note: string;
  expected: number;
  demand_awbs: number;
  demand_hash: string;
  recorder?: Recorder;
};
/** The p_changes JSON of public.operator_commit_records (design 3.1; C1 notes). */
export type RecordChanges = {
  orders?: {
    insert?: Partial<OrderRow>[];
    update?: OrderUpdate[];
    delete?: { id: string; version: number }[];
  };
  issues?: RecordIssue[];
  sortCounts?: RecordSortCount[];
  importEffects?: ImportEffects;
  events?: Event[];
};
/** Keys of a slice that are not the stored document. */
const SLICE_KEYS = ["orders", "issues", "sortCounts", "events", "cartonIssued", "demand"];
/** JSON with object keys sorted (jsonb from the database orders keys its own way). */
const canonical = (value: unknown): string =>
  JSON.stringify(value === undefined ? null : value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
      : v,
  );
const OUT_OF_SCOPE = "This change is outside your role's records.";
const byId = <T extends { id: string }>(a: T, b: T) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const versionOf = (o: Order) => {
  if (!Number.isSafeInteger(o.version) || o.version! < 1)
    throw new Error("This AWB could not be read with its version. Refresh and try again.");
  return o.version!;
};
/**
 * The change set that turns the slice `before` into `after` for `type`, within the
 * command's operator_record_rules scope (recordRules), or an error when the command changed
 * something outside it (mirrors step 6 of operator_commit_records): the document, a column
 * the rule does not allow, a recorded issue or count, or an insert or delete the rule does
 * not allow. Updates and deletes carry the version read into the slice; columns the
 * database stamps are left out.
 */
export function sliceDelta(
  type: string,
  before: Draft,
  after: Draft,
  opts: { effects?: ImportEffects | null; recorder?: Recorder } = {},
): RecordChanges {
  const rule = recordRules[type];
  if (!rule) throw new Error("This action is not available for order records.");
  // An order command never changes the document.
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
    if (
      !SLICE_KEYS.includes(key) &&
      canonical((before as unknown as Record<string, unknown>)[key]) !==
        canonical((after as unknown as Record<string, unknown>)[key])
    )
      throw new Error(OUT_OF_SCOPE);

  const prev = new Map(before.orders.map((o) => [o.id, o]));
  const next = new Map(after.orders.map((o) => [o.id, o]));
  const inserts: Partial<OrderRow>[] = [];
  const updates: OrderUpdate[] = [];
  const deletes: { id: string; version: number }[] = [];
  for (const [id, o] of prev)
    if (!next.has(id)) deletes.push({ id, version: versionOf(o) });
  for (const [id, o] of next) {
    const old = prev.get(id);
    if (!old) {
      const row: Partial<OrderRow> = orderToRow(o);
      for (const c of STAMPED_ON_INSERT) delete row[c];
      inserts.push(row);
      continue;
    }
    const a = orderToRow(old) as Record<Column, unknown>,
      b = orderToRow(o) as Record<Column, unknown>;
    const set: Record<string, unknown> = {};
    for (const c of COLUMNS)
      if (!STAMPED_ON_UPDATE.includes(c) && canonical(a[c]) !== canonical(b[c])) {
        if (!rule.orderColumns.includes(c)) throw new Error(OUT_OF_SCOPE);
        set[c] = b[c];
      }
    if (Object.keys(set).length) updates.push({ id, version: versionOf(old), set });
  }
  if ((inserts.length && !rule.orderInsert) || (deletes.length && !rule.orderDelete))
    throw new Error(OUT_OF_SCOPE);

  // Stock issues and sort counts are insert-only.
  const recorder = opts.recorder ? { recorder: opts.recorder } : {};
  const added = <T extends { id: string }>(was: T[] = [], now: T[] = []) => {
    const old = new Map(was.map((x) => [x.id, x]));
    const kept = new Map(now.map((x) => [x.id, x]));
    for (const [id, x] of old)
      if (!kept.has(id) || canonical(kept.get(id)) !== canonical(x))
        throw new Error(OUT_OF_SCOPE);
    return now.filter((x) => !old.has(x.id));
  };
  const issues: RecordIssue[] = added(before.issues, after.issues).map((i) => ({
    id: i.id,
    order_id: i.orderId,
    carton_id: i.cartonId,
    qty: i.qty,
    pic: i.pic,
    ...recorder,
  }));
  const sortCounts: RecordSortCount[] = added(before.sortCounts, after.sortCounts).map(
    (c) => {
      const demand = after.demand?.[`${c.date}|${c.product}`];
      if (!demand || demand.hash !== c.fingerprint)
        throw new Error("Orders changed while the count was prepared. Count again.");
      return {
        id: c.id,
        fulfil_date: c.date,
        product: c.product,
        counted: c.counted,
        pic: c.pic,
        note: c.note,
        expected: demand.expected,
        demand_awbs: demand.awbs,
        demand_hash: demand.hash,
        ...recorder,
      };
    },
  );
  if ((issues.length && !rule.issues) || (sortCounts.length && !rule.sortCounts))
    throw new Error(OUT_OF_SCOPE);
  if (opts.effects && !rule.importEffects) throw new Error(OUT_OF_SCOPE);

  const seen = new Set(before.events.map((e) => e.id));
  const events = after.events.filter((e) => !seen.has(e.id));
  const changes: RecordChanges = {};
  if (inserts.length || updates.length || deletes.length)
    changes.orders = {
      ...(inserts.length ? { insert: inserts.sort((x, y) => byId(x as { id: string }, y as { id: string })) } : {}),
      ...(updates.length ? { update: updates.sort(byId) } : {}),
      ...(deletes.length ? { delete: deletes.sort(byId) } : {}),
    };
  if (issues.length) changes.issues = issues;
  if (sortCounts.length) changes.sortCounts = sortCounts;
  if (opts.effects) changes.importEffects = opts.effects;
  if (events.length) changes.events = events;
  return changes;
}

/** The transient keys a slice or a tables-mode document view adds; never stored. */
const TRANSIENT = ["orders", "issues", "sortCounts", "cartonIssued", "demand"] as const;
/**
 * A tables-mode site document for a document command (stock, production, notes, …): empty
 * order lists so the shared rules run, and the table's issued totals so stock balances
 * count table issues. stripTransient() removes them again before signing.
 */
export function documentView(doc: Draft, cartonIssued: Record<string, number>): Draft {
  return { ...doc, orders: [], issues: [], cartonIssued };
}
export function stripTransient<T extends object>(state: T): T {
  const out = { ...state } as Record<string, unknown>;
  for (const key of TRANSIENT) delete out[key];
  return out as T;
}
