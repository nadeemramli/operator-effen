# Role-based entry, five-stage sachet route and shared machine records

Status: implemented on a draft branch for OPER-2, OPER-4 and OPER-5; repaired 2026-10-05 for
the operational write bypass and membership/file integration. Not deployed. The migrations
below have **not** been applied to any hosted Supabase project.

## Owner policy (confirmed 2026-10-05)

Entry is role-based with explicit capabilities, replacing the earlier literal "SV only" rule.
Actual performer and authenticated recorder stay separate throughout.

| Role | Scope | Capabilities (defaults; a site policy may only narrow them) |
|---|---|---|
| Production SV | one site | plan batches, record and correct stages, machines, day close, staff memberships*, feedback |
| Stock-in SV | one site | record and correct stages, machines, receive stock, **stock adjustments**, day close, staff memberships*, feedback |
| Stock-out SV | one site | order entry, fulfilment, outbound corrections, read sources, day close, staff memberships*, feedback |
| Office admin | site or all sites | order/AWB import and release, order entry, read sources, feedback |
| HR | site or all sites | memberships (all roles, all sites), site capability policy, feedback |
| Management | site or all sites | review comments, read sources, feedback |
| Packer, driver, assistant | one site | view and feedback only |

\* Supervisors may grant or revoke only packer, driver and assistant memberships at their own
site. "All access" never includes production corrections, stock adjustments, audit history or
permission changes; those stay with the capabilities above. The catalogue lives in
`apps/web/src/lib/capabilities.ts` and the `operator_role_capabilities`,
`operator_command_rules` and `operator_grantable_roles` tables (a test keeps them identical).

## Write path and trust boundary

`public.operator_commit_workspace` is the only operational write path. Records are still one
JSON document per site with one revision (normalized per-record storage is #10).

1. The API server derives identity, site and capabilities from the Supabase session and
   `operator_memberships`, ignores any client role, runs the domain rules (`applyCommand`),
   stamps the server-derived recorder on every new audit entry, and signs the resulting
   transition with HMAC-SHA256 (`OPERATOR_COMMIT_SECRET`, server-only).
2. The database, under the caller's own JWT (`auth.uid()`), re-checks the active membership
   and the command's capability at that site, verifies the signature over the exact state text,
   user, revision, operation ID, command and payload fingerprint, limits the change to the
   command's top-level records, and enforces invariants itself: audit events, notes, stock
   issues, adjustments and sort counts are append-only; new events, notes and history entries
   are attributed to the caller; received cartons are immutable; no carton goes below zero;
   batches, custody (transfer) facts and route snapshots are fixed; stage completion is never
   undone and PIC/correction/rework history is append-only; a batch with a route snapshot needs
   every stage completed with a PIC before transfer; machines and their history persist.
3. The commit, its audit row and the idempotency record (`operator_commits`) are one
   transaction. A retry with the same operation ID returns the established result; the same ID
   with different input is rejected.

Consequences: a member calling the RPC directly cannot commit (no signature); a leaked server
key still cannot act as another user or break the invariants; no service-role key is used.
Remaining trust: the API server is the authoritative validator for domain rules that are not
re-expressed in SQL (for example stage-name and route-review semantics, PIC rules).

## Membership administration contract

Database functions (callable with the signed-in user's JWT; ready for the future screen):

- `operator_grant_membership(workspace, user, role, display_name, staff_profile_id, reason, scope)`
- `operator_revoke_membership(membership, reason)`
- `operator_set_site_policy(workspace, policy, reason)` — HR only; can only narrow a role.

Rules enforced in SQL: nobody changes their own access; only HR grants all-sites access;
supervisors act only at their site and only on packer/driver/assistant memberships (both the
current and the new role must be grantable); every change writes `operator_membership_audit`
with before/after and reason. Direct table writes are denied.

Temporary provisioning (until the screen exists): an administrator creates Supabase Auth users
and bootstraps the first all-sites HR membership with SQL on the reviewed project. After that,
HR and supervisors call the functions above (for example from the SQL editor while signed in
via an authenticated client, or a small admin script using their own session). SQL provisioning
does **not** satisfy the membership-admin screen requirement; see the follow-up below.

```sql
-- Bootstrap only (administrator, after confirming the selected project; real values stay
-- outside the repository).
insert into public.operator_workspaces (site_id, name) values ('site-a', 'Site A');
insert into public.operator_memberships (workspace_id, user_id, role, display_name, scope)
values (null, '<auth user id>', 'hr', '<display name>', 'all-sites');
```

### Follow-up: HR / site-supervisor membership screen (separate delivery)

- HR: list people and memberships across sites, grant/change/revoke with reason, set site
  capability policy, view the audit trail.
- Site supervisor: same list filtered to their site and grantable roles only; grant/revoke
  packer, driver, assistant; link a performer profile (`staff_profile_id`).
- Built only on the functions and RLS above; no new authorization logic in the UI.
- Acceptance: denied paths visible (self-change, other site, non-grantable role), audit shown.

## Operational source files

- Bucket `operator-sources`, path `<workspace id>/<sha256>.pdf`. Upload needs `orders.import`
  at that site; reading needs `sources.read` or `orders.import`. Storage RLS enforces the same
  rules for direct Storage API calls.
- `/api/awb-files` authorizes before signing; signed download URLs live 60 seconds. Malformed,
  guessed, missing or unauthorized paths all return the same 404; storage outages return 503.
- `import-save` only accepts files already stored under the same site.
- The fictional sandbox keeps `awb-draft-sources/<account id>/…`; sandbox files are fictional
  and are not migrated. Operational and sandbox paths are never mixed (the bucket follows the
  caller's mode).

## Fictional preview sandbox

An account with `ui_draft_access` and no membership keeps the per-account
`ui_draft_workspaces` sandbox with the role switcher and keeps write access there (owner
decision). It never reaches operational workspaces or files. `OPERATOR_PREVIEW_WRITES=off`
makes it read-only.

## Feedback

Every role, including view-only staff, can post feedback. A note stores the authenticated
author, site, optional record reference and time, and never edits operational records.

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

## Deployment prerequisites (not done; owner/coordinator)

1. Review and apply both migrations to an isolated staging project first.
2. Generate a 32-byte key; store it as the server-only env var `OPERATOR_COMMIT_SECRET` (hex)
   and in `operator_private.server_keys` (`id = 'commit'`). Never a `NEXT_PUBLIC_` variable.
   Without both, operational saves fail closed with a clear 503.
3. Create Auth users and bootstrap the first HR membership as above.

## Verification

- `pnpm test` — domain, capability-parity and command-scope tests.
- `scripts/verify-migrations-local.sh` — applies all migrations to a disposable Postgres with
  stub `auth`/`storage` schemas, runs `supabase/tests/operator_access.test.sql` (bypass,
  signatures, invariants, capabilities, memberships, storage policies), rehearses rollback and
  re-applies.
- `tests/integration/run-real-stack.sh` — real GoTrue, PostgREST and Storage API on a local
  Postgres behind `router.mjs` (prefix routing and CORS, as Kong does), with the production
  Next.js build and Chromium. Requires the binaries described in the script header.

## Rollback

Run `supabase/rollback/20261005090000_operator_trusted_commands.down.sql`, then
`20261004090000_operator_memberships.down.sql`, after exporting operational state,
`operator_commits` and `operator_membership_audit`. Rolling back the repair alone leaves no
operational write path (the unsafe replacement-state RPC is intentionally not restored).

## Known limits

- One JSON document and revision per site: unrelated saves still conflict (#10).
- Domain rules not re-expressed in SQL rely on the API server (see trust boundary).
- No offline outbox beyond the single kept pending save (#12).
- The membership-admin screen is a separate follow-up.
