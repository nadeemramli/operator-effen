-- Adypocide factory and warehouse stages (follows 20261007090000_operator_factory_scope.sql).
--
-- Floor improvements plan WP2 (docs/floor-improvements-plan-2026-10.md). Every sachet route
-- is split by stage key into factory stages (mixing, filling), recorded by production, and
-- warehouse stages (every later stage: batching, hologram, wrapping), recorded by stock-in
-- before the box count.
--   * operator_private.factory_stage(text): the split, kept identical to `factoryStages` in
--     apps/web/src/lib/draft.ts (tests/warehouse-stages.test.mjs compares them).
--   * operator_private.assert_core_transition, replaced with the same signature:
--       - transfer gate: a newly transferred batch with a route snapshot needs its factory
--         stages completed with a PIC (previously every route stage);
--       - new box-count gate: a new carton of a batch with a route snapshot needs every
--         route stage completed with a PIC.
--     All other checks are unchanged from 20261005090000.
-- Additive: no data changes. Existing transferred batches and cartons are not re-checked
-- (both gates apply only to records that are new in a change).
-- Rollback: supabase/rollback/20261009090001_operator_warehouse_stages.down.sql.

create function operator_private.factory_stage(p_stage text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_stage in ('mixing', 'filling')
$$;
revoke all on function operator_private.factory_stage(text) from public;

create or replace function operator_private.assert_core_transition(p_old jsonb, p_new jsonb, p_uid uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  k text;
begin
  -- Append-only collections: every earlier record is kept unchanged.
  foreach k in array array['events', 'issues', 'adjustments', 'notes', 'sortCounts'] loop
    if jsonb_typeof(coalesce(p_new -> k, '[]')) <> 'array' or exists (
      select e from jsonb_array_elements(coalesce(p_old -> k, '[]')) e
      except
      select e from jsonb_array_elements(coalesce(p_new -> k, '[]')) e
    ) then
      raise exception 'Existing % records cannot be changed or removed.', k using errcode = '23514';
    end if;
  end loop;
  -- New audit entries and notes are attributed to the signed-in user.
  if exists (
    select 1 from (
      select e from jsonb_array_elements(coalesce(p_new -> 'events', '[]')) e
      except select e from jsonb_array_elements(coalesce(p_old -> 'events', '[]')) e
    ) n where coalesce(n.e -> 'recorder' ->> 'userId', '') <> p_uid::text
  ) then
    raise exception 'New audit entries must be attributed to the signed-in user.' using errcode = '23514';
  end if;
  if exists (
    select 1 from (
      select e from jsonb_array_elements(coalesce(p_new -> 'notes', '[]')) e
      except select e from jsonb_array_elements(coalesce(p_old -> 'notes', '[]')) e
    ) n where coalesce(n.e -> 'author' ->> 'userId', '') <> p_uid::text
  ) then
    raise exception 'New notes must be attributed to the signed-in user.' using errcode = '23514';
  end if;
  -- Stock movements are positive whole quantities.
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_new -> 'issues', '[]')) i
    where coalesce(jsonb_typeof(i -> 'qty'), 'missing') <> 'number'
      or ((i ->> 'qty')::numeric > 0 and (i ->> 'qty')::numeric = trunc((i ->> 'qty')::numeric)) is not true
  ) then
    raise exception 'Stock issues must be positive whole quantities.' using errcode = '23514';
  end if;
  -- Every carton has a non-negative whole received quantity.
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_new -> 'cartons', '[]')) c
    where coalesce(jsonb_typeof(c -> 'qty'), 'missing') <> 'number'
      or ((c ->> 'qty')::numeric >= 0 and (c ->> 'qty')::numeric = trunc((c ->> 'qty')::numeric)) is not true
      or coalesce(c ->> 'id', '') = ''
  ) then
    raise exception 'Cartons need an identifier and a whole received quantity.' using errcode = '23514';
  end if;
  -- Received cartons keep their quantity, batch, product and unit, and are never removed.
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_old -> 'cartons', '[]')) o
    where not exists (
      select 1 from jsonb_array_elements(coalesce(p_new -> 'cartons', '[]')) n
      where n ->> 'id' = o ->> 'id' and n -> 'qty' = o -> 'qty'
        and n ->> 'batchId' is not distinct from o ->> 'batchId'
        and n ->> 'product' = o ->> 'product' and n ->> 'unit' = o ->> 'unit')
  ) then
    raise exception 'Received stock cannot be rewritten.' using errcode = '23514';
  end if;
  -- Inventory conservation: no carton balance may fall below zero (or further below an
  -- existing historical deficit). Aggregated per carton to stay linear in document size.
  if exists (
    with docs(version, doc) as (values ('old', p_old), ('new', p_new)),
    issued as (
      select d.version, i ->> 'cartonId' as id, sum((i ->> 'qty')::numeric) as q
      from docs d, jsonb_array_elements(coalesce(d.doc -> 'issues', '[]')) i group by 1, 2),
    boxed as (
      select d.version, b ->> 'sourceId' as id,
        sum((b ->> 'boxes')::numeric * (b ->> 'ratio')::numeric + (b ->> 'loss')::numeric) as q
      from docs d, jsonb_array_elements(coalesce(d.doc -> 'boxing', '[]')) b group by 1, 2),
    adjusted as (
      select d.version, a ->> 'cartonId' as id, sum((a ->> 'delta')::numeric) as q
      from docs d, jsonb_array_elements(coalesce(d.doc -> 'adjustments', '[]')) a group by 1, 2),
    balances as (
      select d.version, c ->> 'id' as id,
        (c ->> 'qty')::numeric - coalesce(i.q, 0) - coalesce(x.q, 0) + coalesce(a.q, 0) as available
      from docs d
      cross join jsonb_array_elements(coalesce(d.doc -> 'cartons', '[]')) c
      left join issued i on i.version = d.version and i.id = c ->> 'id'
      left join boxed x on x.version = d.version and x.id = c ->> 'id'
      left join adjusted a on a.version = d.version and a.id = c ->> 'id')
    select 1 from balances n
    left join balances o on o.version = 'old' and o.id = n.id
    where n.version = 'new'
      and (n.available is null or (n.available < 0 and n.available < coalesce(o.available, 0)))
  ) then
    raise exception 'This change would take a carton below zero stock.' using errcode = '23514';
  end if;
  -- Batches: never removed; identity, custody and route snapshots are fixed once set.
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_old -> 'batches', '[]')) o
    left join (
      select n ->> 'id' as id, n from jsonb_array_elements(coalesce(p_new -> 'batches', '[]')) n
    ) x on x.id = o ->> 'id'
    where x.n is null
      or x.n ->> 'code' is distinct from o ->> 'code'
      or x.n ->> 'product' is distinct from o ->> 'product'
      or (o ->> 'transferredAt' is not null and (
        x.n ->> 'transferredAt' is distinct from o ->> 'transferredAt'
        or x.n ->> 'transferPic' is distinct from o ->> 'transferPic'))
      or coalesce((x.n ->> 'sent')::numeric, 0) < coalesce((o ->> 'sent')::numeric, 0)
      or (o -> 'route' is not null and (
        x.n -> 'route' -> 'id' is distinct from o -> 'route' -> 'id'
        or x.n -> 'route' -> 'stages' is distinct from o -> 'route' -> 'stages'))
      or jsonb_array_length(coalesce(x.n -> 'steps', '[]')) < jsonb_array_length(coalesce(o -> 'steps', '[]'))
      or exists (
        select r from jsonb_array_elements(coalesce(o -> 'revisions', '[]')) r
        except select r from jsonb_array_elements(coalesce(x.n -> 'revisions', '[]')) r)
  ) then
    raise exception 'Batch identity, custody, route or revision history cannot be rewritten.' using errcode = '23514';
  end if;
  -- Step history: completion is not undone; PIC history, corrections and rework are
  -- append-only; new entries are attributed to the signed-in user.
  if exists (
    with new_steps as (
      select nb ->> 'id' as batch, ns.pos, ns.step
      from jsonb_array_elements(coalesce(p_new -> 'batches', '[]')) nb
      cross join lateral jsonb_array_elements(coalesce(nb -> 'steps', '[]')) with ordinality ns(step, pos)),
    old_steps as (
      select ob ->> 'id' as batch, os.pos, os.step
      from jsonb_array_elements(coalesce(p_old -> 'batches', '[]')) ob
      cross join lateral jsonb_array_elements(coalesce(ob -> 'steps', '[]')) with ordinality os(step, pos))
    select 1
    from new_steps ns
    left join old_steps o on o.batch = ns.batch and o.pos = ns.pos
    -- Unchanged steps need no further checks.
    where ns.step is distinct from o.step and (
      (coalesce((o.step ->> 'done')::boolean, false) and not coalesce((ns.step ->> 'done')::boolean, false))
      or exists (
        select h from jsonb_array_elements(coalesce(o.step -> 'picHistory', '[]')) h
        except select h from jsonb_array_elements(coalesce(ns.step -> 'picHistory', '[]')) h)
      or exists (
        select h from jsonb_array_elements(coalesce(o.step -> 'corrections', '[]')) h
        except select h from jsonb_array_elements(coalesce(ns.step -> 'corrections', '[]')) h)
      or exists (
        select h from jsonb_array_elements(coalesce(o.step -> 'occurrences', '[]')) h
        except select h from jsonb_array_elements(coalesce(ns.step -> 'occurrences', '[]')) h)
      or exists (
        select 1 from (
          select h from jsonb_array_elements(coalesce(ns.step -> 'picHistory', '[]')
            || coalesce(ns.step -> 'corrections', '[]') || coalesce(ns.step -> 'occurrences', '[]')) h
          except
          select h from jsonb_array_elements(coalesce(o.step -> 'picHistory', '[]')
            || coalesce(o.step -> 'corrections', '[]') || coalesce(o.step -> 'occurrences', '[]')) h
        ) added where coalesce(added.h -> 'recordedBy' ->> 'userId', '') <> p_uid::text)
      or (ns.step -> 'recordedBy' is distinct from o.step -> 'recordedBy'
        and coalesce(ns.step -> 'recordedBy' ->> 'userId', '') <> p_uid::text))
  ) then
    raise exception 'Stage history must be append-only and attributed to the signed-in user.' using errcode = '23514';
  end if;
  -- New revision flags are attributed to the signed-in user.
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_new -> 'batches', '[]')) nb,
      jsonb_array_elements(coalesce(nb -> 'revisions', '[]')) r
    where not exists (
      select 1 from jsonb_array_elements(coalesce(p_old -> 'batches', '[]')) ob,
        jsonb_array_elements(coalesce(ob -> 'revisions', '[]')) r2
      where ob ->> 'id' = nb ->> 'id' and r2 = r)
      and coalesce(r -> 'recordedBy' ->> 'userId', '') <> p_uid::text
  ) then
    raise exception 'Revision flags must be attributed to the signed-in user.' using errcode = '23514';
  end if;
  -- Transfer gate (20261009090001): a batch newly sent with a route snapshot needs its
  -- factory stages (mixing, filling) completed with a PIC. Warehouse stages are recorded by
  -- stock-in after transfer. Unsnapshotted legacy batches are handled by the server's
  -- explicit route review.
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_new -> 'batches', '[]')) nb
    where nb -> 'route' is not null and nb ->> 'transferredAt' is not null
      and not exists (
        select 1 from jsonb_array_elements(coalesce(p_old -> 'batches', '[]')) ob
        where ob ->> 'id' = nb ->> 'id' and ob ->> 'transferredAt' is not null)
      and (coalesce(jsonb_typeof(nb -> 'route' -> 'stages'), 'missing') <> 'array'
        or not exists (
          select 1 from jsonb_array_elements_text(nb -> 'route' -> 'stages') stage
          where operator_private.factory_stage(stage))
        or exists (
        select 1 from jsonb_array_elements_text(nb -> 'route' -> 'stages') stage
        where operator_private.factory_stage(stage) and not exists (
          select 1 from jsonb_array_elements(coalesce(nb -> 'steps', '[]')) st
          where st ->> 'sachetStage' = stage
            and coalesce((st ->> 'done')::boolean, false)
            and coalesce(st ->> 'pic', '') <> '')))
  ) then
    raise exception 'The mixing and filling stages need a completed record with a PIC before transfer.' using errcode = '23514';
  end if;
  -- Box-count gate (20261009090001): a carton that is new in this change and belongs to a
  -- batch with a route snapshot needs every stage of that route completed with a PIC in the
  -- new state. Bottle batches carry no route snapshot, so their cartons pass.
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_new -> 'cartons', '[]')) nc
    join lateral (
      select nb from jsonb_array_elements(coalesce(p_new -> 'batches', '[]')) nb
      where nb ->> 'id' = nc ->> 'batchId' limit 1) x on true
    where x.nb -> 'route' is not null
      and not exists (
        select 1 from jsonb_array_elements(coalesce(p_old -> 'cartons', '[]')) oc
        where oc ->> 'id' = nc ->> 'id')
      and (coalesce(jsonb_typeof(x.nb -> 'route' -> 'stages'), 'missing') <> 'array'
        or jsonb_array_length(x.nb -> 'route' -> 'stages') = 0
        or exists (
        select 1 from jsonb_array_elements_text(x.nb -> 'route' -> 'stages') stage
        where not exists (
          select 1 from jsonb_array_elements(coalesce(x.nb -> 'steps', '[]')) st
          where st ->> 'sachetStage' = stage
            and coalesce((st ->> 'done')::boolean, false)
            and coalesce(st ->> 'pic', '') <> '')))
  ) then
    raise exception 'Every stage of the batch route needs a completed record with a PIC before the box count.' using errcode = '23514';
  end if;
  -- Machines are never deleted; their change history is append-only and attributed.
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_old -> 'machines', '[]')) om
    left join lateral (
      select n from jsonb_array_elements(coalesce(p_new -> 'machines', '[]')) n
      where n ->> 'id' = om ->> 'id' limit 1) x on true
    where x.n is null
      or x.n ->> 'siteId' is distinct from om ->> 'siteId'
      or exists (
        select h from jsonb_array_elements(coalesce(om -> 'history', '[]')) h
        except select h from jsonb_array_elements(coalesce(x.n -> 'history', '[]')) h)
  ) or exists (
    select 1 from jsonb_array_elements(coalesce(p_new -> 'machines', '[]')) nm,
      jsonb_array_elements(coalesce(nm -> 'history', '[]')) h
    where not exists (
      select 1 from jsonb_array_elements(coalesce(p_old -> 'machines', '[]')) om,
        jsonb_array_elements(coalesce(om -> 'history', '[]')) h2
      where om ->> 'id' = nm ->> 'id' and h2 = h)
      and coalesce(h -> 'recordedBy' ->> 'userId', '') <> p_uid::text
  ) then
    raise exception 'Machine records and history cannot be rewritten.' using errcode = '23514';
  end if;
end
$$;
revoke all on function operator_private.assert_core_transition(jsonb, jsonb, uuid) from public;
