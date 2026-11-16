import type { supabaseServer } from "@/lib/supabase/server";

type Db = Awaited<ReturnType<typeof supabaseServer>>;

/**
 * Counts one screen view or refused save in the usage log (operator_log_usage). Usage
 * tracking never gets in the way of work: every failure is swallowed, including a backend
 * that has not had 20261116090000_operator_usage.sql applied.
 */
export async function logUsage(
  db: Db,
  workspaceId: string,
  kind: "view" | "failed",
  detail: string,
  profileId?: string,
): Promise<boolean> {
  try {
    const { error } = await db.rpc("operator_log_usage", {
      p_workspace: workspaceId,
      p_kind: kind,
      p_detail: detail,
      p_profile: profileId ?? null,
    });
    return !error;
  } catch {
    return false;
  }
}
