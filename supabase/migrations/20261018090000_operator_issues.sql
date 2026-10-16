-- Stock issues in their own table (follows 20261017090000_operator_orders.sql). The last
-- per-AWB record in the workspace document: once packing is recorded, every packed AWB adds
-- a stock issue (about 150 bytes).
--
--   * public.operator_issues: one row per stock issue; insert-only (nobody updates or
--     deletes them). Carton, order and the Malaysian work day are indexed.
--   * public.operator_issue_totals(workspace, since): issued quantity per carton per day
--     from `since`, and per carton before it (day null). public.operator_issues_for(
--     workspace, orders, dates): the issues of these orders or of orders on these work
--     dates. Row-level security applies.
--   * operator_commit_workspace (same signature and signed message): `issues` carries only
--     the stock issues the command added (the stored document keeps `issues: []`). Every
--     existing rule runs as if all stored issues were in the document, each carton's stored
--     total standing in for its issues, so the balance check (no carton below zero) stays
--     exact. Saves to a site run one at a time (row lock), so two issues cannot both take the
--     last unit. New: an order with stock issues cannot be removed.
--   * Data: each site's stock issues move into the table and leave the document.
-- Apply after the application version that reads issues from the table is deployed.
-- Assignments use `v := (select ...)`, never `select ... into` (see 20261015090000).
-- Rollback: supabase/rollback/20261018090000_operator_issues.down.sql.

create table public.operator_issues (
  workspace_id uuid not null references public.operator_workspaces(id) on delete cascade,
  id text not null check (char_length(id) between 1 and 200 and id not like 'total:%'),
  carton_id text not null,
  order_id text not null default '',
  qty integer not null check (qty > 0),
  issue_day date not null,
  body jsonb not null check (jsonb_typeof(body) = 'object' and octet_length(body::text) <= 20000),
  recorded_at timestamptz not null default now(),
  primary key (workspace_id, id)
);
create index operator_issues_order on public.operator_issues (workspace_id, order_id);
create index operator_issues_carton_day on public.operator_issues (workspace_id, carton_id, issue_day);

alter table public.operator_issues enable row level security;
revoke all on public.operator_issues from anon, authenticated;
grant select on public.operator_issues to authenticated;
create policy "active members read their stock issues" on public.operator_issues
for select to authenticated using (public.operator_active_role(workspace_id) is not null);

create function public.operator_issue_totals(p_workspace uuid, p_since date)
returns table (carton_id text, day date, qty bigint)
language sql
stable
set search_path = ''
as $$
  select i.carton_id, case when i.issue_day >= p_since then i.issue_day end, sum(i.qty)
  from public.operator_issues i
  where i.workspace_id = p_workspace
  group by 1, 2
$$;
create function public.operator_issues_for(p_workspace uuid, p_orders text[], p_dates text[] default '{}')
returns table (body jsonb)
language sql
stable
set search_path = ''
as $$
  select i.body from public.operator_issues i
  where i.workspace_id = p_workspace
    and (i.order_id = any(p_orders) or exists (
      select 1 from public.operator_orders o
      where o.workspace_id = i.workspace_id and o.id = i.order_id and o.order_date = any(p_dates)))
  order by i.recorded_at desc, i.id
$$;
revoke all on function public.operator_issue_totals(uuid, date), public.operator_issues_for(uuid, text[], text[]) from public, anon;
grant execute on function public.operator_issue_totals(uuid, date), public.operator_issues_for(uuid, text[], text[]) to authenticated;

-- Each site's stock issues move into the table (oldest first) and leave the document.
insert into public.operator_issues (workspace_id, id, carton_id, order_id, qty, issue_day, body)
select w.id, i ->> 'id', i ->> 'cartonId', coalesce(i ->> 'orderId', ''), (i ->> 'qty')::integer,
  (coalesce(operator_private.iso_time(i ->> 'at'), now()) at time zone 'Asia/Kuala_Lumpur')::date, i
from public.operator_workspaces w,
  jsonb_array_elements(case when jsonb_typeof(w.state -> 'issues') = 'array'
    then w.state -> 'issues' else '[]' end) with ordinality x(i, n)
order by w.id, n desc;
update public.operator_workspaces w
set state = w.state || '{"issues": []}'::jsonb, updated_at = now()
where w.state -> 'issues' is distinct from '[]'::jsonb;

-- Same as 20261017090000_operator_orders.sql, plus stock issues (marked "issues").
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
  v_hist jsonb; -- issues
  v_added jsonb; -- issues
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
  -- issues: the stock issues this command added (the stored document keeps none).
  v_added := (select coalesce(jsonb_agg(n.e), '[]'::jsonb) from (
    select e from jsonb_array_elements(coalesce(v_new -> 'issues', '[]')) e
    except select e from jsonb_array_elements(coalesce(v_current.state -> 'issues', '[]')) e) n);
  if jsonb_typeof(coalesce(v_new -> 'issues', '[]')) is distinct from 'array' or exists (
    select 1 from jsonb_array_elements(v_added) e
    where jsonb_typeof(e) is distinct from 'object'
      or (char_length(coalesce(e ->> 'id', '')) between 1 and 200) is not true
      or e ->> 'id' like 'total:%'
      or not exists (select 1 from jsonb_array_elements(coalesce(v_new -> 'cartons', '[]')) c
        where c ->> 'id' = e ->> 'cartonId')
  ) then
    raise exception 'Stock issues need an identifier and an existing carton.' using errcode = '23514';
  end if;
  -- issues: every rule runs as if all stored issues were in the document; each carton's
  -- stored total stands in for its issues (balances and append-only checks stay exact).
  v_hist := (select coalesce(jsonb_agg(jsonb_build_object('id', 'total:' || t.carton_id,
      'cartonId', t.carton_id, 'qty', t.qty) order by t.carton_id), '[]'::jsonb)
    from (select i.carton_id, sum(i.qty) as qty from public.operator_issues i
      where i.workspace_id = p_workspace group by i.carton_id) t);
  perform operator_private.assert_factory_scope(v_current.state, v_new, v_factory); -- factory scope
  perform operator_private.assert_transition(
    v_current.state || jsonb_build_object('issues', v_hist || coalesce(v_current.state -> 'issues', '[]')),
    v_new || jsonb_build_object('issues', v_hist || coalesce(v_new -> 'issues', '[]')),
    v_uid);
  -- orders: the document's revision matters only when this command changes the document;
  -- order changes are checked against each order's own version instead.
  v_doc := (v_new - 'awbImports' - 'orders') || '{"events": [], "issues": []}'::jsonb;
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
  -- issues: an AWB with stock issues stays for traceability.
  if exists (
    select 1 from jsonb_array_elements(coalesce(v_new -> 'orders', '[]')) x
    join public.operator_issues i on i.workspace_id = p_workspace and i.order_id = x ->> 'id'
    where x ->> 'op' = 'delete'
  ) then
    raise exception 'This AWB has stock issues and stays for traceability.' using errcode = '23514';
  end if;
  insert into public.operator_issues (workspace_id, id, carton_id, order_id, qty, issue_day, body)
  select p_workspace, e ->> 'id', e ->> 'cartonId', coalesce(e ->> 'orderId', ''), (e ->> 'qty')::integer,
    (coalesce(operator_private.iso_time(e ->> 'at'), now()) at time zone 'Asia/Kuala_Lumpur')::date, e
  from jsonb_array_elements(v_added) e;
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
