import type { Role } from "./draft.ts";

/**
 * Where a signed-in person lands. The screen is taken from `?view=` when the role may
 * open it; otherwise the role's home screen. The sidebar lists screens in `views` order,
 * which is not the same thing as a role's home: Management's first sidebar entry is
 * Driver trips, but Management opens on Overview.
 */
export type View =
  | "overview"
  | "production"
  | "warehouse"
  | "input"
  | "tally"
  | "orders"
  | "packing"
  | "trips"
  | "trace"
  | "reports"
  | "feedback";

/** Sidebar order and the roles that may open each screen. */
export const views: { id: View; roles: Role[] }[] = [
  { id: "production", roles: ["production"] },
  // Office admin reads Stock-in, Packing and Daily tally (view only: no stock capabilities).
  { id: "warehouse", roles: ["intake", "admin"] },
  { id: "input", roles: ["admin", "outbound"] },
  { id: "orders", roles: ["admin", "outbound"] },
  { id: "packing", roles: ["packer", "outbound", "admin"] },
  { id: "trips", roles: ["driver", "outbound", "management"] },
  { id: "tally", roles: ["outbound", "management", "admin"] },
  {
    id: "overview",
    roles: ["production", "intake", "outbound", "admin", "hr", "management"],
  },
  {
    id: "trace",
    roles: ["production", "intake", "outbound", "management", "driver"],
  },
  { id: "reports", roles: ["management", "hr"] },
  {
    id: "feedback",
    roles: [
      "production",
      "intake",
      "outbound",
      "admin",
      "hr",
      "packer",
      "driver",
      "management",
    ],
  },
];

/** Older links used `view=outbound` for what is now Order management. */
const aliases: Record<string, View> = { outbound: "orders" };

/** Roles whose home is not their first sidebar entry. */
const homes: Partial<Record<Role, View>> = {
  management: "overview",
  admin: "input",
};

export const allowedViews = (role: Role): View[] =>
  views.filter((v) => v.roles.includes(role)).map((v) => v.id);

/** The screen a role opens on without a `?view=` in the address. */
export const homeView = (role: Role): View =>
  homes[role] ?? allowedViews(role)[0] ?? "feedback";

/**
 * Resolves the requested screen for a role. A missing, unknown, aliased-away or
 * not-permitted request falls back to the role's home, never to an arbitrary screen.
 */
export function resolveView(role: Role, requested: string | null): View {
  const wanted = requested === null ? null : (aliases[requested] ?? requested);
  const allowed = allowedViews(role);
  return allowed.find((v) => v === wanted) ?? homeView(role);
}

/**
 * The in-app address to return to after sign-in. Only a path on this site is accepted
 * (it must start with a single "/"); anything else, including the sign-in page itself,
 * goes to the workspace root so a crafted link cannot send a person elsewhere.
 */
export function returnPath(next: unknown): string {
  if (
    typeof next !== "string" ||
    !next.startsWith("/") ||
    next.startsWith("//") ||
    next.startsWith("/\\") ||
    next.startsWith("/login") ||
    next.startsWith("/api") ||
    /[\s\0]/.test(next) ||
    next.length > 2048
  )
    return "/";
  return next;
}
