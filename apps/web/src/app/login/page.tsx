import { redirect } from "next/navigation";
import { returnPath } from "@/lib/landing";
import { resolveAccess } from "@/lib/supabase/server";
import { LoginForm } from "@/components/login-form";
export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ expired?: string; next?: string }>;
}) {
  const { user } = await resolveAccess();
  const { expired, next } = await searchParams;
  if (user) redirect(returnPath(next));
  return <LoginForm expired={expired === "1"} next={returnPath(next)} />;
}
