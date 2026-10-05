import { Suspense } from "react";
import { redirect } from "next/navigation";
import { resolveAccess } from "@/lib/supabase/server";
import { DraftApp } from "@/components/draft-app";
export default async function Home() {
  const { user } = await resolveAccess();
  if (!user) redirect("/login");
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
