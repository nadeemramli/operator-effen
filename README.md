# Operator EFFEN

Environment foundation for the EFFEN operations application. The current page is a placeholder; operational workflows and authentication are not implemented yet.

## Stack

- Node.js 24 (see `.nvmrc`), pnpm 11.16.0
- Next.js 16.2.11, React 19.2.4, TypeScript
- Tailwind CSS 4, shadcn-compatible theme, Geist typography
- Supabase for the planned operational database and authentication
- Vercel for hosting

The workspace layout (`apps/web`), framework versions and theme align with Fullkit. The theme was copied from Fullkit commit `c56d0b4b311a8bff13582238f5ce566b6e272c57`; Geist uses its bundled font package so builds do not need Google Fonts access.

## Local setup

```sh
nvm install
nvm use
corepack enable
corepack prepare pnpm@11.16.0 --activate
pnpm install --frozen-lockfile
cp apps/web/.env.example apps/web/.env.local
```

Populate the selected Operator project's public Supabase URL and publishable key, then run `pnpm check:env`. Link the Vercel project and verify environment configuration before starting connected development.

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm dev
```

The placeholder can build without a database connection. A successful build does not imply database or authentication readiness.

## Hosting

Configure Vercel with root directory `apps/web`, framework Next.js, Node.js 24.x, and pnpm. Store environment values in the appropriate Vercel environments. Never put service-role or secret keys in variables beginning with `NEXT_PUBLIC_`.

No database migrations, catalog imports, production records or user accounts are included. Domain configuration, authentication/access rules and the reporting connection to Fullkit are separate setup steps.

## Repository boundary

Keep credentials, AWB/customer documents, staff rosters and private business documentation outside this repository. The requirements remain in the private Operator knowledge folder.
