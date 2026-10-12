-- PDF uploads move out of the workspace document (order volume plan, work package A;
-- follows 20261011090000_operator_remove_awbs.sql).
--
-- Problem: every PDF upload lived in `operator_workspaces.state.awbImports`, about 815 bytes
-- per label row inside a 2 MB document that every save and refresh sends whole. A
-- 1,000-label PDF could not be uploaded or reviewed. See docs/order-volume-plan-2026-10.md.
--
-- After this migration:
--   * public.operator_imports (one upload: name, work date, files, confirmed / received /
--     deleted marks) and public.operator_import_rows (one label, in review order) hold the
--     uploads. RLS: members with orders.import or sources.read at the site read them; nobody
--     writes them directly. Deleted uploads are hidden.
--   * Writes go through security-definer functions that check the caller's capability at
--     the site with operator_has_capability:
--       operator_import_save    (orders.import)   creates or replaces a draft upload and its
--                                                 rows; optimistic check on updated_at.
--       operator_import_receive (outbound.fulfil) acknowledges a confirmed upload once.
--       operator_import_list / operator_import_get (security invoker: the policies decide)
--                                                 read them in the API shape (one JSON
--                                                 value, so a 1,200-label upload is not cut
--                                                 at the Data API's row limit).
--   * Releasing, deleting and removing an AWB still change the document (orders and audit
--     entries stay there until work package C), so they keep the signed commit path.
--     operator_commit_workspace gains a trailing p_import_effects argument (exact JSON text,
--     signed like p_state) that it applies in the same transaction as the document update:
--       {"release": "<upload id>"}                  import-release only
--       {"delete": "<upload id>", "reason": "..."}  import-delete only
--       {"rows": [{"id": "<row id>", "excluded": true, "reviewNote": "..."}]}  remove-order only
--     import-release and import-delete must carry their effect. The signed message becomes
--     'operator-commit-v2' with one more line: sha256 hex of coalesce(p_import_effects, '').
--     A commit without effects is still accepted under the previous 'operator-commit-v1'
--     message, so the migration can be applied before or after the server deploys; effects
--     are accepted under v2 only.
--   * Command rules: import-save and import-receive are no longer document commands
--     (deleted); import-release, import-delete and remove-order are scoped {orders,events}.
--   * Errors: 42501 denied, 23514 invariant, 40001 a teammate saved the review first (the
--     API answers 409 code 'record'), P0002 upload not found, 22023 malformed input.
--   * Upload limits: 10 PDFs, 2,500 pages across the files and 1,200 labels per upload.
--   * Backfill: every document's awbImports moves to the tables (positions in array order,
--     created_by unknown), the key is removed and the revision bumped. Legacy identifiers
--     that are not UUIDs get a stable derived UUID and the orders that point at them are
--     updated to match. The preview sandbox (ui_draft_workspaces) drops its awbImports:
--     uploads are tested on the synthetic operational site from now on.
-- Mirrors apps/web/src/lib/capabilities.ts (tests/capabilities.test.mjs compares them),
-- apps/web/src/lib/access.ts (attest) and apps/web/src/lib/awb-import.ts (limits).
-- Rollback: supabase/rollback/20261012090000_operator_imports.down.sql.

-- ---------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------
create function operator_private.try_uuid(p_value text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case when p_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then p_value::uuid end
$$;
-- Backfill only: a legacy identifier as a UUID; non-UUID values map to a stable UUID.
create function operator_private.legacy_uuid(p_value text, p_scope text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select coalesce(operator_private.try_uuid(p_value),
    md5(p_scope || '/' || coalesce(p_value, ''))::uuid)
$$;
create function operator_private.try_timestamptz(p_value text)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
begin
  return date_trunc('milliseconds', p_value::timestamptz);
exception when others then
  return null;
end
$$;
-- Timestamps leave the database as JavaScript ISO strings (milliseconds, UTC).
create function operator_private.iso(p_value timestamptz)
returns text
language sql
stable
set search_path = ''
as $$
  select to_char(p_value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
revoke all on function operator_private.try_uuid(text), operator_private.legacy_uuid(text, text),
  operator_private.try_timestamptz(text), operator_private.iso(timestamptz) from public;

-- ---------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------
create table public.operator_imports (
  id uuid primary key,
  workspace_id uuid not null references public.operator_workspaces(id) on delete restrict,
  name text not null default '' check (char_length(name) <= 200),
  date text not null check (date ~ '^\d{4}-\d{2}-\d{2}$'),
  files jsonb not null default '[]' check (jsonb_typeof(files) = 'array'),
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  received_at timestamptz,
  received_by text,
  received_user uuid,
  deleted_at timestamptz,
  deleted_reason text,
  -- Target of the labels' (import_id, workspace_id) key: a label is always at its upload's site.
  unique (id, workspace_id)
);
create index operator_imports_recent on public.operator_imports (workspace_id, created_at desc)
  where deleted_at is null;
comment on table public.operator_imports is
  'One PDF upload of AWB labels. Written only through operator_import_save / operator_import_receive and the effects of operator_commit_workspace.';

create table public.operator_import_rows (
  id uuid primary key,
  import_id uuid not null,
  workspace_id uuid not null references public.operator_workspaces(id) on delete restrict,
  position integer not null check (position >= 0),
  awb text not null default '',
  order_ref text not null default '',
  channel text not null default '',
  store text not null default '',
  courier text not null default '',
  lines jsonb not null default '[]' check (jsonb_typeof(lines) = 'array'),
  sources jsonb not null default '[]' check (jsonb_typeof(sources) = 'array'),
  warnings jsonb not null default '[]' check (jsonb_typeof(warnings) = 'array'),
  notes jsonb check (notes is null or jsonb_typeof(notes) = 'array'),
  reviewed boolean not null default false,
  review_note text not null default '',
  excluded boolean not null default false,
  released_order_id text,
  original text not null default '',
  foreign key (import_id, workspace_id) references public.operator_imports (id, workspace_id)
    on delete cascade
);
create unique index operator_import_rows_position on public.operator_import_rows (import_id, position);
create index operator_import_rows_awb on public.operator_import_rows (workspace_id, awb);
comment on table public.operator_import_rows is
  'One label of a PDF upload, in review order. Raw label text (original) never enters the workspace document.';

alter table public.operator_imports enable row level security;
alter table public.operator_import_rows enable row level security;
revoke all on public.operator_imports, public.operator_import_rows from anon, authenticated;
grant select on public.operator_imports, public.operator_import_rows to authenticated;
create policy "importers and source readers read site uploads" on public.operator_imports
for select to authenticated using (
  deleted_at is null and (
    public.operator_has_capability(workspace_id, 'orders.import')
    or public.operator_has_capability(workspace_id, 'sources.read'))
);
-- Labels join through their upload: visible exactly when the upload is (same site by the
-- composite key). The uncorrelated subquery runs the upload policy once per upload, not
-- once per label, so a 1,200-label upload reads in one pass.
create policy "importers and source readers read site upload labels" on public.operator_import_rows
for select to authenticated using (
  import_id in (select i.id from public.operator_imports i)
);

-- One upload in the API shape (apps/web/src/lib/awb-import.ts AwbImport): with its rows, or
-- with counts only for the list.
create function operator_private.import_json(p_import uuid, p_rows boolean)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('id', i.id, 'name', i.name, 'date', i.date, 'files', i.files,
      'createdAt', operator_private.iso(i.created_at),
      'updatedAt', operator_private.iso(i.updated_at))
    || case when i.confirmed_at is null then '{}'::jsonb
      else jsonb_build_object('confirmedAt', operator_private.iso(i.confirmed_at)) end
    || case when i.received_at is null then '{}'::jsonb
      else jsonb_build_object('receivedAt', operator_private.iso(i.received_at),
        'receivedBy', coalesce(i.received_by, '')) end
    || case when p_rows then jsonb_build_object('rows', coalesce((
        select jsonb_agg(jsonb_build_object('id', r.id, 'awb', r.awb, 'orderRef', r.order_ref,
            'channel', r.channel, 'store', r.store, 'courier', r.courier, 'lines', r.lines,
            'sources', r.sources, 'warnings', r.warnings, 'reviewed', r.reviewed,
            'reviewNote', r.review_note, 'excluded', r.excluded, 'original', r.original)
          || case when r.notes is null then '{}'::jsonb else jsonb_build_object('notes', r.notes) end
          || case when r.released_order_id is null then '{}'::jsonb
            else jsonb_build_object('releasedOrderId', r.released_order_id) end
          order by r.position)
        from public.operator_import_rows r where r.import_id = i.id), '[]'::jsonb))
      else jsonb_build_object('counts', (
        select jsonb_build_object('rows', count(*),
          'released', count(*) filter (where r.released_order_id is not null))
        from public.operator_import_rows r where r.import_id = i.id)) end
  from public.operator_imports i
  where i.id = p_import
$$;
revoke all on function operator_private.import_json(uuid, boolean),
  operator_private.iso(timestamptz) from public;
-- Called by the invoker read functions below as the member, so the table policies apply.
grant execute on function operator_private.import_json(uuid, boolean),
  operator_private.iso(timestamptz) to authenticated;

-- ---------------------------------------------------------------------------------------
-- Reading: security invoker, so the select policies above decide what the member sees; the
-- explicit check only turns "no access" into an error instead of an empty answer. One JSON
-- value per call, so the Data API's row limit never truncates a 1,200-label upload.
-- ---------------------------------------------------------------------------------------
create function public.operator_import_list(p_workspace uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if (public.operator_has_capability(p_workspace, 'orders.import')
    or public.operator_has_capability(p_workspace, 'sources.read')) is not true then
    raise exception 'Your role at this site cannot open PDF uploads.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(operator_private.import_json(x.id, false) order by x.created_at desc)
    from (
      select i.id, i.created_at from public.operator_imports i
      where i.workspace_id = p_workspace and i.deleted_at is null
      order by i.created_at desc
      limit 200) x), '[]'::jsonb);
end
$$;
create function public.operator_import_get(p_workspace uuid, p_import uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if (public.operator_has_capability(p_workspace, 'orders.import')
    or public.operator_has_capability(p_workspace, 'sources.read')) is not true then
    raise exception 'Your role at this site cannot open PDF uploads.' using errcode = '42501';
  end if;
  -- NULL when the upload does not exist at this site or was deleted.
  return (select operator_private.import_json(i.id, true) from public.operator_imports i
    where i.id = p_import and i.workspace_id = p_workspace and i.deleted_at is null);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Saving a draft upload (orders.import)
-- ---------------------------------------------------------------------------------------
create function public.operator_import_save(
  p_workspace uuid,
  p_import jsonb,
  p_rows jsonb,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_id uuid;
  v_old public.operator_imports%rowtype;
  v_now timestamptz := date_trunc('milliseconds', now());
  v_originals jsonb;
begin
  if v_uid is null then
    raise exception 'Sign in again before saving.' using errcode = '28000';
  end if;
  if public.operator_has_capability(p_workspace, 'orders.import') is not true then
    raise exception 'Your role at this site cannot upload or review PDF batches.' using errcode = '42501';
  end if;
  if (jsonb_typeof(p_import) = 'object' and jsonb_typeof(p_rows) = 'array') is not true then
    raise exception 'Invalid upload.' using errcode = '22023';
  end if;
  v_id := operator_private.try_uuid(p_import ->> 'id');
  if (v_id is not null
    and jsonb_typeof(p_import -> 'name') = 'string'
    and char_length(p_import ->> 'name') <= 200
    and coalesce(p_import ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$'
    and jsonb_typeof(p_import -> 'files') = 'array') is not true then
    raise exception 'Invalid upload.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_import -> 'files') > 10 or jsonb_array_length(p_rows) > 1200 then
    raise exception 'Use up to 10 PDFs and 1200 labels per upload.' using errcode = '23514';
  end if;
  -- Files: <workspace id>/<sha256>.pdf at this site, whole page counts, at most 2,500 pages.
  -- (The API server checks separately that each object is stored.)
  if exists (
    select 1 from jsonb_array_elements(p_import -> 'files') f
    where (case when jsonb_typeof(f) = 'object' and jsonb_typeof(f -> 'pages') = 'number'
      then coalesce(f ->> 'id', '') ~ '^[0-9a-f]{64}$'
        and f ->> 'path' = p_workspace::text || '/' || (f ->> 'id') || '.pdf'
        and (f ->> 'pages')::numeric >= 1
        and (f ->> 'pages')::numeric = trunc((f ->> 'pages')::numeric)
      end) is not true
  ) then
    raise exception 'This PDF was not uploaded to this site.' using errcode = '23514';
  end if;
  if (select count(distinct f ->> 'id') from jsonb_array_elements(p_import -> 'files') f)
    <> jsonb_array_length(p_import -> 'files') then
    raise exception 'Duplicate import record identifiers.' using errcode = '23514';
  end if;
  if (select coalesce(sum((f ->> 'pages')::numeric), 0)
    from jsonb_array_elements(p_import -> 'files') f) > 2500 then
    raise exception 'Use up to 2500 PDF pages per upload.' using errcode = '23514';
  end if;
  -- Rows: the fields the review screen and the release rules rely on.
  if exists (
    select 1 from jsonb_array_elements(p_rows) r
    where (case when jsonb_typeof(r) = 'object'
      then operator_private.try_uuid(r ->> 'id') is not null
        and jsonb_typeof(r -> 'awb') = 'string' and jsonb_typeof(r -> 'orderRef') = 'string'
        and jsonb_typeof(r -> 'channel') = 'string' and jsonb_typeof(r -> 'store') = 'string'
        and jsonb_typeof(r -> 'courier') = 'string' and jsonb_typeof(r -> 'reviewNote') = 'string'
        and jsonb_typeof(r -> 'original') = 'string'
        and jsonb_typeof(r -> 'lines') = 'array' and jsonb_typeof(r -> 'sources') = 'array'
        and jsonb_typeof(r -> 'warnings') = 'array'
        and coalesce(jsonb_typeof(r -> 'notes'), 'array') in ('array', 'null')
        and jsonb_typeof(r -> 'reviewed') = 'boolean' and jsonb_typeof(r -> 'excluded') = 'boolean'
      end) is not true
  ) then
    raise exception 'Invalid label record.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_rows) r
    where (r ->> 'excluded')::boolean and btrim(r ->> 'reviewNote') = ''
  ) then
    raise exception 'Explain why the label is excluded.' using errcode = '23514';
  end if;
  if (select count(distinct operator_private.try_uuid(r ->> 'id')) from jsonb_array_elements(p_rows) r)
    <> jsonb_array_length(p_rows) then
    raise exception 'Duplicate import record identifiers.' using errcode = '23514';
  end if;

  select * into v_old from public.operator_imports i where i.id = v_id for update;
  if found then
    if v_old.workspace_id is distinct from p_workspace then
      raise exception 'This upload belongs to another site.' using errcode = '42501';
    end if;
    if v_old.deleted_at is not null then
      raise exception 'This upload was deleted. Upload the PDFs again if they are still needed.'
        using errcode = '23514';
    end if;
    if v_old.confirmed_at is not null then
      raise exception 'Released batches cannot be edited. Make a new handoff for remaining labels.'
        using errcode = '23514';
    end if;
    if p_expected_updated_at is distinct from v_old.updated_at then
      raise exception 'A teammate updated this PDF review. Reopen the batch before saving.'
        using errcode = '40001';
    end if;
  elsif p_expected_updated_at is not null then
    raise exception 'This PDF review could not be found. Reopen the batch before saving.'
      using errcode = '40001';
  end if;
  if exists (
    select 1 from public.operator_import_rows x
    where x.id in (select (r ->> 'id')::uuid from jsonb_array_elements(p_rows) r)
      and x.import_id <> v_id
  ) then
    raise exception 'Duplicate import record identifiers.' using errcode = '23514';
  end if;

  if v_old.id is null then
    insert into public.operator_imports (id, workspace_id, name, date, files, created_by,
      updated_by, created_at, updated_at)
    values (v_id, p_workspace, p_import ->> 'name', p_import ->> 'date', p_import -> 'files',
      v_uid, v_uid, v_now, v_now);
  else
    -- Every save moves updated_at forward, even within the same millisecond.
    v_now := greatest(v_now, v_old.updated_at + interval '1 millisecond');
    update public.operator_imports i
    set name = p_import ->> 'name', date = p_import ->> 'date', files = p_import -> 'files',
      updated_by = v_uid, updated_at = v_now
    where i.id = v_id;
  end if;
  -- Replace the rows; a row saved before keeps the label text it was first read with.
  select jsonb_object_agg(r.id::text, r.original) into v_originals
  from public.operator_import_rows r where r.import_id = v_id;
  delete from public.operator_import_rows r where r.import_id = v_id;
  insert into public.operator_import_rows (id, import_id, workspace_id, position, awb, order_ref,
    channel, store, courier, lines, sources, warnings, notes, reviewed, review_note, excluded,
    released_order_id, original)
  select (t.r ->> 'id')::uuid, v_id, p_workspace, (t.ord - 1)::integer, t.r ->> 'awb',
    t.r ->> 'orderRef', t.r ->> 'channel', t.r ->> 'store', t.r ->> 'courier', t.r -> 'lines',
    t.r -> 'sources', t.r -> 'warnings',
    case when jsonb_typeof(t.r -> 'notes') = 'array' then t.r -> 'notes' end,
    (t.r ->> 'reviewed')::boolean, t.r ->> 'reviewNote', (t.r ->> 'excluded')::boolean, null,
    coalesce(v_originals ->> ((t.r ->> 'id')::uuid)::text, t.r ->> 'original')
  from jsonb_array_elements(p_rows) with ordinality t(r, ord);
  return operator_private.import_json(v_id, true);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Receiving a confirmed upload (outbound.fulfil), once
-- ---------------------------------------------------------------------------------------
create function public.operator_import_receive(p_workspace uuid, p_import uuid, p_pic text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_old public.operator_imports%rowtype;
  v_now timestamptz := date_trunc('milliseconds', now());
begin
  if v_uid is null then
    raise exception 'Sign in again before saving.' using errcode = '28000';
  end if;
  if public.operator_has_capability(p_workspace, 'outbound.fulfil') is not true then
    raise exception 'Only stock-out can acknowledge a released batch.' using errcode = '42501';
  end if;
  if (char_length(btrim(coalesce(p_pic, ''))) between 1 and 100) is not true then
    raise exception 'Choose the receiving PIC.' using errcode = '22023';
  end if;
  select * into v_old from public.operator_imports i
  where i.id = p_import and i.workspace_id = p_workspace and i.deleted_at is null
  for update;
  if not found then
    raise exception 'Upload batch not found.' using errcode = 'P0002';
  end if;
  if v_old.confirmed_at is null or v_old.received_at is not null then
    raise exception 'Only stock-out can acknowledge a released batch once.' using errcode = '23514';
  end if;
  update public.operator_imports i
  set received_at = v_now, received_by = btrim(p_pic), received_user = v_uid, updated_by = v_uid,
    updated_at = greatest(v_now, v_old.updated_at + interval '1 millisecond')
  where i.id = p_import;
  return operator_private.import_json(p_import, true);
end
$$;
revoke all on function public.operator_import_list(uuid), public.operator_import_get(uuid, uuid),
  public.operator_import_save(uuid, jsonb, jsonb, timestamptz),
  public.operator_import_receive(uuid, uuid, text) from public, anon;
grant execute on function public.operator_import_list(uuid), public.operator_import_get(uuid, uuid),
  public.operator_import_save(uuid, jsonb, jsonb, timestamptz),
  public.operator_import_receive(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------
-- Upload effects of signed document commands (called by operator_commit_workspace after the
-- document update, in the same transaction)
-- ---------------------------------------------------------------------------------------
create function operator_private.apply_import_effects(
  p_workspace uuid,
  p_command text,
  p_old jsonb,
  p_new jsonb,
  p_effects jsonb,
  p_uid uuid
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_now timestamptz := date_trunc('milliseconds', now());
  v_kind text;
  v_expected text := case p_command when 'import-release' then 'release'
    when 'import-delete' then 'delete' when 'remove-order' then 'rows' end;
  v_id uuid;
  v_import public.operator_imports%rowtype;
begin
  if p_effects is not null then
    if (jsonb_typeof(p_effects) = 'object') is not true then
      raise exception 'Invalid upload changes.' using errcode = '22023';
    end if;
    v_kind := case when p_effects ? 'release' then 'release' when p_effects ? 'delete' then 'delete'
      when p_effects ? 'rows' then 'rows' end;
    if v_kind is null
      or (v_kind = 'release' and p_effects - 'release' <> '{}'::jsonb)
      or (v_kind = 'delete' and p_effects - 'delete' - 'reason' <> '{}'::jsonb)
      or (v_kind = 'rows' and p_effects - 'rows' <> '{}'::jsonb) then
      raise exception 'Invalid upload changes.' using errcode = '22023';
    end if;
    if v_kind is distinct from v_expected then
      raise exception 'These upload changes do not belong to the % command.', p_command
        using errcode = '42501';
    end if;
  end if;
  if v_expected in ('release', 'delete') and v_kind is null then
    raise exception 'This change needs its upload record. Refresh and try again.' using errcode = '23514';
  end if;

  if v_kind = 'release' then
    if public.operator_has_capability(p_workspace, 'orders.import') is not true then
      raise exception 'Your role at this site does not permit orders.import.' using errcode = '42501';
    end if;
    v_id := operator_private.try_uuid(p_effects ->> 'release');
    select * into v_import from public.operator_imports i
    where i.id = v_id and i.workspace_id = p_workspace for update;
    if v_import.id is null or v_import.deleted_at is not null or v_import.confirmed_at is not null then
      raise exception 'This handoff is already confirmed or the upload no longer exists.' using errcode = '23514';
    end if;
    -- Every AWB of this upload in the new document points at its own label: present, not
    -- excluded and not released before.
    if exists (
      with released as (
        select n ->> 'id' as order_id, n ->> 'importRowId' as row_id
        from jsonb_array_elements(coalesce(p_new -> 'orders', '[]')) n
        where n ->> 'importId' = v_id::text)
      select 1 from released o
      left join public.operator_import_rows r
        on r.import_id = v_id and r.id = operator_private.try_uuid(o.row_id)
      where r.id is null or r.excluded or r.released_order_id is not null or o.order_id is null
    ) or (
      select count(*) <> count(distinct n ->> 'importRowId')
      from jsonb_array_elements(coalesce(p_new -> 'orders', '[]')) n
      where n ->> 'importId' = v_id::text
    ) then
      raise exception 'Every released AWB needs its own unreleased label in this upload.' using errcode = '23514';
    end if;
    with released as (
      select n ->> 'id' as order_id, operator_private.try_uuid(n ->> 'importRowId') as row_id
      from jsonb_array_elements(coalesce(p_new -> 'orders', '[]')) n
      where n ->> 'importId' = v_id::text)
    update public.operator_import_rows r
    set released_order_id = o.order_id
    from released o
    where r.import_id = v_id and r.id = o.row_id;
    update public.operator_imports i
    set confirmed_at = v_now, updated_by = p_uid,
      updated_at = greatest(v_now, i.updated_at + interval '1 millisecond')
    where i.id = v_id;

  elsif v_kind = 'delete' then
    if public.operator_has_capability(p_workspace, 'orders.import') is not true then
      raise exception 'Your role at this site does not permit orders.import.' using errcode = '42501';
    end if;
    v_id := operator_private.try_uuid(p_effects ->> 'delete');
    select * into v_import from public.operator_imports i
    where i.id = v_id and i.workspace_id = p_workspace for update;
    if v_import.id is null or v_import.deleted_at is not null then
      raise exception 'This upload no longer exists.' using errcode = '23514';
    end if;
    if (jsonb_typeof(p_effects -> 'reason') = 'string'
      and char_length(btrim(p_effects ->> 'reason')) between 1 and 2000) is not true then
      raise exception 'Enter a reason for deleting this upload.' using errcode = '22023';
    end if;
    if exists (
      select 1 from jsonb_array_elements(coalesce(p_new -> 'orders', '[]')) n
      where n ->> 'importId' = v_id::text
    ) then
      raise exception 'AWBs released from this upload are still in the order list.' using errcode = '23514';
    end if;
    update public.operator_imports i
    set deleted_at = v_now, deleted_reason = btrim(p_effects ->> 'reason'), updated_by = p_uid,
      updated_at = greatest(v_now, i.updated_at + interval '1 millisecond')
    where i.id = v_id;

  elsif v_kind = 'rows' then
    if (public.operator_has_capability(p_workspace, 'orders.enter')
      or public.operator_has_capability(p_workspace, 'orders.import')) is not true then
      raise exception 'Your role at this site does not permit orders.enter.' using errcode = '42501';
    end if;
    if (jsonb_typeof(p_effects -> 'rows') = 'array'
      and jsonb_array_length(p_effects -> 'rows') between 1 and 1200) is not true then
      raise exception 'Invalid upload changes.' using errcode = '22023';
    end if;
    if exists (
        select 1 from jsonb_array_elements(p_effects -> 'rows') e
        where (case when jsonb_typeof(e) = 'object'
          then operator_private.try_uuid(e ->> 'id') is not null
            and e -> 'excluded' = 'true'::jsonb
            and jsonb_typeof(e -> 'reviewNote') = 'string'
            and char_length(btrim(e ->> 'reviewNote')) between 1 and 2100
            and e - 'id' - 'excluded' - 'reviewNote' = '{}'::jsonb
          end) is not true)
      or (select count(distinct operator_private.try_uuid(e ->> 'id'))
        from jsonb_array_elements(p_effects -> 'rows') e) <> jsonb_array_length(p_effects -> 'rows') then
      raise exception 'Invalid upload changes.' using errcode = '22023';
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_effects -> 'rows') e
      left join public.operator_import_rows r
        on r.id = operator_private.try_uuid(e ->> 'id') and r.workspace_id = p_workspace
      left join public.operator_imports i on i.id = r.import_id
      where r.id is null or i.confirmed_at is null or i.deleted_at is not null
    ) then
      raise exception 'Only labels of a confirmed upload at this site can be marked removed.' using errcode = '23514';
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_effects -> 'rows') e
      join public.operator_import_rows r on r.id = operator_private.try_uuid(e ->> 'id')
      where r.released_order_id is not null and exists (
        select 1 from jsonb_array_elements(coalesce(p_new -> 'orders', '[]')) n
        where n ->> 'id' = r.released_order_id)
    ) then
      raise exception 'The AWB released from this label is still in the order list.' using errcode = '23514';
    end if;
    with marks as (
      select operator_private.try_uuid(e ->> 'id') as id, btrim(e ->> 'reviewNote') as note
      from jsonb_array_elements(p_effects -> 'rows') e)
    update public.operator_import_rows r
    set excluded = true, reviewed = true, released_order_id = null,
      review_note = case when r.review_note = '' then m.note else r.review_note || ' · ' || m.note end
    from marks m
    where r.id = m.id;
    update public.operator_imports i
    set updated_by = p_uid, updated_at = greatest(v_now, i.updated_at + interval '1 millisecond')
    where i.id in (
      select r.import_id from public.operator_import_rows r
      where r.id in (select operator_private.try_uuid(e ->> 'id') from jsonb_array_elements(p_effects -> 'rows') e));
  end if;

  -- An AWB removed from the document that is still the released AWB of a label must mark
  -- that label in the same commit, so the upload never counts a removed AWB.
  if p_command = 'remove-order' and exists (
    with removed as (
      select o ->> 'id' as id from jsonb_array_elements(coalesce(p_old -> 'orders', '[]')) o
      except
      select n ->> 'id' from jsonb_array_elements(coalesce(p_new -> 'orders', '[]')) n)
    select 1
    from jsonb_array_elements(coalesce(p_old -> 'orders', '[]')) o
    join removed x on x.id = o ->> 'id'
    join public.operator_import_rows r
      on r.id = operator_private.try_uuid(o ->> 'importRowId')
      and r.workspace_id = p_workspace and r.released_order_id = o ->> 'id'
    where not exists (
      select 1 from jsonb_array_elements(
        case when v_kind = 'rows' then p_effects -> 'rows' else '[]'::jsonb end) e
      where operator_private.try_uuid(e ->> 'id') = r.id)
  ) then
    raise exception 'Mark the removed AWB''s PDF label excluded in its upload.' using errcode = '23514';
  end if;
end
$$;
revoke all on function operator_private.apply_import_effects(uuid, text, jsonb, jsonb, jsonb, uuid)
  from public;

-- ---------------------------------------------------------------------------------------
-- The commit path: same as 20261007090000_operator_factory_scope.sql plus the upload effects
-- (marked "import effects"). New signature, so the old one is dropped.
-- ---------------------------------------------------------------------------------------
drop function public.operator_commit_workspace(uuid, integer, text, uuid, text, text, text);
create function public.operator_commit_workspace(
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
revoke all on function public.operator_commit_workspace(uuid, integer, text, uuid, text, text, text, text)
  from public, anon;
grant execute on function public.operator_commit_workspace(uuid, integer, text, uuid, text, text, text, text)
  to authenticated;
comment on function public.operator_commit_workspace(uuid, integer, text, uuid, text, text, text, text) is
  'Commits a server-validated, signed transition for the signed-in member, with its upload effects. See 20261005090000 and 20261012090000.';

-- ---------------------------------------------------------------------------------------
-- Command rules (kept in sync with apps/web/src/lib/capabilities.ts)
-- ---------------------------------------------------------------------------------------
delete from public.operator_command_rules where command in ('import-save', 'import-receive');
update public.operator_command_rules set state_keys = '{orders,events}'
where command in ('import-release', 'import-delete', 'remove-order');

-- ---------------------------------------------------------------------------------------
-- Backfill: document uploads into the tables, then drop the document key
-- ---------------------------------------------------------------------------------------
insert into public.operator_imports (id, workspace_id, name, date, files, created_by, created_at,
  updated_at, confirmed_at, received_at, received_by)
select operator_private.legacy_uuid(b ->> 'id', w.id::text), w.id,
  left(coalesce(b ->> 'name', ''), 200),
  case when coalesce(b ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$' then b ->> 'date'
    else to_char(now(), 'YYYY-MM-DD') end,
  case when jsonb_typeof(b -> 'files') = 'array' then b -> 'files' else '[]'::jsonb end,
  null,
  coalesce(operator_private.try_timestamptz(b ->> 'createdAt'), date_trunc('milliseconds', now())),
  coalesce(operator_private.try_timestamptz(b ->> 'updatedAt'),
    operator_private.try_timestamptz(b ->> 'createdAt'), date_trunc('milliseconds', now())),
  operator_private.try_timestamptz(b ->> 'confirmedAt'),
  operator_private.try_timestamptz(b ->> 'receivedAt'),
  nullif(b ->> 'receivedBy', '')
from public.operator_workspaces w
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(w.state -> 'awbImports') = 'array' then w.state -> 'awbImports'
    else '[]'::jsonb end) b
where jsonb_typeof(b) = 'object'
on conflict do nothing;

insert into public.operator_import_rows (id, import_id, workspace_id, position, awb, order_ref,
  channel, store, courier, lines, sources, warnings, notes, reviewed, review_note, excluded,
  released_order_id, original)
select operator_private.legacy_uuid(t.r ->> 'id', w.id::text || '/' || coalesce(b ->> 'id', '')),
  operator_private.legacy_uuid(b ->> 'id', w.id::text), w.id, (t.ord - 1)::integer,
  coalesce(t.r ->> 'awb', ''), coalesce(t.r ->> 'orderRef', ''), coalesce(t.r ->> 'channel', ''),
  coalesce(t.r ->> 'store', ''), coalesce(t.r ->> 'courier', ''),
  case when jsonb_typeof(t.r -> 'lines') = 'array' then t.r -> 'lines' else '[]'::jsonb end,
  case when jsonb_typeof(t.r -> 'sources') = 'array' then t.r -> 'sources' else '[]'::jsonb end,
  case when jsonb_typeof(t.r -> 'warnings') = 'array' then t.r -> 'warnings' else '[]'::jsonb end,
  case when jsonb_typeof(t.r -> 'notes') = 'array' then t.r -> 'notes' end,
  coalesce(t.r -> 'reviewed' = 'true'::jsonb, false), coalesce(t.r ->> 'reviewNote', ''),
  coalesce(t.r -> 'excluded' = 'true'::jsonb, false), nullif(t.r ->> 'releasedOrderId', ''),
  coalesce(t.r ->> 'original', '')
from public.operator_workspaces w
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(w.state -> 'awbImports') = 'array' then w.state -> 'awbImports'
    else '[]'::jsonb end) b
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(b -> 'rows') = 'array' then b -> 'rows' else '[]'::jsonb end)
  with ordinality t(r, ord)
where jsonb_typeof(b) = 'object' and jsonb_typeof(t.r) = 'object'
on conflict do nothing;

-- Orders keep pointing at their upload and label (identical for UUID identifiers).
update public.operator_workspaces w
set state = case when jsonb_typeof(w.state -> 'orders') = 'array'
    then jsonb_set(w.state - 'awbImports', '{orders}', (
      select coalesce(jsonb_agg(
        case when jsonb_typeof(o -> 'importId') = 'string'
          then o || jsonb_build_object('importId',
              operator_private.legacy_uuid(o ->> 'importId', w.id::text)::text)
            || case when jsonb_typeof(o -> 'importRowId') = 'string'
              then jsonb_build_object('importRowId', operator_private.legacy_uuid(
                o ->> 'importRowId', w.id::text || '/' || (o ->> 'importId'))::text)
              else '{}'::jsonb end
          else o end
        order by t.ord), '[]'::jsonb)
      from jsonb_array_elements(w.state -> 'orders') with ordinality t(o, ord)))
    else w.state - 'awbImports' end,
  revision = w.revision + 1,
  updated_at = now()
where w.state ? 'awbImports';

-- The preview sandbox no longer covers uploads.
update public.ui_draft_workspaces d
set state = d.state - 'awbImports', revision = d.revision + 1, updated_at = now()
where d.state ? 'awbImports';
