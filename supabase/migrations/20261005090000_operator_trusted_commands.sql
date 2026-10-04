-- Repair for 20261004090000_operator_memberships.sql (OPER-2/4/5, readiness #9/#10).
--
-- Problem: operator_commit_workspace accepted any replacement state from any active
-- supervisor and compared only top-level keys, so a direct RPC call could rewrite audit
-- history, forge recorders or transfer an incomplete batch.
--
-- Trust boundary after this migration:
--   * The Operator API server validates every command with the domain rules and signs the
--     resulting transition (HMAC-SHA256, key held only by the server and in operator_private).
--   * The database still authenticates the caller from the Supabase JWT (auth.uid()), checks
--     the active membership, site and per-command capability, verifies the signature over the
--     exact state text, the caller, command, operation ID and expected revision, and enforces
--     structural invariants (append-only history, attribution, stock balances, custody and
--     route gates) itself. Operation results and the commit audit are written atomically.
--   * No service-role key is used. A caller without the server key cannot commit anything;
--     a server-key holder still cannot act as another user or bypass the invariants.
-- Authorization and invariant checks fail closed: a guard proceeds only when its whole
-- condition IS TRUE; NULL (unknown caller, missing field) is treated as a denial.
-- Limitation kept: state is still one JSON document per site with one revision (#10).
-- Rollback: supabase/rollback/20261005090000_operator_trusted_commands.down.sql.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------------------
-- Roles, scopes and capabilities (owner policy 2026-10-05)
-- ---------------------------------------------------------------------------------------
alter table public.operator_memberships drop constraint operator_memberships_role_check;
alter table public.operator_memberships add constraint operator_memberships_role_check
  check (role in ('production', 'intake', 'outbound', 'admin', 'hr', 'management',
                  'packer', 'driver', 'assistant'));
alter table public.operator_memberships alter column workspace_id drop not null;
alter table public.operator_memberships
  add column scope text not null default 'site' check (scope in ('site', 'all-sites')),
  add column granted_by uuid references auth.users(id) on delete set null,
  add column updated_at timestamptz not null default now();
-- Cross-site visibility exists only for office admin, HR and management.
alter table public.operator_memberships add constraint operator_memberships_scope_shape check (
  (scope = 'site' and workspace_id is not null)
  or (scope = 'all-sites' and workspace_id is null and role in ('admin', 'hr', 'management'))
);
create unique index operator_memberships_all_sites_user
  on public.operator_memberships (user_id) where scope = 'all-sites';

-- Reference data (read-only to members; kept in sync with apps/web/src/lib/access.ts).
create table public.operator_role_capabilities (
  role text not null,
  capability text not null,
  primary key (role, capability)
);
insert into public.operator_role_capabilities (role, capability) values
  ('production', 'production.plan'), ('production', 'stage.record'),
  ('production', 'stage.correct'), ('production', 'machines.manage'),
  ('production', 'day.close'), ('production', 'feedback.post'),
  ('production', 'members.manage'),
  ('intake', 'stage.record'), ('intake', 'stage.correct'), ('intake', 'machines.manage'),
  ('intake', 'stock.receive'), ('intake', 'stock.adjust'), ('intake', 'day.close'),
  ('intake', 'feedback.post'), ('intake', 'members.manage'),
  ('outbound', 'orders.enter'), ('outbound', 'outbound.fulfil'),
  ('outbound', 'outbound.correct'), ('outbound', 'sources.read'), ('outbound', 'day.close'),
  ('outbound', 'feedback.post'), ('outbound', 'members.manage'),
  ('admin', 'orders.import'), ('admin', 'orders.enter'), ('admin', 'sources.read'),
  ('admin', 'feedback.post'),
  ('hr', 'members.manage'), ('hr', 'feedback.post'),
  ('management', 'review.comment'), ('management', 'sources.read'),
  ('management', 'feedback.post'),
  ('packer', 'feedback.post'), ('driver', 'feedback.post'), ('assistant', 'feedback.post');

create table public.operator_command_rules (
  command text primary key,
  capability text not null,
  state_keys text[] not null
);
insert into public.operator_command_rules (command, capability, state_keys) values
  ('batch', 'production.plan', '{batches,events}'),
  ('route-review', 'production.plan', '{batches,events}'),
  ('step', 'production.plan', '{batches,events}'),
  ('transfer', 'production.plan', '{batches,events}'),
  ('machine', 'stage.record', '{batches,events}'),
  ('stage-rework', 'stage.record', '{batches,events}'),
  ('change-step-pic', 'stage.correct', '{batches,events}'),
  ('stage-correct', 'stage.correct', '{batches,events}'),
  ('machine-create', 'machines.manage', '{machines,events}'),
  ('machine-update', 'machines.manage', '{machines,events}'),
  ('machine-deactivate', 'machines.manage', '{machines,events}'),
  ('machine-reactivate', 'machines.manage', '{machines,events}'),
  ('receive', 'stock.receive', '{cartons,events}'),
  ('receive-ady', 'stock.receive', '{adypocideReceipts,events}'),
  ('stock-in-ady', 'stock.receive', '{cartons,adypocideReceipts,events}'),
  ('count', 'stock.receive', '{counts,events}'),
  ('adjust', 'stock.adjust', '{adjustments,counts,events}'),
  ('order', 'orders.enter', '{orders,events}'),
  ('edit-order', 'orders.enter', '{orders,events}'),
  ('review-order', 'orders.enter', '{orders,events}'),
  ('split-order', 'orders.enter', '{orders,events}'),
  ('import-save', 'orders.import', '{awbImports,events}'),
  ('import-release', 'orders.import', '{awbImports,orders,events}'),
  ('import-receive', 'outbound.fulfil', '{awbImports,orders,events}'),
  ('sort-count', 'outbound.fulfil', '{sortCounts,events}'),
  ('assign-package', 'outbound.fulfil', '{orders,events}'),
  ('assign-orders', 'outbound.fulfil', '{orders,events}'),
  ('print-orders', 'outbound.fulfil', '{orders,events}'),
  ('move-orders', 'outbound.fulfil', '{orders,events}'),
  ('print', 'outbound.fulfil', '{orders,events}'),
  ('issue-orders', 'outbound.fulfil', '{issues,events}'),
  ('issue', 'outbound.fulfil', '{issues,events}'),
  ('pack', 'outbound.fulfil', '{orders,events}'),
  ('dispatch', 'outbound.fulfil', '{orders,events}'),
  ('correct', 'outbound.correct', '{orders,events}'),
  ('review', 'review.comment', '{notes,events}'),
  ('feedback', 'feedback.post', '{notes}'),
  ('close', 'day.close', '{closedDays,events}');

-- Which roles each role may grant or revoke. HR: any role, any site. Site supervisors:
-- view-only staff at their own site only.
create table public.operator_grantable_roles (
  grantor_role text not null,
  grantable_role text not null,
  primary key (grantor_role, grantable_role)
);
insert into public.operator_grantable_roles (grantor_role, grantable_role)
select 'hr', r from unnest(array['production', 'intake', 'outbound', 'admin', 'hr',
  'management', 'packer', 'driver', 'assistant']) r
union all
select g, r from unnest(array['production', 'intake', 'outbound']) g,
  unnest(array['packer', 'driver', 'assistant']) r;

alter table public.operator_role_capabilities enable row level security;
alter table public.operator_command_rules enable row level security;
alter table public.operator_grantable_roles enable row level security;
revoke all on public.operator_role_capabilities, public.operator_command_rules,
  public.operator_grantable_roles from anon, authenticated;
grant select on public.operator_role_capabilities, public.operator_command_rules,
  public.operator_grantable_roles to authenticated;
create policy "reference data" on public.operator_role_capabilities for select to authenticated using (true);
create policy "reference data" on public.operator_command_rules for select to authenticated using (true);
create policy "reference data" on public.operator_grantable_roles for select to authenticated using (true);

-- Site policy: optional {"<role>": ["capability", ...]} narrowing per site. Missing role =
-- role defaults. A site can never grant a capability outside the role's ceiling.
alter table public.operator_workspaces alter column write_policy set default '{}'::jsonb;
update public.operator_workspaces
set write_policy = write_policy - 'admin_imports' - 'management_comments';

-- Active role at a workspace: site membership first, then an all-sites membership.
create or replace function public.operator_active_role(p_workspace uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
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

create function public.operator_capabilities(p_workspace uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(c.capability order by c.capability), '{}')
  from public.operator_role_capabilities c
  join public.operator_workspaces w on w.id = p_workspace
  where c.role = public.operator_active_role(p_workspace)
    and (not (w.write_policy ? c.role) or (w.write_policy -> c.role) ? c.capability)
$$;
create function public.operator_has_capability(p_workspace uuid, p_capability text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_capability = any (public.operator_capabilities(p_workspace))
$$;
revoke all on function public.operator_capabilities(uuid),
  public.operator_has_capability(uuid, text) from public, anon;
grant execute on function public.operator_capabilities(uuid),
  public.operator_has_capability(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------
-- Trusted commit path
-- ---------------------------------------------------------------------------------------
create schema if not exists operator_private;
revoke all on schema operator_private from public, anon, authenticated;
-- Shared with the API server (OPERATOR_COMMIT_SECRET). Set by an administrator; never
-- exposed through the Data API.
create table operator_private.server_keys (
  id text primary key,
  secret bytea not null check (octet_length(secret) >= 32),
  created_at timestamptz not null default now()
);
revoke all on operator_private.server_keys from public, anon, authenticated;

-- One row per committed operation: idempotency record and commit audit in one.
create table public.operator_commits (
  workspace_id uuid not null references public.operator_workspaces(id) on delete restrict,
  operation_id uuid not null,
  user_id uuid not null,
  role text not null,
  command text not null,
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  result_revision integer not null,
  committed_at timestamptz not null default now(),
  primary key (workspace_id, operation_id)
);
create index operator_commits_user on public.operator_commits (user_id, committed_at desc);
alter table public.operator_commits enable row level security;
revoke all on public.operator_commits from anon, authenticated;
grant select on public.operator_commits to authenticated;
create policy "members read own commits" on public.operator_commits for select to authenticated
  using (user_id = (select auth.uid()) and public.operator_active_role(workspace_id) is not null);

drop function public.operator_commit_workspace(uuid, integer, jsonb);
drop function public.operator_writable_keys(text, jsonb);

create function operator_private.assert_transition(p_old jsonb, p_new jsonb, p_uid uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  k text;
begin
  -- Append-only collections: every earlier record is kept unchanged.
  foreach k in array array['events', 'issues', 'adjustments', 'notes', 'sortCounts'] loop
    if jsonb_typeof(coalesce(p_new -> k, '[]')) <> 'array' or exists (
      select e from jsonb_array_elements(coalesce(p_old -> k, '[]')) e
      except
      select e from jsonb_array_elements(coalesce(p_new -> k, '[]')) e
    ) then
      raise exception 'Existing % records cannot be changed or removed.', k using errcode = '23514';
    end if;
  end loop;
  -- New audit entries and notes are attributed to the signed-in user.
  if exists (
    select 1 from (
      select e from jsonb_array_elements(coalesce(p_new -> 'events', '[]')) e
      except select e from jsonb_array_elements(coalesce(p_old -> 'events', '[]')) e
    ) n where coalesce(n.e -> 'recorder' ->> 'userId', '') <> p_uid::text
  ) then
    raise exception 'New audit entries must be attributed to the signed-in user.' using errcode = '23514';
  end if;
  if exists (
    select 1 from (
      select e from jsonb_array_elements(coalesce(p_new -> 'notes', '[]')) e
      except select e from jsonb_array_elements(coalesce(p_old -> 'notes', '[]')) e
    ) n where coalesce(n.e -> 'author' ->> 'userId', '') <> p_uid::text
  ) then
    raise exception 'New notes must be attributed to the signed-in user.' using errcode = '23514';
  end if;
  -- Stock movements are positive whole quantities.
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_new -> 'issues', '[]')) i
    where coalesce(jsonb_typeof(i -> 'qty'), 'missing') <> 'number'
      or ((i ->> 'qty')::numeric > 0 and (i ->> 'qty')::numeric = trunc((i ->> 'qty')::numeric)) is not true
  ) then
    raise exception 'Stock issues must be positive whole quantities.' using errcode = '23514';
  end if;
  -- Every carton has a non-negative whole received quantity.
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_new -> 'cartons', '[]')) c
    where coalesce(jsonb_typeof(c -> 'qty'), 'missing') <> 'number'
      or ((c ->> 'qty')::numeric >= 0 and (c ->> 'qty')::numeric = trunc((c ->> 'qty')::numeric)) is not true
      or coalesce(c ->> 'id', '') = ''
  ) then
    raise exception 'Cartons need an identifier and a whole received quantity.' using errcode = '23514';
  end if;
  -- Received cartons keep their quantity, batch, product and unit, and are never removed.
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_old -> 'cartons', '[]')) o
    where not exists (
      select 1 from jsonb_array_elements(coalesce(p_new -> 'cartons', '[]')) n
      where n ->> 'id' = o ->> 'id' and n -> 'qty' = o -> 'qty'
        and n ->> 'batchId' is not distinct from o ->> 'batchId'
        and n ->> 'product' = o ->> 'product' and n ->> 'unit' = o ->> 'unit')
  ) then
    raise exception 'Received stock cannot be rewritten.' using errcode = '23514';
  end if;
  -- Inventory conservation: no carton balance may fall below zero (or further below an
  -- existing historical deficit). Aggregated per carton to stay linear in document size.
  if exists (
    with docs(version, doc) as (values ('old', p_old), ('new', p_new)),
    issued as (
      select d.version, i ->> 'cartonId' as id, sum((i ->> 'qty')::numeric) as q
      from docs d, jsonb_array_elements(coalesce(d.doc -> 'issues', '[]')) i group by 1, 2),
    boxed as (
      select d.version, b ->> 'sourceId' as id,
        sum((b ->> 'boxes')::numeric * (b ->> 'ratio')::numeric + (b ->> 'loss')::numeric) as q
      from docs d, jsonb_array_elements(coalesce(d.doc -> 'boxing', '[]')) b group by 1, 2),
    adjusted as (
      select d.version, a ->> 'cartonId' as id, sum((a ->> 'delta')::numeric) as q
      from docs d, jsonb_array_elements(coalesce(d.doc -> 'adjustments', '[]')) a group by 1, 2),
    balances as (
      select d.version, c ->> 'id' as id,
        (c ->> 'qty')::numeric - coalesce(i.q, 0) - coalesce(x.q, 0) + coalesce(a.q, 0) as available
      from docs d
      cross join jsonb_array_elements(coalesce(d.doc -> 'cartons', '[]')) c
      left join issued i on i.version = d.version and i.id = c ->> 'id'
      left join boxed x on x.version = d.version and x.id = c ->> 'id'
      left join adjusted a on a.version = d.version and a.id = c ->> 'id')
    select 1 from balances n
    left join balances o on o.version = 'old' and o.id = n.id
    where n.version = 'new'
      and (n.available is null or (n.available < 0 and n.available < coalesce(o.available, 0)))
  ) then
    raise exception 'This change would take a carton below zero stock.' using errcode = '23514';
  end if;
  -- Batches: never removed; identity, custody and route snapshots are fixed once set.
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_old -> 'batches', '[]')) o
    left join (
      select n ->> 'id' as id, n from jsonb_array_elements(coalesce(p_new -> 'batches', '[]')) n
    ) x on x.id = o ->> 'id'
    where x.n is null
      or x.n ->> 'code' is distinct from o ->> 'code'
      or x.n ->> 'product' is distinct from o ->> 'product'
      or (o ->> 'transferredAt' is not null and (
        x.n ->> 'transferredAt' is distinct from o ->> 'transferredAt'
        or x.n ->> 'transferPic' is distinct from o ->> 'transferPic'))
      or coalesce((x.n ->> 'sent')::numeric, 0) < coalesce((o ->> 'sent')::numeric, 0)
      or (o -> 'route' is not null and (
        x.n -> 'route' -> 'id' is distinct from o -> 'route' -> 'id'
        or x.n -> 'route' -> 'stages' is distinct from o -> 'route' -> 'stages'))
      or jsonb_array_length(coalesce(x.n -> 'steps', '[]')) < jsonb_array_length(coalesce(o -> 'steps', '[]'))
      or exists (
        select r from jsonb_array_elements(coalesce(o -> 'revisions', '[]')) r
        except select r from jsonb_array_elements(coalesce(x.n -> 'revisions', '[]')) r)
  ) then
    raise exception 'Batch identity, custody, route or revision history cannot be rewritten.' using errcode = '23514';
  end if;
  -- Step history: completion is not undone; PIC history, corrections and rework are
  -- append-only; new entries are attributed to the signed-in user.
  if exists (
    with new_steps as (
      select nb ->> 'id' as batch, ns.pos, ns.step
      from jsonb_array_elements(coalesce(p_new -> 'batches', '[]')) nb
      cross join lateral jsonb_array_elements(coalesce(nb -> 'steps', '[]')) with ordinality ns(step, pos)),
    old_steps as (
      select ob ->> 'id' as batch, os.pos, os.step
      from jsonb_array_elements(coalesce(p_old -> 'batches', '[]')) ob
      cross join lateral jsonb_array_elements(coalesce(ob -> 'steps', '[]')) with ordinality os(step, pos))
    select 1
    from new_steps ns
    left join old_steps o on o.batch = ns.batch and o.pos = ns.pos
    -- Unchanged steps need no further checks.
    where ns.step is distinct from o.step and (
      (coalesce((o.step ->> 'done')::boolean, false) and not coalesce((ns.step ->> 'done')::boolean, false))
      or exists (
        select h from jsonb_array_elements(coalesce(o.step -> 'picHistory', '[]')) h
        except select h from jsonb_array_elements(coalesce(ns.step -> 'picHistory', '[]')) h)
      or exists (
        select h from jsonb_array_elements(coalesce(o.step -> 'corrections', '[]')) h
        except select h from jsonb_array_elements(coalesce(ns.step -> 'corrections', '[]')) h)
      or exists (
        select h from jsonb_array_elements(coalesce(o.step -> 'occurrences', '[]')) h
        except select h from jsonb_array_elements(coalesce(ns.step -> 'occurrences', '[]')) h)
      or exists (
        select 1 from (
          select h from jsonb_array_elements(coalesce(ns.step -> 'picHistory', '[]')
            || coalesce(ns.step -> 'corrections', '[]') || coalesce(ns.step -> 'occurrences', '[]')) h
          except
          select h from jsonb_array_elements(coalesce(o.step -> 'picHistory', '[]')
            || coalesce(o.step -> 'corrections', '[]') || coalesce(o.step -> 'occurrences', '[]')) h
        ) added where coalesce(added.h -> 'recordedBy' ->> 'userId', '') <> p_uid::text)
      or (ns.step -> 'recordedBy' is distinct from o.step -> 'recordedBy'
        and coalesce(ns.step -> 'recordedBy' ->> 'userId', '') <> p_uid::text))
  ) then
    raise exception 'Stage history must be append-only and attributed to the signed-in user.' using errcode = '23514';
  end if;
  -- New revision flags are attributed to the signed-in user.
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_new -> 'batches', '[]')) nb,
      jsonb_array_elements(coalesce(nb -> 'revisions', '[]')) r
    where not exists (
      select 1 from jsonb_array_elements(coalesce(p_old -> 'batches', '[]')) ob,
        jsonb_array_elements(coalesce(ob -> 'revisions', '[]')) r2
      where ob ->> 'id' = nb ->> 'id' and r2 = r)
      and coalesce(r -> 'recordedBy' ->> 'userId', '') <> p_uid::text
  ) then
    raise exception 'Revision flags must be attributed to the signed-in user.' using errcode = '23514';
  end if;
  -- Transfer gate: a batch newly sent with a route snapshot needs every stage completed
  -- with a PIC (five stages for sachet-v2). Unsnapshotted legacy batches are handled by the
  -- server's explicit route review.
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_new -> 'batches', '[]')) nb
    where nb -> 'route' is not null and nb ->> 'transferredAt' is not null
      and not exists (
        select 1 from jsonb_array_elements(coalesce(p_old -> 'batches', '[]')) ob
        where ob ->> 'id' = nb ->> 'id' and ob ->> 'transferredAt' is not null)
      and (coalesce(jsonb_typeof(nb -> 'route' -> 'stages'), 'missing') <> 'array'
        or jsonb_array_length(nb -> 'route' -> 'stages') = 0
        or exists (
        select 1 from jsonb_array_elements_text(nb -> 'route' -> 'stages') stage
        where not exists (
          select 1 from jsonb_array_elements(coalesce(nb -> 'steps', '[]')) st
          where st ->> 'sachetStage' = stage
            and coalesce((st ->> 'done')::boolean, false)
            and coalesce(st ->> 'pic', '') <> '')))
  ) then
    raise exception 'Every stage of the batch route needs a completed record with a PIC before transfer.' using errcode = '23514';
  end if;
  -- Machines are never deleted; their change history is append-only and attributed.
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_old -> 'machines', '[]')) om
    left join lateral (
      select n from jsonb_array_elements(coalesce(p_new -> 'machines', '[]')) n
      where n ->> 'id' = om ->> 'id' limit 1) x on true
    where x.n is null
      or x.n ->> 'siteId' is distinct from om ->> 'siteId'
      or exists (
        select h from jsonb_array_elements(coalesce(om -> 'history', '[]')) h
        except select h from jsonb_array_elements(coalesce(x.n -> 'history', '[]')) h)
  ) or exists (
    select 1 from jsonb_array_elements(coalesce(p_new -> 'machines', '[]')) nm,
      jsonb_array_elements(coalesce(nm -> 'history', '[]')) h
    where not exists (
      select 1 from jsonb_array_elements(coalesce(p_old -> 'machines', '[]')) om,
        jsonb_array_elements(coalesce(om -> 'history', '[]')) h2
      where om ->> 'id' = nm ->> 'id' and h2 = h)
      and coalesce(h -> 'recordedBy' ->> 'userId', '') <> p_uid::text
  ) then
    raise exception 'Machine records and history cannot be rewritten.' using errcode = '23514';
  end if;
end
$$;
revoke all on function operator_private.assert_transition(jsonb, jsonb, uuid) from public;

-- The only operational write path.
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
  v_role := public.operator_active_role(p_workspace);
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

-- ---------------------------------------------------------------------------------------
-- Membership administration contract (for the future HR / site-supervisor screen)
-- ---------------------------------------------------------------------------------------
create table public.operator_membership_audit (
  id bigint generated always as identity primary key,
  action text not null check (action in ('grant', 'change', 'revoke', 'policy')),
  workspace_id uuid references public.operator_workspaces(id) on delete restrict,
  membership_id uuid,
  target_user uuid,
  actor_user uuid not null,
  actor_role text not null,
  before jsonb,
  after jsonb,
  reason text not null check (char_length(reason) between 1 and 1000),
  at timestamptz not null default now()
);
alter table public.operator_membership_audit enable row level security;
revoke all on public.operator_membership_audit from anon, authenticated;
grant select on public.operator_membership_audit to authenticated;

-- Caller's role for administration: an all-sites HR membership, else the site role.
create function operator_private.admin_role(p_workspace uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select 'hr' from public.operator_memberships m
     where m.user_id = (select auth.uid()) and m.active and m.revoked_at is null
       and m.role = 'hr' and m.scope = 'all-sites'),
    case when p_workspace is null then null else public.operator_active_role(p_workspace) end)
$$;
create function operator_private.may_grant(p_workspace uuid, p_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    exists (
      select 1 from public.operator_grantable_roles g
      where g.grantor_role = operator_private.admin_role(p_workspace) and g.grantable_role = p_role)
    and (operator_private.admin_role(p_workspace) = 'hr'
      or public.operator_has_capability(p_workspace, 'members.manage')),
    false)
$$;
create policy "HR and site supervisors read membership audit" on public.operator_membership_audit
for select to authenticated using (
  operator_private.admin_role(workspace_id) = 'hr'
  or (workspace_id is not null and public.operator_has_capability(workspace_id, 'members.manage'))
);
-- Administrators can see the memberships they are allowed to manage.
create policy "membership administrators read managed rows" on public.operator_memberships
for select to authenticated using (
  operator_private.admin_role(workspace_id) = 'hr'
  or (workspace_id is not null and operator_private.may_grant(workspace_id, role))
);

create function public.operator_grant_membership(
  p_workspace uuid,
  p_user uuid,
  p_role text,
  p_display_name text,
  p_staff_profile_id text,
  p_reason text,
  p_scope text default 'site'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor_role text;
  v_before public.operator_memberships%rowtype;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'Sign in again.' using errcode = '28000';
  end if;
  if p_user is null or p_role is null or coalesce(trim(p_display_name), '') = '' then
    raise exception 'Choose the person, role and display name.' using errcode = '22023';
  end if;
  if p_user is not distinct from v_uid then
    raise exception 'You cannot change your own access.' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Enter a reason for this access change.' using errcode = '22023';
  end if;
  if p_scope = 'all-sites' then
    v_actor_role := operator_private.admin_role(null);
    if v_actor_role is distinct from 'hr' then
      raise exception 'Only HR can grant access across all sites.' using errcode = '42501';
    end if;
    select * into v_before from public.operator_memberships m
    where m.user_id = p_user and m.scope = 'all-sites' for update;
  elsif p_scope = 'site' then
    v_actor_role := operator_private.admin_role(p_workspace);
    if p_workspace is null or operator_private.may_grant(p_workspace, p_role) is not true then
      raise exception 'You cannot grant % access at this site.', p_role using errcode = '42501';
    end if;
    select * into v_before from public.operator_memberships m
    where m.user_id = p_user and m.workspace_id = p_workspace for update;
    -- Changing someone's existing access requires authority over their current role too.
    if v_before.id is not null
      and operator_private.may_grant(p_workspace, v_before.role) is not true then
      raise exception 'You cannot change the access of a % member.', v_before.role using errcode = '42501';
    end if;
  else
    raise exception 'Choose site or all-sites scope.' using errcode = '22023';
  end if;
  if v_before.id is null then
    insert into public.operator_memberships (workspace_id, user_id, role, display_name,
      staff_profile_id, scope, granted_by)
    values (case when p_scope = 'site' then p_workspace end, p_user, p_role, p_display_name,
      p_staff_profile_id, p_scope, v_uid)
    returning id into v_id;
  else
    update public.operator_memberships m
    set role = p_role, display_name = p_display_name, staff_profile_id = p_staff_profile_id,
      active = true, revoked_at = null, granted_by = v_uid, updated_at = now()
    where m.id = v_before.id
    returning m.id into v_id;
  end if;
  insert into public.operator_membership_audit (action, workspace_id, membership_id,
    target_user, actor_user, actor_role, before, after, reason)
  select case when v_before.id is null then 'grant' else 'change' end,
    m.workspace_id, m.id, p_user, v_uid, v_actor_role,
    case when v_before.id is null then null else to_jsonb(v_before) end, to_jsonb(m), p_reason
  from public.operator_memberships m where m.id = v_id;
  return v_id;
end
$$;

create function public.operator_revoke_membership(p_membership uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_before public.operator_memberships%rowtype;
  v_actor_role text;
begin
  if v_uid is null then
    raise exception 'Sign in again.' using errcode = '28000';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Enter a reason for this access change.' using errcode = '22023';
  end if;
  select * into v_before from public.operator_memberships m where m.id = p_membership for update;
  v_actor_role := case when v_before.id is not null
    then operator_private.admin_role(v_before.workspace_id) end;
  -- Fail closed: proceed only when the whole permission expression IS TRUE. An unknown
  -- membership, a caller without an active role (outsider, revoked, another site) or any
  -- NULL is a denial, reported identically so membership IDs cannot be probed.
  if (v_before.id is not null
    and v_actor_role is not null
    and v_before.user_id is distinct from v_uid
    and (v_actor_role = 'hr'
      or (v_before.workspace_id is not null
        and operator_private.may_grant(v_before.workspace_id, v_before.role)))) is not true then
    raise exception 'You cannot revoke this access.' using errcode = '42501';
  end if;
  update public.operator_memberships m
  set active = false, revoked_at = now(), updated_at = now()
  where m.id = p_membership;
  insert into public.operator_membership_audit (action, workspace_id, membership_id,
    target_user, actor_user, actor_role, before, after, reason)
  select 'revoke', m.workspace_id, m.id, m.user_id, v_uid, v_actor_role, to_jsonb(v_before),
    to_jsonb(m), p_reason
  from public.operator_memberships m where m.id = p_membership;
end
$$;

create function public.operator_set_site_policy(p_workspace uuid, p_policy jsonb, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_before jsonb;
begin
  if operator_private.admin_role(null) is distinct from 'hr' or p_workspace is null then
    raise exception 'Only HR can change site capability policy.' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Enter a reason for this policy change.' using errcode = '22023';
  end if;
  if (jsonb_typeof(p_policy) = 'object') is not true or exists (
    select 1 from jsonb_each(p_policy) e
    where jsonb_typeof(e.value) <> 'array' or exists (
      select 1 from jsonb_array_elements_text(e.value) cap
      where not exists (select 1 from public.operator_role_capabilities c
        where c.role = e.key and c.capability = cap))
  ) then
    raise exception 'A site policy can only narrow capabilities within each role.' using errcode = '22023';
  end if;
  select w.write_policy into v_before from public.operator_workspaces w
  where w.id = p_workspace for update;
  if not found then
    raise exception 'Site not found.' using errcode = '22023';
  end if;
  update public.operator_workspaces w set write_policy = p_policy, updated_at = now()
  where w.id = p_workspace;
  insert into public.operator_membership_audit (action, workspace_id, actor_user, actor_role,
    before, after, reason)
  values ('policy', p_workspace, v_uid, 'hr', v_before, p_policy, p_reason);
end
$$;
revoke all on function public.operator_grant_membership(uuid, uuid, text, text, text, text, text),
  public.operator_revoke_membership(uuid, text),
  public.operator_set_site_policy(uuid, jsonb, text) from public, anon;
grant execute on function public.operator_grant_membership(uuid, uuid, text, text, text, text, text),
  public.operator_revoke_membership(uuid, text),
  public.operator_set_site_policy(uuid, jsonb, text) to authenticated;
revoke all on function operator_private.admin_role(uuid), operator_private.may_grant(uuid, text)
  from public;
grant usage on schema operator_private to authenticated;
grant execute on function operator_private.admin_role(uuid), operator_private.may_grant(uuid, text)
  to authenticated;

-- ---------------------------------------------------------------------------------------
-- Operational source documents: <workspace id>/<sha256>.pdf, shared by site capability.
-- The fictional sandbox keeps its own awb-draft-sources bucket and per-account folders.
-- ---------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('operator-sources', 'operator-sources', false, 20971520, array['application/pdf']);

create function public.operator_source_access(p_name text, p_capability text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}\.pdf$'
    then public.operator_has_capability(split_part(p_name, '/', 1)::uuid, p_capability)
    else false
  end
$$;
revoke all on function public.operator_source_access(text, text) from public, anon;
grant execute on function public.operator_source_access(text, text) to authenticated;

create policy "site importers upload operational sources" on storage.objects
for insert to authenticated with check (
  bucket_id = 'operator-sources' and public.operator_source_access(name, 'orders.import')
);
create policy "authorized colleagues read operational sources" on storage.objects
for select to authenticated using (
  bucket_id = 'operator-sources' and (
    public.operator_source_access(name, 'sources.read')
    or public.operator_source_access(name, 'orders.import'))
);

comment on function public.operator_commit_workspace(uuid, integer, text, uuid, text, text, text) is
  'Commits a server-validated, signed transition for the signed-in member. See migration header.';
