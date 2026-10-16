-- Orders in their own table (follows 20261016090000_operator_order_archive.sql). Work
-- package C of docs/order-volume-plan-2026-10.md: one row per AWB, so the workspace
-- document no longer grows with order volume and unrelated order saves do not conflict.
--
--   * public.operator_orders: the order (`doc`) with its own `version`. AWB (normalized),
--     work date and upload are derived from the order and indexed; one active order per AWB
--     per site (the duplicate rule, now enforced by the database). Members read; only
--     operator_commit_workspace writes.
--   * public.operator_orders_for(...): the orders a command or screen needs, by ID, AWB,
--     work date or upload (row-level security applies).
--   * operator_commit_workspace (same signature and signed message): a command's changed
--     orders arrive in `orders` as operations: {"op": "put", "order": {...}, "expected": n}
--     (null for a new order) or {"op": "delete", "id": ..., "expected": n}. Every version
--     must still match, otherwise nothing is written and the API retries on fresh data.
--     The document revision is checked and bumped only when the document itself changes,
--     so saves that touch only orders no longer conflict with each other or with the rest.
--   * Data: each site's orders, and any archived ones, move into the table and leave the
--     document. Archiving stops: operator_archive_orders finds no orders in the document.
-- Apply after the application version that reads orders from the table is deployed: it
-- works with both layouts, the previous one does not.
-- Assignments use `v := (select ...)`, never `select ... into` (see 20261015090000).
-- Rollback: supabase/rollback/20261017090000_operator_orders.down.sql.

create table public.operator_orders (
  workspace_id uuid not null references public.operator_workspaces(id) on delete cascade,
  id text not null check (char_length(id) between 1 and 200),
  doc jsonb not null check (jsonb_typeof(doc) = 'object' and octet_length(doc::text) <= 100000),
  awb text generated always as (upper(regexp_replace(coalesce(doc ->> 'awb', ''), '\s', '', 'g'))) stored,
  order_date text generated always as (doc ->> 'date') stored,
  import_id text generated always as (doc ->> 'importId') stored,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, id),
  check (awb <> '')
);
create unique index operator_orders_awb on public.operator_orders (workspace_id, awb);
create index operator_orders_date on public.operator_orders (workspace_id, order_date);
create index operator_orders_import on public.operator_orders (workspace_id, import_id)
  where import_id is not null;

alter table public.operator_orders enable row level security;
revoke all on public.operator_orders from anon, authenticated;
grant select on public.operator_orders to authenticated;
create policy "active members read their orders" on public.operator_orders
for select to authenticated using (public.operator_active_role(workspace_id) is not null);

create function public.operator_orders_for(
  p_workspace uuid,
  p_ids text[] default '{}',
  p_awbs text[] default '{}',
  p_dates text[] default '{}',
  p_imports text[] default '{}'
)
returns table (doc jsonb, version integer)
language sql
stable
set search_path = ''
as $$
  select o.doc, o.version from public.operator_orders o
  where o.workspace_id = p_workspace
    and (o.id = any(p_ids) or o.awb = any(p_awbs) or o.order_date = any(p_dates)
      or o.import_id = any(p_imports))
  order by o.order_date desc nulls last, o.id
$$;
revoke all on function public.operator_orders_for(uuid, text[], text[], text[], text[]) from public, anon;
grant execute on function public.operator_orders_for(uuid, text[], text[], text[], text[]) to authenticated;

-- Each site's orders (document first, then any archived ones) move into the table.
insert into public.operator_orders (workspace_id, id, doc)
select w.id, o ->> 'id', o
from public.operator_workspaces w,
  jsonb_array_elements(case when jsonb_typeof(w.state -> 'orders') = 'array'
    then w.state -> 'orders' else '[]' end) o
where jsonb_typeof(o) = 'object' and coalesce(o ->> 'id', '') <> ''
on conflict do nothing;
insert into public.operator_orders (workspace_id, id, doc)
select a.workspace_id, a.id, a.doc from public.operator_orders_archive a
on conflict do nothing;
delete from public.operator_orders_archive a
using public.operator_orders o
where o.workspace_id = a.workspace_id and o.id = a.id;
update public.operator_workspaces w
set state = w.state - 'orders', updated_at = now()
where w.state ? 'orders';

-- Same as 20261015090000_operator_imports_and_events.sql, plus orders (marked "orders").
create or replace function public.operator_commit_workspace(
  p_workspace uuid,
  p_expected_revision integer,
  p_command text,
  p_operation uuid,
  p_fingerprint text,
  p_state text,
  p_attestation text
)
returns table (new_state jsonb, new_revision integer, replayed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_role text;
  v_factory text; -- factory scope
  v_access text[]; -- tables (assignments below avoid SELECT ... INTO, see header)
  v_rule public.operator_command_rules%rowtype;
  v_current public.operator_workspaces%rowtype;
  v_prior public.operator_commits%rowtype;
  v_secret bytea;
  v_message text;
  v_new jsonb;
  v_doc jsonb; -- tables
  v_doc_changed boolean; -- orders
  v_rev integer; -- orders
begin
  if v_uid is null then
    raise exception 'Sign in again before saving.' using errcode = '28000';
  end if;
  perform 1 from public.operator_workspaces w where w.id = p_workspace for update;
  v_current := (select w from public.operator_workspaces w where w.id = p_workspace);
  -- factory scope: role and factory are read in one statement, so from the same snapshot.
  v_access := (select array[public.operator_active_role(p_workspace),
    operator_private.active_factory(p_workspace)]);
  v_role := v_access[1];
  v_factory := v_access[2];
  if v_current.id is null or v_role is null then
    raise exception 'No active membership for this site.' using errcode = '42501';
  end if;
  -- A retried operation returns its established result without repeating effects.
  v_prior := (select c from public.operator_commits c
    where c.workspace_id = p_workspace and c.operation_id = p_operation);
  if v_prior.operation_id is not null then
    if v_prior.user_id is distinct from v_uid or v_prior.command is distinct from p_command
      or v_prior.fingerprint is distinct from p_fingerprint then
      raise exception 'This save ID was already used for a different change.' using errcode = 'PT409';
    end if;
    return query select v_current.state, v_current.revision, true;
    return;
  end if;
  v_rule := (select r from public.operator_command_rules r where r.command = p_command);
  if v_rule.command is null then
    raise exception 'Unknown operational command.' using errcode = '42501';
  end if;
  if public.operator_has_capability(p_workspace, v_rule.capability) is not true then
    raise exception 'Your role at this site does not permit %.', v_rule.capability using errcode = '42501';
  end if;
  v_secret := (select k.secret from operator_private.server_keys k where k.id = 'commit');
  if v_secret is null then
    raise exception 'Operational saving is not configured.' using errcode = '55000';
  end if;
  if (p_fingerprint ~ '^[0-9a-f]{64}$') is not true or p_operation is null
    or p_expected_revision is null or p_state is null then
    raise exception 'Invalid operation.' using errcode = '22023';
  end if;
  v_message := concat_ws(E'\n', 'operator-commit-v1', p_workspace::text,
    p_expected_revision::text, v_uid::text, p_operation::text, p_command, p_fingerprint,
    encode(extensions.digest(convert_to(coalesce(p_state, ''), 'UTF8'), 'sha256'), 'hex'));
  if (lower(p_attestation) =
    encode(extensions.hmac(convert_to(v_message, 'UTF8'), v_secret, 'sha256'), 'hex')) is not true then
    raise exception 'This change was not validated by the Operator server.' using errcode = '42501';
  end if;
  begin
    v_new := p_state::jsonb;
  exception when others then
    raise exception 'Invalid workspace state.' using errcode = '22023';
  end;
  if (jsonb_typeof(v_new) = 'object') is not true then
    raise exception 'Invalid workspace state.' using errcode = '22023';
  end if;
  if (v_new - v_rule.state_keys) is distinct from (v_current.state - v_rule.state_keys) then
    raise exception 'This change is outside the % command scope.', p_command using errcode = '42501';
  end if;
  -- tables: the touched uploads are whole objects with label rows, or removal markers.
  if v_new ? 'awbImports' and (
    jsonb_typeof(v_new -> 'awbImports') is distinct from 'array'
    or exists (
      select 1 from jsonb_array_elements(v_new -> 'awbImports') i
      where jsonb_typeof(i) is distinct from 'object'
        or (char_length(coalesce(i ->> 'id', '')) between 1 and 80) is not true
        or (i -> 'deleted' is distinct from 'true'::jsonb
          and jsonb_typeof(i -> 'rows') is distinct from 'array'))
    or (select count(distinct i ->> 'id') <> count(*) from jsonb_array_elements(v_new -> 'awbImports') i)
  ) then
    raise exception 'Invalid upload record.' using errcode = '22023';
  end if;
  -- tables: every audit entry is an object with an identifier.
  if jsonb_typeof(coalesce(v_new -> 'events', '[]')) is distinct from 'array' or exists (
    select 1 from jsonb_array_elements(coalesce(v_new -> 'events', '[]')) e
    where jsonb_typeof(e) is distinct from 'object'
      or (char_length(coalesce(e ->> 'id', '')) between 1 and 200) is not true
  ) then
    raise exception 'Audit entries need an identifier.' using errcode = '23514';
  end if;
  -- orders: changed orders arrive as operations, each with the version it was based on.
  if v_new ? 'orders' and (
    jsonb_typeof(v_new -> 'orders') is distinct from 'array'
    or exists (
      select 1 from jsonb_array_elements(v_new -> 'orders') x
      where jsonb_typeof(x) is distinct from 'object'
        or (x ->> 'op' = 'put' and (jsonb_typeof(x -> 'order') is distinct from 'object'
          or (char_length(coalesce(x -> 'order' ->> 'id', '')) between 1 and 200) is not true
          or coalesce(x -> 'order' ->> 'awb', '') = ''
          or (x -> 'expected' is not null and jsonb_typeof(x -> 'expected') not in ('number', 'null'))))
        or (x ->> 'op' = 'delete' and ((char_length(coalesce(x ->> 'id', '')) between 1 and 200) is not true
          or jsonb_typeof(x -> 'expected') is distinct from 'number'))
        or coalesce(x ->> 'op', '') not in ('put', 'delete'))
    or (select count(distinct coalesce(x -> 'order' ->> 'id', x ->> 'id')) <> count(*)
      from jsonb_array_elements(v_new -> 'orders') x)
  ) then
    raise exception 'Invalid order record.' using errcode = '22023';
  end if;
  perform operator_private.assert_factory_scope(v_current.state, v_new, v_factory); -- factory scope
  perform operator_private.assert_transition(v_current.state, v_new, v_uid);
  -- orders: the document's revision matters only when this command changes the document;
  -- order changes are checked against each order's own version instead.
  v_doc := (v_new - 'awbImports' - 'orders') || '{"events": []}'::jsonb;
  v_doc_changed := v_doc is distinct from v_current.state;
  if v_doc_changed and v_current.revision is distinct from p_expected_revision then
    return;
  end if;
  if exists (
    select 1 from jsonb_array_elements(coalesce(v_new -> 'orders', '[]')) x
    left join public.operator_orders o
      on o.workspace_id = p_workspace and o.id = coalesce(x -> 'order' ->> 'id', x ->> 'id')
    where (x -> 'expected' is null or jsonb_typeof(x -> 'expected') = 'null') is distinct from (o.id is null)
      or (o.id is not null and o.version is distinct from (x ->> 'expected')::integer)
  ) then
    return;
  end if;
  perform 1 from public.operator_orders o, jsonb_array_elements(coalesce(v_new -> 'orders', '[]')) x
  where o.workspace_id = p_workspace and o.id = coalesce(x -> 'order' ->> 'id', x ->> 'id')
  for update of o;
  -- tables: store the touched uploads and append the audit entries, oldest first.
  delete from public.operator_imports t
  using jsonb_array_elements(coalesce(v_new -> 'awbImports', '[]')) i
  where t.workspace_id = p_workspace and t.id = i ->> 'id' and i -> 'deleted' = 'true'::jsonb;
  insert into public.operator_imports as t (workspace_id, id, doc)
  select p_workspace, i ->> 'id', i
  from jsonb_array_elements(coalesce(v_new -> 'awbImports', '[]')) i
  where i -> 'deleted' is distinct from 'true'::jsonb
  on conflict (workspace_id, id) do update set doc = excluded.doc, updated_at = now();
  insert into public.operator_events (workspace_id, id, entity, body)
  select p_workspace, e ->> 'id', coalesce(e ->> 'entity', ''), e
  from jsonb_array_elements(coalesce(v_new -> 'events', '[]')) with ordinality x(e, n)
  order by n desc
  on conflict do nothing;
  -- orders: removals, then new and changed orders (each change bumps its version).
  delete from public.operator_orders o
  using jsonb_array_elements(coalesce(v_new -> 'orders', '[]')) x
  where o.workspace_id = p_workspace and x ->> 'op' = 'delete' and o.id = x ->> 'id';
  insert into public.operator_orders as o (workspace_id, id, doc)
  select p_workspace, x -> 'order' ->> 'id', x -> 'order'
  from jsonb_array_elements(coalesce(v_new -> 'orders', '[]')) x
  where x ->> 'op' = 'put'
  on conflict (workspace_id, id) do update
    set doc = excluded.doc, version = o.version + 1, updated_at = now();
  v_rev := v_current.revision;
  if v_doc_changed then
    v_rev := v_rev + 1;
    update public.operator_workspaces w
    set state = v_doc, revision = v_rev, updated_at = now()
    where w.id = p_workspace;
  end if;
  insert into public.operator_commits (workspace_id, operation_id, user_id, role, command,
    fingerprint, result_revision)
  values (p_workspace, p_operation, v_uid, v_role, p_command, p_fingerprint, v_rev);
  return query select v_doc, v_rev, false;
end
$$;
