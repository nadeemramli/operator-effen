import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { effectiveCapabilities, type Capability } from "@/lib/capabilities";

export async function supabaseServer() {
  const jar = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => jar.getAll(),
        setAll(values) {
          try {
            values.forEach(({ name, value, options }) =>
              jar.set(name, value, options),
            );
          } catch {
            /* Server Components rely on proxy.ts to refresh cookies. */
          }
        },
      },
    },
  );
}

type Db = Awaited<ReturnType<typeof supabaseServer>>;
type WorkspaceRow = {
  id: string;
  site_id: string;
  name: string;
  write_policy: unknown;
};
type MembershipRow = {
  workspace_id: string | null;
  role: string;
  scope: "site" | "all-sites";
  staff_profile_id: string | null;
  display_name: string;
};
/** One site the signed-in member can open, with the capabilities they hold there. */
export type Membership = {
  workspaceId: string;
  siteId: string;
  workspaceName: string;
  role: string;
  scope: "site" | "all-sites";
  staffProfileId?: string;
  displayName: string;
  capabilities: Capability[];
};
// The membership tables may not exist yet on a backend that has not had the
// reviewed migrations applied; that backend only serves the fictional preview.
const missingRelation = (code?: string) =>
  code === "42P01" || code === "PGRST205" || code === "PGRST200" || code === "42703";

/**
 * Resolves who is signed in and which sites they may open, entirely on the server.
 * Active memberships are authoritative: a site membership wins over an all-sites one
 * (office admin, HR, management). The legacy shared test account (`ui_draft_access`)
 * without a membership gets only the fictional preview sandbox.
 */
export async function resolveAccess(existing?: Db): Promise<
  | { status: 401 | 403 | 503; db: Db; user: null; error: string }
  | {
      status: 200;
      db: Db;
      user: NonNullable<Awaited<ReturnType<Db["auth"]["getUser"]>>["data"]["user"]>;
      memberships: Membership[];
      preview: boolean;
    }
> {
  const db = existing ?? (await supabaseServer());
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user)
    return { status: 401, db, user: null, error: "Please sign in again." };
  const result = await db
    .from("operator_memberships")
    .select("workspace_id,role,scope,staff_profile_id,display_name")
    .eq("user_id", user.id)
    .eq("active", true)
    .is("revoked_at", null);
  if (result.error && !missingRelation(result.error.code))
    return {
      status: 503,
      db,
      user: null,
      error: "Unable to check your workspace access.",
    };
  const rows = (result.data ?? []) as MembershipRow[];
  let memberships: Membership[] = [];
  if (rows.length) {
    // RLS returns only the workspaces this user may open.
    const sites = await db
      .from("operator_workspaces")
      .select("id,site_id,name,write_policy")
      .order("name");
    if (sites.error)
      return {
        status: 503,
        db,
        user: null,
        error: "Unable to check your workspace access.",
      };
    const global = rows.find((r) => r.scope === "all-sites");
    memberships = ((sites.data ?? []) as WorkspaceRow[]).flatMap((w) => {
      const row =
        rows.find((r) => r.workspace_id === w.id) ?? global ?? undefined;
      return row
        ? [
            {
              workspaceId: w.id,
              siteId: w.site_id,
              workspaceName: w.name,
              role: row.role,
              scope: row.scope,
              staffProfileId: row.staff_profile_id ?? undefined,
              displayName: row.display_name,
              capabilities: effectiveCapabilities(row.role, w.write_policy),
            },
          ]
        : [];
    });
  }
  const preview =
    !rows.length && user.app_metadata?.ui_draft_access === true;
  if (!memberships.length && !preview)
    return {
      status: 403,
      db,
      user: null,
      error: "This account has no active Operator workspace access.",
    };
  return { status: 200, db, user, memberships, preview };
}
