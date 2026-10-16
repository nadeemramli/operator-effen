-- Rollback for 20261017090000_operator_orders.sql: puts each site's orders back into its
-- document (newest work date first), restores the commit function of
-- 20261015090000_operator_imports_and_events.sql and drops the orders table and lookup.
-- Deploy the application version without the orders table first. The document check (4 MB)
-- refuses the move if a site's orders no longer fit; then keep the table.

update public.operator_workspaces w
set state = w.state || jsonb_build_object('orders', coalesce((
    select jsonb_agg(o.doc order by o.order_date desc nulls last, o.id)
    from public.operator_orders o where o.workspace_id = w.id), '[]'::jsonb)),
  revision = w.revision + 1, updated_at = now();

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
  perform operator_private.assert_factory_scope(v_current.state, v_new, v_factory); -- factory scope
  perform operator_private.assert_transition(v_current.state, v_new, v_uid);
  if v_current.revision is distinct from p_expected_revision then
    return;
  end if;
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
  v_doc := (v_new - 'awbImports') || '{"events": []}'::jsonb;
  update public.operator_workspaces w
  set state = v_doc, revision = w.revision + 1, updated_at = now()
  where w.id = p_workspace;
  insert into public.operator_commits (workspace_id, operation_id, user_id, role, command,
    fingerprint, result_revision)
  values (p_workspace, p_operation, v_uid, v_role, p_command, p_fingerprint,
    v_current.revision + 1);
  return query select v_doc, v_current.revision + 1, false;
end
$$;

drop function public.operator_orders_for(uuid, text[], text[], text[], text[]);
drop table public.operator_orders;
