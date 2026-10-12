-- Removing mistaken AWBs and whole PDF uploads (follows 20261009090003_operator_trip_dropoffs.sql).
--
-- Two commands, kept in sync with apps/web/src/lib/capabilities.ts
-- (tests/capabilities.test.mjs compares them):
--   * `remove-order` (capability orders.enter, scope {orders,awbImports,events}): office
--     admin or the stock-out supervisor removes one AWB that has no stock, packing or
--     handover records, with a reason. Its PDF label is marked excluded in the upload.
--   * `import-delete` (capability orders.import, scope {awbImports,orders,events}): office
--     admin removes a whole PDF upload and every AWB it released, with a reason, as long
--     as none of them has stock, packing or handover records.
-- Both are refused by the application rules when stock has moved; the database keeps
-- issues, events and received cartons append-only (operator_private.assert_transition),
-- so a removal can never take recorded stock movements with it. The audit entry lists what
-- was removed. Source PDFs stay in the operator-sources bucket.
-- Additive: no data changes.
-- Rollback: supabase/rollback/20261011090000_operator_remove_awbs.down.sql.

insert into public.operator_command_rules (command, capability, state_keys) values
  ('remove-order', 'orders.enter', '{orders,awbImports,events}'),
  ('import-delete', 'orders.import', '{awbImports,orders,events}');
