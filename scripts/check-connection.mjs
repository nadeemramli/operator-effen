import "./check-env.mjs";
import { readFileSync } from "node:fs";

if (process.exitCode) process.exit(1);

try {
  const reference = readFileSync(
    new URL("../supabase/.temp/project-ref", import.meta.url),
    "utf8",
  ).trim();
  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL.trim());
  if (!/^[a-z]{20}$/.test(reference) || url.hostname !== reference + ".supabase.co") {
    throw new Error("The app URL does not match the linked Supabase project.");
  }

  const response = await fetch(new URL("/auth/v1/health", url), {
    headers: {
      apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.trim(),
    },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error("Supabase Auth health check returned HTTP " + response.status + ".");
  }
  const health = await response.json();
  if (health.name !== "GoTrue" && health.name !== "Auth") {
    throw new Error("Supabase Auth health check returned an unexpected response.");
  }
  console.log("Linked Supabase Auth health check passed (HTTP 200).");
  console.log("This checks service reachability, not login flows or database permissions.");
} catch (error) {
  const reason = error?.code === "ENOENT"
    ? "Link this checkout with pnpm exec supabase link before checking the connection."
    : error instanceof Error ? error.message : "Connection check failed.";
  console.error(reason);
  process.exitCode = 1;
}
