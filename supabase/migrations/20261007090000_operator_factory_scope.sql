-- Per-factory scope for production supervisors (follows 20261006090000_operator_driver_trips.sql).
--
-- Problem: capabilities are per role per site, so both production supervisors at a site
-- could plan, record and correct batches for both factories (bottle/capsule and sachet).
-- The "All / Bottle / Sachet factory" toggle in the production screen was only a filter.
--
-- After this migration:
--   * A production membership may carry a factory ('bottle' or 'sachet'). NULL keeps the
--     current behaviour (both factories). Only production memberships may be scoped.
--   * operator_commit_workspace refuses, for a scoped member, any commit that adds, changes
--     or removes a batch whose product belongs to the other factory (or to no known factory),
--     and, for a bottle-scoped member, any change to the machine register (machines are the
--     sachet route's equipment). This is checked on the signed state itself, so it holds for
--     every command and for direct RPC calls, not only for the screens that hide the batches.
--   * The check fails closed: a batch change is allowed only when its product's factory IS
--     the member's factory; an unknown product or a missing field is a denial.
--   * operator_set_membership_factory lets HR set or clear the scope, with an audit row.
--     Until an HR user exists, the owner sets it with the SQL in
--     docs/sv-entry-and-sachet-route.md ("Factory scope").
-- Additive: new column (NULL for every existing row), new functions, and a replacement of
-- operator_commit_workspace with the same signature and grants.
-- Mirrors apps/web/src/lib/access.ts (factoryDenial / outOfFactory) and the product list in
-- apps/web/src/lib/draft.ts; tests/factory-scope.test.mjs checks they stay in step.
-- Rollback: supabase/rollback/20261007090000_operator_factory_scope.down.sql.

alter table public.operator_memberships
  add column factory text
    constraint operator_memberships_factory_check check (factory in ('bottle', 'sachet')),
  add constraint operator_memberships_factory_role check (factory is null or role = 'production');
comment on column public.operator_memberships.factory is
  'Production supervisors only: the one factory (bottle or sachet) whose batches this member may change. NULL = both.';

-- Factory of a product. Kept in sync with `products` in apps/web/src/lib/draft.ts.
create function operator_private.product_factory(p_product text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_product = 'ady' then 'sachet'
    when p_product in ('cav', 'gly', 'lip', 'syn') then 'bottle'
  end
$$;

-- Factory scope of the caller's active membership at a workspace; NULL = unscoped. Same
-- membership choice as public.operator_active_role (site membership before all-sites).
create function operator_private.active_factory(p_workspace uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.factory
  from public.operator_memberships m
  where m.user_id = (select auth.uid())
    and m.active
    and m.revoked_at is null
    and (m.workspace_id = p_workspace
      or (m.scope = 'all-sites'
        and exists (select 1 from public.operator_workspaces w where w.id = p_workspace)))
  order by (m.workspace_id is not null) desc
  limit 1
$$;

create function operator_private.assert_factory_scope(p_old jsonb, p_new jsonb, p_factory text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_factory is null then
    return;
  end if;
  -- Every batch version added or removed by this transition (a changed batch appears as its
  -- old and its new version) must belong to the member's factory.
  if exists (
    select 1 from (
      (select b from jsonb_array_elements(coalesce(p_new -> 'batches', '[]')) b
       except
       select b from jsonb_array_elements(coalesce(p_old -> 'batches', '[]')) b)
      union all
      (select b from jsonb_array_elements(coalesce(p_old -> 'batches', '[]')) b
       except
       select b from jsonb_array_elements(coalesce(p_new -> 'batches', '[]')) b)
    ) changed
    where (operator_private.product_factory(changed.b ->> 'product') = p_factory) is not true
  ) then
    raise exception 'Your access covers the % factory only. Ask that factory''s supervisor to record this batch.',
      p_factory using errcode = '42501';
  end if;
  -- The machine register holds sachet-route machines only.
  if (p_factory = 'sachet') is not true
    and coalesce(p_new -> 'machines', '[]') is distinct from coalesce(p_old -> 'machines', '[]') then
    raise exception 'Machines belong to the sachet factory. Your access covers the % factory only.',
      p_factory using errcode = '42501';
  end if;
end
$$;
revoke all on function operator_private.product_factory(text),
  operator_private.active_factory(uuid),
  operator_private.assert_factory_scope(jsonb, jsonb, text) from public;

-- Same as 20261005090000_operator_trusted_commands.sql, plus the factory scope (marked).
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

-- HR sets or clears a production supervisor's factory scope. Audited like other changes.
create function public.operator_set_membership_factory(
  p_membership uuid,
  p_factory text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_before public.operator_memberships%rowtype;
begin
  if v_uid is null then
    raise exception 'Sign in again.' using errcode = '28000';
  end if;
  if operator_private.admin_role(null) is distinct from 'hr' then
    raise exception 'Only HR can change a supervisor''s factory.' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Enter a reason for this access change.' using errcode = '22023';
  end if;
  if p_factory is not null and p_factory not in ('bottle', 'sachet') then
    raise exception 'Choose the bottle or sachet factory, or no factory.' using errcode = '22023';
  end if;
  select * into v_before from public.operator_memberships m where m.id = p_membership for update;
  if (v_before.id is not null
    and v_before.user_id is distinct from v_uid
    and v_before.active
    and v_before.revoked_at is null
    and v_before.role = 'production'
    and v_before.scope = 'site') is not true then
    raise exception 'Only an active production supervisor''s site access can be limited to a factory.'
      using errcode = '42501';
  end if;
  update public.operator_memberships m
  set factory = p_factory, granted_by = v_uid, updated_at = now()
  where m.id = p_membership;
  insert into public.operator_membership_audit (action, workspace_id, membership_id,
    target_user, actor_user, actor_role, before, after, reason)
  select 'change', m.workspace_id, m.id, m.user_id, v_uid, 'hr', to_jsonb(v_before),
    to_jsonb(m), p_reason
  from public.operator_memberships m where m.id = p_membership;
end
$$;
revoke all on function public.operator_set_membership_factory(uuid, text, text) from public, anon;
grant execute on function public.operator_set_membership_factory(uuid, text, text) to authenticated;
