-- One driver role and driver trip logs (follows 20261005090000_operator_trusted_commands.sql).
--
-- Owner decision 2026-10-06: driver and assistant driver are one role, not two. The driver
-- signs in and logs their own trips: assistant name, pickup time, arrival time and a photo.
-- The assistant is recorded by name on the trip and does not sign in.
--   * Existing 'assistant' memberships become 'driver' memberships (the same view and
--     feedback access, plus trip logging). Site policies keyed on 'assistant' are dropped.
--   * trips.log (driver): commands trip / trip-update, scope {trips,events}.
--   * trips.read (stock-out SV, management): read every trip photo at the site.
--   * Database invariants on top of the existing ones: trips are never removed; recorded
--     trip fields never change; only the driver who logged a trip may add its missing
--     arrival time or photo; new trips are attributed to the signed-in driver; arrival is
--     never before pickup; a photo lives in that driver's own folder.
--   * Photos: private bucket operator-trip-photos, <workspace id>/<driver user id>/<sha256>.jpg.
--     Drivers upload and read their own folder; trips.read reads the whole site. The
--     fictional sandbox keeps per-account trip-draft-photos folders.
-- Rollback: supabase/rollback/20261006090000_operator_driver_trips.down.sql.

-- ---------------------------------------------------------------------------------------
-- One driver role
-- ---------------------------------------------------------------------------------------
update public.operator_memberships
set role = 'driver', updated_at = now()
where role = 'assistant';
alter table public.operator_memberships drop constraint operator_memberships_role_check;
alter table public.operator_memberships add constraint operator_memberships_role_check
  check (role in ('production', 'intake', 'outbound', 'admin', 'hr', 'management',
                  'packer', 'driver'));
delete from public.operator_role_capabilities where role = 'assistant';
delete from public.operator_grantable_roles where grantable_role = 'assistant';
update public.operator_workspaces
set write_policy = write_policy - 'assistant'
where write_policy ? 'assistant';

-- ---------------------------------------------------------------------------------------
-- Trip capabilities and commands (kept in sync with apps/web/src/lib/capabilities.ts)
-- ---------------------------------------------------------------------------------------
insert into public.operator_role_capabilities (role, capability) values
  ('driver', 'trips.log'), ('outbound', 'trips.read'), ('management', 'trips.read');
insert into public.operator_command_rules (command, capability, state_keys) values
  ('trip', 'trips.log', '{trips,events}'),
  ('trip-update', 'trips.log', '{trips,events}');

-- ---------------------------------------------------------------------------------------
-- Trip invariants. The existing checks keep running unchanged under a new name; the commit
-- function calls operator_private.assert_transition, which now runs both.
-- ---------------------------------------------------------------------------------------
alter function operator_private.assert_transition(jsonb, jsonb, uuid)
  rename to assert_core_transition;

create function operator_private.assert_trip_transition(p_old jsonb, p_new jsonb, p_uid uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if jsonb_typeof(coalesce(p_new -> 'trips', '[]')) <> 'array' or exists (
    select 1 from jsonb_array_elements(coalesce(p_new -> 'trips', '[]')) n
    where (jsonb_typeof(n) = 'object'
      and coalesce(n ->> 'id', '') <> ''
      and coalesce(n ->> 'pickupAt', '') <> ''
      and coalesce(n ->> 'arriveAt', n ->> 'pickupAt') collate "C" >= (n ->> 'pickupAt') collate "C"
    ) is not true
  ) or exists (
    select 1 from jsonb_array_elements(coalesce(p_new -> 'trips', '[]')) n
    group by n ->> 'id' having count(*) > 1
  ) then
    raise exception 'Trips need an identifier and a pickup time, and arrival cannot be before pickup.'
      using errcode = '23514';
  end if;
  -- Recorded trips are never removed or rewritten. Only their own driver may add the
  -- arrival time or photo that is still missing.
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_old -> 'trips', '[]')) o
    left join lateral (
      select n from jsonb_array_elements(coalesce(p_new -> 'trips', '[]')) n
      where n ->> 'id' = o ->> 'id' limit 1) x on true
    where x.n is null
      or exists (select 1 from jsonb_each(o) f where x.n -> f.key is distinct from f.value)
      or exists (
        select 1 from jsonb_object_keys(x.n) k
        where not o ? k and k not in ('arriveAt', 'arrivalRecordedAt', 'photo', 'photoRecordedAt'))
      or (x.n is distinct from o and coalesce(o -> 'recordedBy' ->> 'userId', '') <> p_uid::text)
  ) then
    raise exception 'Recorded trips cannot be changed or removed; only their driver can add a missing arrival time or photo.'
      using errcode = '23514';
  end if;
  -- New trips belong to the signed-in driver.
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_new -> 'trips', '[]')) n
    where not exists (
      select 1 from jsonb_array_elements(coalesce(p_old -> 'trips', '[]')) o
      where o ->> 'id' = n ->> 'id')
      and coalesce(n -> 'recordedBy' ->> 'userId', '') <> p_uid::text
  ) then
    raise exception 'New trips must be attributed to the signed-in driver.' using errcode = '23514';
  end if;
  -- A newly attached photo comes from the signed-in driver's own folder.
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_new -> 'trips', '[]')) n
    where n ? 'photo'
      and not exists (
        select 1 from jsonb_array_elements(coalesce(p_old -> 'trips', '[]')) o
        where o ->> 'id' = n ->> 'id' and o ? 'photo')
      and (n ->> 'photo' ~ ('^[0-9a-f-]{36}/' || p_uid::text || '/[0-9a-f]{64}\.jpg$')) is not true
  ) then
    raise exception 'A trip photo must be uploaded by the driver who logged the trip.' using errcode = '23514';
  end if;
end
$$;

create function operator_private.assert_transition(p_old jsonb, p_new jsonb, p_uid uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform operator_private.assert_core_transition(p_old, p_new, p_uid);
  perform operator_private.assert_trip_transition(p_old, p_new, p_uid);
end
$$;
revoke all on function operator_private.assert_core_transition(jsonb, jsonb, uuid),
  operator_private.assert_trip_transition(jsonb, jsonb, uuid),
  operator_private.assert_transition(jsonb, jsonb, uuid) from public;

-- ---------------------------------------------------------------------------------------
-- Trip photos
-- ---------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('operator-trip-photos', 'operator-trip-photos', false, 5242880, array['image/jpeg']),
  ('trip-draft-photos', 'trip-draft-photos', false, 5242880, array['image/jpeg']);

-- <workspace id>/<driver user id>/<sha256>.jpg. Writing: only the driver, in their own
-- folder, with trips.log at that site. Reading: the same driver, or trips.read at the site.
create function public.operator_trip_photo_access(p_name text, p_write boolean)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}\.jpg$'
    then coalesce(
      (split_part(p_name, '/', 2) = (select auth.uid())::text
        and public.operator_has_capability(split_part(p_name, '/', 1)::uuid, 'trips.log'))
      or (p_write is false
        and public.operator_has_capability(split_part(p_name, '/', 1)::uuid, 'trips.read')),
      false)
    else false
  end
$$;
revoke all on function public.operator_trip_photo_access(text, boolean) from public, anon;
grant execute on function public.operator_trip_photo_access(text, boolean) to authenticated;

create policy "drivers upload own trip photos" on storage.objects
for insert to authenticated with check (
  bucket_id = 'operator-trip-photos' and public.operator_trip_photo_access(name, true)
);
create policy "drivers and reviewers read trip photos" on storage.objects
for select to authenticated using (
  bucket_id = 'operator-trip-photos' and public.operator_trip_photo_access(name, false)
);
create policy "testers upload own trip photos" on storage.objects
for insert to authenticated with check (
  bucket_id = 'trip-draft-photos' and (storage.foldername(name))[1] = (select auth.uid())::text
  and (select auth.jwt()) -> 'app_metadata' ->> 'ui_draft_access' = 'true'
);
create policy "testers read own trip photos" on storage.objects
for select to authenticated using (
  bucket_id = 'trip-draft-photos' and (storage.foldername(name))[1] = (select auth.uid())::text
  and (select auth.jwt()) -> 'app_metadata' ->> 'ui_draft_access' = 'true'
);
