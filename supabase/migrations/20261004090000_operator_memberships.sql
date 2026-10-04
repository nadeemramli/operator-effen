-- OPER-2: authenticated, site-scoped operational workspaces with supervisor-only writes.
-- Additive: the fictional `ui_draft_workspaces` sandbox and its rows are untouched.
-- Rollback: supabase/rollback/20261004090000_operator_memberships.down.sql (destroys
-- operational workspace rows; export them first).

create table public.operator_workspaces (
  id uuid primary key default gen_random_uuid(),
  site_id text not null unique check (site_id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text not null check (char_length(name) between 1 and 120),
  -- Unresolved exceptions to supervisor-only entry; both off until the owner decides.
  write_policy jsonb not null
    default '{"admin_imports": false, "management_comments": false}'::jsonb
    check (jsonb_typeof(write_policy) = 'object'),
  state jsonb not null
    default '{"version":1,"batches":[],"cartons":[],"orders":[],"issues":[],"boxing":[],"counts":[],"adjustments":[],"events":[],"notes":[],"closedDays":[]}'::jsonb
    check (jsonb_typeof(state) = 'object' and octet_length(state::text) <= 2000000),
  revision integer not null default 0 check (revision >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A membership grants sign-in access to one site workspace with one protected role.
-- Performer profiles (packers, drivers, assistants) live in workspace state and never
-- grant sign-in or write access by themselves.
create table public.operator_memberships (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.operator_workspaces(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in (
    'production', 'intake', 'outbound', 'admin', 'management', 'packer', 'driver', 'assistant'
  )),
  staff_profile_id text check (staff_profile_id is null or char_length(staff_profile_id) <= 100),
  display_name text not null check (char_length(display_name) between 1 and 120),
  active boolean not null default true,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id),
  check (active or revoked_at is not null)
);
create index operator_memberships_user_active on public.operator_memberships (user_id)
  where active;

alter table public.operator_workspaces enable row level security;
alter table public.operator_memberships enable row level security;
revoke all on public.operator_workspaces, public.operator_memberships from anon, authenticated;
grant select on public.operator_workspaces, public.operator_memberships to authenticated;

-- Current role of the signed-in user in a workspace; null when not an active member.
create function public.operator_active_role(p_workspace uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.operator_memberships m
  where m.workspace_id = p_workspace
    and m.user_id = (select auth.uid())
    and m.active
    and m.revoked_at is null
$$;
revoke all on function public.operator_active_role(uuid) from public, anon;
grant execute on function public.operator_active_role(uuid) to authenticated;

create policy "members read own memberships" on public.operator_memberships
for select to authenticated using (user_id = (select auth.uid()));
create policy "active members read their workspace" on public.operator_workspaces
for select to authenticated using (public.operator_active_role(id) is not null);
-- No insert/update/delete policies: direct Data API writes are denied for every role.

-- Top-level state keys each role may change. Mirrors roleStateKeys in apps/web/src/lib/access.ts.
-- Packers, drivers, assistants (and admin/management unless enabled) get null: no writes.
create function public.operator_writable_keys(p_role text, p_policy jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case p_role
    when 'production' then array['batches','machines','events','notes','closedDays','operations']
    when 'intake' then array['batches','machines','cartons','adypocideReceipts','counts',
      'adjustments','events','notes','closedDays','operations']
    when 'outbound' then array['orders','issues','sortCounts','awbImports','events','notes',
      'closedDays','operations']
    when 'admin' then case when p_policy -> 'admin_imports' = 'true'::jsonb
      then array['orders','awbImports','events','notes','operations'] end
    when 'management' then case when p_policy -> 'management_comments' = 'true'::jsonb
      then array['notes','events','operations'] end
  end
$$;

-- The only write path. Re-checks membership at commit time (revocation takes effect on
-- the next save), restricts the change to the role's scope and applies an optimistic
-- revision check. Returns no row on a revision conflict.
create function public.operator_commit_workspace(
  p_workspace uuid,
  p_expected_revision integer,
  p_state jsonb
)
returns table (new_state jsonb, new_revision integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_keys text[];
  v_current public.operator_workspaces%rowtype;
begin
  if (select auth.uid()) is null then
    raise exception 'Sign in again before saving.' using errcode = '28000';
  end if;
  select * into v_current from public.operator_workspaces w
  where w.id = p_workspace for update;
  v_role := public.operator_active_role(p_workspace);
  if v_current.id is null or v_role is null then
    raise exception 'No active membership for this workspace.' using errcode = '42501';
  end if;
  v_keys := public.operator_writable_keys(v_role, v_current.write_policy);
  if v_keys is null then
    raise exception 'Operational records are entered by authorized supervisors.'
      using errcode = '42501';
  end if;
  if p_state is null or jsonb_typeof(p_state) <> 'object' then
    raise exception 'Invalid workspace state.' using errcode = '22023';
  end if;
  if (p_state - v_keys) is distinct from (v_current.state - v_keys) then
    raise exception 'This change is outside the % role scope.', v_role using errcode = '42501';
  end if;
  if v_current.revision <> p_expected_revision then
    return;
  end if;
  update public.operator_workspaces w
  set state = p_state, revision = w.revision + 1, updated_at = now()
  where w.id = p_workspace
  returning w.state, w.revision into new_state, new_revision;
  return next;
end
$$;
revoke all on function public.operator_commit_workspace(uuid, integer, jsonb) from public, anon;
grant execute on function public.operator_commit_workspace(uuid, integer, jsonb) to authenticated;

comment on table public.operator_workspaces is
  'Site-scoped operational workspace. Written only through operator_commit_workspace.';
comment on table public.operator_memberships is
  'Administrator-managed sign-in access. Role is authoritative; client role previews are not.';
