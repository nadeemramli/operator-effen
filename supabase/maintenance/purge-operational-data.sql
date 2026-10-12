-- Removes every operational record keyed in so far while keeping sign-in and access data.
--
-- Removed:  workspace records (batches, cartons, orders/AWBs, AWB imports, trips, counts,
--           receipts, returns, issues, boxing, adjustments, notes, events, closed days,
--           operation records), the order record tables (AWBs, stock issues, carton totals,
--           sort counts, departures) and the commit log of those records.
-- Kept:     auth users, operator_workspaces rows (site, name, write policy),
--           operator_memberships, membership audit, staff PINs, role/command rules,
--           server keys, record rules, each site's order store (document or tables), and the
--           staffProfiles and machines configuration inside state.
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
-- Audit entries of the sites (operator_events, since 20261013090000_operator_events.sql).
delete from public.operator_events;
-- Order records (since 20261014090000_operator_order_records.sql), before the uploads the
-- AWBs point at. Issues and sort counts are insert-only; the archiving flag lets this
-- transaction delete them.
set local operator.archiving = 'on';
delete from public.operator_order_departures;
delete from public.operator_issues;
delete from public.operator_sort_counts;
delete from public.operator_carton_issued;
delete from public.operator_orders;
-- PDF uploads and their label rows (operator_imports, since 20261012090000; rows cascade).
delete from public.operator_imports;

-- Reset each site to the empty workspace shape. Revision keeps increasing so any open
-- browser tab with the old revision is rejected as stale and reloads. A site whose orders
-- are table rows (order_store = 'tables') gets no orders or issues lists: its document
-- commits refuse order keys.
update public.operator_workspaces w
set state = jsonb_build_object(
      'version', 1,
      'batches', '[]'::jsonb,
      'cartons', '[]'::jsonb,
      'boxing', '[]'::jsonb,
      'counts', '[]'::jsonb,
      'adjustments', '[]'::jsonb,
      'events', '[]'::jsonb,
      'notes', '[]'::jsonb,
      'closedDays', '[]'::jsonb
    )
    || case when w.order_store = 'document'
         then '{"orders": [], "issues": []}'::jsonb else '{}'::jsonb end
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
