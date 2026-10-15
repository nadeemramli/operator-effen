-- AWB uploads and audit entries out of the workspace document (follows
-- 20261014090000_operator_workspace_capacity.sql). Work packages A and B of
-- docs/order-volume-plan-2026-10.md.
--
-- The document held every PDF upload with all its label rows, and every audit entry ever
-- written; together about 70% of the live site's bytes, growing with each AWB. They now
-- live in their own tables:
--   * public.operator_imports: one row per PDF upload (its label rows inside `doc`).
--   * public.operator_events: one row per audit entry; insert-only.
-- Members of a site read both (same rule as the document); nobody writes them directly.
--
-- public.operator_commit_workspace keeps its signature and signed message: the API server
-- still signs one logical state, which carries, besides the document,
--   * `events`: only the audit entries this command added (the stored document keeps
--     `events: []`), and
--   * `awbImports` (upload commands only): the one upload the command touched, in full, or
--     `{"id": ..., "deleted": true}` when the command removed it.
-- The function runs every existing check on that logical state (scope, factory scope,
-- transition rules, the signed-in recorder on new audit entries), then, in the same
-- transaction, stores the upload, appends the audit entries and saves the document without
-- them. Audit entries already in the table are kept as they are (`on conflict do nothing`).
--
-- Data: each site's current uploads and audit entries move to the tables, in order, and
-- leave the document. Reads of the full history go through the API (recent entries and
-- upload summaries come with each load; trace and upload screens fetch the rest).
-- Rollback: supabase/rollback/20261015090000_operator_imports_and_events.down.sql.

create table public.operator_imports (
  workspace_id uuid not null references public.operator_workspaces(id) on delete cascade,
  id text not null check (char_length(id) between 1 and 80),
  doc jsonb not null check (
    jsonb_typeof(doc) = 'object' and jsonb_typeof(doc -> 'rows') = 'array'
    and octet_length(doc::text) <= 3000000),
  -- The upload list reads these instead of every label row.
  head jsonb generated always as (doc - 'rows') stored,
  row_count integer generated always as (jsonb_array_length(doc -> 'rows')) stored,
  released_count integer generated always as (jsonb_array_length(
    jsonb_path_query_array(doc, '$.rows[*].releasedOrderId ? (@ != "")'))) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, id)
);
create index operator_imports_recent on public.operator_imports (workspace_id, created_at desc);

create table public.operator_events (
  workspace_id uuid not null references public.operator_workspaces(id) on delete cascade,
  seq bigint generated always as identity,
  id text not null check (char_length(id) between 1 and 200),
  entity text not null,
  body jsonb not null check (jsonb_typeof(body) = 'object' and octet_length(body::text) <= 50000),
  recorded_at timestamptz not null default now(),
  primary key (workspace_id, id)
);
create index operator_events_recent on public.operator_events (workspace_id, seq desc);
create index operator_events_entity on public.operator_events (workspace_id, entity, seq desc);

alter table public.operator_imports enable row level security;
alter table public.operator_events enable row level security;
revoke all on public.operator_imports, public.operator_events from anon, authenticated;
grant select on public.operator_imports, public.operator_events to authenticated;
create policy "active members read their uploads" on public.operator_imports
for select to authenticated using (public.operator_active_role(workspace_id) is not null);
create policy "active members read their audit entries" on public.operator_events
for select to authenticated using (public.operator_active_role(workspace_id) is not null);
-- No insert/update/delete policies: only operator_commit_workspace writes these tables.

-- The upload list: everything but the label rows, plus their counts.
create view public.operator_import_summaries with (security_invoker = true) as
select i.workspace_id, i.id, i.created_at,
  i.head || jsonb_build_object('rowCount', i.row_count, 'releasedCount', i.released_count) as summary
from public.operator_imports i;
revoke all on public.operator_import_summaries from anon, authenticated;
grant select on public.operator_import_summaries to authenticated;

-- Move each site's uploads and audit entries out of its document, oldest first (both
-- lists are stored newest first).
create function operator_private.iso_time(p text) returns timestamptz
language plpgsql immutable set search_path = '' as $$
begin
  return p::timestamptz;
exception when others then
  return null;
end
$$;
revoke all on function operator_private.iso_time(text) from public;

insert into public.operator_imports (workspace_id, id, doc, created_at, updated_at)
select w.id, i ->> 'id', i,
  coalesce(operator_private.iso_time(i ->> 'createdAt'), now()),
  coalesce(operator_private.iso_time(i ->> 'updatedAt'), now())
from public.operator_workspaces w,
  jsonb_array_elements(case when jsonb_typeof(w.state -> 'awbImports') = 'array'
    then w.state -> 'awbImports' else '[]' end) i
where jsonb_typeof(i) = 'object' and coalesce(i ->> 'id', '') <> ''
  and jsonb_typeof(i -> 'rows') = 'array'
on conflict do nothing;

insert into public.operator_events (workspace_id, id, entity, body, recorded_at)
select w.id, coalesce(nullif(e ->> 'id', ''), 'legacy-' || w.id || '-' || n),
  coalesce(e ->> 'entity', ''), e,
  coalesce(operator_private.iso_time(e ->> 'at'), now())
from public.operator_workspaces w,
  jsonb_array_elements(case when jsonb_typeof(w.state -> 'events') = 'array'
    then w.state -> 'events' else '[]' end) with ordinality x(e, n)
where jsonb_typeof(e) = 'object'
order by w.id, n desc
on conflict do nothing;

update public.operator_workspaces w
set state = (w.state - 'awbImports') || '{"events": []}'::jsonb, updated_at = now()
where w.state ? 'awbImports' or w.state -> 'events' is distinct from '[]'::jsonb;

-- Same as 20261007090000_operator_factory_scope.sql, plus the upload and audit-entry
-- tables (marked "tables").
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
  v_doc jsonb; -- tables
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
