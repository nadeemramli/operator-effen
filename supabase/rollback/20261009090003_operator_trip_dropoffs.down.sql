-- Rollback for 20261009090003_operator_trip_dropoffs.sql: restores the 20261006090000 body of
-- operator_private.assert_trip_transition (no drop-offs) and removes the command rule.
-- Export operational state first: recorded drop-offs stay in the trips but no new ones can
-- be added, and a trip that already has drop-offs can no longer gain its arrival or photo.

create or replace function operator_private.assert_trip_transition(p_old jsonb, p_new jsonb, p_uid uuid)
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
revoke all on function operator_private.assert_trip_transition(jsonb, jsonb, uuid) from public;
delete from public.operator_command_rules where command = 'trip-dropoff';
