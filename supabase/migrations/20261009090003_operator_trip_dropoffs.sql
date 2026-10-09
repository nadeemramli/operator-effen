-- Driver trips: several assistants and drop-offs with photo and time (follows
-- 20261009090002_operator_stock_returns.sql).
--
-- Floor improvements plan WP4 (docs/floor-improvements-plan-2026-10.md), on top of the shared
-- driver sign-in (20261008090000 era, PR #20):
--   * Command `trip-dropoff` (capability trips.log, scope {trips,events}), kept in sync with
--     apps/web/src/lib/capabilities.ts (tests/capabilities.test.mjs compares them).
--   * operator_private.assert_trip_transition, replaced with the same signature: an existing
--     trip may also gain `dropoffs`, appended only (earlier drop-offs unchanged and in place),
--     still only by the sign-in that logged it; each new drop-off needs an id, a time not before
--     pickup and a photo in the signed-in account's own folder; at most 20 per trip. New trips
--     may carry `assistants` (no rule beyond being attributed to the signed-in driver).
--     Everything else is unchanged from 20261006090000.
-- Additive: no data changes; existing trips have no drop-offs.
-- Rollback: supabase/rollback/20261009090003_operator_trip_dropoffs.down.sql.

insert into public.operator_command_rules (command, capability, state_keys) values
  ('trip-dropoff', 'trips.log', '{trips,events}');

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
      or exists (
        select 1 from jsonb_each(o) f
        where f.key <> 'dropoffs' and x.n -> f.key is distinct from f.value)
      or exists (
        select 1 from jsonb_object_keys(x.n) k
        where not o ? k
          and k not in ('arriveAt', 'arrivalRecordedAt', 'photo', 'photoRecordedAt', 'dropoffs'))
      -- Drop-offs are appended only: every earlier drop-off stays, unchanged and in place.
      or (o ? 'dropoffs' and (
        coalesce(jsonb_typeof(x.n -> 'dropoffs'), 'missing') <> 'array'
        or exists (
          select 1 from jsonb_array_elements(o -> 'dropoffs') with ordinality d(v, i)
          where x.n -> 'dropoffs' -> (d.i::int - 1) is distinct from d.v)))
      or (x.n is distinct from o and coalesce(o -> 'recordedBy' ->> 'userId', '') <> p_uid::text)
  ) then
    raise exception 'Recorded trips cannot be changed or removed; only their driver can add a missing arrival time or photo.'
      using errcode = '23514';
  end if;
  -- New drop-offs (20261009090003): at most 20 per trip; each has an identifier, a time
  -- not before pickup and a proof photo from the signed-in account's own folder.
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_new -> 'trips', '[]')) n
    where n ? 'dropoffs' and (
      coalesce(jsonb_typeof(n -> 'dropoffs'), 'missing') <> 'array'
      or jsonb_array_length(n -> 'dropoffs') > 20)
  ) or exists (
    select 1 from jsonb_array_elements(coalesce(p_new -> 'trips', '[]')) n
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(n -> 'dropoffs') = 'array' then n -> 'dropoffs' else '[]' end
    ) with ordinality d(v, i)
    where d.i > coalesce((
        select jsonb_array_length(o -> 'dropoffs') from jsonb_array_elements(coalesce(p_old -> 'trips', '[]')) o
        where o ->> 'id' = n ->> 'id' and jsonb_typeof(o -> 'dropoffs') = 'array' limit 1), 0)
      and (jsonb_typeof(d.v) is distinct from 'object'
        or coalesce(d.v ->> 'id', '') = ''
        or coalesce(d.v ->> 'at', '') = ''
        or (d.v ->> 'at') collate "C" < (n ->> 'pickupAt') collate "C"
        or (d.v ->> 'photo' ~ ('^[0-9a-f-]{36}/' || p_uid::text || '/[0-9a-f]{64}\.jpg$')) is not true)
  ) then
    raise exception 'A drop-off needs a time not before pickup and a photo uploaded by the driver who logged the trip.'
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
