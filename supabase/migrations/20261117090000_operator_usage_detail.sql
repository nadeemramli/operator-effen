-- Usage per person and day (follows 20261116090000_operator_usage.sql).
--
-- Owner request 2026-11-16: Management wants to see, per person, who signed in, what they
-- did each day, how far through the role's process they got and where they stopped, so the
-- person can be asked about a specific day.
--   * public.operator_usage_daily accepts two more kinds: `sign-in` (the person signed in;
--     detail is `sign-in`) and `open` (an entry form was opened; detail is the command).
--     A form opened and not saved shows where someone stopped. Still no record contents,
--     reasons or free text.
--   * public.operator_log_usage accepts those kinds; everything else is unchanged.
--   * public.operator_usage_days: Management and HR only. One site's activity per Malaysia
--     day, role, user, packer profile, kind and detail, with the count and the first and
--     last time, as one JSON array of arrays
--     [day, role, user_id, profile_id, kind, detail, uses, first_at, last_at].
--     Saved actions (`command`) come from operator_commits; the rest from the usage log.
--     One JSON value, so the Data API row limit cannot cut a long period short. At most the
--     last 92 days.
-- Additive: one check constraint widened, one function replaced, one function added.
-- Rollback: supabase/rollback/20261117090000_operator_usage_detail.down.sql.

alter table public.operator_usage_daily
  drop constraint operator_usage_daily_kind_check,
  add constraint operator_usage_daily_kind_check
    check (kind in ('view', 'failed', 'open', 'sign-in'));

create or replace function public.operator_log_usage(
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
        when 'sign-in' then p_detail = 'sign-in'
        when 'failed' then exists (
          select 1 from public.operator_command_rules r where r.command = p_detail)
        when 'open' then exists (
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

create function public.operator_usage_days(p_workspace uuid, p_since date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_since date;
  v_result jsonb;
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
  v_since := greatest(p_since, (now() at time zone 'Asia/Kuala_Lumpur')::date - 92);
  select coalesce(jsonb_agg(jsonb_build_array(
      d.day, d.role, d.user_id, d.profile_id, d.kind, d.detail, d.uses, d.first_at, d.last_at)
      order by d.day, d.first_at), '[]'::jsonb)
  into v_result
  from (
    select (c.committed_at at time zone 'Asia/Kuala_Lumpur')::date as day, c.role, c.user_id,
      ''::text as profile_id, 'command'::text as kind, c.command as detail,
      count(*) as uses, min(c.committed_at) as first_at, max(c.committed_at) as last_at
    from public.operator_commits c
    where c.workspace_id = p_workspace
      and c.committed_at >= (v_since::timestamp at time zone 'Asia/Kuala_Lumpur')
    group by 1, c.role, c.user_id, c.command
    union all
    select u.day, u.role, u.user_id, u.profile_id, u.kind, u.detail, u.uses::bigint,
      u.first_at, u.last_at
    from public.operator_usage_daily u
    where u.workspace_id = p_workspace and u.day >= v_since
  ) d;
  return v_result;
end;
$$;
revoke all on function public.operator_usage_days(uuid, date) from public, anon;
grant execute on function public.operator_usage_days(uuid, date) to authenticated;
