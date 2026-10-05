import { redirect } from "next/navigation";
import { resolveAccess } from "@/lib/supabase/server";
import { LoginForm } from "@/components/login-form";
export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ expired?: string }>;
}) {
  const { user } = await resolveAccess();
  if (user) redirect("/");
  const { expired } = await searchParams;
  return <LoginForm expired={expired === "1"} />;
}
