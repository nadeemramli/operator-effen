-- Packers record their own packed counts behind a personal PIN (follows
-- 20261007090000_operator_factory_scope.sql).
--
-- Owner decision 2026-10-06: packers share one sign-in per site. The stock-out supervisor sets
-- up a packer profile (name) and a PIN for each person. On the shared account, a packer picks
-- their name, enters their PIN, sees the AWBs assigned to them and records what they packed.
-- The supervisor still corrects saved counts and reviews the daily tally.
--   * packing.record (packer): command pack-own, scope {orders,events}. The API server only
--     signs a pack-own commit for the profile unlocked with its PIN, only for AWBs assigned to
--     that profile and only for a first count; corrections stay outbound.correct.
--   * staff-profile-create / staff-profile-update (members.manage): packer profiles live in
--     workspace state (staffProfiles); the domain rules allow the stock-out supervisor and HR.
--   * PINs are never in workspace state, which every member of the site can read. They are
--     bcrypt hashes in operator_private.staff_pins, reachable only through the functions
--     below: set (stock-out supervisor or HR), verify (packing.record, five wrong PINs lock
--     the profile for 15 minutes) and status (no hashes).
-- Additive: new reference rows, one private table and three functions.
-- Mirrors apps/web/src/lib/capabilities.ts; tests/capabilities.test.mjs checks they stay in step.
-- Rollback: supabase/rollback/20261008090000_operator_packer_self_entry.down.sql.

insert into public.operator_role_capabilities (role, capability) values
  ('packer', 'packing.record');
insert into public.operator_command_rules (command, capability, state_keys) values
  ('pack-own', 'packing.record', '{orders,events}'),
  ('staff-profile-create', 'members.manage', '{staffProfiles,events}'),
  ('staff-profile-update', 'members.manage', '{staffProfiles,events}');

create table operator_private.staff_pins (
  workspace_id uuid not null references public.operator_workspaces(id) on delete cascade,
  profile_id text not null check (char_length(profile_id) between 1 and 100),
  pin_hash text not null,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  set_by uuid not null,
  set_at timestamptz not null default now(),
  primary key (workspace_id, profile_id)
);
revoke all on operator_private.staff_pins from public, anon, authenticated;

-- An active packer profile in the workspace state.
create function operator_private.packer_profile_exists(p_workspace uuid, p_profile text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.operator_workspaces w
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(w.state -> 'staffProfiles') = 'array'
        then w.state -> 'staffProfiles' else '[]'::jsonb end) p
    where w.id = p_workspace
      and p ->> 'id' = p_profile
      and p ->> 'role' = 'packer'
      and coalesce(p ->> 'active', 'true') <> 'false')
$$;
revoke all on function operator_private.packer_profile_exists(uuid, text) from public;

-- Sets or replaces a packer's PIN and clears any lockout. Stock-out supervisor or HR only.
create function public.operator_set_staff_pin(p_workspace uuid, p_profile text, p_pin text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'Sign in again.' using errcode = '28000';
  end if;
  if (public.operator_active_role(p_workspace) in ('outbound', 'hr')
    and public.operator_has_capability(p_workspace, 'members.manage')) is not true then
    raise exception 'Only the stock-out supervisor or HR can set packer PINs.' using errcode = '42501';
  end if;
  if (p_pin ~ '^[0-9]{4,6}$') is not true then
    raise exception 'Use a PIN of 4 to 6 digits.' using errcode = '22023';
  end if;
  if operator_private.packer_profile_exists(p_workspace, p_profile) is not true then
    raise exception 'Choose an active packer profile at this site.' using errcode = '22023';
  end if;
  insert into operator_private.staff_pins (workspace_id, profile_id, pin_hash, set_by)
  values (p_workspace, p_profile, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)), v_uid)
  on conflict (workspace_id, profile_id) do update
  set pin_hash = excluded.pin_hash, failed_attempts = 0, locked_until = null,
    set_by = excluded.set_by, set_at = now();
end
$$;

-- Checks a packer's PIN for the shared packer sign-in. Returns 'ok', 'wrong', 'locked' or
-- 'unset' instead of raising, so the failed-attempt count persists. Five wrong PINs in a row
-- lock the profile for 15 minutes; a new PIN from the supervisor clears the lock.
create function public.operator_verify_staff_pin(p_workspace uuid, p_profile text, p_pin text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pin operator_private.staff_pins%rowtype;
begin
  if (select auth.uid()) is null then
    raise exception 'Sign in again.' using errcode = '28000';
  end if;
  if public.operator_has_capability(p_workspace, 'packing.record') is not true then
    raise exception 'Your role at this site does not record packing.' using errcode = '42501';
  end if;
  if operator_private.packer_profile_exists(p_workspace, p_profile) is not true then
    return 'unset';
  end if;
  select * into v_pin from operator_private.staff_pins s
  where s.workspace_id = p_workspace and s.profile_id = p_profile
  for update;
  if not found then
    return 'unset';
  end if;
  if v_pin.locked_until > now() then
    return 'locked';
  end if;
  if p_pin is not null and p_pin ~ '^[0-9]{4,6}$'
    and extensions.crypt(p_pin, v_pin.pin_hash) = v_pin.pin_hash then
    update operator_private.staff_pins s set failed_attempts = 0, locked_until = null
    where s.workspace_id = p_workspace and s.profile_id = p_profile;
    return 'ok';
  end if;
  update operator_private.staff_pins s
  set failed_attempts = case when v_pin.failed_attempts + 1 >= 5 then 0 else v_pin.failed_attempts + 1 end,
    locked_until = case when v_pin.failed_attempts + 1 >= 5 then now() + interval '15 minutes' end
  where s.workspace_id = p_workspace and s.profile_id = p_profile;
  return case when v_pin.failed_attempts + 1 >= 5 then 'locked' else 'wrong' end;
end
$$;

-- Which packer profiles have a PIN and which are locked. Never returns hashes.
create function public.operator_staff_pin_status(p_workspace uuid)
returns table (profile_id text, set_at timestamptz, locked_until timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (public.operator_active_role(p_workspace) in ('outbound', 'hr')
    and public.operator_has_capability(p_workspace, 'members.manage')) is not true then
    raise exception 'Only the stock-out supervisor or HR can view packer PINs.' using errcode = '42501';
  end if;
  return query
  select s.profile_id, s.set_at, case when s.locked_until > now() then s.locked_until end
  from operator_private.staff_pins s
  where s.workspace_id = p_workspace;
end
$$;

revoke all on function public.operator_set_staff_pin(uuid, text, text),
  public.operator_verify_staff_pin(uuid, text, text),
  public.operator_staff_pin_status(uuid) from public, anon;
grant execute on function public.operator_set_staff_pin(uuid, text, text),
  public.operator_verify_staff_pin(uuid, text, text),
  public.operator_staff_pin_status(uuid) to authenticated;

comment on table operator_private.staff_pins is
  'Packer PINs (bcrypt) for the shared packer sign-in. Reached only through operator_set_staff_pin, operator_verify_staff_pin and operator_staff_pin_status.';
