#!/usr/bin/env bash
# Runs tests/integration/scenario.mjs against the official LOCAL Supabase CLI stack
# (`pnpm exec supabase start`, Docker). Resets only that local database. Never point this
# at a linked or hosted project: the script refuses when supabase/.temp/project-ref exists.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
pw="${PLAYWRIGHT_MODULE:-/opt/node-tools/node_modules/playwright}"
app_port=3100
[ -e "$root/supabase/.temp/project-ref" ] && { echo "Refusing: this checkout is linked to a hosted project."; exit 1; }
cd "$root"
pnpm exec supabase db reset --local --no-seed >/tmp/operator-db-reset.log 2>&1 || { tail -20 /tmp/operator-db-reset.log; exit 1; }
eval "$(pnpm exec supabase status -o env 2>/dev/null | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY|DB_URL)=')"
db_port="$(node -p "new URL(process.argv[1]).port" "$DB_URL")"
export PGPASSWORD="$(node -p "decodeURIComponent(new URL(process.argv[1]).password)" "$DB_URL")"
commit_secret="$(node -p 'require("crypto").randomBytes(32).toString("hex")')"
psql -h 127.0.0.1 -p "$db_port" -U postgres -q -v ON_ERROR_STOP=1 \
  -c "insert into operator_private.server_keys (id, secret) values ('commit', decode('$commit_secret', 'hex'))"
export NEXT_PUBLIC_SUPABASE_URL="$API_URL" NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$ANON_KEY"
pnpm build >/tmp/operator-cli-build.log 2>&1 || { tail -30 /tmp/operator-cli-build.log; exit 1; }
(cd apps/web && exec env OPERATOR_COMMIT_SECRET="$commit_secret" pnpm exec next start -p $app_port >/tmp/operator-cli-app.log 2>&1) &
app=$!
trap 'kill $app 2>/dev/null || true' EXIT
for _ in $(seq 60); do curl -sf "http://127.0.0.1:$app_port/login" >/dev/null && break; sleep 1; done
node tests/integration/scenario.mjs "http://localhost:$app_port" "$API_URL" "$ANON_KEY" "$SERVICE_ROLE_KEY" "$db_port" "$pw"
