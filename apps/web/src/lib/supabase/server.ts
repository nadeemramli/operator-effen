import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

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
export async function tester() {
  const db = await supabaseServer();
  const {
    data: { user },
  } = await db.auth.getUser();
  return {
    db,
    user: user?.app_metadata?.ui_draft_access === true ? user : null,
  };
}

type Db = Awaited<ReturnType<typeof supabaseServer>>;
type MembershipRow = {
  workspace_id: string;
  role: string;
  staff_profile_id: string | null;
  display_name: string;
  operator_workspaces: {
    site_id: string;
    name: string;
    write_policy: unknown;
  } | null;
};
export type Membership = {
  workspaceId: string;
  siteId: string;
  workspaceName: string;
  role: string;
  staffProfileId?: string;
  displayName: string;
  writePolicy: unknown;
};
// The membership tables may not exist yet on a backend that has not had the
// reviewed migration applied; that backend only serves the fictional preview.
const missingRelation = (code?: string) =>
  code === "42P01" || code === "PGRST205" || code === "PGRST200";

/**
 * Resolves who is signed in and what they may do, entirely on the server.
 * Active workspace memberships are authoritative. The legacy shared test account
 * (`ui_draft_access`) without a membership gets only the fictional preview sandbox.
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
    .select(
      "workspace_id,role,staff_profile_id,display_name,operator_workspaces(site_id,name,write_policy)",
    )
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
  const memberships = ((result.data ?? []) as unknown as MembershipRow[])
    .filter((m) => m.operator_workspaces)
    .map((m) => ({
      workspaceId: m.workspace_id,
      siteId: m.operator_workspaces!.site_id,
      workspaceName: m.operator_workspaces!.name,
      role: m.role,
      staffProfileId: m.staff_profile_id ?? undefined,
      displayName: m.display_name,
      writePolicy: m.operator_workspaces!.write_policy,
    }));
  const preview =
    !memberships.length && user.app_metadata?.ui_draft_access === true;
  if (!memberships.length && !preview)
    return {
      status: 403,
      db,
      user: null,
      error: "This account has no active Operator workspace access.",
    };
  return { status: 200, db, user, memberships, preview };
}
