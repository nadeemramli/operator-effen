-- Rollback for 20261016090000_operator_order_archive.sql: puts archived orders back at the end
-- of each site's order list (oldest last, as they were), then drops the function and table.
-- Deploy the application version without the archive first. The document check (4 MB) refuses
-- the move if a site's orders no longer fit; then keep the archive.

update public.operator_workspaces w
set state = jsonb_set(w.state, '{orders}', coalesce(w.state -> 'orders', '[]'::jsonb)
    || (select jsonb_agg(a.doc order by a.order_date desc, a.id)
        from public.operator_orders_archive a where a.workspace_id = w.id)),
  revision = w.revision + 1, updated_at = now()
where exists (select 1 from public.operator_orders_archive a where a.workspace_id = w.id);

drop function public.operator_archive_orders(uuid);
drop table public.operator_orders_archive;
