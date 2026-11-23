-- Luminosyl and Cissupetide, bottle products made at the bottle factory (follows
-- 20261116090000_operator_usage.sql).
--
-- `products` in apps/web/src/lib/draft.ts gains ids `lum` and `cis`. The factory map used
-- by the factory-scope rules (operator_private.assert_factory_scope) must know them, or a
-- bottle-scoped production supervisor would be refused on their batches and a
-- sachet-scoped one allowed. tests/factory-scope.test.mjs compares this definition with
-- the app's product list. No tables or rules change.
-- Additive: no data changes.
-- Rollback: supabase/rollback/20261123090000_operator_luminosyl_cissupetide.down.sql.

create or replace function operator_private.product_factory(p_product text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_product = 'ady' then 'sachet'
    when p_product in ('cav', 'gly', 'lip', 'syn', 'nur', 'lum', 'cis') then 'bottle'
  end
$$;
