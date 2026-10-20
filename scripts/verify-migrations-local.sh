#!/usr/bin/env bash
# Applies every migration plus the access tests to a disposable local Postgres cluster.
# Uses synthetic data only and never connects to a Supabase project.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
bin="${PG_BIN:-$(dirname "$(command -v initdb || ls /usr/lib/postgresql/*/bin/initdb | tail -1)")}"
dir="$(mktemp -d)"
trap '"$bin/pg_ctl" -D "$dir/data" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$dir"' EXIT
"$bin/initdb" -D "$dir/data" -U postgres -A trust >/dev/null
"$bin/pg_ctl" -D "$dir/data" -o "-k $dir -c listen_addresses=''" -l "$dir/log" start >/dev/null
psql=(psql -h "$dir" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)
"${psql[@]}" -f "$root/supabase/tests/local-auth-stub.sql"
for file in "$root"/supabase/migrations/*.sql; do
  echo "migration: $(basename "$file")"
  "${psql[@]}" -f "$file"
done
"${psql[@]}" -At -f "$root/supabase/tests/operator_access.test.sql"
echo "rollback rehearsal"
"${psql[@]}" -f "$root/supabase/rollback/20261025090000_operator_box_recount.down.sql"
"${psql[@]}" -At -c "select count(*) from public.operator_command_rules where command = 'recount-ady'" | grep -qx 0
"${psql[@]}" -f "$root/supabase/rollback/20261024090000_operator_warehouse_count.down.sql"
"${psql[@]}" -At -c "select prosrc not like '%warehouse stages only%' from pg_proc where proname = 'assert_core_transition'" | grep -qx t
"${psql[@]}" -f "$root/supabase/rollback/20261023090000_operator_stock_in_sends.down.sql"
"${psql[@]}" -At -c "select state_keys::text from public.operator_command_rules where command = 'stock-in-ady'" | grep -qx '{cartons,adypocideReceipts,events}'
"${psql[@]}" -At -c "select state_keys::text from public.operator_command_rules where command = 'receive-ady'" | grep -qx '{adypocideReceipts,events}'
"${psql[@]}" -f "$root/supabase/rollback/20261022090000_operator_optional_stages.down.sql"
"${psql[@]}" -At -c "select count(*) from public.operator_command_rules where command in ('stage-skip', 'wrapping-count')" | grep -qx 0
"${psql[@]}" -At -c "select to_regprocedure('operator_private.optional_stage(text)') is null" | grep -qx t
"${psql[@]}" -f "$root/supabase/rollback/20261021090000_operator_nurokids.down.sql"
"${psql[@]}" -At -c "select operator_private.product_factory('nur') is null and operator_private.product_factory('cav') = 'bottle'" | grep -qx t
"${psql[@]}" -f "$root/supabase/rollback/20261020090000_operator_sku_aliases.down.sql"
"${psql[@]}" -At -c "select count(*) from public.operator_command_rules where command like 'sku-alias-%'" | grep -qx 0
"${psql[@]}" -f "$root/supabase/rollback/20261019090000_operator_batch_cancel.down.sql"
"${psql[@]}" -At -c "select count(*) from public.operator_command_rules where command in ('batch-cancel', 'batch-correct')" | grep -qx 0
"${psql[@]}" -f "$root/supabase/rollback/20261018090000_operator_issues.down.sql"
"${psql[@]}" -At -c "select (state -> 'issues') @> '[{\"id\": \"i-x4\"}]' and to_regclass('public.operator_issues') is null from public.operator_workspaces where site_id = 'site-a'" | grep -qx t
"${psql[@]}" -f "$root/supabase/rollback/20261017090000_operator_orders.down.sql"
"${psql[@]}" -At -c "select (state -> 'orders') @> '[{\"id\": \"o2\"}]' and to_regclass('public.operator_orders') is null from public.operator_workspaces where site_id = 'site-a'" | grep -qx t
"${psql[@]}" -f "$root/supabase/rollback/20261016090000_operator_order_archive.down.sql"
"${psql[@]}" -At -c "select (state -> 'orders') @> '[{\"id\": \"arch-old\"}]' from public.operator_workspaces where site_id = 'site-a'" | grep -qx t
"${psql[@]}" -f "$root/supabase/rollback/20261015090000_operator_imports_and_events.down.sql"
"${psql[@]}" -At -c "select to_regclass('public.operator_events') is null and to_regclass('public.operator_imports') is null" | grep -qx t
"${psql[@]}" -At -c "select jsonb_array_length(state -> 'events') > 0 from public.operator_workspaces where site_id = 'site-a'" | grep -qx t
"${psql[@]}" -f "$root/supabase/rollback/20261014090000_operator_workspace_capacity.down.sql"
"${psql[@]}" -At -c "select pg_get_constraintdef(oid) like '%<= 2000000%' from pg_constraint where conname = 'operator_workspaces_state_check'" | grep -qx t
"${psql[@]}" -f "$root/supabase/rollback/20261011090000_operator_remove_awbs.down.sql"
"${psql[@]}" -At -c "select count(*) from public.operator_command_rules where command in ('remove-order', 'import-delete')" | grep -qx 0
"${psql[@]}" -f "$root/supabase/rollback/20261009090003_operator_trip_dropoffs.down.sql"
"${psql[@]}" -At -c "select count(*) from public.operator_command_rules where command = 'trip-dropoff'" | grep -qx 0
"${psql[@]}" -f "$root/supabase/rollback/20261009090002_operator_stock_returns.down.sql"
"${psql[@]}" -At -c "select count(*) from public.operator_command_rules where command = 'return'" | grep -qx 0
"${psql[@]}" -f "$root/supabase/rollback/20261009090001_operator_warehouse_stages.down.sql"
"${psql[@]}" -At -c "select to_regprocedure('operator_private.factory_stage(text)') is null" | grep -qx t
"${psql[@]}" -f "$root/supabase/rollback/20261008090000_operator_packer_self_entry.down.sql"
"${psql[@]}" -f "$root/supabase/rollback/20261007090000_operator_factory_scope.down.sql"
"${psql[@]}" -f "$root/supabase/rollback/20261006090000_operator_driver_trips.down.sql"
"${psql[@]}" -f "$root/supabase/rollback/20261005090000_operator_trusted_commands.down.sql"
"${psql[@]}" -f "$root/supabase/rollback/20261004090000_operator_memberships.down.sql"
"${psql[@]}" -At -c "select count(*) from pg_tables where tablename like 'operator_%'" | grep -qx 0
"${psql[@]}" -At -c "select to_regclass('public.ui_draft_workspaces') is not null" | grep -qx t
echo "re-apply after rollback"
"${psql[@]}" -f "$root/supabase/migrations/20261004090000_operator_memberships.sql"
"${psql[@]}" -c "delete from storage.buckets where id = 'operator-sources'"
"${psql[@]}" -f "$root/supabase/migrations/20261005090000_operator_trusted_commands.sql"
"${psql[@]}" -c "delete from storage.buckets where id in ('operator-trip-photos', 'trip-draft-photos')"
echo "assistant memberships become driver memberships"
"${psql[@]}" -c "insert into public.operator_workspaces (id, site_id, name, write_policy)
  values ('10000000-0000-4000-8000-0000000000aa', 'site-x', 'Synthetic site X',
    '{\"assistant\": [\"feedback.post\"]}');
  insert into public.operator_memberships (workspace_id, user_id, role, display_name)
  values ('10000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-000000000002',
    'assistant', 'Synthetic assistant')"
"${psql[@]}" -f "$root/supabase/migrations/20261006090000_operator_driver_trips.sql"
"${psql[@]}" -At -c "select role from public.operator_memberships
  where user_id = '00000000-0000-4000-8000-000000000002'" | grep -qx driver
"${psql[@]}" -At -c "select write_policy ? 'assistant' from public.operator_workspaces
  where site_id = 'site-x'" | grep -qx f
"${psql[@]}" -f "$root/supabase/migrations/20261007090000_operator_factory_scope.sql"
"${psql[@]}" -At -c "select count(*) from public.operator_memberships where factory is not null" | grep -qx 0
"${psql[@]}" -f "$root/supabase/migrations/20261008090000_operator_packer_self_entry.sql"
"${psql[@]}" -At -c "select count(*) from operator_private.staff_pins" | grep -qx 0
"${psql[@]}" -f "$root/supabase/migrations/20261009090001_operator_warehouse_stages.sql"
"${psql[@]}" -At -c "select operator_private.factory_stage('filling') and not operator_private.factory_stage('hologram')" | grep -qx t
"${psql[@]}" -f "$root/supabase/migrations/20261009090002_operator_stock_returns.sql"
"${psql[@]}" -At -c "select capability from public.operator_command_rules where command = 'return'" | grep -qx stock.receive
"${psql[@]}" -f "$root/supabase/migrations/20261009090003_operator_trip_dropoffs.sql"
"${psql[@]}" -At -c "select capability from public.operator_command_rules where command = 'trip-dropoff'" | grep -qx trips.log
"${psql[@]}" -f "$root/supabase/migrations/20261011090000_operator_remove_awbs.sql"
"${psql[@]}" -At -c "select string_agg(command || ':' || capability, ',' order by command) from public.operator_command_rules where command in ('import-delete', 'remove-order')" | grep -qx 'import-delete:orders.import,remove-order:orders.enter'
echo "released uploads drop their raw extraction text"
"${psql[@]}" -c "update public.operator_workspaces set state = state || '{\"awbImports\": [
  {\"id\": \"imp-r\", \"confirmedAt\": \"2026-10-13T00:00:00Z\", \"rows\": [{\"id\": \"r1\", \"original\": \"raw text\"}]},
  {\"id\": \"imp-o\", \"rows\": [{\"id\": \"r2\", \"original\": \"raw text\"}]}]}'::jsonb where site_id = 'site-x'"
"${psql[@]}" -f "$root/supabase/migrations/20261014090000_operator_workspace_capacity.sql"
"${psql[@]}" -At -c "select string_agg(i ->> 'id' || ':' || (r ->> 'original'), ',' order by i ->> 'id')
  from public.operator_workspaces w, jsonb_array_elements(w.state -> 'awbImports') i, jsonb_array_elements(i -> 'rows') r
  where w.site_id = 'site-x'" | grep -qx 'imp-o:raw text,imp-r:'
"${psql[@]}" -At -c "select pg_get_constraintdef(oid) like '%<= 4000000%' from pg_constraint where conname = 'ui_draft_workspaces_state_check'" | grep -qx t
echo "uploads and audit entries move to their tables"
"${psql[@]}" -c "update public.operator_workspaces set state = state || '{\"events\": [
  {\"id\": \"e-new\", \"entity\": \"b1\", \"action\": \"later\", \"at\": \"2026-10-14T02:00:00Z\"},
  {\"id\": \"e-old\", \"entity\": \"b1\", \"action\": \"earlier\", \"at\": \"2026-10-14T01:00:00Z\"}]}'::jsonb
  where site_id = 'site-x'"
"${psql[@]}" -f "$root/supabase/migrations/20261015090000_operator_imports_and_events.sql"
"${psql[@]}" -At -c "select string_agg(e.id, ',' order by e.seq) from public.operator_events e
  join public.operator_workspaces w on w.id = e.workspace_id where w.site_id = 'site-x'" | grep -qx 'e-old,e-new'
"${psql[@]}" -At -c "select string_agg(i.id, ',' order by i.id) from public.operator_imports i
  join public.operator_workspaces w on w.id = i.workspace_id where w.site_id = 'site-x'" | grep -qx 'imp-o,imp-r'
"${psql[@]}" -At -c "select bool_and(not state ? 'awbImports' and state -> 'events' = '[]') from public.operator_workspaces" | grep -qx t
echo "order archive re-applies"
"${psql[@]}" -f "$root/supabase/migrations/20261016090000_operator_order_archive.sql"
"${psql[@]}" -At -c "select has_function_privilege('authenticated', 'public.operator_archive_orders(uuid)', 'execute')" | grep -qx t
echo "orders move to their table"
"${psql[@]}" -c "update public.operator_workspaces set state = jsonb_set(state, '{orders}', '[{\"id\": \"ox1\", \"awb\": \"nvmy x1\", \"date\": \"2026-10-15\"}]') where site_id = 'site-x'"
"${psql[@]}" -f "$root/supabase/migrations/20261017090000_operator_orders.sql"
"${psql[@]}" -At -c "select string_agg(o.id || ':' || o.awb || ':' || o.version, ',') from public.operator_orders o join public.operator_workspaces w on w.id = o.workspace_id where w.site_id = 'site-x'" | grep -qx 'ox1:NVMYX1:1'
"${psql[@]}" -At -c "select bool_and(not state ? 'orders') from public.operator_workspaces" | grep -qx t
echo "stock issues move to their table"
"${psql[@]}" -c "update public.operator_workspaces set state = jsonb_set(state, '{issues}', '[{\"id\": \"ix1\", \"cartonId\": \"cx\", \"orderId\": \"ox1\", \"qty\": 2, \"at\": \"2026-10-15T20:00:00Z\"}]') where site_id = 'site-x'"
"${psql[@]}" -f "$root/supabase/migrations/20261018090000_operator_issues.sql"
"${psql[@]}" -At -c "select string_agg(i.id || ':' || i.qty || ':' || i.issue_day, ',') from public.operator_issues i join public.operator_workspaces w on w.id = i.workspace_id where w.site_id = 'site-x'" | grep -qx 'ix1:2:2026-10-16'
"${psql[@]}" -At -c "select bool_and(state -> 'issues' = '[]') from public.operator_workspaces" | grep -qx t
echo "batch cancel and date correction commands re-apply"
"${psql[@]}" -f "$root/supabase/migrations/20261019090000_operator_batch_cancel.sql"
"${psql[@]}" -At -c "select string_agg(command || ':' || capability, ',' order by command) from public.operator_command_rules where command in ('batch-cancel', 'batch-correct')" | grep -qx 'batch-cancel:production.plan,batch-correct:production.plan'
echo "package SKU mapping rules re-apply"
"${psql[@]}" -f "$root/supabase/migrations/20261020090000_operator_sku_aliases.sql"
"${psql[@]}" -At -c "select string_agg(command || ':' || capability || ':' || array_to_string(state_keys, '+'), ',' order by command) from public.operator_command_rules where command like 'sku-alias-%'" | grep -qx 'sku-alias-reactivate:orders.import:skuAliases+events,sku-alias-retire:orders.import:skuAliases+events,sku-alias-save:orders.import:skuAliases+events'
echo "nurokids joins the bottle factory"
"${psql[@]}" -f "$root/supabase/migrations/20261021090000_operator_nurokids.sql"
"${psql[@]}" -At -c "select operator_private.product_factory('nur') = 'bottle' and operator_private.product_factory('ady') = 'sachet'" | grep -qx t
echo "ok"
