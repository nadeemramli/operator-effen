-- Rollback for 20261117090000_operator_usage_detail.sql: removes the per-day usage report and
-- returns the usage log to screen views and refused saves only. The sign-in and form-opened
-- counters are deleted (export public.operator_usage_daily first if they are still wanted).
-- Deploy the application without the per-person usage view first, or that view falls back
-- to the per-role figures.

drop function if exists public.operator_usage_days(uuid, date);
delete from public.operator_usage_daily where kind in ('open', 'sign-in');
alter table public.operator_usage_daily
  drop constraint operator_usage_daily_kind_check,
  add constraint operator_usage_daily_kind_check check (kind in ('view', 'failed'));

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
