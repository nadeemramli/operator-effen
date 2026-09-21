import { redirect } from "next/navigation";
import { tester } from "@/lib/supabase/server";
import { LoginForm } from "@/components/login-form";
export default async function Login() {
  const { user } = await tester();
  if (user) redirect("/");
  return <LoginForm />;
}
