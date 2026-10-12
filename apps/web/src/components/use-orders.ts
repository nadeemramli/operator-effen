"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Issue, Order } from "@/lib/draft";
import type { DaySummary, ListedOrder } from "@/lib/order-reads";

/**
 * Order records of a tables-mode site (order volume WP C, PR C3; design section 6), read
 * through /api/orders/*. Each hook is idle while its view is closed (`enabled` false or
 * no site), loads when opened, and refreshes:
 *  - every 60 seconds and when the tab becomes visible again, while the view is open and
 *    not `paused` (a form open or a save in flight), sending the last ETag (the day marker)
 *    so an unchanged day answers 304 with no body;
 *  - after a save: DraftApp calls notifyOrdersChanged with the days a records commit
 *    touched (records.result.days), and every hook covering one of them refreshes;
 *  - when the document revision moves (`revision`), for reads that also use the document.
 * Realtime (#11) can call notifyOrdersChanged from a Broadcast instead of the timer.
 * Document-mode sites and the preview sandbox keep reading the workspace document.
 */

// --- Change notifications -----------------------------------------------------------------

export type OrdersChange = {
  workspaceId?: string;
  /** Days whose rows changed; null or absent: any day. */
  days?: string[] | null;
};
const listeners = new Set<(change: OrdersChange) => void>();
/** Tells the open order views that records changed (after a save, or from realtime). */
export function notifyOrdersChanged(change: OrdersChange = {}) {
  for (const listener of [...listeners]) listener(change);
}

// --- Fetching -----------------------------------------------------------------------------

export class OrdersError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}
type Got<T> = { notModified: true } | { notModified: false; data: T; tag: string | null };
async function getOrders<T>(url: string, tag?: string | null): Promise<Got<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      cache: "no-store",
      headers: tag ? { "If-None-Match": tag } : {},
    });
  } catch {
    throw new OrdersError("Connection lost. AWB records could not be refreshed.", 0);
  }
  if (res.status === 304) return { notModified: true };
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new OrdersError(data.error ?? "Unable to load AWB records.", res.status, data.code);
  return { notModified: false, data: data as T, tag: res.headers.get("ETag") };
}
const query = (path: string, params: Record<string, string | undefined | null>) =>
  path +
  "?" +
  new URLSearchParams(
    Object.entries(params).filter((e): e is [string, string] => !!e[1]),
  ).toString();

export const REFRESH_MS = 60000;
type Options = {
  workspaceId?: string;
  /** Days this read covers (for save notifications); null: refresh on any change. */
  days: string[] | null;
  /** The document revision, for reads that also use the document. */
  revision?: unknown;
  /** Skip the timed refresh (a form is open or a save is in flight). */
  paused?: boolean;
};
type Loaded<T> = { url: string; data: T | null; error: string; code?: string; at: number };
export type Resource<T> = {
  data: T | null;
  loading: boolean;
  refreshing: boolean;
  error: string;
  code?: string;
  /** When the data was last confirmed current (ms). */
  updatedAt?: number;
  refresh: () => void;
};
/** One GET endpoint with ETag refresh; idle while `url` is null. */
function useResource<T>(url: string | null, opts: Options): Resource<T> {
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const tags = useRef(new Map<string, string>());
  const run = useCallback(async (target: string, conditional: boolean) => {
    const tag = conditional ? (tags.current.get(target) ?? null) : null;
    if (conditional) setRefreshing(true);
    try {
      const got = await getOrders<T>(target, tag);
      if (got.notModified) {
        setLoaded((prev) =>
          prev && prev.url === target ? { ...prev, error: "", code: undefined, at: Date.now() } : prev,
        );
        return;
      }
      if (got.tag) tags.current.set(target, got.tag);
      else tags.current.delete(target);
      setLoaded({ url: target, data: got.data, error: "", at: Date.now() });
    } catch (e) {
      const error = e instanceof Error ? e.message : "Unable to load AWB records.";
      setLoaded((prev) => ({
        url: target,
        // Keep what the view showed; say that it may be out of date.
        data: prev?.url === target ? prev.data : null,
        error,
        code: e instanceof OrdersError ? e.code : undefined,
        at: prev?.url === target ? prev.at : 0,
      }));
    } finally {
      if (conditional) setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    if (!url) return;
    void Promise.resolve().then(() => run(url, false));
  }, [url, run]);
  const refresh = useCallback(() => {
    if (url) void run(url, true);
  }, [url, run]);
  useRefresh(url ? refresh : null, opts);
  const current = url && loaded?.url === url ? loaded : null;
  return {
    data: current?.data ?? null,
    loading: !!url && !current,
    refreshing,
    error: current?.error ?? "",
    code: current?.code,
    updatedAt: current?.at || undefined,
    refresh,
  };
}
/** The refresh triggers of an open view (see the module comment). */
function useRefresh(refresh: (() => void) | null, opts: Options) {
  const { workspaceId, paused } = opts;
  const days = opts.days ? opts.days.join(",") : null;
  useEffect(() => {
    if (!refresh) return;
    const tick = () => {
      if (!paused && document.visibilityState === "visible") refresh();
    };
    const onChange = (change: OrdersChange) => {
      if (change.workspaceId && workspaceId && change.workspaceId !== workspaceId) return;
      if (change.days && days && !change.days.some((d) => days.split(",").includes(d))) return;
      refresh();
    };
    const timer = setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    listeners.add(onChange);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      listeners.delete(onChange);
    };
  }, [refresh, workspaceId, days, paused]);
  const seen = useRef(opts.revision);
  useEffect(() => {
    if (seen.current === opts.revision) return;
    seen.current = opts.revision;
    refresh?.();
  }, [opts.revision, refresh]);
}

// --- The hooks ----------------------------------------------------------------------------

export type ListFilters = {
  product?: string;
  package?: string;
  q?: string;
  status?: string;
  group?: string;
  limit?: number;
};
export type OrdersPage = {
  orders: ListedOrder[];
  next: string | null;
  total: number;
  marker: string;
};
/**
 * A day's AWBs, 200 per page with "load more" (GET /api/orders). Filters change the
 * query, not an in-memory filter. Pages loaded with "load more" are read again when the
 * day changes, so the list keeps its length on a refresh.
 */
export function useDayOrders(p: {
  workspaceId?: string;
  date: string;
  filters?: ListFilters;
  enabled: boolean;
  paused?: boolean;
}) {
  const f = p.filters ?? {};
  const base =
    p.enabled && p.workspaceId
      ? query("/api/orders", {
          workspace: p.workspaceId,
          date: p.date,
          product: f.product,
          package: f.package,
          q: f.q?.trim(),
          status: f.status,
          group: f.group,
          limit: f.limit ? String(f.limit) : undefined,
        })
      : null;
  const first = useResource<OrdersPage>(base, {
    workspaceId: p.workspaceId,
    days: [p.date],
    paused: p.paused,
  });
  const [more, setMore] = useState<{ base: string | null; marker?: string; pages: OrdersPage[] }>({
    base: null,
    pages: [],
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState("");
  const extra = more.base === base ? more.pages : [];
  const pages = first.data ? [first.data, ...extra] : [];
  const next = pages.length ? pages[pages.length - 1].next : null;
  const seen = new Set<string>();
  const orders = pages
    .flatMap((page) => page.orders)
    .filter((o) => !seen.has(o.id) && !!seen.add(o.id));
  // The day changed after more pages were loaded: read the same number of pages again.
  const firstPage = first.data;
  useEffect(() => {
    if (!base || !firstPage || more.base !== base || !more.pages.length) return;
    if (more.marker === firstPage.marker) return;
    let live = true;
    void (async () => {
      const fresh: OrdersPage[] = [];
      let after = firstPage.next;
      for (let i = 0; i < more.pages.length && after; i++) {
        const got = await getOrders<OrdersPage>(base + "&after=" + encodeURIComponent(after));
        if (got.notModified) return;
        fresh.push(got.data);
        after = got.data.next;
      }
      if (live) setMore({ base, marker: firstPage.marker, pages: fresh });
    })().catch(() => {
      /* Keep the pages shown; the next refresh tries again. */
    });
    return () => {
      live = false;
    };
  }, [base, firstPage, more]);
  const loadMore = useCallback(async () => {
    if (!base || !next || !firstPage) return;
    setLoadingMore(true);
    setMoreError("");
    try {
      const got = await getOrders<OrdersPage>(base + "&after=" + encodeURIComponent(next));
      if (!got.notModified)
        setMore((prev) => ({
          base,
          marker: firstPage.marker,
          pages: [...(prev.base === base ? prev.pages : []), got.data],
        }));
    } catch (e) {
      setMoreError(e instanceof Error ? e.message : "Unable to load more AWBs.");
    } finally {
      setLoadingMore(false);
    }
  }, [base, next, firstPage]);
  return {
    ...first,
    orders,
    total: first.data?.total ?? 0,
    next,
    loadMore,
    loadingMore,
    error: first.error || moreError,
  };
}

/** The day's counts from operator_orders_summary, as the day endpoint carries them. */
export type DayCounts = {
  scope: "day" | "all";
  date: string;
  awbs: number;
  review: number;
  unassigned: number;
  unpacked: number;
  handover: number;
  dispatched: number;
  mismatch: number;
  openEarlier: number;
  marker: string | null;
};
export type DayAggregates = DaySummary & { counts: DayCounts; marker: string };
/** A day's aggregates: package groups, tallies, inventory, counts (GET /api/orders/day). */
export function useDaySummary(p: {
  workspaceId?: string;
  date: string;
  enabled: boolean;
  revision?: unknown;
  paused?: boolean;
}) {
  return useResource<DayAggregates>(
    p.enabled && p.workspaceId
      ? query("/api/orders/day", { workspace: p.workspaceId, date: p.date })
      : null,
    { workspaceId: p.workspaceId, days: [p.date], revision: p.revision, paused: p.paused },
  );
}
/** Overview figures for a day, or across every hot AWB (GET /api/orders/summary). */
export function useOrderSummary(p: {
  workspaceId?: string;
  date: string;
  all: boolean;
  enabled: boolean;
  paused?: boolean;
}) {
  return useResource<DayCounts>(
    p.enabled && p.workspaceId
      ? query("/api/orders/summary", {
          workspace: p.workspaceId,
          date: p.date,
          scope: p.all ? "all" : undefined,
        })
      : null,
    { workspaceId: p.workspaceId, days: p.all ? null : [p.date], paused: p.paused },
  );
}
export type PackerPage = { profileId: string; orders: Order[]; marker: string };
/**
 * A packer's AWBs of a day (GET /api/orders/packer). Without `profile`: the packer
 * unlocked on this phone (the server copies the packer cookie into x-operator-packer);
 * with it: that packer's AWBs as a supervisor reads them.
 */
export function usePackerOrders(p: {
  workspaceId?: string;
  date: string;
  profile?: string;
  enabled: boolean;
  paused?: boolean;
}) {
  return useResource<PackerPage>(
    p.enabled && p.workspaceId
      ? query("/api/orders/packer", { workspace: p.workspaceId, date: p.date, profile: p.profile })
      : null,
    { workspaceId: p.workspaceId, days: [p.date], paused: p.paused },
  );
}
/** Unpacked AWBs per packer profile for the unlock screen (GET /api/orders/packer-counts). */
export function usePackerCounts(p: { workspaceId?: string; date: string; enabled: boolean }) {
  const r = useResource<{ counts: { profileId: string; open: number }[] }>(
    p.enabled && p.workspaceId
      ? query("/api/orders/packer-counts", { workspace: p.workspaceId, date: p.date })
      : null,
    { workspaceId: p.workspaceId, days: [p.date] },
  );
  return r.data
    ? Object.fromEntries(r.data.counts.map((c) => [c.profileId, Number(c.open)]))
    : null;
}
export type TraceRequest = { q: string } | { order: string } | { batch: string };
export type TraceResult = {
  cartons: { id: string; ref: string; product: string; unit: string; qty: number; rack: string; issued: number }[];
  parcels: boolean;
  orders: ListedOrder[];
  issues: (Issue & { product: string; unit: string })[];
  events: unknown[];
  next: { date: string; awb: string } | null;
};
/** Trace by AWB (every occurrence, newest first), order reference, AWB id or batch. */
export function useTrace(workspaceId: string | undefined, request: TraceRequest | null) {
  const params = request
    ? "q" in request
      ? { q: request.q.trim() }
      : "order" in request
        ? { order: request.order }
        : { batch: request.batch }
    : null;
  const ready = !!params && !!Object.values(params)[0];
  return useResource<TraceResult>(
    workspaceId && ready ? query("/api/orders/trace", { workspace: workspaceId, ...params }) : null,
    { workspaceId, days: null },
  );
}
/** The recorded AWBs a PDF review needs, and the upload's released AWBs and their issues. */
export function useUploadOrders(p: { workspaceId?: string; uploadId?: string; enabled: boolean }) {
  return useResource<{ orders: Order[]; issues: Issue[] }>(
    p.enabled && p.workspaceId && p.uploadId
      ? query("/api/orders/upload", { workspace: p.workspaceId, id: p.uploadId })
      : null,
    { workspaceId: p.workspaceId, days: null },
  );
}
/** Pending AWB ids of a day's package groups for one product ("Issue stock"). */
export async function openOrderIds(
  workspaceId: string,
  date: string,
  productId: string,
  pkg?: string,
) {
  const got = await getOrders<{ ids: string[] }>(
    query("/api/orders/open", { workspace: workspaceId, date, product: productId, package: pkg }),
  );
  return got.notModified ? [] : got.data.ids;
}
/**
 * Downloads the parcel CSV of a day range (GET /api/orders/export, at most 31 days).
 * Returns the server's message when it refuses (for example, a longer range).
 */
export async function downloadExport(workspaceId: string, from: string, to: string) {
  let res: Response;
  try {
    res = await fetch(query("/api/orders/export", { workspace: workspaceId, from, to }), {
      cache: "no-store",
    });
  } catch {
    return "Connection lost. Try the export again.";
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return (data.error as string) ?? "Unable to export.";
  }
  const name =
    /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ??
    `operator-awbs-${from}.csv`;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return null;
}
