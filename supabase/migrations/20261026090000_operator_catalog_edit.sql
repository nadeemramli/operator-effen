-- Package SKU catalogue: its own capability, and releases that remember new SKUs (follows
-- 20261025090000_operator_box_recount.sql).
--
-- Owner request 2026-10-22: a label whose SKU the catalogue does not know goes to review on
-- every upload until someone adds the SKU in Package SKUs, and only the office admin could.
--   * New capability `catalog.edit`, held by the office admin and the stock-out supervisor.
--     The three catalogue commands (`sku-alias-save`, `sku-alias-retire`,
--     `sku-alias-reactivate`, from 20261020090000) move from orders.import to it; their
--     scope {skuAliases,events} is unchanged. Stock-out can now add or fix a SKU once in
--     Package SKUs without waiting for the admin.
--   * `import-release` gains `skuAliases` in its scope: when the admin confirms an upload,
--     every line whose SKU is not in the catalogue but was given a product and units by hand
--     is saved as a catalogue record (origin custom, with the release recorder in its
--     history and an audit event), so the next upload resolves it automatically. The
--     application skips a SKU mapped two ways in the same upload, a retired SKU, and a full
--     catalogue; a release never fails for the catalogue.
-- Kept in sync with apps/web/src/lib/capabilities.ts (tests/capabilities.test.mjs compares
-- them). Additive: no data changes; no function changes.
-- Rollback: supabase/rollback/20261026090000_operator_catalog_edit.down.sql.

insert into public.operator_role_capabilities (role, capability) values
  ('admin', 'catalog.edit'), ('outbound', 'catalog.edit');

delete from public.operator_command_rules
where command in ('sku-alias-save', 'sku-alias-retire', 'sku-alias-reactivate', 'import-release');
insert into public.operator_command_rules (command, capability, state_keys) values
  ('sku-alias-save', 'catalog.edit', '{skuAliases,events}'),
  ('sku-alias-retire', 'catalog.edit', '{skuAliases,events}'),
  ('sku-alias-reactivate', 'catalog.edit', '{skuAliases,events}'),
  ('import-release', 'orders.import', '{awbImports,orders,skuAliases,events}');
