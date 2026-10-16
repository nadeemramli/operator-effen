-- Package SKU mappings for AWB imports (follows 20261019090000_operator_batch_cancel.sql).
--
-- Three commands, kept in sync with apps/web/src/lib/capabilities.ts
-- (tests/capabilities.test.mjs compares them), all with capability orders.import (the
-- office admin, who imports the AWB PDFs) and scope {skuAliases,events}:
--   * `sku-alias-save`: maps a package SKU the built-in defaults do not know (product and
--     units per package), or edits a mapping with a reason. Later imports resolve the SKU
--     automatically.
--   * `sku-alias-retire` / `sku-alias-reactivate`: stops or resumes using a mapping, with a
--     reason. Mappings are never deleted; each keeps its own history.
-- The mappings live in the workspace document under the new top-level key `skuAliases`;
-- operator_commit_workspace limits each command to its state keys, so no other command
-- can change them and these commands can change nothing else. The application refuses a
-- SKU that is already built in, an unknown product and units outside 1 to 1000.
-- Additive: no data changes.
-- Rollback: supabase/rollback/20261020090000_operator_sku_aliases.down.sql.

insert into public.operator_command_rules (command, capability, state_keys) values
  ('sku-alias-save', 'orders.import', '{skuAliases,events}'),
  ('sku-alias-retire', 'orders.import', '{skuAliases,events}'),
  ('sku-alias-reactivate', 'orders.import', '{skuAliases,events}');
