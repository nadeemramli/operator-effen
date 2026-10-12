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
"${psql[@]}" -f "$root/supabase/rollback/20261012090000_operator_imports.down.sql"
"${psql[@]}" -At -c "select to_regclass('public.operator_imports') is null and to_regclass('public.operator_import_rows') is null
  and to_regprocedure('public.operator_commit_workspace(uuid, integer, text, uuid, text, text, text)') is not null
  and to_regprocedure('public.operator_commit_workspace(uuid, integer, text, uuid, text, text, text, text)') is null" | grep -qx t
"${psql[@]}" -At -c "select string_agg(command || ':' || array_to_string(state_keys, '+'), ',' order by command) from public.operator_command_rules where command like 'import-%' or command = 'remove-order'" \
  | grep -qx 'import-delete:awbImports+orders+events,import-receive:awbImports+orders+events,import-release:awbImports+orders+events,import-save:awbImports+events,remove-order:orders+awbImports+events'
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
echo "uploads move from the document to tables"
"${psql[@]}" -c "update public.operator_workspaces set state = state || '{
  \"awbImports\": [
    {\"id\": \"30000000-0000-4000-8000-0000000000f1\", \"name\": \"Synthetic released\", \"date\": \"2026-10-10\",
     \"files\": [], \"createdAt\": \"2026-10-10T01:00:00.000Z\", \"updatedAt\": \"2026-10-10T02:00:00.000Z\",
     \"confirmedAt\": \"2026-10-10T02:00:00.000Z\", \"rows\": [
      {\"id\": \"31000000-0000-4000-8000-0000000000f1\", \"awb\": \"NVMYBF1\", \"orderRef\": \"R1\", \"channel\": \"Luxana\",
       \"store\": \"S\", \"courier\": \"Ninja Van\", \"lines\": [], \"sources\": [], \"warnings\": [], \"reviewed\": false,
       \"reviewNote\": \"\", \"excluded\": false, \"releasedOrderId\": \"o-bf1\", \"original\": \"raw\"},
      {\"id\": \"31000000-0000-4000-8000-0000000000f2\", \"awb\": \"NVMYBF2\", \"orderRef\": \"R2\", \"channel\": \"Luxana\",
       \"store\": \"S\", \"courier\": \"Ninja Van\", \"lines\": [], \"sources\": [], \"warnings\": [], \"reviewed\": true,
       \"reviewNote\": \"Not ours\", \"excluded\": true, \"original\": \"raw 2\"}]},
    {\"id\": \"legacy-1\", \"name\": \"Synthetic legacy\", \"date\": \"2026-10-09\", \"files\": [], \"createdAt\": \"\",
     \"updatedAt\": \"\", \"rows\": [{\"id\": \"r1\", \"awb\": \"NVMYBF3\", \"lines\": [], \"sources\": [], \"warnings\": [],
       \"reviewed\": false, \"reviewNote\": \"\", \"excluded\": false, \"releasedOrderId\": \"o-bf3\"}]}],
  \"orders\": [{\"id\": \"o-bf1\", \"awb\": \"NVMYBF1\", \"importId\": \"30000000-0000-4000-8000-0000000000f1\",
     \"importRowId\": \"31000000-0000-4000-8000-0000000000f1\"},
    {\"id\": \"o-bf3\", \"awb\": \"NVMYBF3\", \"importId\": \"legacy-1\", \"importRowId\": \"r1\"},
    {\"id\": \"o-man\", \"awb\": \"MANUAL-1\"}]}'::jsonb where site_id = 'site-x';
  insert into public.ui_draft_workspaces (user_id, state, revision)
  values ('00000000-0000-4000-8000-000000000002', '{\"version\": 1, \"orders\": [], \"awbImports\": [{\"id\": \"x\"}]}', 4)
  on conflict (user_id) do update set state = excluded.state, revision = excluded.revision"
before="$("${psql[@]}" -At -c "select revision from public.operator_workspaces where site_id = 'site-x'")"
"${psql[@]}" -f "$root/supabase/migrations/20261012090000_operator_imports.sql"
"${psql[@]}" -At -c "select to_regclass('public.operator_imports') is not null and to_regclass('public.operator_import_rows') is not null" | grep -qx t
"${psql[@]}" -At -c "select string_agg(command || ':' || array_to_string(state_keys, '+'), ',' order by command) from public.operator_command_rules where command like 'import-%' or command = 'remove-order'" \
  | grep -qx 'import-delete:orders+events,import-release:orders+events,remove-order:orders+events'
"${psql[@]}" -At -c "select (state ? 'awbImports')::text || ':' || (revision - $before) from public.operator_workspaces where site_id = 'site-x'" | grep -qx 'false:1'
"${psql[@]}" -At -c "select count(*) || ':' || count(confirmed_at) from public.operator_imports" | grep -qx '2:1'
"${psql[@]}" -At -c "select string_agg(awb || '=' || coalesce(released_order_id, '-') || '/' || excluded || '/' || original, ',' order by awb) from public.operator_import_rows" \
  | grep -qx 'NVMYBF1=o-bf1/false/raw,NVMYBF2=-/true/raw 2,NVMYBF3=o-bf3/false/'
# The legacy identifiers got derived UUIDs, and the order that points at them followed.
"${psql[@]}" -At -c "select count(*) from public.operator_workspaces w, jsonb_array_elements(w.state -> 'orders') o
  join public.operator_import_rows r on r.id = (o ->> 'importRowId')::uuid and r.import_id = (o ->> 'importId')::uuid
  where w.site_id = 'site-x' and r.released_order_id = o ->> 'id'" | grep -qx 2
"${psql[@]}" -At -c "select (state ? 'awbImports')::text || ':' || revision from public.ui_draft_workspaces where user_id = '00000000-0000-4000-8000-000000000002'" | grep -qx 'false:5'
echo "ok"
