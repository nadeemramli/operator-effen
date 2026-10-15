import type { AwbImport } from "@/lib/awb-import";
import type { Draft, Event } from "@/lib/draft";
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
): Record<string, unknown> {
  const { awbImports, ...doc } = state;
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
): Promise<Draft> {
  if (legacyDocument(doc)) return doc;
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
    return doc;
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
