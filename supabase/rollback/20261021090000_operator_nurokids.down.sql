-- Rollback for 20261021090000_operator_nurokids.sql: restores the factory map from
-- 20261007090000_operator_factory_scope.sql (Nurokids batches then match no factory, so a
-- factory-scoped supervisor can no longer change them).
create or replace function operator_private.product_factory(p_product text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_product = 'ady' then 'sachet'
    when p_product in ('cav', 'gly', 'lip', 'syn') then 'bottle'
  end
$$;
