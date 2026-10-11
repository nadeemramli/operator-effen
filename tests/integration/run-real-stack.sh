#!/usr/bin/env bash
# Runs the integration scenarios against REAL Supabase components on a disposable local
# Postgres: GoTrue (Auth), PostgREST (Data API), Storage API (file backend) and the
# repository migrations, behind router.mjs (prefix routing + CORS, as Kong does), with the
# production Next.js build and Chromium. Synthetic users and data only; no hosted project.
#
# Required (paths may be overridden):
#   PG_BIN       Postgres 16+ binaries (initdb, pg_ctl)
#   SUPA_BIN     dir with GoTrue `auth` binary + its `migrations/`, and `postgrest`
#   STORAGE_DIR  built supabase/storage checkout (npm ci && npm run build)
#   PLAYWRIGHT_MODULE  playwright package path; Chromium at /opt/pw-browsers/chromium
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
bin="${PG_BIN:-/usr/lib/postgresql/16/bin}"
supa="${SUPA_BIN:-/opt/supa}"
storage="${STORAGE_DIR:-/opt/supa/storage}"
pw="${PLAYWRIGHT_MODULE:-/opt/node-tools/node_modules/playwright}"
# The cloud container keeps a system Chromium; elsewhere Playwright uses its own browser.
[ -z "${PW_CHROMIUM:-}" ] && [ -x /opt/pw-browsers/chromium ] && export PW_CHROMIUM=/opt/pw-browsers/chromium
pg_port=54432 auth_port=54433 storage_port=54434 rest_port=54436 api_port=54400 app_port=3100
dir="$(mktemp -d)"; mkdir -p "$dir/files"
as_pg=(); [ "$(id -u)" = 0 ] && { chown -R postgres "$dir"; as_pg=(runuser -u postgres --); }
pids=()
cleanup() {
  status=$?
  [ "$status" != 0 ] && for log in gotrue storage postgrest router app; do
    echo "--- $log.log"; tail -15 "$dir/$log.log" 2>/dev/null | cut -c1-300 || true; done
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  "${as_pg[@]}" "$bin/pg_ctl" -D "$dir/data" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$dir"
}
trap cleanup EXIT
wait_for() { for _ in $(seq 60); do curl -sf "$1" >/dev/null && return 0; sleep 1; done; echo "timeout: $1"; return 1; }
psql_=(psql -h 127.0.0.1 -p "$pg_port" -U postgres -q -v ON_ERROR_STOP=1)

"${as_pg[@]}" "$bin/initdb" -D "$dir/data" -U postgres -A trust >/dev/null
"${as_pg[@]}" "$bin/pg_ctl" -D "$dir/data" -o "-k $dir -c listen_addresses=127.0.0.1 -p $pg_port" -l "$dir/pg.log" start >/dev/null
"${psql_[@]}" -f "$root/tests/integration/bootstrap.sql"

# Throwaway local secrets for this run only.
eval "$(node -e '
const c=require("crypto"),s=c.randomBytes(32).toString("hex");
const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
const sign=p=>{const h=b({alg:"HS256",typ:"JWT"}),q=b(p);return h+"."+q+"."+c.createHmac("sha256",s).update(h+"."+q).digest("base64url")};
const exp=Math.floor(Date.now()/1000)+86400;
console.log(`JWT_SECRET=${s} ANON_KEY=${sign({role:"anon",iss:"supabase",exp})} SERVICE_KEY=${sign({role:"service_role",iss:"supabase",exp})} COMMIT_SECRET=${c.randomBytes(32).toString("hex")}`)')"

gotrue_env=(GOTRUE_DB_DRIVER=postgres "DATABASE_URL=postgres://supabase_auth_admin@127.0.0.1:$pg_port/postgres?sslmode=disable"
  GOTRUE_DB_NAMESPACE=auth "GOTRUE_DB_MIGRATIONS_PATH=$supa/migrations" "GOTRUE_JWT_SECRET=$JWT_SECRET"
  GOTRUE_SITE_URL=http://localhost:$app_port API_EXTERNAL_URL=http://127.0.0.1:$api_port/auth/v1)
(cd "$supa" && env -i PATH="$PATH" "${gotrue_env[@]}" ./auth migrate >"$dir/gotrue-migrate.log" 2>&1)
(cd "$supa" && exec env -i PATH="$PATH" "${gotrue_env[@]}" GOTRUE_API_HOST=127.0.0.1 PORT=$auth_port \
  GOTRUE_JWT_EXP=3600 GOTRUE_JWT_AUD=authenticated GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated GOTRUE_JWT_ADMIN_ROLES=service_role \
  GOTRUE_EXTERNAL_EMAIL_ENABLED=true GOTRUE_MAILER_AUTOCONFIRM=true GOTRUE_DISABLE_SIGNUP=true \
  GOTRUE_LOG_LEVEL=warn ./auth serve >"$dir/gotrue.log" 2>&1) & pids+=($!)
(cd "$storage" && exec env -i PATH="$PATH" HOME="$HOME" NODE_ENV=production SERVER_HOST=127.0.0.1 \
  SERVER_PORT=$storage_port SERVER_ADMIN_PORT=$((storage_port + 1)) SERVER_REGION=local \
  AUTH_JWT_SECRET="$JWT_SECRET" AUTH_JWT_ALGORITHM=HS256 ANON_KEY="$ANON_KEY" SERVICE_KEY="$SERVICE_KEY" \
  TENANT_ID=stub IS_MULTITENANT=false "DATABASE_URL=postgres://supabase_storage_admin@127.0.0.1:$pg_port/postgres" \
  DB_INSTALL_ROLES=false DB_ANON_ROLE=anon DB_SERVICE_ROLE=service_role DB_AUTHENTICATED_ROLE=authenticated \
  DB_SUPER_USER=postgres STORAGE_BACKEND=file STORAGE_FILE_BACKEND_PATH="$dir/files" GLOBAL_S3_BUCKET=stub \
  STORAGE_FILE_ETAG_ALGORITHM=md5 UPLOAD_FILE_SIZE_LIMIT=52428800 UPLOAD_SIGNED_URL_EXPIRATION_TIME=60 \
  IMAGE_TRANSFORMATION_ENABLED=false PG_QUEUE_ENABLE=false RATE_LIMITER_ENABLED=false LOG_LEVEL=warn \
  OTEL_METRICS_ENABLED=false PROMETHEUS_METRICS_ENABLED=false LOGFLARE_ENABLED=false \
  node dist/start/server.js >"$dir/storage.log" 2>&1) & pids+=($!)
wait_for "http://127.0.0.1:$auth_port/health"
wait_for "http://127.0.0.1:$storage_port/status"
"${psql_[@]}" -f "$root/tests/integration/storage-grants.sql"
for f in "$root"/supabase/migrations/*.sql; do "${psql_[@]}" -f "$f" 2>&1 | grep -v NOTICE || true; done
"${psql_[@]}" -c "insert into operator_private.server_keys (id, secret) values ('commit', decode('$COMMIT_SECRET', 'hex'))"
(cd "$supa" && exec env -i PATH="$PATH" "PGRST_DB_URI=postgres://authenticator@127.0.0.1:$pg_port/postgres" \
  PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon "PGRST_JWT_SECRET=$JWT_SECRET" PGRST_SERVER_HOST=127.0.0.1 \
  PGRST_SERVER_PORT=$rest_port PGRST_DB_EXTRA_SEARCH_PATH=public,extensions PGRST_LOG_LEVEL=warn \
  ./postgrest >"$dir/postgrest.log" 2>&1) & pids+=($!)
node "$root/tests/integration/router.mjs" $api_port "http://127.0.0.1:$auth_port" \
  "http://127.0.0.1:$rest_port" "http://127.0.0.1:$storage_port" >"$dir/router.log" 2>&1 & pids+=($!)
wait_for "http://127.0.0.1:$api_port/auth/v1/health"

export NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:$api_port" NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$ANON_KEY"
(cd "$root" && pnpm build >"$dir/build.log" 2>&1) || { tail -30 "$dir/build.log"; exit 1; }
(cd "$root/apps/web" && exec env OPERATOR_COMMIT_SECRET="$COMMIT_SECRET" pnpm exec next start -p $app_port >"$dir/app.log" 2>&1) & pids+=($!)
wait_for "http://127.0.0.1:$app_port/login"
(cd "$root" && node "${SCENARIO:-tests/integration/scenario.mjs}" "http://localhost:$app_port" \
  "http://127.0.0.1:$api_port" "$ANON_KEY" "$SERVICE_KEY" "$pg_port" "$pw")
