import { Suspense } from "react";
import { redirect } from "next/navigation";
import { resolveAccess } from "@/lib/supabase/server";
import { DraftApp } from "@/components/draft-app";
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await resolveAccess();
  if (!user) {
    // Come back to this screen after signing in rather than to the role's home.
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(await searchParams))
      for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value])
        q.append(key, v);
    const here = q.toString();
    redirect("/login" + (here ? "?next=" + encodeURIComponent("/?" + here) : ""));
  }
  return (
    <Suspense
      fallback={
        <main className="p-10 text-muted-foreground">Loading workspace…</main>
      }
    >
      <DraftApp />
    </Suspense>
  );
}
