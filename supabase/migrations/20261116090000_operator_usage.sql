-- Feature usage per role (follows 20261028090000_operator_stock_add_recount.sql).
--
-- Owner request 2026-11-16: see how each role uses the app and whether the intended
-- features are used. Saved actions are already in public.operator_commits (user, role,
-- command, time). This migration adds what leaves no trace today and a way to read both:
--   * public.operator_usage_daily: one row per site, Malaysia day, user, role, packer
--     profile, kind and detail, with a counter. Kinds: `view` (a screen was opened; detail
--     is the screen id) and `failed` (a save was refused; detail is the command). No record
--     contents, no free text. A day's repeats only raise the counter, so the table grows
--     with people x screens x days, not with clicks.
--   * public.operator_log_usage: the only way to write it. The role comes from the caller's
--     membership, never from the request. A packer profile is kept only for a caller with
--     packing.record and an active packer profile of that site; the profile is the one the
--     API server found unlocked by PIN, but the database cannot verify the PIN session, so
--     treat per-packer rows as usage statistics, not as evidence.
--   * public.operator_usage_report: Management and HR only (the roles that open Reports).
--     Returns, for one site since a day: the active members (`member`), saved actions from
--     operator_commits (`command`), the usage rows (`view`, `failed`), and the days each
--     person did anything (`active`), each counted per role, user and packer profile.
-- The screen list mirrors `views` in apps/web/src/lib/landing.ts (tests/usage.test.mjs).
-- Additive: one table and two functions. Nobody reads or writes the table directly.
-- Rollback: supabase/rollback/20261116090000_operator_usage.down.sql.

create table public.operator_usage_daily (
  workspace_id uuid not null references public.operator_workspaces(id) on delete cascade,
  day date not null,
  user_id uuid not null,
  role text not null,
  profile_id text not null default '' check (char_length(profile_id) <= 100),
  kind text not null check (kind in ('view', 'failed')),
  detail text not null check (char_length(detail) between 1 and 60),
  uses integer not null default 1 check (uses > 0),
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  primary key (workspace_id, day, user_id, role, profile_id, kind, detail)
);
alter table public.operator_usage_daily enable row level security;
revoke all on public.operator_usage_daily from public, anon, authenticated;

create function operator_private.usage_view(p_view text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_view in ('production', 'warehouse', 'input', 'orders', 'packing', 'trips', 'tally',
    'overview', 'trace', 'reports', 'feedback')
$$;
revoke all on function operator_private.usage_view(text) from public;

create function public.operator_log_usage(
  p_workspace uuid, p_kind text, p_detail text, p_profile text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_role text;
  v_profile text := '';
begin
  if v_uid is null then
    raise exception 'Sign in again.' using errcode = '28000';
  end if;
  v_role := public.operator_active_role(p_workspace);
  if v_role is null then
    raise exception 'No active membership for this workspace.' using errcode = '42501';
  end if;
  if (case p_kind
        when 'view' then operator_private.usage_view(p_detail)
        when 'failed' then exists (
          select 1 from public.operator_command_rules r where r.command = p_detail)
      end) is not true then
    raise exception 'Unknown usage entry.' using errcode = '22023';
  end if;
  if p_profile is not null and p_profile <> ''
    and public.operator_has_capability(p_workspace, 'packing.record')
    and operator_private.packer_profile_exists(p_workspace, p_profile) then
    v_profile := p_profile;
  end if;
  insert into public.operator_usage_daily as u
    (workspace_id, day, user_id, role, profile_id, kind, detail)
  values (p_workspace, (now() at time zone 'Asia/Kuala_Lumpur')::date, v_uid, v_role,
    v_profile, p_kind, p_detail)
  on conflict (workspace_id, day, user_id, role, profile_id, kind, detail)
  do update set uses = least(u.uses + 1, 1000000), last_at = now();
end;
$$;
revoke all on function public.operator_log_usage(uuid, text, text, text) from public, anon;
grant execute on function public.operator_log_usage(uuid, text, text, text) to authenticated;

create function public.operator_usage_report(p_workspace uuid, p_since date)
returns table (
  role text, user_id uuid, display_name text, profile_id text, kind text, detail text,
  uses bigint, active_days bigint, last_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Sign in again.' using errcode = '28000';
  end if;
  if (public.operator_active_role(p_workspace) in ('management', 'hr')) is not true then
    raise exception 'Only Management and HR can read the usage report.' using errcode = '42501';
  end if;
  if p_since is null then
    raise exception 'Choose a start day.' using errcode = '22023';
  end if;
  return query
  with members as (
    -- A site membership wins over an all-sites one, as in operator_active_role.
    select distinct on (m.user_id) m.user_id, m.role, m.display_name
    from public.operator_memberships m
    where m.active and m.revoked_at is null
      and (m.workspace_id = p_workspace or m.scope = 'all-sites')
    order by m.user_id, (m.workspace_id is not null) desc
  ),
  names as (
    -- Latest name on record, so people whose membership ended still have one.
    select distinct on (m.user_id) m.user_id, m.display_name
    from public.operator_memberships m
    where m.workspace_id = p_workspace or m.scope = 'all-sites'
    order by m.user_id, (m.active and m.revoked_at is null) desc,
      (m.workspace_id is not null) desc
  ),
  activity as (
    select c.role, c.user_id, ''::text as profile_id, 'command'::text as kind,
      c.command as detail, count(*) as uses,
      count(distinct (c.committed_at at time zone 'Asia/Kuala_Lumpur')::date) as active_days,
      max(c.committed_at) as last_at
    from public.operator_commits c
    where c.workspace_id = p_workspace
      and c.committed_at >= (p_since::timestamp at time zone 'Asia/Kuala_Lumpur')
    group by c.role, c.user_id, c.command
    union all
    select u.role, u.user_id, u.profile_id, u.kind, u.detail, sum(u.uses)::bigint,
      count(distinct u.day), max(u.last_at)
    from public.operator_usage_daily u
    where u.workspace_id = p_workspace and u.day >= p_since
    group by u.role, u.user_id, u.profile_id, u.kind, u.detail
  ),
  days as (
    select c.role, c.user_id, ''::text as profile_id,
      (c.committed_at at time zone 'Asia/Kuala_Lumpur')::date as day, c.committed_at as at
    from public.operator_commits c
    where c.workspace_id = p_workspace
      and c.committed_at >= (p_since::timestamp at time zone 'Asia/Kuala_Lumpur')
    union all
    select u.role, u.user_id, u.profile_id, u.day, u.last_at
    from public.operator_usage_daily u
    where u.workspace_id = p_workspace and u.day >= p_since
  )
  select m.role, m.user_id, m.display_name, ''::text, 'member'::text, ''::text,
    0::bigint, 0::bigint, null::timestamptz
  from members m
  union all
  select d.role, d.user_id, coalesce(n.display_name, ''), d.profile_id, 'active'::text,
    ''::text, 0::bigint, count(distinct d.day), max(d.at)
  from days d left join names n on n.user_id = d.user_id
  group by d.role, d.user_id, n.display_name, d.profile_id
  union all
  select a.role, a.user_id, coalesce(n.display_name, ''), a.profile_id, a.kind, a.detail,
    a.uses, a.active_days, a.last_at
  from activity a left join names n on n.user_id = a.user_id;
end;
$$;
revoke all on function public.operator_usage_report(uuid, date) from public, anon;
grant execute on function public.operator_usage_report(uuid, date) to authenticated;
