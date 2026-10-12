-- Manual rollback for 20261012090000_operator_imports.sql. Not run by the CLI.
-- Run before 20261011090000_operator_remove_awbs.down.sql. Confirm the selected project
-- first. Deploy the previous application build together with it: the earlier API server
-- signs 'operator-commit-v1' messages and keeps uploads in the workspace document.
-- Uploads stored in operator_imports / operator_import_rows are NOT copied back into the
-- documents: export them first if they are still needed (orders they released stay in the
-- documents; their importId and importRowId then point at nothing).
begin;
-- Restore the commit function of 20261007090000_operator_factory_scope.sql (the last
-- migration that replaced it before 20261012090000), with its grants and comment.
drop function public.operator_commit_workspace(uuid, integer, text, uuid, text, text, text, text);
create function public.operator_commit_workspace(
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
  v_rule public.operator_command_rules%rowtype;
  v_current public.operator_workspaces%rowtype;
  v_prior public.operator_commits%rowtype;
  v_secret bytea;
  v_message text;
  v_new jsonb;
begin
  if v_uid is null then
    raise exception 'Sign in again before saving.' using errcode = '28000';
  end if;
  select * into v_current from public.operator_workspaces w where w.id = p_workspace for update;
  -- factory scope: role and factory are read in one statement, so from the same snapshot.
  select public.operator_active_role(p_workspace), operator_private.active_factory(p_workspace)
  into v_role, v_factory;
  if v_current.id is null or v_role is null then
    raise exception 'No active membership for this site.' using errcode = '42501';
  end if;
  -- A retried operation returns its established result without repeating effects.
  select * into v_prior from public.operator_commits c
  where c.workspace_id = p_workspace and c.operation_id = p_operation;
  if found then
    if v_prior.user_id is distinct from v_uid or v_prior.command is distinct from p_command
      or v_prior.fingerprint is distinct from p_fingerprint then
      raise exception 'This save ID was already used for a different change.' using errcode = 'PT409';
    end if;
    return query select v_current.state, v_current.revision, true;
    return;
  end if;
  select * into v_rule from public.operator_command_rules r where r.command = p_command;
  if not found then
    raise exception 'Unknown operational command.' using errcode = '42501';
  end if;
  if public.operator_has_capability(p_workspace, v_rule.capability) is not true then
    raise exception 'Your role at this site does not permit %.', v_rule.capability using errcode = '42501';
  end if;
  select k.secret into v_secret from operator_private.server_keys k where k.id = 'commit';
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
  perform operator_private.assert_factory_scope(v_current.state, v_new, v_factory); -- factory scope
  perform operator_private.assert_transition(v_current.state, v_new, v_uid);
  if v_current.revision is distinct from p_expected_revision then
    return;
  end if;
  update public.operator_workspaces w
  set state = v_new, revision = w.revision + 1, updated_at = now()
  where w.id = p_workspace;
  insert into public.operator_commits (workspace_id, operation_id, user_id, role, command,
    fingerprint, result_revision)
  values (p_workspace, p_operation, v_uid, v_role, p_command, p_fingerprint,
    v_current.revision + 1);
  return query select v_new, v_current.revision + 1, false;
end
$$;
revoke all on function public.operator_commit_workspace(uuid, integer, text, uuid, text, text, text)
  from public, anon;
grant execute on function public.operator_commit_workspace(uuid, integer, text, uuid, text, text, text)
  to authenticated;
comment on function public.operator_commit_workspace(uuid, integer, text, uuid, text, text, text) is
  'Commits a server-validated, signed transition for the signed-in member. See migration header.';

drop function public.operator_import_save(uuid, jsonb, jsonb, timestamptz);
drop function public.operator_import_receive(uuid, uuid, text);
drop function public.operator_import_list(uuid);
drop function public.operator_import_get(uuid, uuid);
drop function operator_private.apply_import_effects(uuid, text, jsonb, jsonb, jsonb, uuid);
drop function operator_private.import_json(uuid, boolean);
drop table public.operator_import_rows, public.operator_imports;
drop function operator_private.iso(timestamptz);
drop function operator_private.try_timestamptz(text);
drop function operator_private.legacy_uuid(text, text);
drop function operator_private.try_uuid(text);

-- Command rules as before 20261012090000.
insert into public.operator_command_rules (command, capability, state_keys) values
  ('import-save', 'orders.import', '{awbImports,events}'),
  ('import-receive', 'outbound.fulfil', '{awbImports,orders,events}');
update public.operator_command_rules set state_keys = '{awbImports,orders,events}'
where command in ('import-release', 'import-delete');
update public.operator_command_rules set state_keys = '{orders,awbImports,events}'
where command = 'remove-order';
commit;
