# Operator EFFEN

Environment foundation for the EFFEN operations application. The current page is a placeholder; operational workflows and authentication are not implemented yet.

## Stack

- Node.js 24 (see `.nvmrc`), pnpm 11.16.0
- Next.js 16.3.5, React 19.2.4, TypeScript
- Tailwind CSS 4, shadcn-compatible theme, Geist typography
- Supabase for the operational database and planned authentication; CLI pinned to 2.117.0
- Vercel for hosting

The workspace layout (`apps/web`), framework family and theme align with Fullkit. Next.js and its ESLint config use 16.3.5 to address dependency advisories affecting the original 16.2.11 baseline. The theme was copied from Fullkit commit `c56d0b4b311a8bff13582238f5ce566b6e272c57`; Geist uses its bundled font package so builds do not need Google Fonts access.

## Local setup

```sh
nvm install
nvm use
corepack enable
corepack prepare pnpm@11.16.0 --activate
pnpm install --frozen-lockfile
```

Link the checkout to the agreed Operator Supabase project and Vercel project. Get the Supabase project reference from the private environment setup record or its dashboard. Authenticate the CLIs with your own access if needed.

```sh
pnpm exec supabase link --project-ref <operator-project-ref>
pnpm dlx vercel@59.23.2 link --yes --project operator-effen --scope nadeemramlis-projects
pnpm dlx vercel@59.23.2 env pull apps/web/.env.local --environment=development --yes --scope nadeemramlis-projects
pnpm check:env
pnpm check:connection
```

Environment values are ignored by Git. `check:connection` verifies that the app URL matches the locally linked Supabase project and checks the Auth health endpoint. It does not verify login flows, RLS or application tables.

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm dev
```

The placeholder can build without a database connection. A successful build alone does not imply database or authentication readiness.

## Environments

The new Operator Supabase project is the development backend during the foundation phase. It is separate from Fullkit's database and currently contains no application tables or business records.

Vercel's **Development** and **Preview** environments receive the public Supabase URL and publishable key. Production database variables are deliberately unset. Establish database separation before introducing live operational data.

The committed `supabase/config.toml` is generated local CLI configuration, with seeding disabled until reviewed seed data exists. It has not been pushed to the hosted project's service settings. Do not run a database reset or configuration push against a hosted project as a setup shortcut.

## Hosting

Vercel is linked to this repository with root directory `apps/web`, framework Next.js, Node.js 24.x and a frozen pnpm install. Git pushes can trigger deployments. Custom domain setup is deferred.

Never put service-role or secret keys in variables beginning with `NEXT_PUBLIC_`. The app currently needs only the publishable key.

No database migrations, catalog imports, production records or user accounts are included. Authentication/access rules and the reporting connection to Fullkit are separate implementation steps.

## Repository boundary

Keep credentials, AWB/customer documents, staff rosters and private business documentation outside this repository. The requirements remain in the private Operator knowledge folder.

## Team UI draft

The deployed workspace is a shared, fictional test sandbox with an authenticated
role preview for production, stock in, stock out, office admin, packing and management.
Its English/Malay interface uses Fullkit's theme tokens and Geist fonts.

- Supabase Auth checks the administrator-controlled `ui_draft_access` app metadata.
  The shared test credentials are distributed privately, never committed.
- The only persistence table is `ui_draft_workspaces`. RLS limits access to the
  approved authenticated account's row. State revisions reject concurrent overwrites.
- Role selection previews workflows; it is not separate employee authentication.
- The database is dedicated to this draft. Vercel's **Production hosting target**
  points to this test backend so the stable Vercel URL is available to the team;
  that label does not mean live operational inventory.
- No customer PII, live stock, messages, PDF imports or Fullkit writes are involved.

Run `pnpm test` for the stock conservation, traceability, role-action and correction
invariants. Run `pnpm lint`, `pnpm typecheck` and `pnpm build` before publishing.

The draft supports batch steps, factory transfers, carton receipt, explicit
sachet-to-box conversion, monthly carton counts and reasoned adjustments, manual
AWBs, stock issue, packer declarations, supervisor quantity corrections, separate
courier handover, trace lookup, management review notes, CSV export and shared feedback.
The test reset is destructive only to this sandbox and requires UI confirmation.

Known boundaries: sample packages and staff; one product per AWB and one batch per
carton; provisional sachet steps; aggregate workspace reports; no PDF parsing or
external integrations. Process-record correction and real approval permissions
need the remaining operational decisions before live use. A recorded QC grouping
does not imply QC was performed or passed. Parcel declarations and allocation logs
are evidence of recorded work, not a physical guarantee of parcel contents.
