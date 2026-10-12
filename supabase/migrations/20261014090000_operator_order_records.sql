-- Orders, stock issues and supervisor sort counts as table rows (order volume plan, work
-- package C, PR C1; follows 20261013090000_operator_events.sql). Design:
-- docs/order-volume-wp-c-design.md, sections 2, 3, 5 and 7.
--
-- Problem: every AWB, stock issue and sort count lived in `operator_workspaces.state`, the
-- 2 MB document that every save and refresh sends whole and that one revision serializes.
-- A 2,000-AWB day does not fit, and unrelated changes conflict through that revision.
--
-- After this migration (additive: every site stays in document mode, nothing is moved and
-- the deployed application behaves exactly as before):
--   * operator_workspaces.order_store ('document' | 'tables', default 'document') says
--     where a site keeps its orders. Only the owner moves a site, with
--     operator_private.move_orders_to_tables(site) (backfill of the document's orders,
--     issues and sort counts, validated, balance-preserving, idempotent) and back with
--     operator_private.move_orders_to_document(site). Neither is granted to clients.
--   * Tables: operator_orders (one AWB, `lines` as jsonb, row `version`), operator_issues
--     (insert-only), operator_carton_issued (running total per carton), operator_sort_counts
--     (insert-only, with the demand hash computed by the database), operator_order_departures
--     (an AWB left a day: removed or moved) and operator_record_rules (command -> capability
--     and row scope, mirrored by recordRules in apps/web/src/lib/capabilities.ts).
--   * AWB numbers (owner decision 2026-10-12): couriers reuse tracking numbers, so the key is
--     the surrogate uuid; an AWB is unique per (site, AWB, fulfilment day), and the same AWB
--     may appear again at a site only when the earlier one was handed over more than 30 days
--     before the later one's day (operator_private.assert_awb_reuse; 23505 otherwise).
--     operator_orders.dispatched_at is stamped on handover for that rule.
--   * RLS: no client inserts, updates or deletes any of them. Orders, issues, sort counts and
--     departures are read by office admin and stock-out (owner decision 2026-10-12; by
--     capability: orders.enter, orders.import, outbound.fulfil or outbound.correct at the
--     site). A packer reads only the AWBs assigned to the profile their PIN unlocked, proven
--     by the sealed packer session that the API server sends in the x-operator-packer
--     request header (PostgREST exposes it as request.headers). Management, production,
--     stock-in, drivers and HR read no AWB rows (their batch trace shows cartons only).
--     Carton totals are read by every active member; the rules are reference data.
--   * public.operator_commit_records(workspace, command, operation, fingerprint, changes,
--     attestation, packer_session) is the one write path for order commands on a
--     tables-mode site: signed 'operator-records-v1' message (below), operation-ID
--     idempotency through operator_commits (which gains a stored `result`), row versions,
--     per-carton advisory locks with the balance computed from the document carton, the
--     issued total, boxing, adjustments and returns, family invariants in
--     operator_private.assert_<family>, upload effects through WP A's
--     apply_import_effects, audit entries through WP B's append_events.
--       message = concat_ws(E'\n', 'operator-records-v1', workspace, auth.uid(), operation,
--         command, fingerprint, sha256hex(changes), sha256hex(coalesce(packer_session, '')))
--   * operator_commit_workspace keeps WP B's signature, signed messages and behaviour. On a
--     tables-mode site only: the site row is locked FOR NO KEY UPDATE (so order and issue
--     inserts, whose foreign keys take KEY SHARE, do not queue behind document saves),
--     cartons whose adjustments or boxing change are locked with the records path's
--     advisory lock, the conservation check counts the table's issued totals, order
--     commands are refused (PT428) and order keys in the document are refused (42501).
--   * Read functions (security invoker, one jsonb value each, so the Data API row limit
--     never truncates a day): operator_orders_page, operator_orders_day,
--     operator_orders_summary (one day, or all time with p_all), operator_orders_trace,
--     operator_orders_export (31 days at most), operator_packer_page;
--     operator_packer_counts (definer, counts only).
--   * Errors: 28000 not signed in; 42501 membership, capability, scope, signature or packer
--     session; PT409 operation ID reused with different input; PT412 stale row version
--     (detail {"stale": [ids]}); PT428 the site's order store is not the one this path
--     writes; 23505 duplicate AWB; 23514 invariant; 22023 malformed; 55000 server key missing.
-- Mirrors apps/web/src/lib/capabilities.ts (recordRules; tests/capabilities.test.mjs),
-- apps/web/src/lib/packer-session.ts (seal) and apps/web/src/lib/draft.ts (order rules).
-- Rollback: supabase/rollback/20261014090000_operator_order_records.down.sql.

-- ---------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------
-- Product -> stock unit (mirrors `products` in apps/web/src/lib/draft.ts).
create function operator_private.product_unit(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p = 'ady' then 'box' when p in ('cav', 'gly', 'lip', 'syn') then 'bottle' end
$$;
-- The distinct products of an AWB, sorted (one product when there are no lines).
create function operator_private.order_products(p_product text, p_lines jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case when p_lines is null or jsonb_typeof(p_lines) <> 'array' then array[p_product]
    else array(select distinct l ->> 'product' from jsonb_array_elements(p_lines) l order by 1) end
$$;
-- A JSON number that is a whole number within [p_min, p_max].
create function operator_private.json_whole(p jsonb, p_min numeric, p_max numeric)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case when jsonb_typeof(p) = 'number'
    then (p::text)::numeric between p_min and p_max and (p::text)::numeric = trunc((p::text)::numeric)
    else false end
$$;
-- 'YYYY-MM-DD' that is a real calendar day, else null.
create function operator_private.try_date(p text)
returns date
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p !~ '^\d{4}-\d{2}-\d{2}$' then
    return null;
  end if;
  return case when to_char(p::date, 'YYYY-MM-DD') = p then p::date end;
exception when others then
  return null;
end
$$;
-- lines: null, or 1..10 objects {product, expected, originalExpected, actual} with no other
-- keys; product valid; expected and originalExpected whole 1..1e6; actual null or whole
-- 0..1e6; and the order's aggregates agree: product = lines[0].product, expected = sum of
-- expected, actual = sum of actual when no line is null, else null.
create function operator_private.order_lines_valid(p_lines jsonb, p_product text,
  p_expected integer, p_actual integer)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  l jsonb;
  v_first text;
  v_expected numeric := 0;
  v_actual numeric := 0;
  v_open boolean := false;
begin
  if p_lines is null then
    return true;
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) not between 1 and 10 then
    return false;
  end if;
  for l in select e from jsonb_array_elements(p_lines) e loop
    if jsonb_typeof(l) <> 'object'
      or (l - 'product' - 'expected' - 'originalExpected' - 'actual') <> '{}'::jsonb
      or operator_private.product_unit(l ->> 'product') is null
      or not operator_private.json_whole(l -> 'expected', 1, 1000000)
      or not operator_private.json_whole(l -> 'originalExpected', 1, 1000000)
      or not (coalesce(jsonb_typeof(l -> 'actual'), 'null') = 'null'
        or operator_private.json_whole(l -> 'actual', 0, 1000000)) then
      return false;
    end if;
    v_first := coalesce(v_first, l ->> 'product');
    v_expected := v_expected + (l ->> 'expected')::numeric;
    if coalesce(jsonb_typeof(l -> 'actual'), 'null') = 'null' then
      v_open := true;
    else
      v_actual := v_actual + (l ->> 'actual')::numeric;
    end if;
  end loop;
  return p_product = v_first and p_expected = v_expected
    and p_actual is not distinct from (case when v_open then null else v_actual end);
end
$$;
revoke all on function operator_private.product_unit(text),
  operator_private.order_products(text, jsonb), operator_private.json_whole(jsonb, numeric, numeric),
  operator_private.try_date(text), operator_private.order_lines_valid(jsonb, text, integer, integer)
  from public;

-- ---------------------------------------------------------------------------------------
-- Per-site switch and stored results
-- ---------------------------------------------------------------------------------------
alter table public.operator_workspaces
  add column order_store text not null default 'document'
    constraint operator_workspaces_order_store check (order_store in ('document', 'tables'));

-- A records commit stores its result, so a retry after a lost response returns it. The
-- idempotency gate inserts the row first (result '{}') and fills it at the end of the same
-- transaction, so nobody ever reads the placeholder.
alter table public.operator_commits
  alter column result_revision drop not null,
  add column result jsonb,
  add constraint operator_commits_result check (result_revision is not null or result is not null);

-- ---------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------
create table public.operator_orders (
  id uuid primary key,
  workspace_id uuid not null references public.operator_workspaces(id) on delete restrict,
  awb text collate "C" not null
    check (char_length(awb) between 1 and 60 and awb = upper(regexp_replace(awb, '\s', '', 'g'))),
  channel text not null check (channel in ('Luxana', 'Shopee', 'TikTok', 'Lazada')),
  store text check (char_length(store) <= 200),
  order_ref text check (char_length(order_ref) <= 200),
  courier text check (char_length(courier) <= 100),
  import_id uuid,
  -- operator_import_rows.id; no foreign key (WP A keeps released_order_id as text).
  import_row_id uuid,
  product text not null check (operator_private.product_unit(product) is not null),
  package text not null default '' check (char_length(package) <= 2000),
  expected integer not null check (expected between 1 and 1000000),
  original_expected integer not null check (original_expected between 1 and 1000000),
  actual integer check (actual between 0 and 1000000),
  lines jsonb,
  products text[] generated always as (operator_private.order_products(product, lines)) stored,
  -- Order.date: the Malaysia fulfilment day.
  fulfil_date date not null,
  note text not null default '' check (char_length(note) <= 4000),
  review_state text not null default 'confirmed' check (review_state in ('pending', 'confirmed')),
  reviewed_by text check (char_length(reviewed_by) <= 200),
  printed boolean not null default false,
  assigned_packer text check (char_length(assigned_packer) <= 100),
  assigned_at timestamptz,
  packer text not null default '' check (char_length(packer) <= 200),
  label_pic text not null default '' check (char_length(label_pic) <= 200),
  packed_at timestamptz,
  pack_recorded_at timestamptz,
  pack_recorded_by jsonb check (pack_recorded_by is null or jsonb_typeof(pack_recorded_by) = 'object'),
  dispatched boolean not null default false,
  -- Stamped by the database on handover; null for backfilled history (the AWB reuse rule
  -- then uses the fulfilment day).
  dispatched_at timestamptz,
  handover_ref text not null default '' check (char_length(handover_ref) <= 200),
  version integer not null default 1 check (version >= 1),
  -- Backfilled from a document by move_orders_to_tables.
  legacy boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  -- Couriers reuse tracking numbers after roughly 90 to 365 days, so an AWB is never a key on
  -- its own (owner decision 2026-10-12): unique per fulfilment day here, plus the reuse rule
  -- of operator_private.assert_awb_reuse across days.
  constraint operator_orders_awb unique (workspace_id, awb, fulfil_date),
  constraint operator_orders_ws_id unique (workspace_id, id),
  -- An upload reference always names an upload of the same site.
  constraint operator_orders_import foreign key (import_id, workspace_id)
    references public.operator_imports (id, workspace_id) on delete restrict,
  constraint operator_orders_lines
    check (operator_private.order_lines_valid(lines, product, expected, actual)),
  -- orderReady(): nothing downstream happens to a pending AWB.
  constraint operator_orders_pending check (review_state = 'confirmed'
    or (not printed and assigned_packer is null and actual is null and not dispatched)),
  -- Handover needs a packed count and a manifest reference.
  constraint operator_orders_handover check (not dispatched or (actual is not null and handover_ref <> '')),
  constraint operator_orders_dispatched_at check (dispatched or dispatched_at is null),
  constraint operator_orders_attribution check (legacy or created_by is not null)
);
create index operator_orders_day on public.operator_orders (workspace_id, fulfil_date, awb) include (version);
create index operator_orders_packer on public.operator_orders (workspace_id, fulfil_date, assigned_packer)
  where assigned_packer is not null;
create index operator_orders_open on public.operator_orders (workspace_id, fulfil_date) where not dispatched;
create index operator_orders_import on public.operator_orders (workspace_id, import_id) where import_id is not null;
create index operator_orders_ref on public.operator_orders (workspace_id, order_ref) where order_ref is not null;
comment on table public.operator_orders is
  'One AWB of a tables-mode site. Written only by operator_commit_records and the owner''s move functions; see 20261014090000.';

create table public.operator_issues (
  id uuid primary key,
  workspace_id uuid not null,
  order_id uuid not null,
  -- A stock carton of the site's document.
  carton_id text not null check (char_length(carton_id) between 1 and 100),
  product text not null check (operator_private.product_unit(product) is not null),
  unit text not null check (unit in ('bottle', 'sachet', 'box')),
  qty integer not null check (qty between 1 and 1000000),
  pic text not null check (char_length(pic) between 1 and 200),
  at timestamptz not null default now(),
  recorded_by uuid,
  recorder jsonb check (recorder is null or jsonb_typeof(recorder) = 'object'),
  operation_id uuid,
  legacy boolean not null default false,
  constraint operator_issues_order foreign key (workspace_id, order_id)
    references public.operator_orders (workspace_id, id) on delete restrict,
  constraint operator_issues_attribution check (legacy or (recorded_by is not null and operation_id is not null))
);
create index operator_issues_order on public.operator_issues (workspace_id, order_id);
create index operator_issues_carton on public.operator_issues (workspace_id, carton_id, at);
create index operator_issues_time on public.operator_issues (workspace_id, at) include (carton_id, qty);
comment on table public.operator_issues is
  'One stock issue from a document carton to an AWB. Insert-only (trigger), written only by operator_commit_records.';

-- Running total per carton, written only by operator_commit_records under the carton lock
-- (and by the move functions). Balances use it, so archived issue rows (WP D) keep them.
create table public.operator_carton_issued (
  workspace_id uuid not null references public.operator_workspaces(id) on delete restrict,
  carton_id text not null,
  issued bigint not null check (issued >= 0),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, carton_id)
);

create table public.operator_sort_counts (
  id uuid primary key,
  workspace_id uuid not null references public.operator_workspaces(id) on delete restrict,
  fulfil_date date not null,
  product text not null check (operator_private.product_unit(product) is not null),
  -- Demand at count time, computed by the database (day_demand).
  expected integer not null check (expected >= 0),
  counted integer not null check (counted between 0 and 1000000),
  demand_awbs integer not null check (demand_awbs >= 0),
  demand_hash text not null check (demand_hash ~ '^[0-9a-f]{64}$'),
  pic text not null check (char_length(pic) between 1 and 200),
  note text not null default '' check (char_length(note) <= 2000),
  at timestamptz not null default now(),
  recorded_by uuid,
  recorder jsonb check (recorder is null or jsonb_typeof(recorder) = 'object'),
  operation_id uuid,
  legacy boolean not null default false,
  constraint operator_sort_counts_attribution check (legacy or recorded_by is not null)
);
create index operator_sort_counts_day on public.operator_sort_counts (workspace_id, fulfil_date, product, at desc);

-- An AWB left a day (removed, moved, later archived): day markers change on deletes and
-- moves, and this is the delete feed realtime (#11) needs for reconnect reconciliation.
create table public.operator_order_departures (
  workspace_id uuid not null references public.operator_workspaces(id) on delete restrict,
  order_id uuid not null,
  fulfil_date date not null,
  reason text not null check (reason in ('removed', 'moved', 'archived')),
  at timestamptz not null default now(),
  operation_id uuid
);
create index operator_order_departures_day on public.operator_order_departures (workspace_id, fulfil_date);

-- Insert-only, also against bugs in security-definer code: UPDATE always raises; DELETE
-- raises unless the caller set `operator.archiving = on` for its transaction (the WP D
-- archive mover, move_orders_to_document and the purge script).
create function operator_private.issues_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and current_setting('operator.archiving', true) = 'on' then
    return old;
  end if;
  raise exception 'Recorded % cannot be changed or removed.',
    case tg_table_name when 'operator_issues' then 'stock issues' else 'sort counts' end
    using errcode = '23514';
end
$$;
revoke all on function operator_private.issues_append_only() from public;
create trigger operator_issues_append_only before update or delete on public.operator_issues
  for each row execute function operator_private.issues_append_only();
create trigger operator_sort_counts_append_only before update or delete on public.operator_sort_counts
  for each row execute function operator_private.issues_append_only();

-- Command -> capability and row scope for the records path. Kept in sync with recordRules in
-- apps/web/src/lib/capabilities.ts (tests/capabilities.test.mjs compares them).
create table public.operator_record_rules (
  command text primary key,
  capability text not null,
  order_insert boolean not null default false,
  order_delete boolean not null default false,
  order_columns text[] not null default '{}',
  issues boolean not null default false,
  sort_counts boolean not null default false,
  import_effects text check (import_effects in ('release', 'delete', 'rows'))
);
insert into public.operator_record_rules (command, capability, order_insert, order_delete, order_columns, issues, sort_counts, import_effects) values
  ('order', 'orders.enter', true, false, '{}', false, false, null),
  ('edit-order', 'orders.enter', false, false, '{awb,product,channel,package,expected,original_expected,lines,fulfil_date}', false, false, null),
  ('review-order', 'orders.enter', false, false, '{review_state,reviewed_by}', false, false, null),
  ('remove-order', 'orders.enter', false, true, '{}', false, false, 'rows'),
  ('split-order', 'orders.enter', true, false, '{awb,product,package,expected,original_expected,lines,review_state,reviewed_by,assigned_packer,assigned_at,printed,packer,label_pic,note}', false, false, null),
  ('assign-package', 'outbound.fulfil', false, false, '{assigned_packer,assigned_at}', false, false, null),
  ('assign-orders', 'outbound.fulfil', false, false, '{assigned_packer,assigned_at}', false, false, null),
  ('print', 'outbound.fulfil', false, false, '{printed}', false, false, null),
  ('print-orders', 'outbound.fulfil', false, false, '{printed}', false, false, null),
  ('move-orders', 'outbound.fulfil', false, false, '{fulfil_date}', false, false, null),
  ('issue', 'outbound.fulfil', false, false, '{}', true, false, null),
  ('issue-orders', 'outbound.fulfil', false, false, '{}', true, false, null),
  ('pack', 'outbound.fulfil', false, false, '{actual,lines,packer,label_pic,packed_at,pack_recorded_at,pack_recorded_by}', false, false, null),
  ('pack-own', 'packing.record', false, false, '{actual,lines,packer,label_pic,packed_at,pack_recorded_at,pack_recorded_by}', false, false, null),
  ('correct', 'outbound.correct', false, false, '{expected,actual,lines}', false, false, null),
  ('dispatch', 'outbound.fulfil', false, false, '{dispatched,handover_ref}', false, false, null),
  ('sort-count', 'outbound.fulfil', false, false, '{}', false, true, null),
  ('import-release', 'orders.import', true, false, '{}', false, false, 'release'),
  ('import-delete', 'orders.import', false, true, '{}', false, false, 'delete');

-- ---------------------------------------------------------------------------------------
-- Read helpers and row-level security
-- ---------------------------------------------------------------------------------------
-- Sites where the caller may read AWB rows: office admin and stock-out, by capability
-- (owner decision 2026-10-12, replacing design 2.3's wider list). Management, production,
-- stock-in, drivers and HR read none; packers read their own assigned AWBs (second policy).
create function operator_private.order_reader_workspaces()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(w.id), '{}')
  from public.operator_workspaces w
  where public.operator_capabilities(w.id) && array['orders.enter', 'orders.import',
    'outbound.fulfil', 'outbound.correct']
$$;

-- The packer profile unlocked by a sealed packer session (apps/web/src/lib/packer-session.ts:
-- v1.<workspace>.<user>.<profile>.<expMs>.<mac>, mac = HMAC-SHA256 over the first five parts
-- with the key HMAC-SHA256(commit secret, 'operator-packer-session-v1')), or null. Valid only
-- for the signed-in user, this site, an expiry within the next 10 minutes, a caller with
-- packing.record and an active packer profile.
create function operator_private.packer_session_profile(p_workspace uuid, p_seal text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_parts text[];
  v_secret bytea;
  v_now numeric := extract(epoch from now()) * 1000;
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
begin
  if p_seal is null or p_workspace is null or v_uid is null or char_length(p_seal) > 400 then
    return null;
  end if;
  v_parts := string_to_array(p_seal, '.');
  if cardinality(v_parts) <> 6 or v_parts[1] <> 'v1' or v_parts[6] !~ '^[0-9a-f]{64}$'
    or v_parts[5] !~ '^[0-9]{1,16}$' or v_parts[2] !~* v_uuid or v_parts[3] !~* v_uuid
    or v_parts[4] !~* v_uuid then
    return null;
  end if;
  select k.secret into v_secret from operator_private.server_keys k where k.id = 'commit';
  if v_secret is null or v_parts[6] <> encode(extensions.hmac(
      convert_to(array_to_string(v_parts[1:5], '.'), 'UTF8'),
      extensions.hmac(convert_to('operator-packer-session-v1', 'UTF8'), v_secret, 'sha256'),
      'sha256'), 'hex') then
    return null;
  end if;
  if v_parts[2] <> p_workspace::text or v_parts[3] <> v_uid::text
    or (v_now < v_parts[5]::numeric and v_parts[5]::numeric <= v_now + 600000) is not true then
    return null;
  end if;
  if public.operator_has_capability(p_workspace, 'packing.record') is not true
    or operator_private.packer_profile_exists(p_workspace, v_parts[4]) is not true then
    return null;
  end if;
  return v_parts[4];
end
$$;

-- The packer session of this request: the API server copies the HttpOnly packer cookie into
-- the x-operator-packer header of packer reads; PostgREST exposes request headers as the
-- request.headers setting (lower-case names). No row when absent or invalid.
create function operator_private.packer_session()
returns table (workspace_id uuid, profile_id text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_seal text;
  v_workspace uuid;
  v_profile text;
begin
  begin
    v_seal := nullif(current_setting('request.headers', true), '')::json ->> 'x-operator-packer';
  exception when others then
    return;
  end;
  v_workspace := operator_private.try_uuid(split_part(coalesce(v_seal, ''), '.', 2));
  v_profile := operator_private.packer_session_profile(v_workspace, v_seal);
  if v_profile is not null then
    return query select v_workspace, v_profile;
  end if;
end
$$;
revoke all on function operator_private.order_reader_workspaces(),
  operator_private.packer_session_profile(uuid, text), operator_private.packer_session() from public;
-- Called in the select policies, so as the member.
grant execute on function operator_private.order_reader_workspaces(),
  operator_private.packer_session() to authenticated;

alter table public.operator_orders enable row level security;
alter table public.operator_issues enable row level security;
alter table public.operator_carton_issued enable row level security;
alter table public.operator_sort_counts enable row level security;
alter table public.operator_order_departures enable row level security;
alter table public.operator_record_rules enable row level security;
revoke all on public.operator_orders, public.operator_issues, public.operator_carton_issued,
  public.operator_sort_counts, public.operator_order_departures, public.operator_record_rules
  from anon, authenticated;
grant select on public.operator_orders, public.operator_issues, public.operator_carton_issued,
  public.operator_sort_counts, public.operator_order_departures, public.operator_record_rules
  to authenticated;
-- The helpers take no row argument, so each runs once per query (initplan) and the
-- (workspace_id, ...) indexes stay usable.
create policy "order readers read site AWBs" on public.operator_orders
for select to authenticated using (workspace_id = any ((select operator_private.order_reader_workspaces())::uuid[]));
create policy "packers read their assigned AWBs" on public.operator_orders
for select to authenticated using (
  (workspace_id, assigned_packer) = (select s.workspace_id, s.profile_id from operator_private.packer_session() s)
);
create policy "order readers read site stock issues" on public.operator_issues
for select to authenticated using (workspace_id = any ((select operator_private.order_reader_workspaces())::uuid[]));
create policy "order readers read site sort counts" on public.operator_sort_counts
for select to authenticated using (workspace_id = any ((select operator_private.order_reader_workspaces())::uuid[]));
create policy "order readers read site departures" on public.operator_order_departures
for select to authenticated using (workspace_id = any ((select operator_private.order_reader_workspaces())::uuid[]));
-- Carton balances are inventory, which every member already reads in the document.
create policy "active members read carton totals" on public.operator_carton_issued
for select to authenticated using (public.operator_active_role(workspace_id) is not null);
create policy "reference data" on public.operator_record_rules for select to authenticated using (true);

-- ---------------------------------------------------------------------------------------
-- Demand, sort counts, balances and the Order shape
-- ---------------------------------------------------------------------------------------
-- Reviewed AWBs of the day containing the product; per AWB the product's expected units.
-- hash = sha256 hex of string_agg(id || ':' || qty, ',' order by id) (uuid byte order, so
-- no collation dependence).
create function operator_private.day_demand(p_workspace uuid, p_date date, p_product text)
returns table (awbs integer, expected bigint, hash text)
language sql
stable
set search_path = ''
as $$
  with d as (
    select o.id, case when o.lines is null then o.expected::bigint
        else (select sum((l ->> 'expected')::numeric)::bigint from jsonb_array_elements(o.lines) l
          where l ->> 'product' = p_product) end as qty
    from public.operator_orders o
    where o.workspace_id = p_workspace and o.fulfil_date = p_date
      and o.review_state = 'confirmed' and p_product = any (o.products))
  select count(*)::integer, coalesce(sum(d.qty), 0)::bigint,
    encode(sha256(convert_to(coalesce(string_agg(d.id::text || ':' || d.qty, ',' order by d.id), ''), 'UTF8')), 'hex')
  from d
$$;
-- The latest count for (day, product) exists and was made against the current demand.
-- "Latest": counts recorded in tables mode are newer than every backfilled one (the backfill
-- always comes first); among backfilled counts, the recorded time decides.
create function operator_private.sort_count_current(p_workspace uuid, p_date date, p_product text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((
    select c.demand_hash = (select d.hash from operator_private.day_demand(p_workspace, p_date, p_product) d)
    from public.operator_sort_counts c
    where c.workspace_id = p_workspace and c.fulfil_date = p_date and c.product = p_product
    order by c.legacy, c.at desc, c.id desc
    limit 1), false)
$$;
-- The document fingerprint of draft.ts demandFingerprint (JSON of [id, qty] pairs sorted by
-- id), used when orders move back into the document.
create function operator_private.document_fingerprint(p_workspace uuid, p_date date, p_product text)
returns text
language sql
stable
set search_path = ''
as $$
  select '[' || coalesce(string_agg('["' || x.id::text || '",' || x.qty || ']', ','
    order by x.id::text collate "C"), '') || ']'
  from (
    select o.id, case when o.lines is null then o.expected::bigint
        else (select sum((l ->> 'expected')::numeric)::bigint from jsonb_array_elements(o.lines) l
          where l ->> 'product' = p_product) end as qty
    from public.operator_orders o
    where o.workspace_id = p_workspace and o.fulfil_date = p_date
      and o.review_state = 'confirmed' and p_product = any (o.products)) x
$$;
-- Carton balances of a document that still holds its issues (the formula of
-- assert_core_transition).
create function operator_private.document_balances(p_state jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(c ->> 'id',
    (c ->> 'qty')::numeric
    - coalesce((select sum((i ->> 'qty')::numeric) from jsonb_array_elements(coalesce(p_state -> 'issues', '[]')) i
        where i ->> 'cartonId' = c ->> 'id'), 0)
    - coalesce((select sum((b ->> 'boxes')::numeric * (b ->> 'ratio')::numeric + (b ->> 'loss')::numeric)
        from jsonb_array_elements(coalesce(p_state -> 'boxing', '[]')) b where b ->> 'sourceId' = c ->> 'id'), 0)
    + coalesce((select sum((a ->> 'delta')::numeric) from jsonb_array_elements(coalesce(p_state -> 'adjustments', '[]')) a
        where a ->> 'cartonId' = c ->> 'id'), 0)
    + coalesce((select sum((r ->> 'qty')::numeric) from jsonb_array_elements(coalesce(p_state -> 'returns', '[]')) r
        where r ->> 'cartonId' = c ->> 'id'), 0)), '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_state -> 'cartons', '[]')) c
$$;
-- Balance of one carton of a tables-mode site: document carton - issued total - boxing +
-- adjustments + returns. Volatile: each call reads the latest committed document and total
-- (the caller holds the carton lock). Null when the carton does not exist.
create function operator_private.carton_balance(p_workspace uuid, p_carton text)
returns numeric
language sql
volatile
set search_path = ''
as $$
  select (c ->> 'qty')::numeric
    - coalesce((select t.issued from public.operator_carton_issued t
        where t.workspace_id = p_workspace and t.carton_id = p_carton), 0)
    - coalesce((select sum((b ->> 'boxes')::numeric * (b ->> 'ratio')::numeric + (b ->> 'loss')::numeric)
        from jsonb_array_elements(coalesce(w.state -> 'boxing', '[]')) b where b ->> 'sourceId' = p_carton), 0)
    + coalesce((select sum((a ->> 'delta')::numeric) from jsonb_array_elements(coalesce(w.state -> 'adjustments', '[]')) a
        where a ->> 'cartonId' = p_carton), 0)
    + coalesce((select sum((r ->> 'qty')::numeric) from jsonb_array_elements(coalesce(w.state -> 'returns', '[]')) r
        where r ->> 'cartonId' = p_carton), 0)
  from public.operator_workspaces w
  cross join lateral jsonb_array_elements(coalesce(w.state -> 'cartons', '[]')) c
  where w.id = p_workspace and c ->> 'id' = p_carton
  limit 1
$$;
-- Balances of every carton of a tables-mode site.
create function operator_private.table_balances(p_workspace uuid)
returns jsonb
language sql
volatile
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(c ->> 'id', operator_private.carton_balance(p_workspace, c ->> 'id')), '{}'::jsonb)
  from public.operator_workspaces w
  cross join lateral jsonb_array_elements(coalesce(w.state -> 'cartons', '[]')) c
  where w.id = p_workspace
$$;
-- One row in the app's Order shape (apps/web/src/lib/draft.ts); row-only columns (version,
-- legacy, products, attribution) are left out.
create function operator_private.order_json(o public.operator_orders)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('id', o.id, 'awb', o.awb, 'channel', o.channel, 'product', o.product,
      'package', o.package, 'expected', o.expected, 'originalExpected', o.original_expected,
      'actual', o.actual, 'packer', o.packer, 'labelPic', o.label_pic, 'printed', o.printed,
      'dispatched', o.dispatched, 'handoverRef', o.handover_ref,
      'date', to_char(o.fulfil_date, 'YYYY-MM-DD'), 'note', o.note, 'reviewState', o.review_state)
    || coalesce((select jsonb_object_agg(k.key, k.value) from jsonb_each(jsonb_build_object(
      'reviewedBy', o.reviewed_by, 'assignedPacker', o.assigned_packer,
      'assignedAt', operator_private.iso(o.assigned_at), 'packedAt', operator_private.iso(o.packed_at),
      'packRecordedAt', operator_private.iso(o.pack_recorded_at), 'packRecordedBy', o.pack_recorded_by,
      'lines', o.lines, 'store', o.store, 'orderRef', o.order_ref, 'courier', o.courier,
      'importId', o.import_id, 'importRowId', o.import_row_id,
      'dispatchedAt', operator_private.iso(o.dispatched_at))) k
      where k.value <> 'null'::jsonb), '{}'::jsonb)
$$;
-- Changes whenever the day's rows change: counts and versions only grow, departures record
-- deletes and moves, so a late commit still changes the marker (design section 5).
create function operator_private.day_marker(p_workspace uuid, p_date date)
returns text
language sql
stable
set search_path = ''
as $$
  select md5(concat_ws(':',
    (select count(*) || ':' || coalesce(sum(o.version), 0) from public.operator_orders o
      where o.workspace_id = p_workspace and o.fulfil_date = p_date),
    (select count(*) from public.operator_order_departures d
      where d.workspace_id = p_workspace and d.fulfil_date = p_date),
    (select count(*) from public.operator_issues i
      where i.workspace_id = p_workspace and i.order_id in (select o.id from public.operator_orders o
        where o.workspace_id = p_workspace and o.fulfil_date = p_date)),
    (select count(*) from public.operator_sort_counts c
      where c.workspace_id = p_workspace and c.fulfil_date = p_date)))
$$;
revoke all on function operator_private.day_demand(uuid, date, text),
  operator_private.sort_count_current(uuid, date, text),
  operator_private.document_fingerprint(uuid, date, text),
  operator_private.document_balances(jsonb), operator_private.carton_balance(uuid, text),
  operator_private.table_balances(uuid), operator_private.order_json(public.operator_orders),
  operator_private.day_marker(uuid, date) from public;
-- Used by the security-invoker read functions below, as the member (RLS applies).
grant execute on function operator_private.day_demand(uuid, date, text),
  operator_private.sort_count_current(uuid, date, text),
  operator_private.order_json(public.operator_orders), operator_private.day_marker(uuid, date)
  to authenticated;

-- ---------------------------------------------------------------------------------------
-- Family invariants (design 3.3). Each receives the touched rows before (p_old: updated and
-- deleted rows) and after (p_new: updated and inserted rows) as jsonb arrays of table rows,
-- after the change was applied in this transaction. They refuse with 23514 even when the
-- change set was signed: the server's TypeScript rules are not trusted blindly.
-- ---------------------------------------------------------------------------------------
create function operator_private.assert_order(p_workspace uuid, p_command text, p_old jsonb,
  p_new jsonb, p_uid uuid, p_profile text, p_effects jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if jsonb_array_length(p_old) <> 0 or jsonb_array_length(p_new) <> 1 then
    raise exception 'Record one AWB at a time.' using errcode = '23514';
  end if;
  if exists (select 1 from jsonb_populate_recordset(null::public.operator_orders, p_new) n
    where (n.review_state = 'pending' and n.actual is null and not n.printed and not n.dispatched
      and n.assigned_packer is null and n.packer = '' and n.label_pic = '' and n.packed_at is null
      and n.pack_recorded_by is null and n.import_id is null and n.import_row_id is null) is not true) then
    raise exception 'A new AWB starts pending review, unassigned and unpacked.' using errcode = '23514';
  end if;
end
$$;

create function operator_private.assert_edit_order(p_workspace uuid, p_command text, p_old jsonb,
  p_new jsonb, p_uid uuid, p_profile text, p_effects jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if jsonb_array_length(p_old) <> 1 or jsonb_array_length(p_new) <> 1 then
    raise exception 'Edit one AWB at a time.' using errcode = '23514';
  end if;
  if exists (select 1 from jsonb_populate_recordset(null::public.operator_orders, p_old) o
    join jsonb_populate_recordset(null::public.operator_orders, p_new) n on n.id = o.id
    where (o.review_state = 'pending' and n.review_state = 'pending'
      and n.original_expected = n.expected) is not true) or not exists (
    select 1 from jsonb_populate_recordset(null::public.operator_orders, p_old) o
    join jsonb_populate_recordset(null::public.operator_orders, p_new) n on n.id = o.id) then
    raise exception 'Reviewed orders require a supervisor correction.' using errcode = '23514';
  end if;
end
$$;

create function operator_private.assert_review_order(p_workspace uuid, p_command text, p_old jsonb,
  p_new jsonb, p_uid uuid, p_profile text, p_effects jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if jsonb_array_length(p_old) <> 1 or jsonb_array_length(p_new) <> 1 or exists (
    select 1 from jsonb_populate_recordset(null::public.operator_orders, p_old) o
    join jsonb_populate_recordset(null::public.operator_orders, p_new) n on n.id = o.id
    where (o.review_state = 'pending' and n.review_state = 'confirmed'
      and btrim(coalesce(n.reviewed_by, '')) <> '') is not true) then
    raise exception 'Only a pending order can be reviewed, with the reviewing PIC.' using errcode = '23514';
  end if;
end
$$;

create function operator_private.assert_remove_order(p_workspace uuid, p_command text, p_old jsonb,
  p_new jsonb, p_uid uuid, p_profile text, p_effects jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if jsonb_array_length(p_old) <> 1 or jsonb_array_length(p_new) <> 0 then
    raise exception 'Remove one AWB at a time.' using errcode = '23514';
  end if;
  if exists (select 1 from jsonb_populate_recordset(null::public.operator_orders, p_old) o
    where (o.actual is null and o.packed_at is null and not o.dispatched) is not true) then
    raise exception 'This AWB has stock, packing or handover records. It stays for traceability; ask the stock-out supervisor for a correction instead.'
      using errcode = '23514';
  end if;
end
$$;

create function operator_private.assert_split_order(p_workspace uuid, p_command text, p_old jsonb,
  p_new jsonb, p_uid uuid, p_profile text, p_effects jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_old public.operator_orders;
begin
  if jsonb_array_length(p_old) <> 1 or jsonb_array_length(p_new) < 2 then
    raise exception 'Split one AWB into one parcel per product.' using errcode = '23514';
  end if;
  select * into v_old from jsonb_populate_recordset(null::public.operator_orders, p_old);
  if not exists (select 1 from jsonb_populate_recordset(null::public.operator_orders, p_new) n where n.id = v_old.id) then
    raise exception 'The original AWB must stay as one of the parcels.' using errcode = '23514';
  end if;
  if (cardinality(v_old.products) >= 2 and v_old.actual is null and not v_old.dispatched) is not true
    or exists (select 1 from public.operator_issues i where i.workspace_id = p_workspace and i.order_id = v_old.id) then
    raise exception 'This historical record has stock or packing activity. Preserve it and ask a supervisor to reconcile it separately.'
      using errcode = '23514';
  end if;
  if exists (select 1 from jsonb_populate_recordset(null::public.operator_orders, p_new) n
    where (n.review_state = 'confirmed' and btrim(coalesce(n.reviewed_by, '')) <> '' and n.lines is null
      and n.assigned_packer is null and not n.printed and n.actual is null and not n.dispatched
      and n.packer = '' and n.label_pic = '' and n.packed_at is null and n.original_expected = n.expected
      and n.channel = v_old.channel and n.fulfil_date = v_old.fulfil_date
      and n.store is not distinct from v_old.store and n.order_ref is not distinct from v_old.order_ref
      and n.courier is not distinct from v_old.courier and n.import_id is not distinct from v_old.import_id
      and n.import_row_id is not distinct from v_old.import_row_id) is not true) then
    raise exception 'Separated parcels are reviewed, unassigned and unpacked, and keep the original order details.'
      using errcode = '23514';
  end if;
  -- Demand is conserved: one parcel per product with that product's units.
  if (select array_agg(n.product || ':' || n.expected order by n.product, n.expected)
      from jsonb_populate_recordset(null::public.operator_orders, p_new) n)
    is distinct from (select array_agg(x.product || ':' || x.qty order by x.product, x.qty) from (
      select l ->> 'product' as product, sum((l ->> 'expected')::numeric)::integer as qty
      from jsonb_array_elements(coalesce(v_old.lines, jsonb_build_array(jsonb_build_object(
        'product', v_old.product, 'expected', v_old.expected)))) l
      group by 1) x) then
    raise exception 'The separated parcels must carry exactly the original units per product.' using errcode = '23514';
  end if;
end
$$;

create function operator_private.assert_assign(p_workspace uuid, p_command text, p_old jsonb,
  p_new jsonb, p_uid uuid, p_profile text, p_effects jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if jsonb_array_length(p_new) < 1 or jsonb_array_length(p_old) <> jsonb_array_length(p_new) then
    raise exception 'Select reviewed AWBs awaiting handover.' using errcode = '23514';
  end if;
  if exists (select 1 from jsonb_populate_recordset(null::public.operator_orders, p_new) n
    where (n.review_state = 'confirmed' and not n.dispatched and n.actual is null) is not true) then
    raise exception 'Only reviewed, unpacked parcels can be assigned.' using errcode = '23514';
  end if;
  if exists (select 1 from jsonb_populate_recordset(null::public.operator_orders, p_new) n
    where n.assigned_packer is not null
      and operator_private.packer_profile_exists(p_workspace, n.assigned_packer) is not true) then
    raise exception 'Choose a packer profile.' using errcode = '23514';
  end if;
end
$$;

create function operator_private.assert_print(p_workspace uuid, p_command text, p_old jsonb,
  p_new jsonb, p_uid uuid, p_profile text, p_effects jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if jsonb_array_length(p_new) < 1 or jsonb_array_length(p_old) <> jsonb_array_length(p_new) or exists (
    select 1 from jsonb_populate_recordset(null::public.operator_orders, p_old) o
    join jsonb_populate_recordset(null::public.operator_orders, p_new) n on n.id = o.id
    where (n.review_state = 'confirmed' and not o.printed and n.printed) is not true) then
    raise exception 'Only a reviewed AWB not yet printed can be recorded as printed.' using errcode = '23514';
  end if;
end
$$;

create function operator_private.assert_move_orders(p_workspace uuid, p_command text, p_old jsonb,
  p_new jsonb, p_uid uuid, p_profile text, p_effects jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if jsonb_array_length(p_new) < 1 or jsonb_array_length(p_old) <> jsonb_array_length(p_new) or exists (
    select 1 from jsonb_populate_recordset(null::public.operator_orders, p_new) n
    where (n.review_state = 'confirmed' and not n.dispatched and n.actual is null) is not true) then
    raise exception 'Only unpacked AWBs can move days. Existing stock allocations and assignments follow the AWB.'
      using errcode = '23514';
  end if;
end
$$;

create function operator_private.assert_pack(p_workspace uuid, p_command text, p_old jsonb,
  p_new jsonb, p_uid uuid, p_profile text, p_effects jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_old public.operator_orders;
  v_new public.operator_orders;
begin
  if jsonb_array_length(p_old) <> 1 or jsonb_array_length(p_new) <> 1 then
    raise exception 'Record one parcel at a time.' using errcode = '23514';
  end if;
  select * into v_old from jsonb_populate_recordset(null::public.operator_orders, p_old);
  select * into v_new from jsonb_populate_recordset(null::public.operator_orders, p_new);
  if (v_old.actual is null and v_old.review_state = 'confirmed' and v_old.assigned_packer is not null
    and cardinality(v_old.products) = 1 and not v_old.dispatched) is not true then
    raise exception 'Only an assigned packer''s first count can be recorded. Saved counts require a supervisor correction.'
      using errcode = '23514';
  end if;
  if (v_new.actual is not null and v_new.packer <> '' and v_new.packed_at is not null
    and v_new.packed_at <= now() + interval '5 minutes'
    and v_new.pack_recorded_by ->> 'userId' = p_uid::text
    -- the count changes only `actual` inside the lines
    and (select coalesce(jsonb_agg(l - 'actual' order by t.ord), 'null'::jsonb)
        from jsonb_array_elements(v_new.lines) with ordinality t(l, ord))
      is not distinct from (select coalesce(jsonb_agg(l - 'actual' order by t.ord), 'null'::jsonb)
        from jsonb_array_elements(v_old.lines) with ordinality t(l, ord))) is not true then
    raise exception 'A packed count needs the quantity, the packer, the time and the signed-in recorder.'
      using errcode = '23514';
  end if;
  if p_command = 'pack-own' and (v_new.packer = p_profile and v_new.label_pic = p_profile
    and v_old.assigned_packer = p_profile) is not true then
    raise exception 'This AWB is assigned to another packer. Ask your supervisor to reassign it.' using errcode = '23514';
  end if;
end
$$;

create function operator_private.assert_correct(p_workspace uuid, p_command text, p_old jsonb,
  p_new jsonb, p_uid uuid, p_profile text, p_effects jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_old public.operator_orders;
  v_new public.operator_orders;
begin
  if jsonb_array_length(p_old) <> 1 or jsonb_array_length(p_new) <> 1 then
    raise exception 'Correct one AWB at a time.' using errcode = '23514';
  end if;
  select * into v_old from jsonb_populate_recordset(null::public.operator_orders, p_old);
  select * into v_new from jsonb_populate_recordset(null::public.operator_orders, p_new);
  if (v_old.lines is null) <> (v_new.lines is null) then
    raise exception 'Correct the quantities of the existing products.' using errcode = '23514';
  end if;
  if v_old.lines is null then
    if v_new.actual is distinct from v_old.actual and (v_old.actual is not null and v_new.actual is not null) is not true then
      raise exception 'No saved packed count exists yet.' using errcode = '23514';
    end if;
  elsif jsonb_array_length(v_new.lines) <> jsonb_array_length(v_old.lines) or exists (
    select 1 from jsonb_array_elements(v_old.lines) with ordinality o(l, ord)
    join jsonb_array_elements(v_new.lines) with ordinality n(l, ord) on n.ord = o.ord
    where n.l ->> 'product' is distinct from o.l ->> 'product'
      or n.l -> 'originalExpected' is distinct from o.l -> 'originalExpected'
      or (n.l -> 'actual' is distinct from o.l -> 'actual'
        and (coalesce(o.l ->> 'actual', '') <> '' and coalesce(n.l ->> 'actual', '') <> '') is not true)) then
    raise exception 'Record the packer''s first count before correction.' using errcode = '23514';
  end if;
end
$$;

create function operator_private.assert_dispatch(p_workspace uuid, p_command text, p_old jsonb,
  p_new jsonb, p_uid uuid, p_profile text, p_effects jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if jsonb_array_length(p_old) <> 1 or jsonb_array_length(p_new) <> 1 or exists (
    select 1 from jsonb_populate_recordset(null::public.operator_orders, p_old) o
    join jsonb_populate_recordset(null::public.operator_orders, p_new) n on n.id = o.id
    where (o.actual is not null and not o.dispatched and n.dispatched
      and btrim(n.handover_ref) <> '') is not true) then
    raise exception 'Record the parcel quantity before handover; a parcel is handed over once, with its reference.'
      using errcode = '23514';
  end if;
end
$$;

create function operator_private.assert_import_release(p_workspace uuid, p_command text, p_old jsonb,
  p_new jsonb, p_uid uuid, p_profile text, p_effects jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if jsonb_array_length(p_old) <> 0 or jsonb_array_length(p_new) < 1 or exists (
    select 1 from jsonb_populate_recordset(null::public.operator_orders, p_new) n
    where (n.review_state = 'confirmed' and n.actual is null and n.packed_at is null and not n.printed
      and not n.dispatched and n.assigned_packer is null and n.packer = '' and n.label_pic = ''
      and n.import_id = operator_private.try_uuid(p_effects ->> 'release')
      and n.import_row_id is not null) is not true) then
    raise exception 'Released AWBs come from the confirmed upload, reviewed and unpacked.' using errcode = '23514';
  end if;
end
$$;

create function operator_private.assert_import_delete(p_workspace uuid, p_command text, p_old jsonb,
  p_new jsonb, p_uid uuid, p_profile text, p_effects jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if jsonb_array_length(p_new) <> 0 or exists (
    select 1 from jsonb_populate_recordset(null::public.operator_orders, p_old) o
    where (o.import_id = operator_private.try_uuid(p_effects ->> 'delete')
      and o.actual is null and o.packed_at is null and not o.dispatched) is not true) then
    raise exception 'AWBs released from this upload already have stock, packing or handover records. They stay for traceability.'
      using errcode = '23514';
  end if;
end
$$;

-- Dispatch by command (the families of design 3.3).
create function operator_private.assert_order_family(p_workspace uuid, p_command text, p_old jsonb,
  p_new jsonb, p_uid uuid, p_profile text, p_effects jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  case p_command
    when 'order' then perform operator_private.assert_order(p_workspace, p_command, p_old, p_new, p_uid, p_profile, p_effects);
    when 'edit-order' then perform operator_private.assert_edit_order(p_workspace, p_command, p_old, p_new, p_uid, p_profile, p_effects);
    when 'review-order' then perform operator_private.assert_review_order(p_workspace, p_command, p_old, p_new, p_uid, p_profile, p_effects);
    when 'remove-order' then perform operator_private.assert_remove_order(p_workspace, p_command, p_old, p_new, p_uid, p_profile, p_effects);
    when 'split-order' then perform operator_private.assert_split_order(p_workspace, p_command, p_old, p_new, p_uid, p_profile, p_effects);
    when 'assign-package', 'assign-orders' then perform operator_private.assert_assign(p_workspace, p_command, p_old, p_new, p_uid, p_profile, p_effects);
    when 'print', 'print-orders' then perform operator_private.assert_print(p_workspace, p_command, p_old, p_new, p_uid, p_profile, p_effects);
    when 'move-orders' then perform operator_private.assert_move_orders(p_workspace, p_command, p_old, p_new, p_uid, p_profile, p_effects);
    when 'pack', 'pack-own' then perform operator_private.assert_pack(p_workspace, p_command, p_old, p_new, p_uid, p_profile, p_effects);
    when 'correct' then perform operator_private.assert_correct(p_workspace, p_command, p_old, p_new, p_uid, p_profile, p_effects);
    when 'dispatch' then perform operator_private.assert_dispatch(p_workspace, p_command, p_old, p_new, p_uid, p_profile, p_effects);
    when 'import-release' then perform operator_private.assert_import_release(p_workspace, p_command, p_old, p_new, p_uid, p_profile, p_effects);
    when 'import-delete' then perform operator_private.assert_import_delete(p_workspace, p_command, p_old, p_new, p_uid, p_profile, p_effects);
    else
      -- issue, issue-orders and sort-count change no order rows (their rule allows none).
      if jsonb_array_length(p_old) + jsonb_array_length(p_new) <> 0 then
        raise exception 'This change is outside the % command scope.', p_command using errcode = '42501';
      end if;
  end case;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Stock issues (design 3.4): carton locks, order row locks, then the checks against the
-- latest committed document, then the rows, the running total and the balance.
-- ---------------------------------------------------------------------------------------
create function operator_private.assert_issue(p_workspace uuid, p_command text, p_issues jsonb, p_state jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  -- A stock carton of this site (finished stock: unit = the product's unit).
  if exists (select 1 from jsonb_array_elements(p_issues) i
    where not exists (select 1 from jsonb_array_elements(coalesce(p_state -> 'cartons', '[]')) c
      where c ->> 'id' = i ->> 'carton_id' and c ->> 'unit' = operator_private.product_unit(c ->> 'product'))) then
    raise exception 'Choose matching saleable stock for this order.' using errcode = '23514';
  end if;
  -- A reviewed, single-product AWB of this site, of the carton's product, not handed over.
  if exists (select 1 from jsonb_array_elements(p_issues) i
    cross join lateral (select c from jsonb_array_elements(p_state -> 'cartons') c
      where c ->> 'id' = i ->> 'carton_id' limit 1) x
    left join public.operator_orders o on o.workspace_id = p_workspace and o.id = (i ->> 'order_id')::uuid
    where (o.review_state = 'confirmed' and cardinality(o.products) = 1
      and o.products[1] = x.c ->> 'product' and not o.dispatched) is not true) then
    raise exception 'Stock goes only to a reviewed single-product AWB of the carton''s product that is not handed over.'
      using errcode = '23514';
  end if;
  -- issue-orders fills remaining demand only (single `issue` has no demand cap, as in draft.ts).
  if p_command = 'issue-orders' and exists (
    select 1 from (
      select (i ->> 'order_id')::uuid as order_id, sum((i ->> 'qty')::numeric) as qty
      from jsonb_array_elements(p_issues) i group by 1) n
    join public.operator_orders o on o.workspace_id = p_workspace and o.id = n.order_id
    where n.qty > o.expected - coalesce((select sum(x.qty) from public.operator_issues x
      where x.workspace_id = p_workspace and x.order_id = o.id and x.product = o.products[1]), 0)) then
    raise exception 'Quantity exceeds the remaining demand for selected AWBs.' using errcode = '23514';
  end if;
end
$$;

create function operator_private.apply_issues(p_workspace uuid, p_command text, p_issues jsonb,
  p_uid uuid, p_operation uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_carton text;
  v_state jsonb;
begin
  if jsonb_array_length(p_issues) = 0 then
    return '[]'::jsonb;
  end if;
  if jsonb_array_length(p_issues) > 2000 then
    raise exception 'One change can record at most 2000 stock issues.' using errcode = '23514';
  end if;
  if exists (select 1 from jsonb_array_elements(p_issues) i
    where (case when jsonb_typeof(i) = 'object' then
        operator_private.try_uuid(i ->> 'id') is not null
        and operator_private.try_uuid(i ->> 'order_id') is not null
        and jsonb_typeof(i -> 'carton_id') = 'string' and char_length(i ->> 'carton_id') between 1 and 100
        and jsonb_typeof(i -> 'qty') = 'number' and jsonb_typeof(i -> 'pic') = 'string'
        and coalesce(jsonb_typeof(i -> 'recorder'), 'null') in ('object', 'null')
        -- server-stamped or derived fields are accepted and ignored
        and (i - array['id', 'order_id', 'carton_id', 'qty', 'pic', 'recorder', 'product', 'unit', 'at',
          'recorded_by', 'operation_id', 'legacy', 'workspace_id']) = '{}'::jsonb
      end) is not true) then
    raise exception 'Invalid stock issue.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_issues) i
    where not operator_private.json_whole(i -> 'qty', 1, 1000000)) then
    raise exception 'Stock issues must be positive whole quantities.' using errcode = '23514';
  end if;
  if exists (select 1 from jsonb_array_elements(p_issues) i
    where jsonb_typeof(i -> 'recorder') = 'object' and i -> 'recorder' ->> 'userId' is distinct from p_uid::text) then
    raise exception 'New stock issues must be attributed to the signed-in user.' using errcode = '23514';
  end if;
  if (select count(distinct (i ->> 'id')::uuid) from jsonb_array_elements(p_issues) i) <> jsonb_array_length(p_issues) then
    raise exception 'Duplicate record identifiers.' using errcode = '23514';
  end if;
  -- 1. Carton locks, ascending, so two commits never wait on each other in a cycle.
  for v_carton in select distinct (i ->> 'carton_id') collate "C" from jsonb_array_elements(p_issues) i order by 1 loop
    perform pg_advisory_xact_lock(hashtextextended('operator-carton:' || p_workspace::text || ':' || v_carton, 0));
  end loop;
  -- 2. Then the AWB rows, ascending.
  perform 1 from public.operator_orders o
  where o.workspace_id = p_workspace
    and o.id in (select (i ->> 'order_id')::uuid from jsonb_array_elements(p_issues) i)
  order by o.id for update;
  -- 3. Only now read the document: a new statement sees adjustments committed while waiting.
  select w.state into v_state from public.operator_workspaces w where w.id = p_workspace;
  -- 4-5. Invariants.
  perform operator_private.assert_issue(p_workspace, p_command, p_issues, v_state);
  -- 6. Rows (product and unit copied from the carton) and the running total.
  begin
    insert into public.operator_issues (id, workspace_id, order_id, carton_id, product, unit, qty, pic,
      at, recorded_by, recorder, operation_id, legacy)
    select (i ->> 'id')::uuid, p_workspace, (i ->> 'order_id')::uuid, i ->> 'carton_id', x.c ->> 'product',
      x.c ->> 'unit', (i ->> 'qty')::numeric::integer, i ->> 'pic', now(), p_uid,
      case when jsonb_typeof(i -> 'recorder') = 'object' then i -> 'recorder' end, p_operation, false
    from jsonb_array_elements(p_issues) i
    cross join lateral (select c from jsonb_array_elements(v_state -> 'cartons') c
      where c ->> 'id' = i ->> 'carton_id' limit 1) x;
  exception when unique_violation then
    raise exception 'Duplicate record identifiers.' using errcode = '23514';
  end;
  insert into public.operator_carton_issued (workspace_id, carton_id, issued, updated_at)
  select p_workspace, i ->> 'carton_id', sum((i ->> 'qty')::numeric)::bigint, now()
  from jsonb_array_elements(p_issues) i group by 2
  on conflict (workspace_id, carton_id) do update
    set issued = public.operator_carton_issued.issued + excluded.issued, updated_at = now();
  -- 7. Balance. Issues only lower it, so there is no historical-deficit allowance.
  if exists (select 1 from (select distinct i ->> 'carton_id' as id from jsonb_array_elements(p_issues) i) c
    where (operator_private.carton_balance(p_workspace, c.id) >= 0) is not true) then
    raise exception 'Not enough stock in this carton.' using errcode = '23514';
  end if;
  return (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb) from public.operator_issues x
    where x.id in (select (i ->> 'id')::uuid from jsonb_array_elements(p_issues) i));
end
$$;

-- ---------------------------------------------------------------------------------------
-- Supervisor sort counts (design 3.2 step 11): the database computes the demand.
-- ---------------------------------------------------------------------------------------
create function operator_private.assert_sort_count(p_workspace uuid, p_counts jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from jsonb_array_elements(p_counts) s
    cross join lateral operator_private.day_demand(p_workspace, (s ->> 'fulfil_date')::date, s ->> 'product') d
    where d.awbs < 1) then
    raise exception 'No reviewed orders for this product and day.' using errcode = '23514';
  end if;
  if exists (select 1 from jsonb_array_elements(p_counts) s
    cross join lateral operator_private.day_demand(p_workspace, (s ->> 'fulfil_date')::date, s ->> 'product') d
    where (s -> 'expected' = to_jsonb(d.expected) and s -> 'demand_awbs' = to_jsonb(d.awbs)
      and s ->> 'demand_hash' = d.hash) is not true) then
    raise exception 'Orders changed while the count was prepared. Count again.' using errcode = '23514';
  end if;
end
$$;

create function operator_private.apply_sort_counts(p_workspace uuid, p_counts jsonb, p_uid uuid, p_operation uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
begin
  if jsonb_array_length(p_counts) = 0 then
    return '[]'::jsonb;
  end if;
  if jsonb_array_length(p_counts) > 20 or exists (select 1 from jsonb_array_elements(p_counts) s
    where (case when jsonb_typeof(s) = 'object' then
        operator_private.try_uuid(s ->> 'id') is not null
        and operator_private.try_date(s ->> 'fulfil_date') is not null
        and jsonb_typeof(s -> 'product') = 'string' and jsonb_typeof(s -> 'pic') = 'string'
        and coalesce(jsonb_typeof(s -> 'note'), 'null') in ('string', 'null')
        and coalesce(jsonb_typeof(s -> 'recorder'), 'null') in ('object', 'null')
        and (s - array['id', 'fulfil_date', 'product', 'counted', 'pic', 'note', 'expected', 'demand_awbs',
          'demand_hash', 'recorder', 'at', 'recorded_by', 'operation_id', 'legacy', 'workspace_id']) = '{}'::jsonb
      end) is not true) then
    raise exception 'Invalid sort count.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_counts) s
    where not operator_private.json_whole(s -> 'counted', 0, 1000000)
      or operator_private.product_unit(s ->> 'product') is null
      or (jsonb_typeof(s -> 'recorder') = 'object' and s -> 'recorder' ->> 'userId' is distinct from p_uid::text)) then
    raise exception 'A sort count needs a product, a whole counted quantity and the signed-in recorder.' using errcode = '23514';
  end if;
  perform operator_private.assert_sort_count(p_workspace, p_counts);
  begin
    insert into public.operator_sort_counts (id, workspace_id, fulfil_date, product, expected, counted,
      demand_awbs, demand_hash, pic, note, at, recorded_by, recorder, operation_id, legacy)
    select (s ->> 'id')::uuid, p_workspace, (s ->> 'fulfil_date')::date, s ->> 'product',
      (s ->> 'expected')::integer, (s ->> 'counted')::numeric::integer, (s ->> 'demand_awbs')::integer,
      s ->> 'demand_hash', s ->> 'pic', coalesce(s ->> 'note', ''), now(), p_uid,
      case when jsonb_typeof(s -> 'recorder') = 'object' then s -> 'recorder' end, p_operation, false
    from jsonb_array_elements(p_counts) s;
  exception when unique_violation then
    raise exception 'Duplicate record identifiers.' using errcode = '23514';
  end;
  return (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb) from public.operator_sort_counts x
    where x.id in (select (s ->> 'id')::uuid from jsonb_array_elements(p_counts) s));
end
$$;

-- ---------------------------------------------------------------------------------------
-- Order rows (design 3.2 step 9): lock every touched row ascending, check every version,
-- then deletes, updates and inserts in ascending id order. The database stamps the
-- server-time and attribution columns and ignores values sent for them.
-- ---------------------------------------------------------------------------------------
create function operator_private.apply_orders(p_workspace uuid, p_command text, p_inserts jsonb,
  p_updates jsonb, p_deletes jsonb, p_uid uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_stale text[];
  v_item jsonb;
  v_set jsonb;
  v_old public.operator_orders;
  v_new public.operator_orders;
  v_before jsonb := '[]';
  v_after jsonb := '[]';
  v_ops jsonb := '[]';
  v_constraint text;
begin
  perform 1 from public.operator_orders o
  where o.workspace_id = p_workspace
    and o.id in (select (x ->> 'id')::uuid from jsonb_array_elements(p_updates || p_deletes) x)
  order by o.id for update;
  select array_agg(x ->> 'id' order by x ->> 'id') into v_stale
  from jsonb_array_elements(p_updates || p_deletes) x
  where not exists (select 1 from public.operator_orders o where o.workspace_id = p_workspace
    and o.id = (x ->> 'id')::uuid and o.version = (x ->> 'version')::integer);
  if v_stale is not null then
    raise exception 'This AWB changed after it was read. Reload it and try again.' using errcode = 'PT412',
      detail = jsonb_build_object('stale', to_jsonb(v_stale))::text;
  end if;
  if exists (select 1 from public.operator_issues i where i.workspace_id = p_workspace
    and i.order_id in (select (x ->> 'id')::uuid from jsonb_array_elements(p_deletes) x)) then
    raise exception 'This AWB has stock, packing or handover records. It stays for traceability; ask the stock-out supervisor for a correction instead.'
      using errcode = '23514';
  end if;
  for v_item in select x from jsonb_array_elements(p_deletes) x order by (x ->> 'id')::uuid loop
    delete from public.operator_orders o
    where o.workspace_id = p_workspace and o.id = (v_item ->> 'id')::uuid
    returning * into v_old;
    v_before := v_before || to_jsonb(v_old);
    v_ops := v_ops || jsonb_build_object('id', v_old.id, 'op', 'delete', 'version', v_old.version);
  end loop;
  for v_item in select x from jsonb_array_elements(p_updates) x order by (x ->> 'id')::uuid loop
    select * into v_old from public.operator_orders o
    where o.workspace_id = p_workspace and o.id = (v_item ->> 'id')::uuid;
    v_set := v_item -> 'set';
    v_new := jsonb_populate_record(v_old, v_set);
    v_new.assigned_at := case when not (v_set ? 'assigned_packer') then v_old.assigned_at
      when v_new.assigned_packer is null then null else v_now end;
    v_new.pack_recorded_at := case when p_command in ('pack', 'pack-own') then v_now else v_old.pack_recorded_at end;
    if p_command = 'pack-own' then
      v_new.packed_at := v_now;
    end if;
    v_new.dispatched_at := case when v_new.dispatched and not v_old.dispatched then v_now
      else v_old.dispatched_at end;
    update public.operator_orders o
    set awb = v_new.awb, channel = v_new.channel, store = v_new.store, order_ref = v_new.order_ref,
      courier = v_new.courier, import_id = v_new.import_id, import_row_id = v_new.import_row_id,
      product = v_new.product, package = v_new.package, expected = v_new.expected,
      original_expected = v_new.original_expected, actual = v_new.actual, lines = v_new.lines,
      fulfil_date = v_new.fulfil_date, note = v_new.note, review_state = v_new.review_state,
      reviewed_by = v_new.reviewed_by, printed = v_new.printed, assigned_packer = v_new.assigned_packer,
      assigned_at = v_new.assigned_at, packer = v_new.packer, label_pic = v_new.label_pic,
      packed_at = v_new.packed_at, pack_recorded_at = v_new.pack_recorded_at,
      pack_recorded_by = v_new.pack_recorded_by, dispatched = v_new.dispatched,
      dispatched_at = v_new.dispatched_at, handover_ref = v_new.handover_ref, version = v_old.version + 1, updated_at = v_now, updated_by = p_uid
    where o.workspace_id = p_workspace and o.id = v_old.id
    returning * into v_new;
    v_before := v_before || to_jsonb(v_old);
    v_after := v_after || to_jsonb(v_new);
    v_ops := v_ops || jsonb_build_object('id', v_new.id, 'op', 'update', 'version', v_new.version);
  end loop;
  for v_item in select x from jsonb_array_elements(p_inserts) x order by (x ->> 'id')::uuid loop
    v_new := jsonb_populate_record(null::public.operator_orders, v_item - array['version', 'created_at',
      'created_by', 'updated_at', 'updated_by', 'assigned_at', 'pack_recorded_at', 'dispatched_at',
      'products', 'legacy', 'workspace_id']);
    insert into public.operator_orders (id, workspace_id, awb, channel, store, order_ref, courier,
      import_id, import_row_id, product, package, expected, original_expected, actual, lines,
      fulfil_date, note, review_state, reviewed_by, printed, assigned_packer, assigned_at, packer,
      label_pic, packed_at, pack_recorded_at, pack_recorded_by, dispatched, handover_ref, version,
      legacy, created_at, created_by, updated_at, updated_by)
    values (v_new.id, p_workspace, v_new.awb, v_new.channel, v_new.store, v_new.order_ref, v_new.courier,
      v_new.import_id, v_new.import_row_id, v_new.product, coalesce(v_new.package, ''), v_new.expected,
      v_new.original_expected, v_new.actual, v_new.lines, v_new.fulfil_date, coalesce(v_new.note, ''),
      coalesce(v_new.review_state, 'confirmed'), v_new.reviewed_by, coalesce(v_new.printed, false),
      v_new.assigned_packer, case when v_new.assigned_packer is not null then v_now end,
      coalesce(v_new.packer, ''), coalesce(v_new.label_pic, ''), v_new.packed_at, null,
      v_new.pack_recorded_by, coalesce(v_new.dispatched, false), coalesce(v_new.handover_ref, ''), 1,
      false, v_now, p_uid, v_now, p_uid)
    returning * into v_new;
    v_after := v_after || to_jsonb(v_new);
    v_ops := v_ops || jsonb_build_object('id', v_new.id, 'op', 'insert', 'version', v_new.version);
  end loop;
  return jsonb_build_object('old', v_before, 'new', v_after, 'ops', v_ops);
exception
  when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'operator_orders_awb' then
      raise exception 'This AWB is already recorded.' using errcode = '23505';
    end if;
    raise exception 'Duplicate record identifiers.' using errcode = '23514';
  when foreign_key_violation then
    raise exception 'This upload does not exist at this site.' using errcode = '23514';
  when not_null_violation or invalid_text_representation or datatype_mismatch
    or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range
    or invalid_binary_representation then
    raise exception 'Invalid order record.' using errcode = '22023';
end
$$;
revoke all on function
  operator_private.assert_order(uuid, text, jsonb, jsonb, uuid, text, jsonb),
  operator_private.assert_edit_order(uuid, text, jsonb, jsonb, uuid, text, jsonb),
  operator_private.assert_review_order(uuid, text, jsonb, jsonb, uuid, text, jsonb),
  operator_private.assert_remove_order(uuid, text, jsonb, jsonb, uuid, text, jsonb),
  operator_private.assert_split_order(uuid, text, jsonb, jsonb, uuid, text, jsonb),
  operator_private.assert_assign(uuid, text, jsonb, jsonb, uuid, text, jsonb),
  operator_private.assert_print(uuid, text, jsonb, jsonb, uuid, text, jsonb),
  operator_private.assert_move_orders(uuid, text, jsonb, jsonb, uuid, text, jsonb),
  operator_private.assert_pack(uuid, text, jsonb, jsonb, uuid, text, jsonb),
  operator_private.assert_correct(uuid, text, jsonb, jsonb, uuid, text, jsonb),
  operator_private.assert_dispatch(uuid, text, jsonb, jsonb, uuid, text, jsonb),
  operator_private.assert_import_release(uuid, text, jsonb, jsonb, uuid, text, jsonb),
  operator_private.assert_import_delete(uuid, text, jsonb, jsonb, uuid, text, jsonb),
  operator_private.assert_order_family(uuid, text, jsonb, jsonb, uuid, text, jsonb),
  operator_private.assert_issue(uuid, text, jsonb, jsonb),
  operator_private.apply_issues(uuid, text, jsonb, uuid, uuid),
  operator_private.assert_sort_count(uuid, jsonb),
  operator_private.apply_sort_counts(uuid, jsonb, uuid, uuid),
  operator_private.apply_orders(uuid, text, jsonb, jsonb, jsonb, uuid)
  from public;

-- ---------------------------------------------------------------------------------------
-- AWB reuse (owner decision 2026-10-12): couriers reuse tracking numbers, so the same AWB
-- may appear again at a site only when the earlier AWB was handed over more than 30 days
-- before the later one's fulfilment day (Malaysia days; backfilled history without a
-- handover time counts from its fulfilment day). Otherwise it is a duplicate.
-- ---------------------------------------------------------------------------------------
create function operator_private.awb_reuse_allowed(a public.operator_orders, b public.operator_orders)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case
    when a.fulfil_date < b.fulfil_date then a.dispatched and b.fulfil_date
      - coalesce((a.dispatched_at at time zone 'Asia/Kuala_Lumpur')::date, a.fulfil_date) > 30
    when b.fulfil_date < a.fulfil_date then b.dispatched and a.fulfil_date
      - coalesce((b.dispatched_at at time zone 'Asia/Kuala_Lumpur')::date, b.fulfil_date) > 30
    else false end
$$;
-- Checks the rows p_ids (inserted, or whose AWB or day changed) against every other AWB of
-- the site with the same number. Takes a per-(site, AWB) advisory lock first, ascending, so
-- two commits entering the same number on different days cannot both pass.
create function operator_private.assert_awb_reuse(p_workspace uuid, p_ids uuid[])
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_awb text;
begin
  if coalesce(cardinality(p_ids), 0) = 0 then
    return;
  end if;
  for v_awb in select distinct o.awb from public.operator_orders o
    where o.workspace_id = p_workspace and o.id = any (p_ids) order by 1 loop
    perform pg_advisory_xact_lock(hashtextextended('operator-awb:' || p_workspace::text || ':' || v_awb, 0));
  end loop;
  if exists (select 1 from public.operator_orders n
    join public.operator_orders o on o.workspace_id = n.workspace_id and o.awb = n.awb and o.id <> n.id
    where n.workspace_id = p_workspace and n.id = any (p_ids)
      and operator_private.awb_reuse_allowed(o, n) is not true) then
    raise exception 'This AWB is already recorded.' using errcode = '23505';
  end if;
end
$$;
revoke all on function operator_private.awb_reuse_allowed(public.operator_orders, public.operator_orders),
  operator_private.assert_awb_reuse(uuid, uuid[]) from public;

-- ---------------------------------------------------------------------------------------
-- The write path for order commands on a tables-mode site (design 3.1 to 3.6)
-- ---------------------------------------------------------------------------------------
create function public.operator_commit_records(
  p_workspace uuid,
  p_command text,
  p_operation uuid,
  p_fingerprint text,
  p_changes text,
  p_attestation text,
  p_packer_session text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_role text;
  v_store text;
  v_fresh integer;
  v_prior public.operator_commits%rowtype;
  v_rule public.operator_record_rules%rowtype;
  v_secret bytea;
  v_message text;
  v_changes jsonb;
  v_orders jsonb;
  v_inserts jsonb;
  v_updates jsonb;
  v_deletes jsonb;
  v_issues jsonb;
  v_counts jsonb;
  v_effects jsonb;
  v_events jsonb;
  v_profile text;
  v_applied jsonb := jsonb_build_object('old', '[]'::jsonb, 'new', '[]'::jsonb, 'ops', '[]'::jsonb);
  v_old jsonb;
  v_new jsonb;
  v_issue_rows jsonb;
  v_count_rows jsonb;
  v_doc_old jsonb;
  v_doc_new jsonb;
  v_result jsonb;
  v_insertable constant text[] := array['id', 'awb', 'channel', 'store', 'order_ref', 'courier',
    'import_id', 'import_row_id', 'product', 'package', 'expected', 'original_expected', 'actual',
    'lines', 'fulfil_date', 'note', 'review_state', 'reviewed_by', 'printed', 'assigned_packer',
    'packer', 'label_pic', 'packed_at', 'pack_recorded_by', 'dispatched', 'handover_ref',
    -- stamped by the database; accepted and ignored
    'version', 'created_at', 'created_by', 'updated_at', 'updated_by', 'assigned_at',
    'pack_recorded_at', 'dispatched_at', 'products', 'legacy', 'workspace_id'];
begin
  -- 1. Caller.
  if v_uid is null then
    raise exception 'Sign in again before saving.' using errcode = '28000';
  end if;
  v_role := public.operator_active_role(p_workspace);
  if v_role is null then
    raise exception 'No active membership for this site.' using errcode = '42501';
  end if;
  -- 2. Site row, KEY SHARE: a move between stores (FOR UPDATE) cannot interleave, while
  -- document saves (FOR NO KEY UPDATE on a tables-mode site) do not block this path.
  select w.order_store into v_store from public.operator_workspaces w where w.id = p_workspace for key share;
  if v_store is distinct from 'tables' then
    raise exception 'Orders at this site are kept in the workspace document. Reload and try again.'
      using errcode = 'PT428';
  end if;
  if p_operation is null or (p_fingerprint ~ '^[0-9a-f]{64}$') is not true or p_changes is null
    or p_command is null or p_attestation is null then
    raise exception 'Invalid operation.' using errcode = '22023';
  end if;
  -- 3. Idempotency gate. A concurrent first attempt with the same ID makes this insert wait
  -- on the primary key until it commits (then this attempt replays) or aborts.
  insert into public.operator_commits (workspace_id, operation_id, user_id, role, command,
    fingerprint, result_revision, result)
  values (p_workspace, p_operation, v_uid, v_role, p_command, p_fingerprint, null, '{}'::jsonb)
  on conflict (workspace_id, operation_id) do nothing;
  get diagnostics v_fresh = row_count;
  if v_fresh = 0 then
    select * into v_prior from public.operator_commits c
    where c.workspace_id = p_workspace and c.operation_id = p_operation;
    if v_prior.user_id is distinct from v_uid or v_prior.command is distinct from p_command
      or v_prior.fingerprint is distinct from p_fingerprint then
      raise exception 'This save ID was already used for a different change.' using errcode = 'PT409';
    end if;
    -- result is null when the operation was a document commit (result_revision instead).
    return jsonb_build_object('replayed', true, 'result', v_prior.result);
  end if;
  -- 4. Rule and capability.
  select * into v_rule from public.operator_record_rules r where r.command = p_command;
  if not found then
    raise exception 'Unknown order command.' using errcode = '42501';
  end if;
  if public.operator_has_capability(p_workspace, v_rule.capability) is not true then
    raise exception 'Your role at this site does not permit %.', v_rule.capability using errcode = '42501';
  end if;
  -- 5. Signature over the exact change text, then parse.
  select k.secret into v_secret from operator_private.server_keys k where k.id = 'commit';
  if v_secret is null then
    raise exception 'Operational saving is not configured.' using errcode = '55000';
  end if;
  v_message := concat_ws(E'\n', 'operator-records-v1', p_workspace::text, v_uid::text,
    p_operation::text, p_command, p_fingerprint,
    encode(extensions.digest(convert_to(p_changes, 'UTF8'), 'sha256'), 'hex'),
    encode(extensions.digest(convert_to(coalesce(p_packer_session, ''), 'UTF8'), 'sha256'), 'hex'));
  if (lower(p_attestation) = encode(extensions.hmac(convert_to(v_message, 'UTF8'), v_secret, 'sha256'), 'hex')) is not true then
    raise exception 'This change was not validated by the Operator server.' using errcode = '42501';
  end if;
  if octet_length(p_changes) > 8388608 then
    raise exception 'This change is too large.' using errcode = '22023';
  end if;
  begin
    v_changes := p_changes::jsonb;
  exception when others then
    raise exception 'Invalid order changes.' using errcode = '22023';
  end;
  if (jsonb_typeof(v_changes) = 'object'
    and (v_changes - array['orders', 'issues', 'sortCounts', 'importEffects', 'events']) = '{}'::jsonb) is not true then
    raise exception 'Invalid order changes.' using errcode = '22023';
  end if;
  v_orders := coalesce(nullif(v_changes -> 'orders', 'null'::jsonb), '{}'::jsonb);
  v_issues := coalesce(nullif(v_changes -> 'issues', 'null'::jsonb), '[]'::jsonb);
  v_counts := coalesce(nullif(v_changes -> 'sortCounts', 'null'::jsonb), '[]'::jsonb);
  v_effects := nullif(v_changes -> 'importEffects', 'null'::jsonb);
  v_events := coalesce(nullif(v_changes -> 'events', 'null'::jsonb), '[]'::jsonb);
  if (jsonb_typeof(v_orders) = 'object'
    and (v_orders - array['insert', 'update', 'delete']) = '{}'::jsonb) is not true then
    raise exception 'Invalid order changes.' using errcode = '22023';
  end if;
  v_inserts := coalesce(nullif(v_orders -> 'insert', 'null'::jsonb), '[]'::jsonb);
  v_updates := coalesce(nullif(v_orders -> 'update', 'null'::jsonb), '[]'::jsonb);
  v_deletes := coalesce(nullif(v_orders -> 'delete', 'null'::jsonb), '[]'::jsonb);
  if (jsonb_typeof(v_inserts) = 'array' and jsonb_typeof(v_updates) = 'array'
    and jsonb_typeof(v_deletes) = 'array' and jsonb_typeof(v_issues) = 'array'
    and jsonb_typeof(v_counts) = 'array' and jsonb_typeof(v_events) = 'array'
    and coalesce(jsonb_typeof(v_effects), 'object') = 'object') is not true then
    raise exception 'Invalid order changes.' using errcode = '22023';
  end if;
  if jsonb_array_length(v_inserts) + jsonb_array_length(v_updates) + jsonb_array_length(v_deletes) > 10000 then
    raise exception 'One change can touch at most 10000 AWBs.' using errcode = '23514';
  end if;
  if exists (select 1 from jsonb_array_elements(v_inserts) x
      where (case when jsonb_typeof(x) = 'object' then
        operator_private.try_uuid(x ->> 'id') is not null
        and not exists (select 1 from jsonb_object_keys(x) k where k <> all (v_insertable))
        and (not x ? 'fulfil_date' or operator_private.try_date(x ->> 'fulfil_date') is not null)
      end) is not true)
    or exists (select 1 from jsonb_array_elements(v_updates) x
      where (case when jsonb_typeof(x) = 'object' then
        operator_private.try_uuid(x ->> 'id') is not null
        and operator_private.json_whole(x -> 'version', 1, 2147483647)
        and jsonb_typeof(x -> 'set') = 'object' and (x - 'id' - 'version' - 'set') = '{}'::jsonb
        and (not (x -> 'set') ? 'fulfil_date' or operator_private.try_date(x -> 'set' ->> 'fulfil_date') is not null)
      end) is not true)
    or exists (select 1 from jsonb_array_elements(v_deletes) x
      where (case when jsonb_typeof(x) = 'object' then
        operator_private.try_uuid(x ->> 'id') is not null
        and operator_private.json_whole(x -> 'version', 1, 2147483647)
        and (x - 'id' - 'version') = '{}'::jsonb
      end) is not true) then
    raise exception 'Invalid order changes.' using errcode = '22023';
  end if;
  if (select count(distinct (x ->> 'id')::uuid) from jsonb_array_elements(v_inserts || v_updates || v_deletes) x)
    <> jsonb_array_length(v_inserts || v_updates || v_deletes) then
    raise exception 'Each AWB may appear once in a change.' using errcode = '22023';
  end if;
  -- 6. Scope: only the parts and columns the command's rule allows.
  if (jsonb_array_length(v_inserts) > 0 and not v_rule.order_insert)
    or (jsonb_array_length(v_deletes) > 0 and not v_rule.order_delete)
    or (jsonb_array_length(v_issues) > 0 and not v_rule.issues)
    or (jsonb_array_length(v_counts) > 0 and not v_rule.sort_counts)
    or (v_effects is not null and v_rule.import_effects is null)
    or exists (select 1 from jsonb_array_elements(v_updates) x, jsonb_object_keys(x -> 'set') k
      where k <> all (v_rule.order_columns)) then
    raise exception 'This change is outside the % command scope.', p_command using errcode = '42501';
  end if;
  -- 7. The packer's own count: the profile comes from the verified session, never the input.
  if p_command = 'pack-own' then
    v_profile := operator_private.packer_session_profile(p_workspace, p_packer_session);
    if v_profile is null then
      raise exception 'Your packer session ended. Enter your PIN again.' using errcode = '42501';
    end if;
  end if;
  -- 8. Stock issues (carton locks, then AWB rows, then balance).
  v_issue_rows := operator_private.apply_issues(p_workspace, p_command, v_issues, v_uid, p_operation);
  -- 9. AWB rows, then the AWB reuse rule and the family's invariants.
  if jsonb_array_length(v_inserts || v_updates || v_deletes) > 0 then
    v_applied := operator_private.apply_orders(p_workspace, p_command, v_inserts, v_updates, v_deletes, v_uid);
  end if;
  v_old := v_applied -> 'old';
  v_new := v_applied -> 'new';
  perform operator_private.assert_awb_reuse(p_workspace, array(
    select n.id from jsonb_populate_recordset(null::public.operator_orders, v_new) n
    left join jsonb_populate_recordset(null::public.operator_orders, v_old) o on o.id = n.id
    where o.id is null or o.awb <> n.awb or o.fulfil_date <> n.fulfil_date));
  perform operator_private.assert_order_family(p_workspace, p_command, v_old, v_new, v_uid, v_profile, v_effects);
  -- 10. Upload effects (WP A), checked against the rows: the function receives the touched
  -- AWBs in the document shape it already understands.
  if v_rule.import_effects is not null then
    v_doc_old := jsonb_build_object('orders', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id::text,
        'importId', o.import_id::text, 'importRowId', o.import_row_id::text)), '[]'::jsonb)
      from jsonb_populate_recordset(null::public.operator_orders, v_old) o
      where not exists (select 1 from jsonb_populate_recordset(null::public.operator_orders, v_new) n where n.id = o.id)));
    v_doc_new := jsonb_build_object('orders', case v_rule.import_effects
      -- release: the AWBs this commit released
      when 'release' then (select coalesce(jsonb_agg(jsonb_build_object('id', n.id::text,
          'importId', n.import_id::text, 'importRowId', n.import_row_id::text)), '[]'::jsonb)
        from jsonb_populate_recordset(null::public.operator_orders, v_new) n where n.import_id is not null)
      -- delete: the upload's AWBs still in the table
      when 'delete' then (select coalesce(jsonb_agg(jsonb_build_object('id', o.id::text, 'importId', o.import_id::text)), '[]'::jsonb)
        from public.operator_orders o where o.workspace_id = p_workspace
          and o.import_id = operator_private.try_uuid(v_effects ->> 'delete'))
      -- rows: AWBs still in the table that the marked labels released
      else (select coalesce(jsonb_agg(jsonb_build_object('id', o.id::text)), '[]'::jsonb)
        from public.operator_orders o where o.workspace_id = p_workspace and o.id::text in (
          select r.released_order_id from public.operator_import_rows r
          where r.workspace_id = p_workspace and r.id in (
            select operator_private.try_uuid(e ->> 'id')
            from jsonb_array_elements(case when jsonb_typeof(v_effects -> 'rows') = 'array'
              then v_effects -> 'rows' else '[]'::jsonb end) e)))
      end);
    perform operator_private.apply_import_effects(p_workspace, p_command, v_doc_old, v_doc_new, v_effects, v_uid);
  end if;
  -- 11. Sort counts against the demand the database computes.
  v_count_rows := operator_private.apply_sort_counts(p_workspace, v_counts, v_uid, p_operation);
  -- 12. Gates: a current supervisor count for every touched (day, product) before
  -- assigning packers or issuing to selected AWBs (draft.ts; single `issue` has no gate).
  if p_command in ('assign-package', 'assign-orders', 'issue-orders') and exists (
    select 1 from (
      select n.fulfil_date, p.product from jsonb_populate_recordset(null::public.operator_orders, v_new) n,
        unnest(n.products) p(product)
      union
      select o.fulfil_date, i.product from jsonb_populate_recordset(null::public.operator_issues, v_issue_rows) i
      join public.operator_orders o on o.workspace_id = p_workspace and o.id = i.order_id) t
    where operator_private.sort_count_current(p_workspace, t.fulfil_date, t.product) is not true) then
    raise exception 'Record a current supervisor count before issuing stock or assigning packers.' using errcode = '23514';
  end if;
  -- 13. Audit entries (WP B), then completeness: every changed AWB, every AWB that received
  -- stock and every counted day has an entry in this change. import-delete logs one entry
  -- for the upload (draft.ts), which covers the AWBs it removed.
  perform operator_private.append_events(p_workspace, v_events, v_uid, p_command, p_operation);
  if exists (
    select 1 from (
      select o ->> 'id' as entity, o ->> 'import_id' as upload from jsonb_array_elements(v_old || v_new) o
      union
      select i ->> 'order_id', null from jsonb_array_elements(v_issue_rows) i
      union
      select s ->> 'fulfil_date', null from jsonb_array_elements(v_count_rows) s) t
    where not exists (select 1 from jsonb_array_elements(v_events) e
      where e ->> 'entity' = t.entity or (p_command = 'import-delete' and e ->> 'entity' = t.upload))) then
    raise exception 'Every changed AWB needs its audit entry in the same change.' using errcode = '23514';
  end if;
  -- 14. Departures: removed AWBs and AWBs that moved to another day.
  insert into public.operator_order_departures (workspace_id, order_id, fulfil_date, reason, at, operation_id)
  select p_workspace, o.id, o.fulfil_date,
    case when n.id is null then 'removed' else 'moved' end, now(), p_operation
  from jsonb_populate_recordset(null::public.operator_orders, v_old) o
  left join jsonb_populate_recordset(null::public.operator_orders, v_new) n on n.id = o.id
  where n.id is null or n.fulfil_date <> o.fulfil_date;
  -- 15. Result, stored for replays.
  v_result := jsonb_build_object(
    'orders', v_applied -> 'ops',
    'issues', (select coalesce(jsonb_agg(i -> 'id' order by i ->> 'id'), '[]'::jsonb) from jsonb_array_elements(v_issue_rows) i),
    'sortCounts', (select coalesce(jsonb_agg(s -> 'id' order by s ->> 'id'), '[]'::jsonb) from jsonb_array_elements(v_count_rows) s),
    'days', (select coalesce(jsonb_agg(d order by d), '[]'::jsonb) from (
      select o ->> 'fulfil_date' as d from jsonb_array_elements(v_old || v_new) o
      union select to_char(o.fulfil_date, 'YYYY-MM-DD') from jsonb_array_elements(v_issue_rows) i
        join public.operator_orders o on o.workspace_id = p_workspace and o.id = (i ->> 'order_id')::uuid
      union select s ->> 'fulfil_date' from jsonb_array_elements(v_count_rows) s) x));
  update public.operator_commits c set result = v_result
  where c.workspace_id = p_workspace and c.operation_id = p_operation;
  return jsonb_build_object('replayed', false, 'result', v_result);
end
$$;
revoke all on function public.operator_commit_records(uuid, text, uuid, text, text, text, text) from public, anon;
grant execute on function public.operator_commit_records(uuid, text, uuid, text, text, text, text) to authenticated;
comment on function public.operator_commit_records(uuid, text, uuid, text, text, text, text) is
  'Commits a server-validated, signed set of order, stock-issue and sort-count rows for the signed-in member on a tables-mode site. See 20261014090000.';

-- ---------------------------------------------------------------------------------------
-- The document commit path: the final text of 20261013090000_operator_events.sql plus the
-- tables-mode changes (marked "order records"). Same signature, so grants are kept.
-- ---------------------------------------------------------------------------------------
create or replace function public.operator_commit_workspace(
  p_workspace uuid,
  p_expected_revision integer,
  p_command text,
  p_operation uuid,
  p_fingerprint text,
  p_state text,
  p_attestation text,
  p_import_effects text default null -- import effects
)
returns table (new_state jsonb, new_revision integer, replayed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_role text;
  v_factory text; -- factory scope
  v_rule public.operator_command_rules%rowtype;
  v_current public.operator_workspaces%rowtype;
  v_prior public.operator_commits%rowtype;
  v_secret bytea;
  v_message text;
  v_message_v1 text; -- accepted without effects during the rollout
  v_new jsonb;
  v_old jsonb; -- audit entries: the stored document without events
  v_stored jsonb; -- audit entries: what is stored, with an empty events list
  v_events jsonb; -- audit entries: the command's new entries
  v_effects jsonb; -- import effects
  v_carton text; -- order records
  v_issued jsonb; -- order records
begin
  if v_uid is null then
    raise exception 'Sign in again before saving.' using errcode = '28000';
  end if;
  -- order records: FOR NO KEY UPDATE, so order and issue inserts (whose foreign keys take
  -- KEY SHARE on the site row) do not queue behind document saves of a tables-mode site.
  -- A document-mode site keeps FOR UPDATE, exactly as before.
  select * into v_current from public.operator_workspaces w where w.id = p_workspace for no key update;
  if v_current.order_store = 'document' then
    select * into v_current from public.operator_workspaces w where w.id = p_workspace for update;
  end if;
  -- factory scope: role and factory are read in one statement, so from the same snapshot.
  select public.operator_active_role(p_workspace), operator_private.active_factory(p_workspace)
  into v_role, v_factory;
  if v_current.id is null or v_role is null then
    raise exception 'No active membership for this site.' using errcode = '42501';
  end if;
  -- A retried operation returns its established result without repeating effects.
  select * into v_prior from public.operator_commits c
  where c.workspace_id = p_workspace and c.operation_id = p_operation;
  if found then
    if v_prior.user_id is distinct from v_uid or v_prior.command is distinct from p_command
      or v_prior.fingerprint is distinct from p_fingerprint then
      raise exception 'This save ID was already used for a different change.' using errcode = 'PT409';
    end if;
    return query select (v_current.state - 'events') || '{"events": []}'::jsonb,
      v_current.revision, true;
    return;
  end if;
  select * into v_rule from public.operator_command_rules r where r.command = p_command;
  if not found then
    raise exception 'Unknown operational command.' using errcode = '42501';
  end if;
  if public.operator_has_capability(p_workspace, v_rule.capability) is not true then
    raise exception 'Your role at this site does not permit %.', v_rule.capability using errcode = '42501';
  end if;
  -- order records: on a tables-mode site order commands go through operator_commit_records.
  if v_current.order_store = 'tables'
    and exists (select 1 from public.operator_record_rules r where r.command = p_command) then
    raise exception 'Orders at this site are kept as records. Reload and try again.' using errcode = 'PT428';
  end if;
  select k.secret into v_secret from operator_private.server_keys k where k.id = 'commit';
  if v_secret is null then
    raise exception 'Operational saving is not configured.' using errcode = '55000';
  end if;
  if (p_fingerprint ~ '^[0-9a-f]{64}$') is not true or p_operation is null
    or p_expected_revision is null or p_state is null then
    raise exception 'Invalid operation.' using errcode = '22023';
  end if;
  -- import effects: v2 message, with the exact effects text as its last line. A commit
  -- without effects is also accepted under the previous v1 message, so applying this
  -- migration and deploying the server that signs v2 need not happen in the same minute;
  -- effects are only ever accepted under v2.
  v_message := concat_ws(E'\n', 'operator-commit-v2', p_workspace::text,
    p_expected_revision::text, v_uid::text, p_operation::text, p_command, p_fingerprint,
    encode(extensions.digest(convert_to(coalesce(p_state, ''), 'UTF8'), 'sha256'), 'hex'),
    encode(extensions.digest(convert_to(coalesce(p_import_effects, ''), 'UTF8'), 'sha256'), 'hex'));
  v_message_v1 := concat_ws(E'\n', 'operator-commit-v1', p_workspace::text,
    p_expected_revision::text, v_uid::text, p_operation::text, p_command, p_fingerprint,
    encode(extensions.digest(convert_to(coalesce(p_state, ''), 'UTF8'), 'sha256'), 'hex'));
  if (lower(p_attestation) =
      encode(extensions.hmac(convert_to(v_message, 'UTF8'), v_secret, 'sha256'), 'hex')
    or (p_import_effects is null and lower(p_attestation) =
      encode(extensions.hmac(convert_to(v_message_v1, 'UTF8'), v_secret, 'sha256'), 'hex'))) is not true then
    raise exception 'This change was not validated by the Operator server.' using errcode = '42501';
  end if;
  begin
    v_new := p_state::jsonb;
    v_effects := p_import_effects::jsonb; -- import effects
  exception when others then
    raise exception 'Invalid workspace state.' using errcode = '22023';
  end;
  if (jsonb_typeof(v_new) = 'object') is not true then
    raise exception 'Invalid workspace state.' using errcode = '22023';
  end if;
  -- order records: order data never slips back into a tables-mode document, and the
  -- server's transient fields are never stored.
  if v_current.order_store = 'tables'
    and v_new ?| array['orders', 'issues', 'sortCounts', 'cartonIssued', 'demand'] then
    raise exception 'Order records cannot be saved in the workspace document.' using errcode = '42501';
  end if;
  -- audit entries: the submitted `events` are this command's new entries. They leave the
  -- document and go to operator_events; both documents are compared without them.
  v_events := coalesce(v_new -> 'events', '[]'::jsonb);
  v_new := v_new - 'events';
  v_old := v_current.state - 'events';
  if v_events <> '[]'::jsonb and not ('events' = any (v_rule.state_keys)) then
    raise exception 'This change is outside the % command scope.', p_command using errcode = '42501';
  end if;
  if (v_new - v_rule.state_keys) is distinct from (v_old - v_rule.state_keys) then
    raise exception 'This change is outside the % command scope.', p_command using errcode = '42501';
  end if;
  perform operator_private.assert_factory_scope(v_old, v_new, v_factory); -- factory scope
  if v_current.order_store = 'tables' then
    -- order records: lock (ascending, the records path's key) every carton whose adjustments
    -- or boxing change, after the site row; records commits take cartons, then AWB rows,
    -- and never the site row lock, so there is no cycle.
    for v_carton in
      select distinct x.id collate "C" from (
        select e ->> 'cartonId' as id from (
          (select e from jsonb_array_elements(coalesce(v_new -> 'adjustments', '[]')) e
            except select e from jsonb_array_elements(coalesce(v_old -> 'adjustments', '[]')) e)
          union all
          (select e from jsonb_array_elements(coalesce(v_old -> 'adjustments', '[]')) e
            except select e from jsonb_array_elements(coalesce(v_new -> 'adjustments', '[]')) e)) a
        union all
        select v.id from (
          (select e from jsonb_array_elements(coalesce(v_new -> 'boxing', '[]')) e
            except select e from jsonb_array_elements(coalesce(v_old -> 'boxing', '[]')) e)
          union all
          (select e from jsonb_array_elements(coalesce(v_old -> 'boxing', '[]')) e
            except select e from jsonb_array_elements(coalesce(v_new -> 'boxing', '[]')) e)) b
        cross join lateral (values (b.e ->> 'sourceId'), (b.e ->> 'cartonId')) v(id)) x
      where x.id is not null
      order by 1
    loop
      perform pg_advisory_xact_lock(hashtextextended('operator-carton:' || p_workspace::text || ':' || v_carton, 0));
    end loop;
    -- order records: the table's issued totals enter both documents as identical virtual
    -- issues, read after the carton locks, so the unchanged conservation check counts them.
    select coalesce(jsonb_agg(jsonb_build_object('cartonId', t.carton_id, 'qty', t.issued)), '[]'::jsonb)
    into v_issued from public.operator_carton_issued t where t.workspace_id = p_workspace;
    perform operator_private.assert_transition(v_old || jsonb_build_object('issues', v_issued),
      v_new || jsonb_build_object('issues', v_issued), v_uid);
  else
    perform operator_private.assert_transition(v_old, v_new, v_uid);
  end if;
  if v_current.revision is distinct from p_expected_revision then
    return;
  end if;
  v_stored := v_new || '{"events": []}'::jsonb; -- audit entries
  update public.operator_workspaces w
  set state = v_stored, revision = w.revision + 1, updated_at = now()
  where w.id = p_workspace;
  insert into public.operator_commits (workspace_id, operation_id, user_id, role, command,
    fingerprint, result_revision)
  values (p_workspace, p_operation, v_uid, v_role, p_command, p_fingerprint,
    v_current.revision + 1);
  -- audit entries: a document still holding entries (written before 20261013090000) hands
  -- them over as recorded; then the command's own entries, attributed to the caller.
  if jsonb_typeof(v_current.state -> 'events') = 'array'
    and v_current.state -> 'events' <> '[]'::jsonb then
    perform operator_private.backfill_events(p_workspace, v_current.state -> 'events');
  end if;
  perform operator_private.append_events(p_workspace, v_events, v_uid, p_command, p_operation);
  -- import effects: applied with the document update or not at all.
  perform operator_private.apply_import_effects(p_workspace, p_command, v_old, v_new,
    v_effects, v_uid);
  return query select v_stored, v_current.revision + 1, false;
end
$$;
comment on function public.operator_commit_workspace(uuid, integer, text, uuid, text, text, text, text) is
  'Commits a server-validated, signed transition for the signed-in member, with its upload effects; its audit entries go to operator_events; on a tables-mode site it counts table stock issues. See 20261005090000, 20261012090000, 20261013090000 and 20261014090000.';

-- ---------------------------------------------------------------------------------------
-- Moving a site between stores (design section 7). Owner-run only (not granted to clients):
--   select operator_private.move_orders_to_tables('<site id>');
--   select operator_private.move_orders_to_document('<site id>');
-- Each is one transaction under the site row lock (FOR UPDATE, which waits for and blocks
-- records commits), keeps every carton balance, bumps the revision so open tabs reload, and
-- is a no-op on a site that is already in the target store.
-- ---------------------------------------------------------------------------------------
-- Why a document order cannot become a row (null when it can).
create function operator_private.legacy_order_problem(p jsonb, p_workspace uuid)
returns text
language plpgsql
stable
set search_path = ''
as $$
begin
  if jsonb_typeof(p) is distinct from 'object' then
    return 'not an order record';
  elsif operator_private.try_uuid(p ->> 'id') is null then
    return 'identifier is not a UUID';
  elsif jsonb_typeof(p -> 'awb') is distinct from 'string'
    or char_length(upper(regexp_replace(p ->> 'awb', '\s', '', 'g'))) not between 1 and 60 then
    return 'AWB missing or longer than 60 characters';
  elsif coalesce(p ->> 'channel', '') not in ('Luxana', 'Shopee', 'TikTok', 'Lazada') then
    return 'unknown order source';
  elsif operator_private.product_unit(p ->> 'product') is null then
    return 'unknown product';
  elsif not operator_private.json_whole(p -> 'expected', 1, 1000000) then
    return 'expected quantity is not a whole number from 1 to 1000000';
  elsif coalesce(jsonb_typeof(p -> 'originalExpected'), 'null') <> 'null'
    and not operator_private.json_whole(p -> 'originalExpected', 1, 1000000) then
    return 'original quantity is not a whole number from 1 to 1000000';
  elsif coalesce(jsonb_typeof(p -> 'actual'), 'null') <> 'null'
    and not operator_private.json_whole(p -> 'actual', 0, 1000000) then
    return 'packed quantity is not a whole number';
  elsif operator_private.try_date(p ->> 'date') is null then
    return 'fulfilment date is not YYYY-MM-DD';
  elsif coalesce(p ->> 'reviewState', 'confirmed') not in ('pending', 'confirmed') then
    return 'unknown review state';
  elsif coalesce(jsonb_typeof(p -> 'printed'), 'null') not in ('boolean', 'null')
    or coalesce(jsonb_typeof(p -> 'dispatched'), 'null') not in ('boolean', 'null') then
    return 'printed or handover flag is not true or false';
  elsif coalesce(jsonb_typeof(p -> 'lines'), 'null') not in ('array', 'null')
    or not operator_private.order_lines_valid(
      case when jsonb_typeof(p -> 'lines') = 'array' then p -> 'lines' end, p ->> 'product',
      (p ->> 'expected')::numeric::integer,
      case when coalesce(jsonb_typeof(p -> 'actual'), 'null') = 'null' then null
        else (p ->> 'actual')::numeric::integer end) then
    return 'product lines do not match the AWB totals';
  elsif coalesce(jsonb_typeof(p -> 'importId'), 'null') <> 'null' and not exists (
    select 1 from public.operator_imports i
    where i.id = operator_private.try_uuid(p ->> 'importId') and i.workspace_id = p_workspace) then
    return 'its upload is not an upload of this site';
  elsif coalesce(jsonb_typeof(p -> 'importRowId'), 'null') <> 'null'
    and operator_private.try_uuid(p ->> 'importRowId') is null then
    return 'its label reference is not a UUID';
  end if;
  return null;
end
$$;

create function operator_private.move_orders_to_tables(p_workspace uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_site public.operator_workspaces%rowtype;
  v_orders jsonb;
  v_issues jsonb;
  v_counts jsonb;
  v_cartons jsonb;
  v_problems text[];
  v_before jsonb;
  v_now timestamptz := date_trunc('milliseconds', now());
begin
  select * into v_site from public.operator_workspaces w where w.id = p_workspace for update;
  if not found then
    raise exception 'Site not found.' using errcode = '22023';
  end if;
  if v_site.order_store = 'tables' then
    return jsonb_build_object('moved', false, 'orderStore', 'tables');
  end if;
  if exists (select 1 from public.operator_orders o where o.workspace_id = p_workspace)
    or exists (select 1 from public.operator_sort_counts s where s.workspace_id = p_workspace)
    or exists (select 1 from public.operator_carton_issued t where t.workspace_id = p_workspace) then
    raise exception 'This site already has order rows. Move it back to the document first.' using errcode = '23514';
  end if;
  v_orders := case when jsonb_typeof(v_site.state -> 'orders') = 'array' then v_site.state -> 'orders' else '[]' end;
  v_issues := case when jsonb_typeof(v_site.state -> 'issues') = 'array' then v_site.state -> 'issues' else '[]' end;
  v_counts := case when jsonb_typeof(v_site.state -> 'sortCounts') = 'array' then v_site.state -> 'sortCounts' else '[]' end;
  v_cartons := case when jsonb_typeof(v_site.state -> 'cartons') = 'array' then v_site.state -> 'cartons' else '[]' end;
  v_before := operator_private.document_balances(v_site.state);

  -- Validate first; the error lists the first 20 problems.
  select array_agg(x.problem) into v_problems from (
    select x.problem from (
      select 'AWB ' || coalesce(o ->> 'awb', '?') || ': '
        || operator_private.legacy_order_problem(o, p_workspace) as problem, t.ord as ord, 1 as kind
      from jsonb_array_elements(v_orders) with ordinality t(o, ord)
      where operator_private.legacy_order_problem(o, p_workspace) is not null
      union all
      select 'AWB ' || min(o ->> 'awb') || ': identifier used more than once', min(t.ord), 2
      from jsonb_array_elements(v_orders) with ordinality t(o, ord)
      group by o ->> 'id' having count(*) > 1
      union all
      select 'AWB ' || min(o ->> 'awb') || ': recorded more than once for ' || (o ->> 'date'), min(t.ord), 3
      from jsonb_array_elements(v_orders) with ordinality t(o, ord)
      group by upper(regexp_replace(o ->> 'awb', '\s', '', 'g')), o ->> 'date' having count(*) > 1
      union all
      select 'Stock issue ' || coalesce(i ->> 'id', '?') || ': ' || case
          when operator_private.try_uuid(i ->> 'id') is null then 'identifier is not a UUID'
          when not exists (select 1 from jsonb_array_elements(v_orders) o where o ->> 'id' = i ->> 'orderId')
            then 'its AWB is not in the order list'
          when not exists (select 1 from jsonb_array_elements(v_cartons) c where c ->> 'id' = i ->> 'cartonId')
            then 'its carton does not exist'
          when not operator_private.json_whole(i -> 'qty', 1, 1000000) then 'quantity is not a positive whole number'
          when jsonb_typeof(i -> 'pic') is distinct from 'string' or char_length(i ->> 'pic') not between 1 and 200
            then 'PIC missing'
        end, t.ord, 4
      from jsonb_array_elements(v_issues) with ordinality t(i, ord)
      where operator_private.try_uuid(i ->> 'id') is null
        or not exists (select 1 from jsonb_array_elements(v_orders) o where o ->> 'id' = i ->> 'orderId')
        or not exists (select 1 from jsonb_array_elements(v_cartons) c where c ->> 'id' = i ->> 'cartonId')
        or not operator_private.json_whole(i -> 'qty', 1, 1000000)
        or jsonb_typeof(i -> 'pic') is distinct from 'string' or char_length(i ->> 'pic') not between 1 and 200
      union all
      select 'Sort count ' || coalesce(s ->> 'id', '?') || ': ' || case
          when operator_private.try_uuid(s ->> 'id') is null then 'identifier is not a UUID'
          when operator_private.try_date(s ->> 'date') is null then 'date is not YYYY-MM-DD'
          when operator_private.product_unit(s ->> 'product') is null then 'unknown product'
          when not operator_private.json_whole(s -> 'counted', 0, 1000000) then 'counted quantity is not a whole number'
          else 'PIC missing'
        end, t.ord, 5
      from jsonb_array_elements(v_counts) with ordinality t(s, ord)
      where operator_private.try_uuid(s ->> 'id') is null or operator_private.try_date(s ->> 'date') is null
        or operator_private.product_unit(s ->> 'product') is null
        or not operator_private.json_whole(s -> 'counted', 0, 1000000)
        or jsonb_typeof(s -> 'pic') is distinct from 'string' or char_length(s ->> 'pic') not between 1 and 200
      ) x
    order by x.kind, x.ord
    limit 20) x;
  if v_problems is not null then
    raise exception 'Order records could not be moved: %', array_to_string(v_problems, '; ') using errcode = '23514';
  end if;

  begin
    -- Array order is newest first; created_at keeps that order for the way back.
    insert into public.operator_orders (id, workspace_id, awb, channel, store, order_ref, courier,
      import_id, import_row_id, product, package, expected, original_expected, actual, lines,
      fulfil_date, note, review_state, reviewed_by, printed, assigned_packer, assigned_at, packer,
      label_pic, packed_at, pack_recorded_at, pack_recorded_by, dispatched, dispatched_at,
      handover_ref, version, legacy, created_at, created_by, updated_at, updated_by)
    select (o ->> 'id')::uuid, p_workspace, upper(regexp_replace(o ->> 'awb', '\s', '', 'g')),
      o ->> 'channel', o ->> 'store', o ->> 'orderRef', o ->> 'courier',
      operator_private.try_uuid(o ->> 'importId'), operator_private.try_uuid(o ->> 'importRowId'),
      o ->> 'product', coalesce(o ->> 'package', ''), (o ->> 'expected')::numeric::integer,
      coalesce((o ->> 'originalExpected')::numeric::integer, (o ->> 'expected')::numeric::integer),
      (o ->> 'actual')::numeric::integer,
      case when jsonb_typeof(o -> 'lines') = 'array' then o -> 'lines' end,
      (o ->> 'date')::date, coalesce(o ->> 'note', ''), coalesce(o ->> 'reviewState', 'confirmed'),
      o ->> 'reviewedBy', coalesce((o ->> 'printed')::boolean, false), nullif(o ->> 'assignedPacker', ''),
      operator_private.try_timestamptz(o ->> 'assignedAt'), coalesce(o ->> 'packer', ''),
      coalesce(o ->> 'labelPic', ''), operator_private.try_timestamptz(o ->> 'packedAt'),
      operator_private.try_timestamptz(o ->> 'packRecordedAt'),
      case when jsonb_typeof(o -> 'packRecordedBy') = 'object' then o -> 'packRecordedBy' end,
      coalesce((o ->> 'dispatched')::boolean, false),
      case when coalesce((o ->> 'dispatched')::boolean, false)
        then operator_private.try_timestamptz(o ->> 'dispatchedAt') end,
      coalesce(o ->> 'handoverRef', ''), 1, true, v_now - t.ord * interval '1 microsecond', null, v_now, null
    from jsonb_array_elements(v_orders) with ordinality t(o, ord);
    -- Product and unit come from the carton. A time that cannot be read becomes the epoch,
    -- which the day views treat as "before the day", as they treated the unreadable value.
    insert into public.operator_issues (id, workspace_id, order_id, carton_id, product, unit, qty,
      pic, at, legacy)
    select (i ->> 'id')::uuid, p_workspace, (i ->> 'orderId')::uuid, i ->> 'cartonId', x.c ->> 'product',
      x.c ->> 'unit', (i ->> 'qty')::numeric::integer, i ->> 'pic',
      coalesce(operator_private.try_timestamptz(i ->> 'at'), 'epoch'::timestamptz), true
    from jsonb_array_elements(v_issues) i
    cross join lateral (select c from jsonb_array_elements(v_cartons) c where c ->> 'id' = i ->> 'cartonId' limit 1) x;
    insert into public.operator_carton_issued (workspace_id, carton_id, issued)
    select p_workspace, i.carton_id, sum(i.qty) from public.operator_issues i
    where i.workspace_id = p_workspace group by i.carton_id;
    -- A backfilled count always reads "orders changed, count again" (zero demand hash).
    insert into public.operator_sort_counts (id, workspace_id, fulfil_date, product, expected, counted,
      demand_awbs, demand_hash, pic, note, at, legacy)
    select (s ->> 'id')::uuid, p_workspace, (s ->> 'date')::date, s ->> 'product',
      greatest(coalesce((s ->> 'expected')::numeric::integer, 0), 0), (s ->> 'counted')::numeric::integer,
      0, repeat('0', 64), s ->> 'pic', left(coalesce(s ->> 'note', ''), 2000),
      coalesce(operator_private.try_timestamptz(s ->> 'at'), 'epoch'::timestamptz), true
    from jsonb_array_elements(v_counts) s;
  exception when others then
    raise exception 'Order records could not be moved: %', sqlerrm using errcode = '23514';
  end;
  -- The AWB reuse rule holds between the moved AWBs.
  select array_agg(distinct n.awb order by n.awb) into v_problems
  from public.operator_orders n
  join public.operator_orders o on o.workspace_id = n.workspace_id and o.awb = n.awb and o.id <> n.id
  where n.workspace_id = p_workspace and operator_private.awb_reuse_allowed(o, n) is not true;
  if v_problems is not null then
    raise exception 'Order records could not be moved: AWB recorded again within 30 days of its handover: %',
      array_to_string(v_problems[1:20], ', ') using errcode = '23514';
  end if;
  if (select count(*) from public.operator_orders o where o.workspace_id = p_workspace) <> jsonb_array_length(v_orders)
    or (select count(*) from public.operator_issues i where i.workspace_id = p_workspace) <> jsonb_array_length(v_issues)
    or (select count(*) from public.operator_sort_counts s where s.workspace_id = p_workspace) <> jsonb_array_length(v_counts)
    or operator_private.table_balances(p_workspace) is distinct from v_before then
    raise exception 'Order records could not be moved: counts or carton balances differ.' using errcode = '23514';
  end if;
  update public.operator_workspaces w
  set state = w.state - 'orders' - 'issues' - 'sortCounts', revision = w.revision + 1,
    updated_at = now(), order_store = 'tables'
  where w.id = p_workspace;
  return jsonb_build_object('moved', true, 'orders', jsonb_array_length(v_orders),
    'issues', jsonb_array_length(v_issues), 'sortCounts', jsonb_array_length(v_counts),
    'cartons', (select count(*) from public.operator_carton_issued t where t.workspace_id = p_workspace));
end
$$;

create function operator_private.move_orders_to_document(p_workspace uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_site public.operator_workspaces%rowtype;
  v_orders jsonb;
  v_issues jsonb;
  v_counts jsonb;
  v_state jsonb;
  v_before jsonb;
begin
  select * into v_site from public.operator_workspaces w where w.id = p_workspace for update;
  if not found then
    raise exception 'Site not found.' using errcode = '22023';
  end if;
  if v_site.order_store = 'document' then
    return jsonb_build_object('moved', false, 'orderStore', 'document');
  end if;
  if (select count(*) from public.operator_orders o where o.workspace_id = p_workspace) > 1000
    or (select count(*) from public.operator_issues i where i.workspace_id = p_workspace) > 2000 then
    raise exception 'This site holds more than 1000 AWBs or 2000 stock issues, more than its workspace document can take. Export or trim them first.'
      using errcode = '23514';
  end if;
  -- Archived issue rows (WP D) would be lost from the balances: refuse.
  if exists (select 1 from public.operator_carton_issued t where t.workspace_id = p_workspace
      and t.issued <> coalesce((select sum(i.qty) from public.operator_issues i
        where i.workspace_id = p_workspace and i.carton_id = t.carton_id), 0))
    or exists (select 1 from public.operator_issues i where i.workspace_id = p_workspace
      and not exists (select 1 from public.operator_carton_issued t
        where t.workspace_id = p_workspace and t.carton_id = i.carton_id)) then
    raise exception 'Issued totals and issue rows differ at this site. Restore archived issues first.' using errcode = '23514';
  end if;
  v_before := operator_private.table_balances(p_workspace);
  -- Today's shapes, newest first; row-only columns are dropped.
  select coalesce(jsonb_agg(operator_private.order_json(o) order by o.created_at desc, o.id desc), '[]'::jsonb)
  into v_orders from public.operator_orders o where o.workspace_id = p_workspace;
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'cartonId', i.carton_id, 'orderId', i.order_id,
      'qty', i.qty, 'pic', i.pic, 'at', operator_private.iso(i.at)) order by i.at desc, i.id desc), '[]'::jsonb)
  into v_issues from public.operator_issues i where i.workspace_id = p_workspace;
  -- A count made against the current demand keeps a matching document fingerprint.
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'date', to_char(s.fulfil_date, 'YYYY-MM-DD'),
      'product', s.product, 'expected', s.expected, 'counted', s.counted,
      'fingerprint', case when operator_private.sort_count_current(p_workspace, s.fulfil_date, s.product)
        and s.id = (select c.id from public.operator_sort_counts c where c.workspace_id = p_workspace
          and c.fulfil_date = s.fulfil_date and c.product = s.product order by c.legacy, c.at desc, c.id desc limit 1)
        then operator_private.document_fingerprint(p_workspace, s.fulfil_date, s.product) else '' end,
      'pic', s.pic, 'note', s.note, 'at', operator_private.iso(s.at)) order by s.legacy, s.at desc, s.id desc), '[]'::jsonb)
  into v_counts from public.operator_sort_counts s where s.workspace_id = p_workspace;
  v_state := (v_site.state - 'orders' - 'issues' - 'sortCounts')
    || jsonb_build_object('orders', v_orders, 'issues', v_issues, 'sortCounts', v_counts);
  if octet_length(v_state::text) > 1800000 then
    raise exception 'The rebuilt workspace document would exceed 1.8 MB. Export or trim the AWBs first.' using errcode = '23514';
  end if;
  if operator_private.document_balances(v_state) is distinct from v_before then
    raise exception 'Carton balances would change. Nothing was moved.' using errcode = '23514';
  end if;
  perform set_config('operator.archiving', 'on', true);
  delete from public.operator_issues i where i.workspace_id = p_workspace;
  delete from public.operator_sort_counts s where s.workspace_id = p_workspace;
  perform set_config('operator.archiving', 'off', true);
  delete from public.operator_carton_issued t where t.workspace_id = p_workspace;
  delete from public.operator_order_departures d where d.workspace_id = p_workspace;
  delete from public.operator_orders o where o.workspace_id = p_workspace;
  update public.operator_workspaces w
  set state = v_state, revision = w.revision + 1, updated_at = now(), order_store = 'document'
  where w.id = p_workspace;
  return jsonb_build_object('moved', true, 'orders', jsonb_array_length(v_orders),
    'issues', jsonb_array_length(v_issues), 'sortCounts', jsonb_array_length(v_counts));
end
$$;
revoke all on function operator_private.legacy_order_problem(jsonb, uuid),
  operator_private.move_orders_to_tables(uuid), operator_private.move_orders_to_document(uuid)
  from public;

-- ---------------------------------------------------------------------------------------
-- Reading (design section 5; wired to /api/orders/* in C3). Security invoker, so the select
-- policies decide what the member sees; the explicit checks only turn "no access" into an
-- error. Each returns one jsonb value, so the Data API row limit never truncates a day.
-- ---------------------------------------------------------------------------------------
create function operator_private.order_status_match(o public.operator_orders, p_status text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_status
    when 'review' then o.review_state = 'pending'
    when 'unassigned' then o.review_state = 'confirmed' and o.assigned_packer is null and o.actual is null and not o.dispatched
    when 'unpacked' then o.review_state = 'confirmed' and o.actual is null and not o.dispatched
    when 'handover' then o.actual is not null and not o.dispatched
    when 'dispatched' then o.dispatched
    when 'mismatch' then o.actual is not null and (case when o.lines is null then o.actual <> o.expected
      else exists (select 1 from jsonb_array_elements(o.lines) l
        where l ->> 'actual' is not null and (l ->> 'actual')::numeric <> (l ->> 'expected')::numeric) end)
    else true end
$$;
-- Units issued to one AWB, per product.
create function operator_private.order_issued(p_workspace uuid, p_order uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(x.product, x.qty), '{}'::jsonb) from (
    select i.product, sum(i.qty) as qty from public.operator_issues i
    where i.workspace_id = p_workspace and i.order_id = p_order group by i.product) x
$$;
create function operator_private.assert_order_reader(p_workspace uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if (p_workspace = any (operator_private.order_reader_workspaces())) is not true then
    raise exception 'Your role at this site cannot open AWBs.' using errcode = '42501';
  end if;
end
$$;
revoke all on function operator_private.order_status_match(public.operator_orders, text),
  operator_private.order_issued(uuid, uuid), operator_private.assert_order_reader(uuid) from public;
grant execute on function operator_private.order_status_match(public.operator_orders, text),
  operator_private.order_issued(uuid, uuid), operator_private.assert_order_reader(uuid) to authenticated;

-- One page of a day's AWBs (keyset by AWB, at most 200), filtered like the order screen.
-- p_group: {"product", "package", "perParcel"} of packageGroups().
create function public.operator_orders_page(p_workspace uuid, p_date date, p_product text default null,
  p_package text default null, p_q text default null, p_status text default null,
  p_group jsonb default null, p_after text default null, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_result jsonb;
begin
  perform operator_private.assert_order_reader(p_workspace);
  if p_date is null or (p_status is not null
    and p_status not in ('review', 'unassigned', 'unpacked', 'handover', 'dispatched', 'mismatch')) then
    raise exception 'Invalid filter.' using errcode = '22023';
  end if;
  with f as (
    select o from public.operator_orders o
    where o.workspace_id = p_workspace and o.fulfil_date = p_date
      and (p_product is null or p_product = any (o.products))
      and (p_package is null or o.package = p_package)
      and (coalesce(p_q, '') = '' or strpos(lower(o.awb || ' ' || coalesce(o.order_ref, '') || ' ' || o.channel),
        lower(btrim(p_q))) > 0)
      and operator_private.order_status_match(o, p_status)
      and (p_group is null or (o.review_state = 'confirmed' and cardinality(o.products) = 1
        and o.products[1] = p_group ->> 'product' and o.package = p_group ->> 'package'
        and o.expected::text = p_group ->> 'perParcel'))),
  page as (
    select f.o, row_number() over (order by (f.o).awb) as rn from f
    where p_after is null or (f.o).awb > p_after
    order by (f.o).awb limit v_limit + 1)
  select jsonb_build_object(
    'orders', coalesce((select jsonb_agg(operator_private.order_json(p.o) || jsonb_build_object(
        'version', (p.o).version, 'issued', operator_private.order_issued(p_workspace, (p.o).id)) order by p.rn)
      from page p where p.rn <= v_limit), '[]'::jsonb),
    'next', (select (p.o).awb from page p where p.rn = v_limit and exists (select 1 from page q where q.rn > v_limit)),
    'total', (select count(*) from f),
    'marker', operator_private.day_marker(p_workspace, p_date))
  into v_result;
  return v_result;
end
$$;

-- Everything the day views aggregate (package groups, tally, packer tally, inventory) in slim
-- form: the server computes the aggregates and the client receives only those.
create function public.operator_orders_day(p_workspace uuid, p_date date)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_start timestamptz := p_date::timestamp at time zone 'Asia/Kuala_Lumpur';
  v_result jsonb;
begin
  perform operator_private.assert_order_reader(p_workspace);
  select jsonb_build_object(
    'date', to_char(p_date, 'YYYY-MM-DD'),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'awb', o.awb, 'date', to_char(o.fulfil_date, 'YYYY-MM-DD'),
        'product', o.product, 'package', o.package, 'lines', o.lines, 'expected', o.expected, 'actual', o.actual,
        'reviewState', o.review_state, 'assignedPacker', o.assigned_packer, 'packer', o.packer,
        'packedAt', operator_private.iso(o.packed_at), 'recordedRole', o.pack_recorded_by ->> 'role',
        'printed', o.printed, 'dispatched', o.dispatched, 'version', o.version) order by o.awb)
      from public.operator_orders o where o.workspace_id = p_workspace and o.fulfil_date = p_date), '[]'::jsonb),
    'issues', coalesce((select jsonb_agg(jsonb_build_object('orderId', i.order_id, 'cartonId', i.carton_id,
        'product', i.product, 'qty', i.qty, 'at', operator_private.iso(i.at)) order by i.at, i.id)
      from public.operator_issues i where i.workspace_id = p_workspace and i.order_id in (
        select o.id from public.operator_orders o where o.workspace_id = p_workspace and o.fulfil_date = p_date)), '[]'::jsonb),
    'sortCounts', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'date', to_char(c.fulfil_date, 'YYYY-MM-DD'),
        'product', c.product, 'expected', c.expected, 'counted', c.counted, 'demandAwbs', c.demand_awbs,
        'demandHash', c.demand_hash, 'pic', c.pic, 'note', c.note, 'at', operator_private.iso(c.at),
        'legacy', c.legacy) order by c.legacy, c.at desc, c.id desc)
      from public.operator_sort_counts c where c.workspace_id = p_workspace and c.fulfil_date = p_date), '[]'::jsonb),
    'demand', coalesce((select jsonb_object_agg(p.product, jsonb_build_object('awbs', d.awbs, 'expected', d.expected,
        'hash', d.hash, 'current', operator_private.sort_count_current(p_workspace, p_date, p.product)))
      from unnest(array['cav', 'gly', 'lip', 'syn', 'ady']) p(product)
      cross join lateral operator_private.day_demand(p_workspace, p_date, p.product) d where d.awbs > 0), '{}'::jsonb),
    -- Issued per carton before the Malaysia day (from the running total, so archived rows
    -- still count) and within it, for dailyInventory.
    'cartonIssued', jsonb_build_object(
      'before', coalesce((select jsonb_object_agg(t.carton_id, t.issued - coalesce((select sum(i.qty)
          from public.operator_issues i where i.workspace_id = p_workspace and i.carton_id = t.carton_id
            and i.at >= v_start), 0))
        from public.operator_carton_issued t where t.workspace_id = p_workspace), '{}'::jsonb),
      'within', coalesce((select jsonb_object_agg(x.carton_id, x.qty) from (
          select i.carton_id, sum(i.qty) as qty from public.operator_issues i
          where i.workspace_id = p_workspace and i.at >= v_start and i.at < v_start + interval '1 day'
          group by i.carton_id) x), '{}'::jsonb)),
    'marker', operator_private.day_marker(p_workspace, p_date))
  into v_result;
  return v_result;
end
$$;

-- Overview figures: for the chosen day by default; p_all counts across the whole hot table
-- (owner decision 2026-10-12: an all-time option for traceability; WP D adds the archive
-- here).
create function public.operator_orders_summary(p_workspace uuid, p_date date, p_all boolean default false)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform operator_private.assert_order_reader(p_workspace);
  select jsonb_build_object(
    'scope', case when p_all then 'all' else 'day' end,
    'date', to_char(p_date, 'YYYY-MM-DD'),
    'awbs', count(*),
    'review', count(*) filter (where operator_private.order_status_match(o, 'review')),
    'unassigned', count(*) filter (where operator_private.order_status_match(o, 'unassigned')),
    'unpacked', count(*) filter (where operator_private.order_status_match(o, 'unpacked')),
    'handover', count(*) filter (where operator_private.order_status_match(o, 'handover')),
    'dispatched', count(*) filter (where o.dispatched),
    'mismatch', count(*) filter (where operator_private.order_status_match(o, 'mismatch')),
    'openEarlier', (select count(*) from public.operator_orders e
      where e.workspace_id = p_workspace and e.fulfil_date < p_date and not e.dispatched),
    'marker', case when p_all then null else operator_private.day_marker(p_workspace, p_date) end)
  into v_result
  from public.operator_orders o
  where o.workspace_id = p_workspace and (p_all or o.fulfil_date = p_date);
  return v_result;
end
$$;

-- Trace: an AWB (exact, every occurrence newest first since couriers reuse numbers), an AWB
-- prefix of at least 6 characters, an order reference, an AWB id, or a batch (its cartons
-- from the document, then the AWBs that received stock from them). Members without AWB
-- access (owner decision 2026-10-12) may trace a batch: they get its cartons and issued
-- totals without parcel details. At most 100 AWBs per page, keyset by (day desc, AWB).
create function public.operator_orders_trace(p_workspace uuid, p_q text default null,
  p_order uuid default null, p_batch text default null, p_after_date date default null,
  p_after_awb text default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_reader boolean := p_workspace = any (operator_private.order_reader_workspaces());
  v_q text := upper(regexp_replace(coalesce(p_q, ''), '\s', '', 'g'));
  v_cartons jsonb := '[]';
  v_ids uuid[];
  v_result jsonb;
begin
  if public.operator_active_role(p_workspace) is null then
    raise exception 'No active membership for this site.' using errcode = '42501';
  end if;
  if num_nonnulls(nullif(p_q, ''), p_order, nullif(p_batch, '')) <> 1 then
    raise exception 'Give one AWB, order reference, AWB id or batch.' using errcode = '22023';
  end if;
  if p_batch is not null then
    select coalesce(jsonb_agg(jsonb_build_object('id', c ->> 'id', 'ref', c ->> 'ref', 'product', c ->> 'product',
        'unit', c ->> 'unit', 'qty', c -> 'qty', 'rack', c ->> 'rack',
        'issued', coalesce((select t.issued from public.operator_carton_issued t
          where t.workspace_id = p_workspace and t.carton_id = c ->> 'id'), 0))), '[]'::jsonb)
    into v_cartons
    from public.operator_workspaces w, jsonb_array_elements(coalesce(w.state -> 'cartons', '[]')) c
    where w.id = p_workspace and c ->> 'batchId' = p_batch;
    if not v_reader then
      return jsonb_build_object('cartons', v_cartons, 'parcels', false, 'orders', '[]'::jsonb,
        'issues', '[]'::jsonb, 'events', '[]'::jsonb, 'next', null);
    end if;
  elsif not v_reader then
    raise exception 'Your role at this site cannot open AWBs.' using errcode = '42501';
  end if;
  select array_agg(x.id order by x.fulfil_date desc, x.awb) into v_ids from (
    select o.id, o.fulfil_date, o.awb from public.operator_orders o
    where o.workspace_id = p_workspace
      and (case
        when p_order is not null then o.id = p_order
        when p_batch is not null then o.id in (select i.order_id from public.operator_issues i
          where i.workspace_id = p_workspace and i.carton_id in (select c ->> 'id' from jsonb_array_elements(v_cartons) c))
        else o.awb = v_q or (char_length(v_q) >= 6 and o.awb like v_q || '%')
          or o.order_ref = btrim(p_q) end)
      and (p_after_date is null or (o.fulfil_date, o.awb) < (p_after_date, p_after_awb collate "C"))
    order by o.fulfil_date desc, o.awb
    limit 101) x;
  select jsonb_build_object(
    'cartons', v_cartons,
    'parcels', true,
    'orders', coalesce((select jsonb_agg(operator_private.order_json(o) || jsonb_build_object('version', o.version,
        'issued', operator_private.order_issued(p_workspace, o.id)) order by o.fulfil_date desc, o.awb)
      from public.operator_orders o where o.workspace_id = p_workspace and o.id = any (v_ids[1:100])), '[]'::jsonb),
    'issues', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'orderId', i.order_id, 'cartonId', i.carton_id,
        'product', i.product, 'unit', i.unit, 'qty', i.qty, 'pic', i.pic, 'at', operator_private.iso(i.at)) order by i.at, i.id)
      from public.operator_issues i where i.workspace_id = p_workspace and i.order_id = any (v_ids[1:100])), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'entity', e.entity, 'action', e.action,
        'detail', e.detail, 'actor', e.actor, 'at', operator_private.iso(e.at),
        'occurredAt', operator_private.iso(e.occurred_at), 'performer', e.performer, 'recorder', e.recorder,
        'seq', e.seq) order by e.seq desc)
      from public.operator_events e where e.workspace_id = p_workspace
        and e.entity in (select u::text from unnest(v_ids[1:100]) u)), '[]'::jsonb),
    'next', case when cardinality(v_ids) > 100 then (select jsonb_build_object('date', to_char(o.fulfil_date, 'YYYY-MM-DD'), 'awb', o.awb)
      from public.operator_orders o where o.id = v_ids[100]) end)
  into v_result;
  return v_result;
end
$$;

-- CSV export source: at most 31 days, keyset pages of 1,000 AWBs on (day, AWB).
create function public.operator_orders_export(p_workspace uuid, p_from date, p_to date,
  p_after_date date default null, p_after_awb text default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform operator_private.assert_order_reader(p_workspace);
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 30 then
    raise exception 'Export at most 31 days at a time.' using errcode = '22023';
  end if;
  with page as (
    select o, row_number() over (order by o.fulfil_date, o.awb) as rn
    from public.operator_orders o
    where o.workspace_id = p_workspace and o.fulfil_date between p_from and p_to
      and (p_after_date is null or (o.fulfil_date, o.awb) > (p_after_date, p_after_awb collate "C"))
    order by o.fulfil_date, o.awb limit 1001)
  select jsonb_build_object(
    'orders', coalesce((select jsonb_agg(operator_private.order_json(p.o) || jsonb_build_object(
        'issued', operator_private.order_issued(p_workspace, (p.o).id)) order by p.rn)
      from page p where p.rn <= 1000), '[]'::jsonb),
    'next', (select jsonb_build_object('date', to_char((p.o).fulfil_date, 'YYYY-MM-DD'), 'awb', (p.o).awb)
      from page p where p.rn = 1000 and exists (select 1 from page q where q.rn > 1000)))
  into v_result;
  return v_result;
end
$$;

-- The packer's own AWBs for the day (the second select policy: the sealed session in the
-- x-operator-packer header).
create function public.operator_packer_page(p_workspace uuid, p_date date)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_profile text := (select s.profile_id from operator_private.packer_session() s where s.workspace_id = p_workspace);
begin
  if v_profile is null then
    raise exception 'Your packer session ended. Enter your PIN again.' using errcode = '42501';
  end if;
  return jsonb_build_object('profileId', v_profile,
    'orders', coalesce((select jsonb_agg(operator_private.order_json(o) || jsonb_build_object('version', o.version) order by o.awb)
      from public.operator_orders o where o.workspace_id = p_workspace and o.fulfil_date = p_date
        and o.assigned_packer = v_profile), '[]'::jsonb),
    'marker', operator_private.day_marker(p_workspace, p_date));
end
$$;

-- Unlock screen: unpacked AWBs assigned per packer profile for the day; counts, no AWBs.
create function public.operator_packer_counts(p_workspace uuid, p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (public.operator_has_capability(p_workspace, 'packing.record')
    or public.operator_has_capability(p_workspace, 'outbound.fulfil')) is not true then
    raise exception 'Your role at this site cannot open the packing station.' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('profileId', x.assigned_packer, 'open', x.n) order by x.assigned_packer)
    from (select o.assigned_packer, count(*) as n from public.operator_orders o
      where o.workspace_id = p_workspace and o.fulfil_date = p_date and o.assigned_packer is not null
        and o.actual is null and not o.dispatched
      group by o.assigned_packer) x), '[]'::jsonb);
end
$$;
revoke all on function
  public.operator_orders_page(uuid, date, text, text, text, text, jsonb, text, integer),
  public.operator_orders_day(uuid, date), public.operator_orders_summary(uuid, date, boolean),
  public.operator_orders_trace(uuid, text, uuid, text, date, text),
  public.operator_orders_export(uuid, date, date, date, text),
  public.operator_packer_page(uuid, date), public.operator_packer_counts(uuid, date)
  from public, anon;
grant execute on function
  public.operator_orders_page(uuid, date, text, text, text, text, jsonb, text, integer),
  public.operator_orders_day(uuid, date), public.operator_orders_summary(uuid, date, boolean),
  public.operator_orders_trace(uuid, text, uuid, text, date, text),
  public.operator_orders_export(uuid, date, date, date, text),
  public.operator_packer_page(uuid, date), public.operator_packer_counts(uuid, date)
  to authenticated;
