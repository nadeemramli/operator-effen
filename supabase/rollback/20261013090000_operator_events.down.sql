-- Manual rollback for 20261013090000_operator_events.sql. Not run by the CLI.
-- Run before 20261012090000_operator_imports.down.sql. Confirm the selected project first.
-- Deploy the previous application build together with it: the earlier build reads audit
-- entries from the workspace document.
-- Every entry in operator_events is copied back into its site's document, newest first,
-- in the shape the app stores (identifiers stay the UUIDs they have in the table, so
-- re-applying 20261013090000 later moves the same entries back without duplicates, plus any
-- entry appended to the document meanwhile). If a site's entries no longer fit the 2 MB
-- document cap, the whole rollback aborts and nothing changes: export or archive first.
begin;
-- Restore the commit function of 20261012090000_operator_imports.sql (same signature, so
-- its grants are kept), with its comment.
create or replace function public.operator_commit_workspace(
  p_workspace uuid,
  p_expected_revision integer,
  p_command text,
  p_operation uuid,
  p_fingerprint text,
  p_state text,
  p_attestation text,
  p_import_effects text default null -- import effects
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
  v_message_v1 text; -- accepted without effects during the rollout
  v_new jsonb;
  v_effects jsonb; -- import effects
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
  -- import effects: v2 message, with the exact effects text as its last line. A commit
  -- without effects is also accepted under the previous v1 message, so applying this
  -- migration and deploying the server that signs v2 need not happen in the same minute;
  -- effects are only ever accepted under v2.
  v_message := concat_ws(E'\n', 'operator-commit-v2', p_workspace::text,
    p_expected_revision::text, v_uid::text, p_operation::text, p_command, p_fingerprint,
    encode(extensions.digest(convert_to(coalesce(p_state, ''), 'UTF8'), 'sha256'), 'hex'),
    encode(extensions.digest(convert_to(coalesce(p_import_effects, ''), 'UTF8'), 'sha256'), 'hex'));
  v_message_v1 := concat_ws(E'\n', 'operator-commit-v1', p_workspace::text,
    p_expected_revision::text, v_uid::text, p_operation::text, p_command, p_fingerprint,
    encode(extensions.digest(convert_to(coalesce(p_state, ''), 'UTF8'), 'sha256'), 'hex'));
  if (lower(p_attestation) =
      encode(extensions.hmac(convert_to(v_message, 'UTF8'), v_secret, 'sha256'), 'hex')
    or (p_import_effects is null and lower(p_attestation) =
      encode(extensions.hmac(convert_to(v_message_v1, 'UTF8'), v_secret, 'sha256'), 'hex'))) is not true then
    raise exception 'This change was not validated by the Operator server.' using errcode = '42501';
  end if;
  begin
    v_new := p_state::jsonb;
    v_effects := p_import_effects::jsonb; -- import effects
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
  -- import effects: applied with the document update or not at all.
  perform operator_private.apply_import_effects(p_workspace, p_command, v_current.state, v_new,
    v_effects, v_uid);
  return query select v_new, v_current.revision + 1, false;
end
$$;
comment on function public.operator_commit_workspace(uuid, integer, text, uuid, text, text, text, text) is
  'Commits a server-validated, signed transition for the signed-in member, with its upload effects. See 20261005090000 and 20261012090000.';

-- Entries back into the documents (newest first, ahead of any entries a document holds).
update public.operator_workspaces w
set state = w.state || jsonb_build_object('events', x.events
    || case when jsonb_typeof(w.state -> 'events') = 'array' then w.state -> 'events' else '[]'::jsonb end),
  revision = w.revision + 1,
  updated_at = now()
from (
  select e.workspace_id, jsonb_agg(
      jsonb_build_object('id', e.id::text, 'entity', e.entity, 'action', e.action,
        'detail', e.detail, 'actor', e.actor, 'at', operator_private.iso(e.at))
      || case when e.recorder = '{}'::jsonb then '{}'::jsonb
        else jsonb_build_object('recorder', e.recorder) end
      || case when e.performer is null then '{}'::jsonb
        else jsonb_build_object('performer', e.performer) end
      || case when e.occurred_at is null then '{}'::jsonb
        else jsonb_build_object('occurredAt', operator_private.iso(e.occurred_at)) end
      order by e.seq desc) as events
  from public.operator_events e
  group by e.workspace_id) x
where w.id = x.workspace_id;
-- A document without the key (written by hand) gets its empty list back.
update public.operator_workspaces w
set state = w.state || '{"events": []}'::jsonb
where not w.state ? 'events';

drop function operator_private.append_events(uuid, jsonb, uuid, text, uuid);
drop function operator_private.backfill_events(uuid, jsonb);
drop table public.operator_events;
commit;
