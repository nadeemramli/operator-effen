"use client";

import { useEffect, useState } from "react";
import type { Event } from "@/lib/draft";

/** Which audit entries to show: those of some records, or the site's latest. */
export type ActivityRequest = { entities: string[] } | { recent: number };
type Loaded = { query: string; events: Event[]; failed: boolean };

/**
 * Audit entries of an operational site, read from /api/events (operator_events since
 * 20261013090000). Idle (no request) while `request` is null, so a closed activity view
 * costs nothing; it reloads when the request or `refreshKey` changes (the workspace
 * revision: every save, and every background refresh that found a change). The preview
 * sandbox keeps its entries in its document and does not use this hook.
 */
export function useSiteActivity(
  workspaceId: string | undefined,
  request: ActivityRequest | null,
  refreshKey: unknown,
) {
  const query =
    workspaceId && request && ("recent" in request || request.entities.length)
      ? new URLSearchParams([
          ["workspace", workspaceId],
          ...("recent" in request
            ? [
                ["recent", "1"],
                ["limit", String(request.recent)],
              ]
            : request.entities.map((e) => ["entity", e])),
        ]).toString()
      : null;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    if (!query) return;
    let live = true;
    fetch("/api/events?" + query, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: { events?: Event[] }) => {
        if (live) setLoaded({ query, events: data.events ?? [], failed: false });
      })
      .catch(() => {
        // Keep what this view already showed; say that it may be out of date.
        if (live)
          setLoaded((prev) => ({
            query,
            events: prev?.query === query ? prev.events : [],
            failed: true,
          }));
      });
    return () => {
      live = false;
    };
  }, [query, refreshKey]);
  const current = query && loaded?.query === query ? loaded : null;
  return {
    events: current?.events ?? [],
    loading: !!query && !current,
    failed: !!current?.failed,
  };
}
