# Operator EFFEN

This repository contains the application foundation. The authoritative requirements are in the owner's private Operator knowledge folder.

- Use Node from `.nvmrc` and pnpm from `package.json`. Do not use npm/yarn to install app dependencies.
- Keep the framework and design system aligned with Fullkit; explain deliberate differences.
- Never commit credentials, environment values, customer/AWB files, staff rosters or internal discovery reports.
- Do not silently point development or previews at a production database.
- Check the selected Supabase project before database commands. Review migrations and access rules before applying changes.
- A placeholder build does not prove database connectivity or authentication.
- Run `pnpm lint`, `pnpm typecheck`, and `pnpm build` for application changes.
