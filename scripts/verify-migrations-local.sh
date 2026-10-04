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
"${psql[@]}" -f "$root/supabase/rollback/20261004090000_operator_memberships.down.sql"
"${psql[@]}" -At -c "select count(*) from pg_tables where tablename like 'operator_%'" | grep -qx 0
"${psql[@]}" -At -c "select to_regclass('public.ui_draft_workspaces') is not null" | grep -qx t
echo "re-apply after rollback"
"${psql[@]}" -f "$root/supabase/migrations/20261004090000_operator_memberships.sql"
echo "ok"
