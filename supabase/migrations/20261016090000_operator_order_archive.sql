-- Order archive (follows 20261015090000_operator_imports_and_events.sql).
--
-- Orders still live in the workspace document, about 620 bytes each; at 400 to 2,000 AWBs a
-- day they would fill it within days to weeks. Until orders get their own table (WP C of
-- docs/order-volume-plan-2026-10.md), orders whose work date is more than 7 days ago (Malaysia
-- time) move to public.operator_orders_archive:
--   * public.operator_archive_orders(p_workspace) moves them in one transaction, bumps the
--     revision (open screens reload) and records one audit entry. Any active member of the
--     site may call it; the cutoff is fixed here, so a caller cannot choose what is archived.
--     The API calls it when a loaded document holds orders older than the cutoff.
--   * Archived orders are read-only. Members read them (trace lookup by AWB); the manual AWB
--     entry and PDF import check them for duplicates. Stock issues stay in the document, so
--     carton balances do not change.
-- Assignments use `v := (select ...)`, never `select ... into` (see 20261015090000).
-- Rollback: supabase/rollback/20261016090000_operator_order_archive.down.sql.

create table public.operator_orders_archive (
  workspace_id uuid not null references public.operator_workspaces(id) on delete cascade,
  id text not null check (char_length(id) between 1 and 200),
  awb text not null,
  order_date date,
  doc jsonb not null check (jsonb_typeof(doc) = 'object' and octet_length(doc::text) <= 100000),
  archived_at timestamptz not null default now(),
  primary key (workspace_id, id)
);
create index operator_orders_archive_awb on public.operator_orders_archive (workspace_id, awb);
create index operator_orders_archive_date on public.operator_orders_archive (workspace_id, order_date desc);

alter table public.operator_orders_archive enable row level security;
revoke all on public.operator_orders_archive from anon, authenticated;
grant select on public.operator_orders_archive to authenticated;
create policy "active members read their archived orders" on public.operator_orders_archive
for select to authenticated using (public.operator_active_role(workspace_id) is not null);

create function public.operator_archive_orders(p_workspace uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_cutoff date := (now() at time zone 'Asia/Kuala_Lumpur')::date - 7;
  v_state jsonb;
  v_moved integer;
  v_event text := gen_random_uuid()::text;
begin
  if v_uid is null then
    raise exception 'Sign in again.' using errcode = '28000';
  end if;
  if public.operator_active_role(p_workspace) is null then
    raise exception 'No active membership for this site.' using errcode = '42501';
  end if;
  perform 1 from public.operator_workspaces w where w.id = p_workspace for update;
  v_state := (select w.state from public.operator_workspaces w where w.id = p_workspace);
  if jsonb_typeof(v_state -> 'orders') is distinct from 'array' then
    return 0;
  end if;
  insert into public.operator_orders_archive (workspace_id, id, awb, order_date, doc)
  select p_workspace, o ->> 'id', upper(regexp_replace(coalesce(o ->> 'awb', ''), '\s', '', 'g')),
    (o ->> 'date')::date, o
  from jsonb_array_elements(v_state -> 'orders') o
  where coalesce(o ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$' and (o ->> 'date')::date < v_cutoff
    and coalesce(o ->> 'id', '') <> ''
  on conflict do nothing;
  v_moved := (select count(*) from jsonb_array_elements(v_state -> 'orders') o
    where coalesce(o ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$' and (o ->> 'date')::date < v_cutoff
      and coalesce(o ->> 'id', '') <> '');
  if v_moved = 0 then
    return 0;
  end if;
  update public.operator_workspaces w
  set state = jsonb_set(w.state, '{orders}', coalesce((
      select jsonb_agg(o order by n)
      from jsonb_array_elements(v_state -> 'orders') with ordinality x(o, n)
      where not (coalesce(o ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$'
        and (o ->> 'date')::date < v_cutoff and coalesce(o ->> 'id', '') <> '')), '[]'::jsonb)),
    revision = w.revision + 1, updated_at = now()
  where w.id = p_workspace;
  insert into public.operator_events (workspace_id, id, entity, body)
  values (p_workspace, v_event, p_workspace::text, jsonb_build_object(
    'id', v_event, 'entity', p_workspace::text, 'action', 'Orders archived',
    'detail', v_moved || ' AWBs dated before ' || v_cutoff || ' moved to the order archive',
    'actor', 'Operator', 'at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'recorder', jsonb_build_object('userId', v_uid::text)));
  return v_moved;
end
$$;
revoke all on function public.operator_archive_orders(uuid) from public, anon;
grant execute on function public.operator_archive_orders(uuid) to authenticated;
