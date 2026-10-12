#!/usr/bin/env bash
# Concurrency tests for operator_commit_records (20261014090000; design section 8.1): two
# psql sessions against the disposable cluster of scripts/verify-migrations-local.sh.
# Usage: operator_records_concurrency.sh <psql connection arguments...>
# Synthetic data only. Helpers live in schema test_support (pg_temp is per session) and are
# dropped at the end; site T stays in tables mode for the rollback rehearsal.
set -euo pipefail
psql=(psql "$@" -X -v ON_ERROR_STOP=1 -q -At)
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
ms() { echo $(( $(date +%s%N) / 1000000 )); }

"${psql[@]}" >/dev/null <<'SQL'
set client_min_messages = warning;
insert into auth.users (id) values ('00000000-0000-4000-8000-000000000006'), ('00000000-0000-4000-8000-000000000009')
on conflict do nothing;
insert into operator_private.server_keys (id, secret) values ('commit', decode(repeat('ab', 32), 'hex'))
on conflict do nothing;
-- Site T: five stock cartons and six reviewed single-product AWBs, moved to tables.
insert into public.operator_workspaces (id, site_id, name, state)
select '10000000-0000-4000-8000-0000000000d0', 'site-t', 'Synthetic site T', jsonb_build_object(
  'version', 1, 'batches', '[]'::jsonb, 'boxing', '[]'::jsonb, 'counts', '[]'::jsonb,
  'adjustments', '[]'::jsonb, 'events', '[]'::jsonb, 'notes', '[]'::jsonb, 'closedDays', '[]'::jsonb,
  'issues', '[]'::jsonb, 'sortCounts', '[]'::jsonb,
  'cartons', (select jsonb_agg(jsonb_build_object('id', c.id, 'ref', 'SYN-T', 'batchId', 'b-t', 'product', 'cav',
      'unit', 'bottle', 'qty', c.qty, 'rack', 'T', 'pic', 'R', 'at', '2026-10-02T01:00:00.000Z'))
    from (values ('C-SYN', 5), ('C-STRESS', 25), ('C-ADJ1', 5), ('C-ADJ2', 5), ('C-OP', 5)) c(id, qty)),
  'orders', (select jsonb_agg(jsonb_build_object('id', '41000000-0000-4000-8000-00000000000' || n, 'awb', 'NVMYT' || n,
      'channel', 'Luxana', 'product', 'cav', 'package', 'P', 'expected', 5, 'originalExpected', 5, 'actual', null,
      'packer', '', 'labelPic', '', 'printed', false, 'dispatched', false, 'handoverRef', '', 'date', '2026-10-20',
      'note', '', 'reviewState', 'confirmed'))
    from generate_series(1, 6) n));
insert into public.operator_memberships (workspace_id, user_id, role, display_name, scope) values
  ('10000000-0000-4000-8000-0000000000d0', '00000000-0000-4000-8000-000000000009', 'outbound', 'SO T', 'site'),
  ('10000000-0000-4000-8000-0000000000d0', '00000000-0000-4000-8000-000000000006', 'intake', 'SI T', 'site');
select operator_private.move_orders_to_tables('10000000-0000-4000-8000-0000000000d0');
-- A current supervisor count for the day (single `issue` does not need one; kept as setup).
insert into public.operator_sort_counts (id, workspace_id, fulfil_date, product, expected, counted, demand_awbs,
  demand_hash, pic, recorded_by, operation_id)
select gen_random_uuid(), '10000000-0000-4000-8000-0000000000d0', '2026-10-20', 'cav', d.expected, d.expected, d.awbs,
  d.hash, 'SO T', '00000000-0000-4000-8000-000000000009', gen_random_uuid()
from operator_private.day_demand('10000000-0000-4000-8000-0000000000d0', '2026-10-20', 'cav') d;

create schema test_support;
create table test_support.log (session text, n integer, outcome text, balance numeric);
-- One signed `issue` as the stock-out supervisor. Issue and audit entry IDs derive from the
-- operation ID, so the same operation always sends the identical change text.
create function test_support.issue(p_carton text, p_order integer, p_qty integer, p_op uuid default gen_random_uuid())
returns jsonb language plpgsql as $$
declare
  v_uid constant uuid := '00000000-0000-4000-8000-000000000009';
  v_ws constant uuid := '10000000-0000-4000-8000-0000000000d0';
  v_order uuid := ('41000000-0000-4000-8000-00000000000' || p_order)::uuid;
  v_text text := jsonb_build_object(
    'issues', jsonb_build_array(jsonb_build_object('id', md5('issue/' || p_op)::uuid, 'order_id', v_order,
      'carton_id', p_carton, 'qty', p_qty, 'pic', 'SO T')),
    'events', jsonb_build_array(jsonb_build_object('id', md5('event/' || p_op)::uuid, 'entity', v_order,
      'action', 'Stock issued to packing', 'detail', p_carton || ' · ' || p_qty, 'actor', 'SO T',
      'at', '2026-10-20T03:00:00.000Z', 'recorder', jsonb_build_object('userId', v_uid))))::text;
  v_fp text := encode(sha256(convert_to('issue' || v_text, 'UTF8')), 'hex');
  v_sig text := encode(extensions.hmac(convert_to(concat_ws(E'\n', 'operator-records-v1', v_ws::text, v_uid::text,
    p_op::text, 'issue', v_fp, encode(sha256(convert_to(v_text, 'UTF8')), 'hex'),
    encode(sha256(convert_to('', 'UTF8')), 'hex')), 'UTF8'),
    (select secret from operator_private.server_keys where id = 'commit'), 'sha256'), 'hex');
  v_out jsonb;
begin
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  set local role authenticated;
  begin
    v_out := jsonb_build_object('code', 'ok') || public.operator_commit_records(v_ws, 'issue', p_op, v_fp, v_text, v_sig);
  exception when others then
    v_out := jsonb_build_object('code', sqlstate, 'message', sqlerrm);
  end;
  reset role;
  return v_out;
end $$;
create function test_support.issue_logged(p_session text, p_n integer, p_carton text, p_order integer, p_qty integer)
returns text language plpgsql as $$
declare v_code text := test_support.issue(p_carton, p_order, p_qty) ->> 'code';
begin
  insert into test_support.log values (p_session, p_n, v_code,
    operator_private.carton_balance('10000000-0000-4000-8000-0000000000d0', p_carton));
  return v_code;
end $$;
-- One signed document `adjust` (operator-commit-v2) as the stock-in supervisor.
create function test_support.adjust(p_carton text, p_delta integer) returns text language plpgsql as $$
declare
  v_uid constant uuid := '00000000-0000-4000-8000-000000000006';
  v_ws constant uuid := '10000000-0000-4000-8000-0000000000d0';
  v_rev integer;
  v_text text;
  v_fp text;
  v_op uuid := gen_random_uuid();
  v_sig text;
  v_code text := 'ok';
begin
  select w.revision, jsonb_set(w.state, '{adjustments}', (w.state -> 'adjustments') || jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid(), 'cartonId', p_carton, 'delta', p_delta, 'reason', 'Broken', 'at', '2026-10-20T04:00:00.000Z')))::text
  into v_rev, v_text from public.operator_workspaces w where w.id = v_ws;
  v_fp := encode(sha256(convert_to('adjust' || v_text, 'UTF8')), 'hex');
  v_sig := encode(extensions.hmac(convert_to(concat_ws(E'\n', 'operator-commit-v2', v_ws::text, v_rev::text, v_uid::text,
    v_op::text, 'adjust', v_fp, encode(sha256(convert_to(v_text, 'UTF8')), 'hex'),
    encode(sha256(convert_to('', 'UTF8')), 'hex')), 'UTF8'),
    (select secret from operator_private.server_keys where id = 'commit'), 'sha256'), 'hex');
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  set local role authenticated;
  begin
    perform public.operator_commit_workspace(v_ws, v_rev, 'adjust', v_op, v_fp, v_text, v_sig);
  exception when others then
    v_code := sqlstate;
  end;
  reset role;
  return v_code;
end $$;
SQL
q() { "${psql[@]}" -c "$1"; }
issued() { q "select coalesce((select issued from public.operator_carton_issued where workspace_id = '10000000-0000-4000-8000-0000000000d0' and carton_id = '$1'), 0)"; }
balance() { q "select operator_private.carton_balance('10000000-0000-4000-8000-0000000000d0', '$1')"; }
rows() { q "select count(*) || ':' || coalesce(sum(qty), 0) from public.operator_issues where workspace_id = '10000000-0000-4000-8000-0000000000d0' and carton_id = '$1'"; }

echo "records concurrency: two issues against one carton"
"${psql[@]}" -c "begin" -c "select test_support.issue('C-SYN', 1, 5) ->> 'code'" -c "select pg_sleep(2)" -c "commit" >"$work/s1" &
first=$!
sleep 0.5
t0=$(ms); second="$(q "select test_support.issue('C-SYN', 2, 5) ->> 'code'")"; t1=$(ms)
wait "$first"
[ "$(head -1 "$work/s1")" = ok ] || fail "first issue: $(cat "$work/s1")"
[ "$second" = 23514 ] || fail "second issue returned $second"
[ $((t1 - t0)) -ge 1400 ] || fail "second issue did not wait for the carton lock ($((t1 - t0)) ms)"
[ "$(rows C-SYN)" = 1:5 ] && [ "$(issued C-SYN)" = 5 ] && [ "$(balance C-SYN)" = 0 ] || fail "C-SYN after the race"

echo "records concurrency: 2 x 20 single-unit issues against 25 units"
for s in s1 s2; do
  for n in $(seq 20); do echo "select test_support.issue_logged('$s', $n, 'C-STRESS', 3, 1);"; done >"$work/$s.sql"
  "${psql[@]}" -f "$work/$s.sql" >/dev/null &
done
wait
[ "$(q "select string_agg(outcome || '=' || n, ',' order by outcome) from (select outcome, count(*) n from test_support.log group by 1) x")" = "23514=15,ok=25" ] \
  || fail "stress outcomes $(q "select string_agg(outcome, ',') from test_support.log")"
[ "$(q "select min(balance) >= 0 from test_support.log")" = t ] || fail "a balance went below zero"
[ "$(q "select count(distinct session) from test_support.log where outcome = 'ok'")" = 2 ] || fail "one session never won"
[ "$(rows C-STRESS)" = 25:25 ] && [ "$(issued C-STRESS)" = 25 ] || fail "C-STRESS totals"

echo "records concurrency: adjustment, then an issue"
"${psql[@]}" -c "begin" -c "select test_support.adjust('C-ADJ1', -3)" -c "select pg_sleep(2)" -c "commit" >"$work/a1" &
first=$!
sleep 0.5
t0=$(ms); second="$(q "select test_support.issue('C-ADJ1', 4, 4) ->> 'code'")"; t1=$(ms)
wait "$first"
[ "$(head -1 "$work/a1")" = ok ] || fail "adjustment: $(cat "$work/a1")"
[ "$second" = 23514 ] && [ $((t1 - t0)) -ge 1400 ] || fail "issue after the adjustment: $second in $((t1 - t0)) ms"
[ "$(balance C-ADJ1)" = 2 ] && [ "$(rows C-ADJ1)" = 0:0 ] || fail "C-ADJ1 balance"

echo "records concurrency: issue, then an adjustment"
"${psql[@]}" -c "begin" -c "select test_support.issue('C-ADJ2', 5, 4) ->> 'code'" -c "select pg_sleep(2)" -c "commit" >"$work/a2" &
first=$!
sleep 0.5
t0=$(ms); second="$(q "select test_support.adjust('C-ADJ2', -3)")"; t1=$(ms)
wait "$first"
[ "$(head -1 "$work/a2")" = ok ] || fail "issue: $(cat "$work/a2")"
[ "$second" = 23514 ] && [ $((t1 - t0)) -ge 1400 ] || fail "adjustment after the issue: $second in $((t1 - t0)) ms"
[ "$(balance C-ADJ2)" = 1 ] || fail "C-ADJ2 balance"

echo "records concurrency: one operation sent twice at once"
op=20000000-0000-4000-8000-0000000000d1
"${psql[@]}" -c "begin" -c "select test_support.issue('C-OP', 6, 2, '$op')" -c "select pg_sleep(2)" -c "commit" >"$work/o1" &
first=$!
sleep 0.5
second="$(q "select test_support.issue('C-OP', 6, 2, '$op')")"
wait "$first"
one="$(head -1 "$work/o1")"
[ "$("${psql[@]}" -c "select ('$one'::jsonb ->> 'replayed') || ':' || ('$second'::jsonb ->> 'replayed') || ':' || (('$one'::jsonb -> 'result') = ('$second'::jsonb -> 'result'))::text")" = false:true:true ] \
  || fail "same operation: $one / $second"
[ "$(rows C-OP)" = 1:2 ] && [ "$(issued C-OP)" = 2 ] || fail "C-OP totals"
[ "$(q "select count(*) from public.operator_commits where operation_id = '$op'")" = 1 ] || fail "commit rows for the operation"

"${psql[@]}" -c "set client_min_messages = warning" -c "drop schema test_support cascade"
echo "records concurrency: ok"
