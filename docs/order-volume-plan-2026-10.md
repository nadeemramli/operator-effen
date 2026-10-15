# Order volume: per-AWB records out of the workspace document

Status: proposal, 2026-10-12. Implements the "normalized shared records" part of readiness
workstream [#10](https://github.com/nadeemramli/operator-effen/issues/10) for orders,
uploads, stock issues and audit entries. Nothing here is live until each work package below
has merged behind green CI and the owner has applied its migration.

Update 2026-10-14: the live site hit the cap (1.92 MB: uploads 779 KB, audit entries
568 KB, orders 515 KB for 830 open AWBs over four days) and refused every save.
`20261014090000_operator_workspace_capacity.sql` raises the cap to 4 MB and drops raw
extraction text from released uploads. That is about a week of headroom at 400 AWBs a day,
not a fix; WP A and B start now.

## Why now

The owner reports days with 2,000 AWBs to fulfil and PDFs of 1,000 labels. The current
storage cannot hold one such day:

| Fact (measured 2026-10-12) | Value |
|---|---|
| Site workspace storage | one JSON document per site, `operator_workspaces.state` |
| Database cap on that document | 2 MB (check constraint, both workspace tables) |
| API request body cap | 1 MB (`apps/web/src/app/api/draft/route.ts`) |
| Sandbox with 432 orders, 428 label rows, 883 events | 870 KB |
| Per imported AWB at release | about 2 KB: label row ~815 B, order ~500 B, two audit entries ~300 B each |
| Per fulfilled AWB over its life | 5 to 7 audit entries, so about 2 KB of events alone |
| Every command response and every 60-second refresh | the whole document, to every open device |

At 2,000 AWBs a day that is roughly 1.6 MB of label rows, 1 MB of orders and over 3 MB of
audit entries per day. Raising the per-upload limit (now 600 pages, 300 labels) or the
document cap only moves the wall by a day and makes every save and refresh heavier on the
packers' phones. The per-AWB stream has to leave the document.

## Target

Keep the document for what is small and genuinely shared: batches, cartons, counts,
adjustments, returns, machines, staff profiles, closed days, notes, trips. Move the per-AWB
stream to tables with row-level rules:

| Table | Holds | Rules |
|---|---|---|
| `operator_imports` | one PDF upload: name, date, files, confirmed/received/deleted marks | admin writes through RPC; `sources.read` reads |
| `operator_import_rows` | one label: AWB, order ref, channel, store, courier, lines, sources, warnings, review note, excluded, released order, raw text | same; raw text never enters the document again |
| `operator_orders` | one AWB: the current `Order` fields plus `version` | unique `(workspace_id, awb)`; per-row version check; hard delete only while no issue, pack or handover (as built on 2026-10-11) |
| `operator_issues` | one stock issue: carton, order, qty, PIC, time, recorder | insert-only; positive whole quantities; conservation checked against the carton in the document |
| `operator_events` | one audit entry: entity, action, detail, actor, time, recorder, performer | insert-only, attributed to `auth.uid()`, written by the RPCs, never by clients |

Idempotency stays in `operator_commits` (workspace + operation ID, fingerprint). The signed
trusted-command pattern stays: the API server validates with the TypeScript domain code and
signs; the database re-checks the invariants it owns. What changes is the unit the RPC
commits: the rows an operation touched, with their expected versions, instead of the whole
document and its revision. That is what the #10 acceptance line "unrelated operations do
not conflict through one workspace-wide revision" asks for.

Carton balance becomes `received − issued (table) − boxed + adjustments + returns`, with the
issue RPC taking a transaction-scoped advisory lock per carton so two issues cannot both
read the same balance. Trace lookup, the daily tally and the packer station read the tables
through the API; the document no longer carries `orders`, `awbImports`, `issues` or
`events`.

## Work packages

Each is one PR with a migration, its rollback file, cases in
`supabase/tests/operator_access.test.sql`, an entry in `scripts/verify-migrations-local.sh`,
unit tests, and the integration scenario where the flow changes. Migrations are applied to
the hosted project by the owner, in order, before the PR merges (as on 2026-10-09).

| WP | Scope | Why this order | Size |
|---|---|---|---|
| A | Uploads to `operator_imports` and `operator_import_rows`. Upload, review, save, release, receive and delete read and write the tables; release still creates orders (in the document until WP C). Upload limits rise to 10 PDFs, 2,500 pages and 1,200 labels per upload. | Biggest bytes per AWB, admin-only, simplest invariants. Makes 1,000-label PDFs reviewable immediately. | 2 to 3 days |
| B | Audit entries to `operator_events`, appended by the commit RPC from the command's event list; trace lookup and audit log read by entity or date through the API. `assert_transition` keeps its attribution rule on the new table. | Removes the unbounded growth; needed before orders so WP C's RPCs log into one place. | 1 to 2 days |
| C | Orders and issues to tables. One RPC per order command family (enter, review, edit, remove, split, assign, print, move, issue, pack, pack-own, correct, dispatch) with row versions, the carton lock and `operator_commits` idempotency. Order list, package groups, tally, packer station and handover read per day through the API with paging. | The change that makes 2,000 AWBs a day hold indefinitely. | 5 to 8 days |
| D | Cutover: backfill any document orders, uploads and events into the tables (the live site is empty since the 2026-10-11 purge, so this is mostly the sandbox), retire the document keys and their command rules, retention (hot 90 days, then archive tables), and dated payload and latency evidence for #8 and #11. | Closes the loop and gives the readiness epic its evidence. | 2 to 3 days |

Roughly three weeks of focused work. WP A alone lets a 1,000-label PDF be uploaded and
reviewed, but released orders still land in the document, which then holds about one
2,000-AWB day. Fulfilling that volume day after day needs WP C.

## Decisions needed from the owner

1. **Scope of the move.** Per-AWB records (uploads, orders, issues, events) move to tables;
   inventory (batches, cartons, receipts, returns) stays in the document for now. Full
   normalization of inventory is a later workstream.
2. **Retention.** Proposed: AWBs stay in the hot tables and the app for 90 days, then move
   to archive tables that trace lookup can still read. Source PDFs follow the same clock.
3. **Preview sandbox.** The fictional per-user sandbox keeps the document shape. Order
   flows in the sandbox either move to per-user rows in the same tables (more work, same
   screens) or the sandbox stops covering order flows and a synthetic site is used for
   testing instead. Proposed: synthetic site; the sandbox keeps production and stock-in.
4. **Interim limits.** Until WP A ships, uploads stay at 600 pages and 300 labels. A
   2,000-AWB day cannot be entered in the app before WP C; the owner decides whether the
   team splits uploads meanwhile or waits.
5. **Sequencing against other work.** WP A to D block on nothing but review time; other
   floor requests touching order screens should wait for WP C to avoid double work.

## What does not change

Roles and capabilities, the membership tables, the signed-commit secret and operation IDs,
batch and carton traceability, the append-only rule for issues and audit entries, the
Malay and English screens, and the storage buckets for PDFs and trip photos.
