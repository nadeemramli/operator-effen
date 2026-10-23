-- Rollback for 20261026090000_operator_catalog_edit.sql: the catalogue commands go back to
-- orders.import (office admin only), `import-release` loses the `skuAliases` scope and the
-- `catalog.edit` capability rows are removed. SKUs remembered by releases stay in the
-- workspace document (`skuAliases`) as ordinary catalogue records.

delete from public.operator_command_rules
where command in ('sku-alias-save', 'sku-alias-retire', 'sku-alias-reactivate', 'import-release');
insert into public.operator_command_rules (command, capability, state_keys) values
  ('sku-alias-save', 'orders.import', '{skuAliases,events}'),
  ('sku-alias-retire', 'orders.import', '{skuAliases,events}'),
  ('sku-alias-reactivate', 'orders.import', '{skuAliases,events}'),
  ('import-release', 'orders.import', '{awbImports,orders,events}');
delete from public.operator_role_capabilities where capability = 'catalog.edit';
