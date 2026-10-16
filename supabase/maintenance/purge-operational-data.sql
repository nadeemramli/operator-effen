-- Removes every operational record keyed in so far while keeping sign-in and access data.
--
-- Removed:  workspace records (batches, cartons, orders/AWBs, AWB imports, trips, counts,
--           receipts, returns, issues, boxing, adjustments, notes, events, closed days,
--           operation records) and the commit log of those records.
-- Kept:     auth users, operator_workspaces rows (site, name, write policy),
--           operator_memberships, membership audit, staff PINs, role/command rules,
--           server keys, and the staffProfiles and machines configuration inside state.
--
-- Storage buckets (awb-draft-sources, operator-sources, operator-trip-photos,
-- trip-draft-photos) are not emptied here. Empty them from the Supabase dashboard
-- (Storage, open the bucket, select all, delete) or with the CLI's storage remove
-- command against the linked project. Deleting storage.objects rows in SQL would leave
-- the files behind in the underlying store, so this script does not touch them.
--
-- Review the selected project first (AGENTS.md). This cannot be undone without a backup.

begin;

-- Commit log first: it only describes the state being discarded.
delete from public.operator_commits;

-- PDF uploads and audit entries kept in their own tables since
-- 20261015090000_operator_imports_and_events.sql (skip these two lines before that).
delete from public.operator_imports;
delete from public.operator_events;

-- Orders kept in their own table since 20261017090000_operator_orders.sql, and any orders
-- archived under 20261016090000 (skip each line before its migration).
delete from public.operator_orders;
delete from public.operator_orders_archive;

-- Reset each site to the empty workspace shape. Revision keeps increasing so any open
-- browser tab with the old revision is rejected as stale and reloads.
update public.operator_workspaces w
set state = jsonb_build_object(
      'version', 1,
      'batches', '[]'::jsonb,
      'cartons', '[]'::jsonb,
      'orders', '[]'::jsonb,
      'issues', '[]'::jsonb,
      'boxing', '[]'::jsonb,
      'counts', '[]'::jsonb,
      'adjustments', '[]'::jsonb,
      'events', '[]'::jsonb,
      'notes', '[]'::jsonb,
      'closedDays', '[]'::jsonb
    )
    || case when w.state ? 'staffProfiles'
         then jsonb_build_object('staffProfiles', w.state -> 'staffProfiles') else '{}'::jsonb end
    || case when w.state ? 'machines'
         then jsonb_build_object('machines', w.state -> 'machines') else '{}'::jsonb end,
    revision = w.revision + 1,
    updated_at = now();

commit;

-- Optional, separate decision: the fictional preview sandbox. Dropping the rows makes the
-- app seed a fresh sample draft for each tester on next open.
-- delete from public.ui_draft_workspaces;
