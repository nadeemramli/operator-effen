import { NextResponse } from "next/server";
import type { Membership, resolveAccess } from "@/lib/supabase/server";
import type { AwbImport } from "@/lib/awb-import";

/**
 * Server helpers shared by /api/imports and /api/draft for PDF uploads, which live in
 * operator_imports / operator_import_rows (20261012090000_operator_imports.sql). Every call
 * uses the signed-in member's own client: the database checks their capability at the site.
 */
type Db = Awaited<ReturnType<typeof resolveAccess>>["db"];

export const json = (body: unknown, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
export const pick = (memberships: Membership[], requested?: unknown) =>
  typeof requested === "string" && requested
    ? memberships.find((m) => m.workspaceId === requested)
    : memberships[0];
export const can = (m: Membership, ...caps: string[]) =>
  caps.some((c) => m.capabilities.includes(c as never));
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The fictional preview sandbox has no upload tables. */
export const SANDBOX_UPLOADS =
  "PDF uploads are tested on the synthetic operational site. The preview sandbox does not cover them.";

/** Maps the upload functions' error codes (see the migration header) to responses. */
export function rpcFailure(error: { code?: string; message: string }) {
  switch (error.code) {
    case "42501":
      return json({ error: error.message }, 403);
    case "28000":
      return json({ error: "Please sign in again." }, 401);
    case "23514":
      return json({ error: error.message, code: "invariant" }, 409);
    case "40001":
      return json({ error: error.message, code: "record" }, 409);
    case "P0002":
      return json({ error: error.message }, 404);
    case "22023":
      return json({ error: error.message }, 400);
    case "55000":
      return json({ error: error.message }, 503);
    default:
      return json({ error: "Unable to save. Your change has not been recorded." }, 503);
  }
}

/** Throws when the source PDF is not stored at <folder>/<id>.pdf in the bucket. */
export async function requireStored(
  db: Db,
  bucket: string,
  folder: string,
  id: string,
) {
  const listed = await db.storage
    .from(bucket)
    .list(folder, { search: id + ".pdf", limit: 1 });
  if (listed.error || !listed.data.some((f) => f.name === id + ".pdf"))
    throw new Error("Source PDF was not saved. Upload it again before confirming.");
}

export class ImportLoadError extends Error {
  constructor(public readonly failure: { code?: string; message: string }) {
    super(failure.message);
  }
}
/** One upload of the site with its rows, or null when it does not exist or was deleted. */
export async function loadImport(
  db: Db,
  workspaceId: string,
  id: string,
): Promise<AwbImport | null> {
  if (!UUID.test(id)) return null;
  const { data, error } = await db.rpc("operator_import_get", {
    p_workspace: workspaceId,
    p_import: id,
  });
  if (error) throw new ImportLoadError(error);
  return (data as AwbImport | null) ?? null;
}
