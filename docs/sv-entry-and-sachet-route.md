# Supervisor-only entry, five-stage sachet route and shared machine records

Status: implemented on a branch for OPER-2, OPER-4 and OPER-5 (2026-10-04). Not deployed. The
migration below has **not** been applied to any hosted Supabase project.

## Identity and permissions (OPER-2)

- Sign-in access comes from `public.operator_memberships` (one role per user per site
  workspace). The server derives recorder identity, role and site from it on every request.
  Client-sent `role` values are ignored for members.
- Only production, stock-in and stock-out supervisors write. Packers, drivers, assistants and
  management are view-only. A performer profile (`staffProfiles` in workspace state) never
  grants sign-in or write access.
- Office-admin imports/releases and management comments are **unresolved exceptions**. They
  are off by default and controlled per workspace by `operator_workspaces.write_policy`
  (`admin_imports`, `management_comments`). Turning one on is an owner decision.
- The only database write path is `public.operator_commit_workspace` (security definer). It
  re-checks the active membership at commit time, limits each role to its own top-level
  records (`operator_writable_keys`, mirrored by `roleStateKeys` in `apps/web/src/lib/access.ts`)
  and applies the optimistic revision check. Direct table writes have no RLS policy.
- Records store the performer (`pic`, `packer`) separately from the recorder (`recordedBy`,
  `packRecordedBy`, event `recorder`). Occurrence time (`occurredAt`, `packedAt`) is separate
  from entry time (`recordedAt`, `packRecordedAt`, event `at`).
- Stock-out supervisors record packing for the actual packer. A packer other than the
  assigned one needs a reason. Historical packer self-declarations are unchanged.
- Saves carry an operation ID. A retry after a lost response returns the original result; a
  reused ID with a different payload is rejected. Unacknowledged saves are kept in the
  browser (`operator-pending-save`) across an expired session and offered back only to the
  same user and site.

### Administrator setup (synthetic example)

Run by an administrator after confirming the selected project. Use real values only outside
this repository.

```sql
insert into public.operator_workspaces (site_id, name) values ('site-a', 'Site A') returning id;
insert into public.operator_memberships (workspace_id, user_id, role, display_name)
values ('<workspace id>', '<auth user id>', 'production', '<display name>');
-- Revoke: takes effect on the user's next load or save.
update public.operator_memberships set active = false, revoked_at = now() where id = '<id>';
```

### Fictional preview sandbox

An account with `ui_draft_access` and no membership keeps the existing per-account
`ui_draft_workspaces` sandbox with the role switcher. Role previews never reach an
operational workspace. Set `OPERATOR_PREVIEW_WRITES=off` to make the sandbox read-only.
Whether the shared preview account should keep write access at all is an owner decision.

## Five-stage sachet route (OPER-4)

| Key | Stage (EN) | Stage (BM) |
|---|---|---|
| `mixing` | Mixer machine (mixing) | Mesin pengadun (mengadun) |
| `filling` | Sachet filling machine (filling) | Mesin pengisian sachet (mengisi) |
| `batching` | Inkjet printer (batching) | Pencetak inkjet (nombor kelompok) |
| `hologram` | Hologram machine | Mesin hologram |
| `wrapping` | Shrink machine (plastic wrapping) | Mesin shrink (balutan plastik) |

- New sachet batches snapshot route `sachet-v2` (above). Transfer needs an actual completion
  with PIC for every stage in the snapshot. Planned PICs are not completions. QC is never
  inferred.
- Batches without a snapshot: transferred ones keep their historical route (`sachet-v1`
  four-stage, or free-form legacy records). Untransferred ones need an explicit production
  route review: upgrade to five stages (adds an open Hologram stage) or keep the four-stage
  route, with a reason. No Hologram completion is ever created automatically, and existing
  step positions are not reinterpreted.
- Rework is recorded as an additional occurrence on the stage (performer, machine, actual
  time, reason, recorder). Late entry takes an actual Malaysia time; screen order is not
  enforced on timestamps.

## Shared machine/PIC records (OPER-5)

- Production and Stock-in edit the same batch stage records. Stock-in shows them under
  "Sachet production records"; both screens share the site machine registry.
- Machines have a stable ID, stage type, name and optional code. Supervisors can add, find,
  edit, deactivate and reactivate them. Stage records keep a machine-name snapshot, so master
  edits do not rewrite history. Inactive machines remain readable but cannot be chosen for
  new work. Machines from another site are refused.
- PIC changes are typed: assignment (planning), reassignment (before completion), shift
  handover (with effective time), and correction. Completion, machine and time corrections
  keep previous/new values, reason, recorder and time.
- Stage and machine edits carry the version the supervisor opened; a stale edit returns a
  reviewable conflict instead of overwriting. Corrections after transfer are flagged as
  batch revisions and never create receipts, transfers or stock movements.

## Verification and rollback

- `pnpm test` — domain and policy tests (`tests/sv-entry`, `tests/sachet-route`,
  `tests/shared-machine-records` plus existing suites).
- `scripts/verify-migrations-local.sh` — applies all migrations to a disposable Postgres, runs
  `supabase/tests/operator_access.test.sql`, rehearses the rollback and re-applies.
- `tests/e2e/run-local.sh` — production build + browser scenarios against a local Postgres
  through `tests/e2e/supabase-shim.mjs` (a local stand-in, not Supabase itself).
- Rollback: `supabase/rollback/20261004090000_operator_memberships.down.sql` (manual;
  deletes operational workspaces — export first). The application falls back to the preview
  sandbox when the membership tables are absent. New optional JSON fields are ignored by the
  previous application version, except that it cannot record the new five-stage route.

## Known limits

- Workspace state is still one JSON document per site with one revision; normalized records
  and row-level stock transactions remain issue #10.
- Supervisors can still commit arbitrary content inside their role's records through the RPC;
  business rules are enforced in the application server, not yet per row in the database.
- No offline outbox beyond the single kept pending save (issue #12). AWB PDF upload storage
  policies still require `ui_draft_access`.
