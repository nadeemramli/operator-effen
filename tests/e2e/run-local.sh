#!/usr/bin/env bash
# Local end-to-end run: disposable Postgres + migrations, Supabase shim, production build,
# Playwright scenarios. Synthetic data only; never touches a hosted Supabase project.
# Requirements: Postgres 16 binaries (PG_BIN), psql, Playwright + Chromium (PLAYWRIGHT_MODULE).
# initdb refuses to run as root; when root, the cluster is created as the postgres user.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
bin="${PG_BIN:-$(dirname "$(command -v initdb || ls /usr/lib/postgresql/*/bin/initdb | tail -1)")}"
pw="${PLAYWRIGHT_MODULE:-$(node -p 'require.resolve("playwright")' 2>/dev/null || echo /opt/node-tools/node_modules/playwright)}"
shim_port="${SHIM_PORT:-54399}" app_port="${APP_PORT:-3100}"
dir="$(mktemp -d)"
as_pg=(); [ "$(id -u)" = 0 ] && { chown postgres "$dir"; as_pg=(runuser -u postgres --); }
cleanup() {
  status=$?
  if [ "$status" != 0 ]; then
    for log in app shim; do echo "--- $log.log"; tail -25 "$dir/$log.log" 2>/dev/null || true; done
  fi
  [ -n "${app:-}" ] && kill "$app" 2>/dev/null || true
  [ -n "${shim:-}" ] && kill "$shim" 2>/dev/null || true
  "${as_pg[@]}" "$bin/pg_ctl" -D "$dir/data" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$dir"
}
trap cleanup EXIT
"${as_pg[@]}" "$bin/initdb" -D "$dir/data" -U postgres -A trust >/dev/null
"${as_pg[@]}" "$bin/pg_ctl" -D "$dir/data" -o "-k $dir -c listen_addresses=''" -l "$dir/log" start >/dev/null
for f in "$root/supabase/tests/local-auth-stub.sql" "$root"/supabase/migrations/*.sql; do
  psql -h "$dir" -U postgres -q -v ON_ERROR_STOP=1 -f "$f"
done
node "$root/tests/e2e/supabase-shim.mjs" "$shim_port" "$dir" >"$dir/shim.log" 2>&1 & shim=$!
export NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:$shim_port"
export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="synthetic-local-key"
(cd "$root" && pnpm build >"$dir/build.log" 2>&1) || { tail -30 "$dir/build.log"; exit 1; }
(cd "$root/apps/web" && exec pnpm exec next start -p "$app_port" >"$dir/app.log" 2>&1) & app=$!
for _ in $(seq 60); do curl -sf "http://127.0.0.1:$app_port/login" >/dev/null && break; sleep 1; done
node "$root/tests/e2e/scenario.mjs" "http://localhost:$app_port" "http://127.0.0.1:$shim_port" "$dir" "$pw"
