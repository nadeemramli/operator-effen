-- Rollback for 20261020090000_operator_sku_aliases.sql: removes the three command rules.
-- Mappings already saved stay in the workspace document (`skuAliases`), unchanged and
-- no longer editable; the application version before this one ignores them.

delete from public.operator_command_rules
where command in ('sku-alias-save', 'sku-alias-retire', 'sku-alias-reactivate');
