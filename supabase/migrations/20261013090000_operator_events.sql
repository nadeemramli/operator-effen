-- Audit entries move out of the workspace document (order volume plan, work package B;
-- follows 20261012090000_operator_imports.sql).
--
-- Problem: every audit entry lived in `operator_workspaces.state.events`, about 300 bytes
-- each and 5 to 7 per AWB over its life, append-only, so the 2 MB document that every save
-- and refresh sends whole grew without bound. See docs/order-volume-plan-2026-10.md.
--
-- After this migration:
--   * public.operator_events holds one row per audit entry: the Event fields the app writes
--     (entity, action, detail, actor, at, occurredAt, performer, recorder) plus the command
--     and operation that appended it and a per-table sequence (`seq`, stable order: within
--     one commit, seq order is chronological order). RLS: every active member of the site
--     reads its entries (as with the document, packers included); nobody inserts, updates or
--     deletes them directly.
--   * operator_private.append_events(workspace, events, uid, command, operation) is the one
--     appender, called by the commit RPC (and by work package C's records RPC). It checks
--     each entry's shape, refuses entries not attributed to the signed-in user (23514 'New
--     audit entries must be attributed to the signed-in user.'), refuses a changed copy of an
--     existing entry (23514), skips identical copies (a retried or rebased save cannot add
--     an entry twice) and inserts the rest oldest first.
--   * operator_commit_workspace keeps WP A's signature and signed message ('operator-commit-
--     v2' / v1 without effects). The submitted state still carries the command's new audit
--     entries under `events` (signed with the rest of the state); the function strips them,
--     stores the document with an empty `events` list, and appends them in the same
--     transaction (commit row, then events, then upload effects). It returns the stored
--     state, whose `events` is empty. The scope check compares documents without `events`;
--     entries submitted by a command whose rule does not list `events` (feedback) are
--     refused as out of scope.
--     Why an empty list rather than no key: the migration is applied before the new server
--     deploys, and the previous server and any open tab with the previous build read
--     `state.events` as a list. With `[]` they keep working (showing no entries) until they
--     reload; work package D retires the key with the other document keys.
--     operator_private.assert_transition is NOT changed: it receives both documents without
--     `events`, so its document rules for events (kept / attributed) have nothing to check
--     there, and those rules now live in append_events and the table's privileges. Its rules
--     for notes, issues, adjustments, sort counts and returns are unchanged.
--   * Command rules: unchanged. `events` stays in every rule's state_keys because the
--     submitted state still carries the command's new entries; the server strips them.
--   * Backfill: each operator_workspaces document's `events` move to the table in
--     chronological order (array reversed: the app stores newest first) with command
--     'backfill' and one fixed operation ID per site; the list is emptied and the revision
--     bumped (open tabs reload). Entries without a recorder user are kept as stored (the
--     attribution check applies to new entries only). Identifiers that are not UUIDs (sample
--     data) get a stable derived UUID. Idempotent by ID, so re-applying after the rollback
--     loses nothing.
--   * The preview sandbox (ui_draft_workspaces) is untouched and keeps events in its
--     document.
-- Mirrors apps/web/src/lib/events.ts (shape limits) and apps/web/src/app/api/events/route.ts
-- (reads). Rollback: supabase/rollback/20261013090000_operator_events.down.sql.

-- ---------------------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------------------
create table public.operator_events (
  id uuid primary key,
  workspace_id uuid not null references public.operator_workspaces(id) on delete restrict,
  seq bigint generated always as identity,
  entity text not null check (char_length(entity) <= 200),
  action text not null check (char_length(action) <= 200),
  -- import-delete lists every AWB it removed (up to 1,200 of up to 60 characters).
  detail text not null check (char_length(detail) <= 100000),
  actor text not null check (char_length(actor) <= 500),
  at timestamptz not null,
  occurred_at timestamptz,
  performer text check (char_length(performer) <= 200),
  recorder jsonb not null check (jsonb_typeof(recorder) = 'object'),
  command text not null check (char_length(command) between 1 and 100),
  operation_id uuid not null,
  created_at timestamptz not null default now(),
  -- New entries name the signed-in user; only backfilled history may lack one.
  constraint operator_events_recorder check (command = 'backfill'
    or coalesce(recorder ->> 'userId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);
create index operator_events_recent on public.operator_events (workspace_id, seq desc);
create index operator_events_entity on public.operator_events (workspace_id, entity, seq desc);
create index operator_events_time on public.operator_events (workspace_id, at desc);
comment on table public.operator_events is
  'One audit entry of an operational site. Appended only by operator_private.append_events inside the signed commit RPCs; never changed or deleted.';

alter table public.operator_events enable row level security;
revoke all on public.operator_events from anon, authenticated;
grant select on public.operator_events to authenticated;
create policy "active members read site audit entries" on public.operator_events
for select to authenticated using (public.operator_active_role(workspace_id) is not null);

-- ---------------------------------------------------------------------------------------
-- The appender (called by security-definer commit functions only)
-- ---------------------------------------------------------------------------------------
create function operator_private.append_events(
  p_workspace uuid,
  p_events jsonb,
  p_uid uuid,
  p_command text,
  p_operation uuid
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_events is null or p_events = '[]'::jsonb then
    return 0;
  end if;
  if (jsonb_typeof(p_events) = 'array' and p_workspace is not null and p_uid is not null
    and p_operation is not null and char_length(coalesce(p_command, '')) between 1 and 100) is not true then
    raise exception 'Invalid audit entries.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_events) > 2000 then
    raise exception 'One change can add at most 2000 audit entries.' using errcode = '23514';
  end if;
  -- Shape (mirrors apps/web/src/lib/events.ts eventProblem).
  if exists (
    select 1 from jsonb_array_elements(p_events) e
    where (case when jsonb_typeof(e) = 'object' then
        operator_private.try_uuid(e ->> 'id') is not null
        and jsonb_typeof(e -> 'entity') = 'string' and char_length(e ->> 'entity') <= 200
        and jsonb_typeof(e -> 'action') = 'string' and char_length(e ->> 'action') <= 200
        and jsonb_typeof(e -> 'detail') = 'string' and char_length(e ->> 'detail') <= 100000
        and jsonb_typeof(e -> 'actor') = 'string' and char_length(e ->> 'actor') <= 500
        and jsonb_typeof(e -> 'at') = 'string'
        and operator_private.try_timestamptz(e ->> 'at') is not null
        and (coalesce(jsonb_typeof(e -> 'occurredAt'), 'null') = 'null'
          or (jsonb_typeof(e -> 'occurredAt') = 'string'
            and operator_private.try_timestamptz(e ->> 'occurredAt') is not null))
        and (coalesce(jsonb_typeof(e -> 'performer'), 'null') = 'null'
          or (jsonb_typeof(e -> 'performer') = 'string' and char_length(e ->> 'performer') <= 200))
        and jsonb_typeof(e -> 'recorder') = 'object'
      end) is not true
  ) then
    raise exception 'Invalid audit entry.' using errcode = '22023';
  end if;
  if (select count(distinct (e ->> 'id')::uuid) from jsonb_array_elements(p_events) e)
    <> jsonb_array_length(p_events) then
    raise exception 'Duplicate audit entry identifiers.' using errcode = '23514';
  end if;
  -- An entry already stored (a retried save) must be the identical entry of this site.
  if exists (
    select 1 from jsonb_array_elements(p_events) e
    join public.operator_events x on x.id = (e ->> 'id')::uuid
    where x.workspace_id <> p_workspace or x.entity <> e ->> 'entity'
      or x.action <> e ->> 'action' or x.detail <> e ->> 'detail' or x.actor <> e ->> 'actor'
      or x.at <> operator_private.try_timestamptz(e ->> 'at')
      or x.recorder ->> 'userId' is distinct from e -> 'recorder' ->> 'userId'
  ) then
    raise exception 'Existing audit entries cannot be changed.' using errcode = '23514';
  end if;
  -- New entries are attributed to the signed-in user.
  if exists (
    select 1 from jsonb_array_elements(p_events) e
    where not exists (select 1 from public.operator_events x where x.id = (e ->> 'id')::uuid)
      and coalesce(e -> 'recorder' ->> 'userId', '') <> p_uid::text
  ) then
    raise exception 'New audit entries must be attributed to the signed-in user.' using errcode = '23514';
  end if;
  -- The app stores newest first; insert oldest first so seq order is chronological.
  insert into public.operator_events (id, workspace_id, entity, action, detail, actor, at,
    occurred_at, performer, recorder, command, operation_id)
  select (t.e ->> 'id')::uuid, p_workspace, t.e ->> 'entity', t.e ->> 'action', t.e ->> 'detail',
    t.e ->> 'actor', operator_private.try_timestamptz(t.e ->> 'at'),
    operator_private.try_timestamptz(t.e ->> 'occurredAt'), t.e ->> 'performer', t.e -> 'recorder',
    p_command, p_operation
  from jsonb_array_elements(p_events) with ordinality t(e, ord)
  order by t.ord desc
  on conflict (id) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- Backfill and safety net: entries that are still in a stored document (written before this
-- migration) move as recorded, in chronological order, without the attribution check.
create function operator_private.backfill_events(p_workspace uuid, p_events jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  if jsonb_typeof(p_events) is distinct from 'array' then
    return 0;
  end if;
  insert into public.operator_events (id, workspace_id, entity, action, detail, actor, at,
    occurred_at, performer, recorder, command, operation_id)
  select operator_private.legacy_uuid(t.e ->> 'id', 'event/' || p_workspace::text), p_workspace,
    left(coalesce(t.e ->> 'entity', ''), 200), left(coalesce(t.e ->> 'action', ''), 200),
    left(coalesce(t.e ->> 'detail', ''), 100000), left(coalesce(t.e ->> 'actor', ''), 500),
    coalesce(operator_private.try_timestamptz(t.e ->> 'at'),
      operator_private.try_timestamptz(t.e ->> 'occurredAt'), date_trunc('milliseconds', now())),
    operator_private.try_timestamptz(t.e ->> 'occurredAt'),
    left(t.e ->> 'performer', 200),
    case when jsonb_typeof(t.e -> 'recorder') = 'object' then t.e -> 'recorder' else '{}'::jsonb end,
    'backfill', md5('operator-events-backfill/' || p_workspace::text)::uuid
  from jsonb_array_elements(p_events) with ordinality t(e, ord)
  where jsonb_typeof(t.e) = 'object'
  order by t.ord desc
  on conflict (id) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;
revoke all on function operator_private.append_events(uuid, jsonb, uuid, text, uuid),
  operator_private.backfill_events(uuid, jsonb) from public;

-- ---------------------------------------------------------------------------------------
-- The commit path: same as 20261012090000_operator_imports.sql plus the audit split (marked
-- "audit entries"). Same signature, so grants are kept.
-- ---------------------------------------------------------------------------------------
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
  v_old jsonb; -- audit entries: the stored document without events
  v_stored jsonb; -- audit entries: what is stored, with an empty events list
  v_events jsonb; -- audit entries: the command's new entries
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
    return query select (v_current.state - 'events') || '{"events": []}'::jsonb,
      v_current.revision, true;
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
  -- audit entries: the submitted `events` are this command's new entries. They leave the
  -- document and go to operator_events; both documents are compared without them.
  v_events := coalesce(v_new -> 'events', '[]'::jsonb);
  v_new := v_new - 'events';
  v_old := v_current.state - 'events';
  if v_events <> '[]'::jsonb and not ('events' = any (v_rule.state_keys)) then
    raise exception 'This change is outside the % command scope.', p_command using errcode = '42501';
  end if;
  if (v_new - v_rule.state_keys) is distinct from (v_old - v_rule.state_keys) then
    raise exception 'This change is outside the % command scope.', p_command using errcode = '42501';
  end if;
  perform operator_private.assert_factory_scope(v_old, v_new, v_factory); -- factory scope
  perform operator_private.assert_transition(v_old, v_new, v_uid);
  if v_current.revision is distinct from p_expected_revision then
    return;
  end if;
  v_stored := v_new || '{"events": []}'::jsonb; -- audit entries
  update public.operator_workspaces w
  set state = v_stored, revision = w.revision + 1, updated_at = now()
  where w.id = p_workspace;
  insert into public.operator_commits (workspace_id, operation_id, user_id, role, command,
    fingerprint, result_revision)
  values (p_workspace, p_operation, v_uid, v_role, p_command, p_fingerprint,
    v_current.revision + 1);
  -- audit entries: a document still holding entries (written before 20261013090000) hands
  -- them over as recorded; then the command's own entries, attributed to the caller.
  if jsonb_typeof(v_current.state -> 'events') = 'array'
    and v_current.state -> 'events' <> '[]'::jsonb then
    perform operator_private.backfill_events(p_workspace, v_current.state -> 'events');
  end if;
  perform operator_private.append_events(p_workspace, v_events, v_uid, p_command, p_operation);
  -- import effects: applied with the document update or not at all.
  perform operator_private.apply_import_effects(p_workspace, p_command, v_old, v_new,
    v_effects, v_uid);
  return query select v_stored, v_current.revision + 1, false;
end
$$;
comment on function public.operator_commit_workspace(uuid, integer, text, uuid, text, text, text, text) is
  'Commits a server-validated, signed transition for the signed-in member, with its upload effects; its audit entries go to operator_events. See 20261005090000, 20261012090000 and 20261013090000.';

-- ---------------------------------------------------------------------------------------
-- Backfill: document audit entries into the table, then empty the document list
-- ---------------------------------------------------------------------------------------
do $$
begin
  perform operator_private.backfill_events(w.id, w.state -> 'events')
  from public.operator_workspaces w
  where jsonb_typeof(w.state -> 'events') = 'array';
end
$$;

update public.operator_workspaces w
set state = w.state || '{"events": []}'::jsonb, revision = w.revision + 1, updated_at = now()
where w.state -> 'events' is distinct from '[]'::jsonb;
