import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("../apps/web/.env.local", import.meta.url));
if (existsSync(file)) process.loadEnvFile(file);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
const errors = [];
try {
  const parsed = new URL(url ?? "");
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".supabase.co")) {
    errors.push("NEXT_PUBLIC_SUPABASE_URL must be the selected hosted Supabase project URL.");
  }
} catch {
  errors.push("NEXT_PUBLIC_SUPABASE_URL is missing or invalid.");
}
if (!key?.startsWith("sb_publishable_")) {
  errors.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must contain a publishable key.");
}
if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log("Required Supabase environment variables are configured. Values are hidden.");
}
