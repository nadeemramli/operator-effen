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
echo "ok"
