import type { AwbImport } from "@/lib/awb-import";
import type { Draft, Event, Issue, Order } from "@/lib/draft";
import type { resolveAccess } from "@/lib/supabase/server";

/**
 * Where a site's records live (20261015090000_operator_imports_and_events.sql). The
 * workspace document keeps the small shared records; PDF uploads are rows of
 * `operator_imports` and audit entries rows of `operator_events`. A command still runs on
 * one in-memory Draft: the server adds the one upload it touches, and the signed commit
 * carries only that upload and the audit entries the command added.
 *
 * Until the migration is applied the document still holds `awbImports` and every audit
 * entry; then everything is saved exactly as before (`legacy`).
 */
type Db = Awaited<ReturnType<typeof resolveAccess>>["db"];

/** Audit entries and uploads sent with each load; older ones are fetched on demand. */
export const RECENT_EVENTS = 300;
export const RECENT_IMPORTS = 100;

const missingRelation = (code?: string) =>
  code === "42P01" || code === "PGRST205" || code === "PGRST200";

/**
 * PostgREST answers any request with at most `max_rows` rows (1000: supabase/config.toml and
 * the hosted default) and does not say when it cut a result short. A day of 1,700 AWBs
 * therefore loaded as 1,000, and the orders screen showed fewer parcels and boxes the more
 * labels were released. Every read that can exceed that reads page by page until a short
 * page; the page size must not be larger than `max_rows`, or a page would be cut and the
 * loop would stop early (a test keeps it equal to the configuration).
 */
export const PAGE_ROWS = 1000;
type Page<T> = PromiseLike<{ data: T[] | null; error: { code?: string } | null }>;
export async function allRows<T>(
  page: (from: number, to: number) => Page<T>,
): Promise<{ data: T[]; error: { code?: string } | null }> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_ROWS) {
    const { data, error } = await page(from, from + PAGE_ROWS - 1);
    if (error) return { data: rows, error };
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE_ROWS) return { data: rows, error: null };
  }
}

/** The upload a command reads or changes, if any. Each upload command touches one. */
export function touchedImport(
  type: string,
  input: Record<string, unknown>,
  state: Draft,
): string | undefined {
  const id = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  switch (type) {
    case "import-save":
      return input.batch && typeof input.batch === "object"
        ? id((input.batch as { id?: unknown }).id)
        : undefined;
    case "import-release":
    case "import-receive":
    case "import-delete":
      return id(input.id);
    case "remove-order":
      return state.orders.find((o) => o.id === input.id)?.importId;
  }
}

/** Whether the document still holds the uploads (the migration is not applied yet). */
export const legacyDocument = (doc: Draft) => Array.isArray(doc.awbImports);

/** One stored upload, or undefined when it does not exist (or the table does not yet). */
export async function loadImport(
  db: Db,
  workspaceId: string,
  id: string,
): Promise<AwbImport | undefined> {
  const { data, error } = await db
    .from("operator_imports")
    .select("doc")
    .eq("workspace_id", workspaceId)
    .eq("id", id)
    .maybeSingle();
  if (error && !missingRelation(error.code)) throw new StoreError();
  return (data?.doc as AwbImport | undefined) ?? undefined;
}

/**
 * The logical state the API signs and commits: the document, the audit entries the
 * command added (the stored document has none), and the touched upload in full, or a
 * removal marker when the command deleted an upload that existed.
 */
export function commitPayload(
  state: Draft,
  importId: string | undefined,
  existed: boolean,
  orders?: OrderOp[],
  /** Stock issues in their own table: only the ones the command added. */
  issues?: Issue[],
): Record<string, unknown> {
  const { awbImports, orders: list, ...base } = state;
  const rest = issues === undefined ? base : { ...base, issues };
  // Orders in their own table (20261017090000) travel as the changes only.
  const doc: Record<string, unknown> =
    orders === undefined ? { ...rest, orders: list } : orders.length ? { ...rest, orders } : rest;
  if (!importId) return doc;
  const after = awbImports?.find((b) => b.id === importId);
  if (after) return { ...doc, awbImports: [after] };
  return existed ? { ...doc, awbImports: [{ id: importId, deleted: true }] } : doc;
}

/**
 * What a member's screens receive: the document plus the latest audit entries and the
 * upload list (without label rows; `rowCount` marks a summary). `full` replaces its
 * summary with the whole upload, so the screen that just saved it can keep it open.
 */
export async function clientState(
  db: Db,
  workspaceId: string,
  doc: Draft,
  full?: AwbImport,
  dates: string[] = [],
  /** Stock issues for the orders on these dates and these orders (default: `dates`). */
  issuesFor: { dates: string[]; ids: string[] } = { dates, ids: [] },
): Promise<Draft> {
  if (legacyDocument(doc)) return doc;
  const orders = legacyOrders(doc)
    ? doc.orders
    : (await loadOrders(db, workspaceId, { ids: [], awbs: [], dates, imports: [] })).orders;
  const issues =
    (await hydrateIssues(db, workspaceId, {
      dates: issuesFor.dates,
      ids: [...issuesFor.ids, ...orders.map((o) => o.id)],
    }))?.issues ?? doc.issues;
  const [events, imports] = await Promise.all([
    db
      .from("operator_events")
      .select("body")
      .eq("workspace_id", workspaceId)
      .order("seq", { ascending: false })
      .limit(RECENT_EVENTS),
    db
      .from("operator_import_summaries")
      .select("summary")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(RECENT_IMPORTS),
  ]);
  if (missingRelation(events.error?.code) || missingRelation(imports.error?.code))
    return { ...doc, orders, issues };
  if (events.error || imports.error) throw new StoreError();
  const summaries = (imports.data ?? []).map(
    (r) => ({ ...(r.summary as object), rows: [] }) as unknown as AwbImport,
  );
  if (full) {
    const at = summaries.findIndex((b) => b.id === full.id);
    if (at >= 0) summaries[at] = full;
    else summaries.unshift(full);
  }
  return {
    ...doc,
    orders,
    issues,
    events: [
      ...(doc.events ?? []),
      ...(events.data ?? []).map((r) => r.body as Event),
    ],
    awbImports: summaries,
  };
}

/** Audit entries about the given records, newest first (trace view). */
export async function entityEvents(
  db: Db,
  workspaceId: string,
  entities: string[],
): Promise<Event[]> {
  const { data, error } = await db
    .from("operator_events")
    .select("body")
    .eq("workspace_id", workspaceId)
    .in("entity", entities)
    .order("seq", { ascending: false })
    .limit(500);
  if (error && !missingRelation(error.code)) throw new StoreError();
  return (data ?? []).map((r) => r.body as Event);
}

export class StoreError extends Error {
  constructor() {
    super("Unable to load your site records.");
  }
}

/**
 * Order archive (20261016090000_operator_order_archive.sql). Orders whose work date is more
 * than ORDER_ARCHIVE_DAYS ago (Malaysia time) move from the document to
 * `operator_orders_archive`; the database fixes the cutoff, this only decides when to ask.
 */
export const ORDER_ARCHIVE_DAYS = 7;
export function archiveCutoff(now = new Date()) {
  const myt = new Date(now.getTime() + 8 * 3600 * 1000);
  myt.setUTCDate(myt.getUTCDate() - ORDER_ARCHIVE_DAYS);
  return myt.toISOString().slice(0, 10);
}
/** Whether the document holds orders old enough to archive. */
export const needsArchive = (doc: Draft, now = new Date()) => {
  const cutoff = archiveCutoff(now);
  return (doc.orders ?? []).some(
    (o) => /^\d{4}-\d{2}-\d{2}$/.test(o.date ?? "") && o.date < cutoff,
  );
};
/** Moves old orders to the archive; 0 when nothing moved or the migration is not applied. */
export async function archiveOrders(db: Db, workspaceId: string): Promise<number> {
  const { data, error } = await db.rpc("operator_archive_orders", {
    p_workspace: workspaceId,
  });
  return error ? 0 : Number(data) || 0;
}
/** Archived orders with these AWBs (normalized), for duplicate checks. */
export async function archivedByAwb(
  db: Db,
  workspaceId: string,
  awbs: string[],
): Promise<Order[]> {
  if (!awbs.length) return [];
  const { data, error } = await db
    .from("operator_orders_archive")
    .select("doc")
    .eq("workspace_id", workspaceId)
    .in("awb", [...new Set(awbs)].slice(0, 1000));
  if (error && !missingRelation(error.code)) throw new StoreError();
  return (data ?? []).map((r) => r.doc as Order);
}
/**
 * Orders whose AWB contains the query, newest work date first (AWB lookup screen): every
 * order once orders have their own table, the archive before that.
 */
export async function searchArchive(
  db: Db,
  workspaceId: string,
  query: string,
): Promise<Order[]> {
  const pattern = `%${query.replace(/[%_\\]/g, "")}%`;
  const table = await db
    .from("operator_orders")
    .select("doc")
    .eq("workspace_id", workspaceId)
    .ilike("awb", pattern)
    .order("order_date", { ascending: false })
    .limit(50);
  if (!table.error) return (table.data ?? []).map((r) => r.doc as Order);
  if (!missingRelation(table.error.code)) throw new StoreError();
  const { data, error } = await db
    .from("operator_orders_archive")
    .select("doc")
    .eq("workspace_id", workspaceId)
    .ilike("awb", pattern)
    .order("order_date", { ascending: false })
    .limit(50);
  if (error && !missingRelation(error.code)) throw new StoreError();
  return (data ?? []).map((r) => r.doc as Order);
}

/**
 * Orders in their own table (20261017090000_operator_orders.sql), one row per AWB with its
 * own version. A command loads the orders it needs; the commit carries only the orders it
 * created, changed or removed, each with the version it was based on. Screens load the
 * work dates they show. Until the migration is applied the document holds every order.
 */
export const legacyOrders = (doc: Draft) =>
  Array.isArray((doc as { orders?: unknown }).orders);

export type OrderNeeds = { ids: string[]; awbs: string[]; dates: string[]; imports: string[] };
export type OrderOp =
  | { op: "put"; order: Order; expected: number | null }
  | { op: "delete"; id: string; expected: number };
export type LoadedOrders = { orders: Order[]; versions: Map<string, number> };

const normalize = (awb: unknown) =>
  typeof awb === "string" ? awb.trim().toUpperCase().replace(/\s+/g, "") : "";
const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The orders a command reads or changes: by ID, by AWB (duplicate checks), by work date
 * (package groups and the daily tally) or by upload. `state` carries the upload a
 * release reads, when loaded.
 */
export function orderNeeds(
  type: string,
  input: Record<string, unknown>,
  state?: Draft,
): OrderNeeds {
  const needs: OrderNeeds = { ids: [], awbs: [], dates: [], imports: [] };
  const id = text(input.id);
  switch (type) {
    case "order":
      needs.awbs.push(normalize(input.awb));
      break;
    case "edit-order":
      if (id) needs.ids.push(id);
      needs.awbs.push(normalize(input.awb));
      break;
    case "split-order":
      if (id) needs.ids.push(id);
      for (const [k, v] of Object.entries(input))
        if (k.startsWith("awb_")) needs.awbs.push(normalize(v));
      break;
    case "review-order":
    case "remove-order":
    case "print":
    case "pack":
    case "pack-own":
    case "correct":
    case "dispatch":
      if (id) needs.ids.push(id);
      break;
    case "issue":
      if (text(input.orderId)) needs.ids.push(input.orderId as string);
      break;
    case "assign-orders":
    case "print-orders":
    case "move-orders":
    case "issue-orders":
      if (Array.isArray(input.ids))
        needs.ids.push(...input.ids.filter((x): x is string => typeof x === "string"));
      break;
    case "assign-package":
    case "sort-count":
      if (DATE.test(String(input.date ?? ""))) needs.dates.push(input.date as string);
      break;
    case "import-delete":
      if (id) needs.imports.push(id);
      break;
    case "import-release":
      for (const row of state?.awbImports?.find((b) => b.id === id)?.rows ?? [])
        needs.awbs.push(normalize(row.awb));
      break;
  }
  needs.awbs = needs.awbs.filter(Boolean);
  return needs;
}

/**
 * Second step for commands that check the day's supervisor count (assign-orders,
 * issue-orders): every order on the work dates of the selected orders.
 */
export function dayNeeds(type: string, orders: Order[]): OrderNeeds {
  const needs: OrderNeeds = { ids: [], awbs: [], dates: [], imports: [] };
  if (type === "assign-orders" || type === "issue-orders")
    needs.dates = [...new Set(orders.map((o) => o.date).filter((d) => DATE.test(d ?? "")))];
  return needs;
}

const empty = (n: OrderNeeds) =>
  !n.ids.length && !n.awbs.length && !n.dates.length && !n.imports.length;

/** Loads the orders matching any of the needs, with their versions. */
export async function loadOrders(
  db: Db,
  workspaceId: string,
  needs: OrderNeeds,
): Promise<LoadedOrders> {
  const versions = new Map<string, number>();
  if (empty(needs)) return { orders: [], versions };
  // The function orders its rows (work date, then ID), so the pages line up.
  const { data, error } = await allRows<{ doc: Order; version: number }>((from, to) =>
    db
      .rpc("operator_orders_for", {
        p_workspace: workspaceId,
        p_ids: [...new Set(needs.ids)],
        p_awbs: [...new Set(needs.awbs)],
        p_dates: [...new Set(needs.dates)],
        p_imports: [...new Set(needs.imports)],
      })
      .range(from, to),
  );
  if (error) throw new StoreError();
  const orders = data.map((r) => {
    versions.set(r.doc.id, r.version);
    return r.doc;
  });
  return { orders, versions };
}

/** Adds newly loaded orders to a loaded set (first load wins). */
export function addLoaded(into: LoadedOrders, more: LoadedOrders) {
  for (const o of more.orders)
    if (!into.versions.has(o.id)) {
      into.orders.push(o);
      into.versions.set(o.id, more.versions.get(o.id)!);
    }
}

/** The orders a command created, changed or removed, against the versions it read. */
export function orderOps(before: LoadedOrders, after: Order[]): OrderOp[] {
  const was = new Map(before.orders.map((o) => [o.id, JSON.stringify(o)]));
  const ops: OrderOp[] = [];
  const kept = new Set<string>();
  for (const order of after) {
    kept.add(order.id);
    if (!was.has(order.id)) ops.push({ op: "put", order, expected: null });
    else if (was.get(order.id) !== JSON.stringify(order))
      ops.push({ op: "put", order, expected: before.versions.get(order.id)! });
  }
  for (const [id] of was)
    if (!kept.has(id))
      ops.push({ op: "delete", id, expected: before.versions.get(id)! });
  return ops;
}

/** The orders a screen holds, after a save that returned only its changes. */
export function mergeOrders(
  current: Order[],
  delta: { put: Order[]; removed: string[] },
): Order[] {
  const gone = new Set([...delta.removed, ...delta.put.map((o) => o.id)]);
  return [...delta.put, ...current.filter((o) => !gone.has(o.id))];
}

/** Today in Malaysia, and the work dates a request asks for (at most 7). */
export const todayMyt = (now = new Date()) =>
  new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
export function viewDates(value: unknown, now = new Date()): string[] {
  const list = (Array.isArray(value) ? value : String(value ?? "").split(","))
    .map(String)
    .filter((d) => DATE.test(d));
  return [...new Set(list.length ? list : [todayMyt(now)])].slice(0, 7);
}

/**
 * Stock issues in their own table (20261018090000_operator_issues.sql). A command or screen
 * gets the real issues of the orders it holds, plus, for every other issue, its carton's
 * total per Malaysian day for the last ISSUE_DAYS days and one total before that (ids
 * starting "total:"). Carton balances, the daily stock report (within the window) and the
 * per-order checks then read exactly as with every issue loaded. Returns null until the
 * migration is applied (the document still holds every issue).
 */
export const ISSUE_DAYS = 62;
export type HydratedIssues = { issues: Issue[]; loaded: Set<string> };

const mytDayOf = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? todayMyt(new Date(t)) : "";
};
const shiftDay = (day: string, by: number) => {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
};

export async function hydrateIssues(
  db: Db,
  workspaceId: string,
  of: { ids: string[]; dates: string[] },
  now = new Date(),
): Promise<HydratedIssues | null> {
  const since = shiftDay(todayMyt(now), -ISSUE_DAYS);
  const ids = [...new Set(of.ids)],
    dates = [...new Set(of.dates)];
  // Totals are grouped, not ordered, in SQL: the pages need an order of their own. Issues
  // come ordered (recorded time, then ID).
  const [totals, real] = await Promise.all([
    allRows<{ carton_id: string; day: string | null; qty: number }>((from, to) =>
      db
        .rpc("operator_issue_totals", { p_workspace: workspaceId, p_since: since })
        .order("carton_id")
        .order("day", { nullsFirst: false })
        .range(from, to),
    ),
    ids.length || dates.length
      ? allRows<{ body: Issue }>((from, to) =>
          db
            .rpc("operator_issues_for", { p_workspace: workspaceId, p_orders: ids, p_dates: dates })
            .range(from, to),
        )
      : Promise.resolve({ data: [] as { body: Issue }[], error: null }),
  ]);
  if (totals.error || real.error) {
    const code = totals.error?.code ?? real.error?.code;
    if (code === "PGRST202" || code === "42883" || missingRelation(code)) return null;
    throw new StoreError();
  }
  const issues = real.data.map((r) => r.body);
  const remaining = new Map<string, number>();
  const key = (carton: string, day: string | null) => carton + "|" + (day ?? "");
  for (const t of totals.data) remaining.set(key(t.carton_id, t.day), Number(t.qty));
  for (const i of issues) {
    const day = mytDayOf(i.at);
    const k = key(i.cartonId, day >= since ? day : null);
    remaining.set(k, (remaining.get(k) ?? 0) - i.qty);
  }
  const totalsAsIssues: Issue[] = [];
  for (const [k, qty] of remaining) {
    if (qty <= 0) continue;
    const [cartonId, day] = k.split("|");
    totalsAsIssues.push({
      id: "total:" + cartonId + ":" + (day || "before"),
      cartonId,
      orderId: "",
      qty,
      pic: "",
      // Noon in Malaysia on that day; totals before the window sit on its eve.
      at: (day || shiftDay(since, -1)) + "T04:00:00.000Z",
    });
  }
  return {
    issues: [...issues, ...totalsAsIssues],
    loaded: new Set([...issues, ...totalsAsIssues].map((i) => i.id)),
  };
}

/** The stock issues a command added: everything it holds that was not loaded. */
export const addedIssues = (hydrated: HydratedIssues, after: Issue[]) =>
  after.filter((i) => !hydrated.loaded.has(i.id));
