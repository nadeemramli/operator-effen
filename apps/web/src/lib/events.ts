import type { Event, Recorder } from "./draft.ts";

/**
 * Audit entries of operational sites live in public.operator_events since
 * 20261013090000_operator_events.sql (order volume plan, work package B). Commands still log
 * into `Draft.events`; the commit RPC stores the new entries in the table and the document
 * keeps no `events` key. These helpers serve GET /api/events and mirror the shape checks of
 * operator_private.append_events. The preview sandbox keeps its entries in its document.
 */

/** One audit entry as /api/events returns it: the stored Event plus its table order. */
export type LoggedEvent = Event & { seq: number };

/** At most this many entries per page, and per command (append_events). */
export const EVENTS_PAGE = 200;
export const EVENTS_PER_COMMAND = 2000;
/** Entities one trace lookup may ask for at once (an AWB and the batches it drew from). */
export const EVENT_ENTITIES = 20;
export const SANDBOX_EVENTS =
  "The preview sandbox keeps its activity in its own workspace. The activity log endpoint serves operational sites only.";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Malaysia-time (UTC+8, no daylight saving) day `date` as a half-open UTC range:
 * entries with from <= at < to. Null for anything but a real YYYY-MM-DD date.
 */
export function mytDayRange(date: string): { from: string; to: string } | null {
  if (!DATE.test(date)) return null;
  const start = new Date(date + "T00:00:00+08:00");
  if (!Number.isFinite(start.getTime())) return null;
  // Reject dates the Date parser rolls over (2026-02-30 becomes 2026-03-02).
  if (new Date(start.getTime() + 8 * 3600000).toISOString().slice(0, 10) !== date)
    return null;
  return {
    from: start.toISOString(),
    to: new Date(start.getTime() + 86400000).toISOString(),
  };
}

export type EventsQuery = (
  | { kind: "entity"; entities: string[] }
  | { kind: "date"; date: string; from: string; to: string }
  | { kind: "recent" }
) & { before?: number; limit: number };

/**
 * Parses /api/events search parameters (the workspace is resolved by the route):
 *   entity=<id> (repeatable, up to 20)  entries of those records
 *   date=YYYY-MM-DD                      entries whose time falls on that Malaysia day
 *   recent=1                             the latest entries of the site
 * plus before=<seq> (older pages) and limit=1..200 (default 200), newest first.
 */
export function parseEventsQuery(params: URLSearchParams): EventsQuery | { error: string } {
  const entities = params.getAll("entity").map((e) => e.trim());
  const date = params.get("date");
  const recent = params.get("recent") === "1";
  if ([entities.length > 0, date !== null, recent].filter(Boolean).length !== 1)
    return { error: "Ask for one of entity, date or recent." };
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? EVENTS_PAGE : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > EVENTS_PAGE)
    return { error: `Use a limit from 1 to ${EVENTS_PAGE}.` };
  const rawBefore = params.get("before");
  const before = rawBefore === null ? undefined : Number(rawBefore);
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
    return { error: "Invalid page." };
  const page = { limit, ...(before !== undefined ? { before } : {}) };
  if (entities.length) {
    if (entities.length > EVENT_ENTITIES || entities.some((e) => !e || e.length > 200))
      return { error: `Ask for 1 to ${EVENT_ENTITIES} record references.` };
    return { kind: "entity", entities: [...new Set(entities)], ...page };
  }
  if (date !== null) {
    const range = mytDayRange(date);
    if (!range) return { error: "Use a date in the form YYYY-MM-DD." };
    return { kind: "date", date, ...range, ...page };
  }
  return { kind: "recent", ...page };
}

/** The columns /api/events selects. */
export const EVENT_COLUMNS =
  "id,seq,entity,action,detail,actor,at,occurred_at,performer,recorder";
export type EventRow = {
  id: string;
  seq: number | string;
  entity: string;
  action: string;
  detail: string;
  actor: string;
  at: string;
  occurred_at: string | null;
  performer: string | null;
  recorder: Recorder | Record<string, never> | null;
};
const iso = (value: string) => new Date(value).toISOString();
/** A table row in the app's Event shape (camelCase, JavaScript ISO times). */
export function eventFromRow(row: EventRow): LoggedEvent {
  const recorder =
    row.recorder && Object.keys(row.recorder).length ? (row.recorder as Recorder) : undefined;
  return {
    id: row.id,
    seq: Number(row.seq),
    entity: row.entity,
    action: row.action,
    detail: row.detail,
    actor: row.actor,
    at: iso(row.at),
    ...(recorder ? { recorder } : {}),
    ...(row.performer !== null ? { performer: row.performer } : {}),
    ...(row.occurred_at !== null ? { occurredAt: iso(row.occurred_at) } : {}),
  };
}

const validTime = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
/**
 * Why operator_private.append_events would refuse these new entries for `userId`, or null.
 * The API checks before signing so a domain bug answers 400 instead of a database refusal.
 */
export function eventProblem(events: readonly Event[], userId: string): string | null {
  if (events.length > EVENTS_PER_COMMAND)
    return `One change can add at most ${EVENTS_PER_COMMAND} audit entries.`;
  if (new Set(events.map((e) => e.id.toLowerCase())).size !== events.length)
    return "Duplicate audit entry identifiers.";
  for (const e of events) {
    if (
      !UUID.test(e.id) ||
      typeof e.entity !== "string" ||
      e.entity.length > 200 ||
      typeof e.action !== "string" ||
      e.action.length > 200 ||
      typeof e.detail !== "string" ||
      e.detail.length > 100000 ||
      typeof e.actor !== "string" ||
      e.actor.length > 500 ||
      !validTime(e.at) ||
      (e.occurredAt !== undefined && e.occurredAt !== null && !validTime(e.occurredAt)) ||
      (e.performer !== undefined &&
        e.performer !== null &&
        (typeof e.performer !== "string" || e.performer.length > 200)) ||
      !e.recorder ||
      typeof e.recorder !== "object"
    )
      return "Invalid audit entry.";
    if (e.recorder.userId !== userId)
      return "New audit entries must be attributed to the signed-in user.";
  }
  return null;
}
