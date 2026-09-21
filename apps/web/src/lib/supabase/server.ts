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
