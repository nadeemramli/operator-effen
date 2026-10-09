# Role-based entry, five-stage sachet route and shared machine records

Status: live since 2026-10-06 on the `operator-effen` Supabase project (see "Go-live record"
below). Implemented for OPER-2, OPER-4 and OPER-5; repaired 2026-10-05 for the operational
write bypass and membership/file integration.

## Owner policy (confirmed 2026-10-05)

Entry is role-based with explicit capabilities, replacing the earlier literal "SV only" rule.
Actual performer and authenticated recorder stay separate throughout.

| Role | Scope | Capabilities (defaults; a site policy may only narrow them) |
|---|---|---|
| Production SV | one site | plan batches, record and correct stages, machines, day close, staff memberships*, feedback |
| Stock-in SV | one site | record and correct stages, machines, receive stock, **stock adjustments**, day close, staff memberships*, feedback |
| Stock-out SV | one site | order entry, fulfilment, outbound corrections, read sources, read driver trips, day close, staff memberships*, feedback |
| Office admin | site or all sites | order/AWB import and release, order entry, read sources, feedback |
| HR | site or all sites | memberships (all roles, all sites), site capability policy, feedback |
| Management | site or all sites | review comments, read sources, read driver trips, feedback |
| Driver | one site | log their own trips (see [driver trips](#driver-trips)), view, feedback |
| Packer | one site | view and feedback only |

\* Supervisors may grant or revoke only packer and driver memberships at their own site. "All access" never includes production corrections, stock adjustments, audit history or
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
   its factory stages (mixing, filling) completed with a PIC before transfer, and every route
   stage completed with a PIC before a box carton is created for it (two gates since
   2026-10-09, migration `20261009090001`); machines and their history persist.
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
supervisors act only at their site and only on packer/driver memberships (both the
current and the new role must be grantable); every change writes `operator_membership_audit`
with before/after and reason. Direct table writes are denied. Every guard fails closed: it
proceeds only when its whole condition is true, so an unknown caller, a revoked or other-site
member, an unknown membership ID or any NULL argument is a denial (one identical message for
unknown and unauthorized memberships, so IDs cannot be probed).

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
  packer, driver; link a performer profile (`staff_profile_id`).
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

- New sachet batches snapshot route `sachet-v2` (above). Planned PICs are not completions. QC
  is never inferred.
- **Factory and warehouse stages (since 2026-10-09).** `mixing` and `filling` are factory
  stages; every later stage of a route is a warehouse stage. Production records the factory
  stages and **Send to warehouse** needs both completed with a PIC. Stock-in records
  batching, hologram and wrapping on the receipt awaiting boxing; **Finalize box count**
  needs every stage of the route completed with a PIC ("n/3 warehouse stages" until then).
  Production may still record any stage; its screen shows the warehouse stages read-only.
  Warehouse-stage records and corrections after transfer are the normal flow and are not
  flagged as revisions until the box count is finalized; factory-stage corrections after
  transfer still are. The split is defined once in TypeScript (`factoryStages`) and once in
  SQL (`operator_private.factory_stage`), and a test keeps them identical. A four-stage
  (`sachet-v1`) batch follows the same split. Historical batches without a route snapshot
  are not re-checked at the box count. Batches already transferred with all five stages are
  unchanged; a batch in production with some stages done transfers once mixing and filling
  are done.
- Batches without a snapshot: transferred ones keep their historical route (`sachet-v1`
  four-stage, or free-form legacy records). Untransferred ones need an explicit production
  route review: upgrade to five stages (adds an open Hologram stage) or keep the four-stage
  route, with a reason. No Hologram completion is ever created automatically, and existing
  step positions are not reinterpreted.
- Rework is recorded as an additional occurrence on the stage (performer, machine, actual
  time, reason, recorder). Late entry takes an actual Malaysia time; screen order is not
  enforced on timestamps.

## Shared machine/PIC records (OPER-5)

(Since 2026-10-09 the stock-in receipt row shows the warehouse stages inline; the full
five-stage view below stays for history and corrections.)


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

## Driver trips

Owner decision (2026-10-06): driver and assistant driver are **one role**. The driver signs in
and logs each trip; the assistant is recorded by name on the trip and does not sign in.
Migration `20261006090000_operator_driver_trips.sql` converts any existing `assistant`
memberships to `driver` and removes the separate role.

- **Log a trip** (`trip`, capability `trips.log`): assistant driver name (optional — blank when
  driving alone), pickup time, arrival time (optional), photo (optional) and a short note.
  Times are actual Malaysia times and cannot be in the future.
- **Log arrival / add photo** (`trip-update`): the same driver adds the arrival time or photo
  later, for example on arrival. Only missing values can be added; recorded values never change.
- The driver is always the signed-in recorder; nobody can log a trip for another driver.
- Stock-out supervisors and management (`trips.read`) see every trip and photo at the site.
  Drivers see their own trips and photos.
- Database invariants: trips are never removed; recorded trip fields are fixed; only the
  trip's own driver can add its missing arrival or photo; arrival is never before pickup; a
  new photo must be in the signed-in driver's folder.
- Photos are re-encoded in the browser as JPEG (max 1600 px, metadata removed) and stored in
  the private bucket `operator-trip-photos` at `<workspace id>/<driver user id>/<sha256>.jpg`
  (5 MB limit). `/api/trip-photos` signs uploads for drivers and 60-second read URLs for the
  driver or `trips.read` holders; storage RLS enforces the same rules. The fictional sandbox
  uses `trip-draft-photos/<account id>/…`.
- Not included: supervisor correction of a mistaken trip time (there is no edit path yet),
  vehicle or route fields, and links between trips and courier handovers.

## Factory scope (production supervisors)

The site has two factories: bottle/capsule (CAV, GLY, LIP, SYN) and sachet (ADY). Migration
`20261007090000_operator_factory_scope.sql` lets a production membership be limited to one of
them (`operator_memberships.factory`: `'bottle'`, `'sachet'` or NULL for both). Only
production memberships can carry a factory.

- **Database** (authoritative): `operator_commit_workspace` refuses, for a scoped member, any
  commit that adds, changes or removes a batch whose product is in the other factory or in
  no known factory, and, for a bottle-scoped member, any change to the machine register
  (machines are sachet-route equipment). It checks the signed state itself, so it covers
  every command and direct RPC calls. Fails closed (unknown product or missing field = denial).
- **API server**: refuses before the domain rules run (`factoryDenial`) and re-checks the
  resulting state (`outOfFactory`) for every operational save, with 403 and a plain message.
- **Screens**: the production view is locked to the member's factory (no All/Bottle/Sachet
  toggle), planning offers only that factory's products, and a bottle-scoped member does not
  see the Machines tab. Unscoped members, intake, management view-as and the fictional
  preview are unchanged.
- Not factory records: day close, feedback and staff (packer/driver) memberships.
- HR sets or clears the scope with
  `operator_set_membership_factory(membership, factory, reason)` (HR only, never on their own
  membership, only on an active production site membership; audited as `change`). Changing a
  scoped member to another role needs the scope cleared first (the check constraint refuses).
- Rollout order does not matter: the app reads memberships without the column until the
  migration exists, and every membership starts unscoped. The migration is additive (new
  column, new functions, `create or replace` of the commit function with the same signature).

Until an HR user exists, the owner assigns the scopes in the SQL Editor (it updates rows, so
the Supabase tool cannot run it). Confirm the selected project is `operator-effen` first.

```sql
begin;
-- 1. Look up the production memberships at site `operator` and note their ids.
select m.id, m.display_name, m.factory
from public.operator_memberships m
join public.operator_workspaces w on w.id = m.workspace_id
where w.site_id = 'operator' and m.role = 'production' and m.active;
-- 2. Record the change, then make it. Replace the placeholders; both must be unscoped now.
create temp table factory_scope (id uuid primary key, factory text not null) on commit drop;
insert into factory_scope values
  ('<capsule supervisor membership id>', 'bottle'),
  ('<sachet supervisor membership id>', 'sachet');
insert into public.operator_membership_audit (action, workspace_id, membership_id,
  target_user, actor_user, actor_role, before, after, reason)
select 'change', m.workspace_id, m.id, m.user_id, '<owner auth user id>', 'owner',
  to_jsonb(m), to_jsonb(m) || jsonb_build_object('factory', f.factory),
  'Owner decision: production supervisors limited to their own factory'
from public.operator_memberships m join factory_scope f on f.id = m.id
where m.role = 'production' and m.active and m.factory is null;
update public.operator_memberships m
set factory = f.factory, updated_at = now()
from factory_scope f
where m.id = f.id and m.role = 'production' and m.active and m.factory is null;
-- 3. Expect exactly the two rows, each with its factory; otherwise run `rollback;`.
select m.display_name, m.factory from public.operator_memberships m
join factory_scope f on f.id = m.id;
commit;
```

## Deployment prerequisites

1. Review and apply the migrations (rehearse with `scripts/verify-migrations-local.sh`).
2. Generate a 32-byte key; store it as the server-only env var `OPERATOR_COMMIT_SECRET` (hex)
   and in `operator_private.server_keys` (`id = 'commit'`). Never a `NEXT_PUBLIC_` variable.
   Without both, operational saves fail closed with a clear 503.
3. Create Auth users and bootstrap the first memberships as above.

## Go-live record (2026-10-06, owner-approved)

- Project `operator-effen` became the live database. No separate staging project was used; the
  three migrations were rehearsed on a disposable local Postgres (access tests and rollback
  passed) and the live catalog was compared object-by-object with a reference build of the
  committed files (functions, policies, constraints, columns, grants and reference data
  identical). The Supabase tool needs an interactive confirmation for destructive statements,
  so the drops, deletes, rename and no-op updates were run once by the owner in the SQL Editor;
  that script also recorded the repository versions in the migration history. After it ran,
  all 61 live functions, policies, constraints and reference-data sets matched the reference.
- One site: `operator` ("Operator"), created with the empty default state (no sample data).
- Memberships (direct bootstrap inserts, each with an `operator_membership_audit` row):
  Production SV Faris (capsule) and Helmi (sachet); Stock-in SV Nurul; Stock-out SV Nadia;
  Office admin Hadera; Management, all sites: Nadeem and the shared `team@` account.
- No user yet for HR, Packer or Driver. Without HR, membership changes need the SQL bootstrap.
- The fictional preview flag (`ui_draft_access`) was removed from those seven accounts. Their
  old sandbox rows remain in `ui_draft_workspaces` but are no longer reachable.
- `OPERATOR_COMMIT_SECRET` is set for Vercel Production only. Vercel Preview and Development
  Supabase variables point at a placeholder, so preview builds cannot reach live data; give
  them a separate staging project to re-enable them.
- Known limit accepted for go-live: production supervisors are not limited to one factory;
  Faris and Helmi can both record capsule and sachet batches. Addressed by
  `20261007090000_operator_factory_scope.sql` (see "Factory scope"); not yet applied to
  `operator-effen` — awaiting the owner's go-ahead and the scope assignment script.

## Verification

- `pnpm test` — domain, capability-parity and command-scope tests.
- `scripts/verify-migrations-local.sh` — applies all migrations to a disposable Postgres with
  stub `auth`/`storage` schemas, runs `supabase/tests/operator_access.test.sql` (bypass,
  signatures, invariants, capabilities, memberships, storage policies, trips, factory scope),
  rehearses rollback and re-applies.
- `tests/integration/run-real-stack.sh` — real GoTrue, PostgREST and Storage API on a local
  Postgres behind `router.mjs` (prefix routing and CORS, as Kong does), with the production
  Next.js build and Chromium. Requires the binaries described in the script header.

## Rollback

Run `supabase/rollback/20261009090001_operator_warehouse_stages.down.sql` (restores the
all-stages transfer gate), then `supabase/rollback/20261007090000_operator_factory_scope.down.sql`, then
`20261006090000_operator_driver_trips.down.sql`, then
`20261005090000_operator_trusted_commands.down.sql`, then
`20261004090000_operator_memberships.down.sql`, after exporting operational state,
`operator_commits` and `operator_membership_audit`. Rolling back the repair alone leaves no
operational write path (the unsafe replacement-state RPC is intentionally not restored).

## Known limits

- One JSON document and revision per site: unrelated saves still conflict (#10).
- Domain rules not re-expressed in SQL rely on the API server (see trust boundary).
- No offline outbox beyond the single kept pending save (#12).
- The membership-admin screen is a separate follow-up.
