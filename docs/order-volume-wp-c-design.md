# Order volume WP C: orders and stock issues as table rows (detailed design)

Status: design, 2026-10-12. Implements work package C of
[order-volume-plan-2026-10.md](order-volume-plan-2026-10.md) (readiness
[#10](https://github.com/nadeemramli/operator-effen/issues/10)). Assumes WP A
(`20261012090000_operator_imports.sql`, uploads in tables) and WP B (audit entries in
`operator_events`, appended by the commit RPCs) have merged and been applied. Every
identifier and example below is synthetic.

Decisions already taken that this design follows: per-AWB records move and inventory stays
in the document; 90-day hot retention (WP D); the synthetic operational site replaces the
preview sandbox for order flows.

## 1. Scope and non-goals

| Record | Decision | Why |
|---|---|---|
| Orders (`Order`, including `lines`) | Move to `operator_orders` | The per-AWB stream; 2,000/day. |
| Stock issues (`Issue`) | Move to `operator_issues`, plus a per-carton running total `operator_carton_issued` | One or more per AWB. The total keeps carton balances O(1) and lets WP D archive issue rows without changing balances. |
| Supervisor sort counts (`SortCount`) | **Move** to `operator_sort_counts` | Small (about 5 a day), but the command reads order demand, and the assign and issue gates must check "current count" against the order rows in the same transaction. Kept in the document, every sort count would need a document commit that reads the tables, and the gate could not be enforced by the database. |
| Audit entries | Already in `operator_events` (WP B) | WP C's RPC appends through WP B's appender. |
| Uploads | Already in `operator_imports` / `operator_import_rows` (WP A) | WP C takes over the order side of release, delete and remove. |
| Cartons, counts, adjustments, returns, boxing, batches, machines, staff profiles, trips, notes, closed days | **Stay in the document** | Plan decision 1. |

Non-goals: realtime (#11; only a hook is left, section 5), offline outbox (#12), retention
and archive tables (WP D; section 7 says how the schema allows them), normalizing inventory,
changing roles or capabilities, changing any order rule's meaning (two latent bugs are fixed,
listed in section 4).

Refinement of the plan's WP split: the order and issue **backfill and the retirement of the
order command rules** are done here (PR C4), because the switch to tables cannot happen
without them. WP D keeps retention, archive tables, and payload and latency evidence.

## 2. Data model

Migration `supabase/migrations/20261014090000_operator_order_records.sql` (timestamp must
sort after WP B's), rollback `supabase/rollback/20261014090000_operator_order_records.down.sql`.

### 2.1 Per-site switch

```sql
alter table public.operator_workspaces
  add column order_store text not null default 'document'
    constraint operator_workspaces_order_store check (order_store in ('document', 'tables'));
```

The migration is additive: every site stays `document` and the deployed code is unchanged.
The owner moves a site with `operator_private.move_orders_to_tables(site)` (section 7). The
API branches on `order_store`. Migrations are applied before their PR merges, so without the
switch the old code would write orders to the document while the tables already exist.

### 2.2 Tables

`lines` stays a **jsonb column** and does not become a child table. Lines are always read and
written with their order, there are 1 to 5 per AWB, there are no per-line foreign keys
(issues reference the order and get the product from the carton), and the row version covers
the whole order. A 1:1 order-to-row mapping also lets the TypeScript `Order` and its rules run
unchanged. The per-product tally reads `lateral jsonb_array_elements(lines)` over at most
about 2,000 rows a day. Product filtering uses the generated `products` array.

```sql
-- Helpers (immutable, mirrored by tests/order-records.test.mjs against draft.ts `products`)
create function operator_private.product_unit(p text) returns text language sql immutable
set search_path = '' as $$ select case when p = 'ady' then 'box'
  when p in ('cav','gly','lip','syn') then 'bottle' end $$;
create function operator_private.order_products(p_product text, p_lines jsonb) returns text[]
language sql immutable set search_path = '' as $$
  select case when p_lines is null then array[p_product] else array(
    select distinct l ->> 'product' from jsonb_array_elements(p_lines) l order by 1) end $$;
-- lines: null, or 1..10 objects {product, expected, originalExpected, actual} with no other
-- keys; product valid; expected/originalExpected whole 1..1e6; actual null or whole 0..1e6;
-- and the aggregates agree: product = lines[0].product, expected = Σ expected,
-- actual = Σ actual when no line is null, else null.
create function operator_private.order_lines_valid(p_lines jsonb, p_product text,
  p_expected integer, p_actual integer) returns boolean language sql immutable ...;

create table public.operator_orders (
  id uuid primary key,
  workspace_id uuid not null references public.operator_workspaces(id) on delete restrict,
  awb text collate "C" not null
    check (char_length(awb) between 1 and 60 and awb = upper(regexp_replace(awb, '\s', '', 'g'))),
  channel text not null check (channel in ('Luxana', 'Shopee', 'TikTok', 'Lazada')),
  store text check (char_length(store) <= 200),
  order_ref text check (char_length(order_ref) <= 200),
  courier text check (char_length(courier) <= 100),
  import_id uuid references public.operator_imports(id) on delete restrict,
  import_row_id uuid,                       -- operator_import_rows.id; no FK (WP A keeps released_order_id as text)
  product text not null check (operator_private.product_unit(product) is not null),
  package text not null default '' check (char_length(package) <= 2000),
  expected integer not null check (expected between 1 and 1000000),
  original_expected integer not null check (original_expected between 1 and 1000000),
  actual integer check (actual between 0 and 1000000),
  lines jsonb,
  products text[] generated always as (operator_private.order_products(product, lines)) stored,
  fulfil_date date not null,                -- Order.date (Malaysia fulfilment day)
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
  handover_ref text not null default '' check (char_length(handover_ref) <= 200),
  version integer not null default 1 check (version >= 1),
  legacy boolean not null default false,    -- backfilled from a document
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint operator_orders_awb unique (workspace_id, awb),
  constraint operator_orders_ws_id unique (workspace_id, id),
  constraint operator_orders_lines
    check (operator_private.order_lines_valid(lines, product, expected, actual)),
  -- orderReady(): nothing downstream happens to a pending AWB
  constraint operator_orders_pending check (review_state = 'confirmed'
    or (not printed and assigned_packer is null and actual is null and not dispatched)),
  -- dispatch needs a packed count and a manifest reference
  constraint operator_orders_handover check (not dispatched or (actual is not null and handover_ref <> '')),
  constraint operator_orders_attribution check (legacy or created_by is not null)
);
create index operator_orders_day on public.operator_orders (workspace_id, fulfil_date, awb) include (version);
create index operator_orders_packer on public.operator_orders (workspace_id, fulfil_date, assigned_packer)
  where assigned_packer is not null;
create index operator_orders_open on public.operator_orders (workspace_id, fulfil_date) where not dispatched;
create index operator_orders_import on public.operator_orders (workspace_id, import_id) where import_id is not null;
create index operator_orders_ref on public.operator_orders (workspace_id, order_ref) where order_ref is not null;

create table public.operator_issues (
  id uuid primary key,
  workspace_id uuid not null,
  order_id uuid not null,
  carton_id text not null check (char_length(carton_id) between 1 and 100),  -- document carton
  product text not null check (operator_private.product_unit(product) is not null),
  unit text not null check (unit in ('bottle', 'sachet', 'box')),
  qty integer not null check (qty between 1 and 1000000),
  pic text not null check (char_length(pic) between 1 and 200),
  at timestamptz not null default now(),
  recorded_by uuid,
  recorder jsonb,
  operation_id uuid,
  legacy boolean not null default false,
  constraint operator_issues_order foreign key (workspace_id, order_id)
    references public.operator_orders (workspace_id, id) on delete restrict,
  constraint operator_issues_attribution check (legacy or (recorded_by is not null and operation_id is not null))
);
create index operator_issues_order on public.operator_issues (workspace_id, order_id);
create index operator_issues_carton on public.operator_issues (workspace_id, carton_id, at);
create index operator_issues_time on public.operator_issues (workspace_id, at) include (carton_id, qty);
-- Insert-only, also against bugs in security-definer code: UPDATE always raises 23514;
-- DELETE raises unless the WP D archive mover set `operator.archiving = on` locally.
create trigger operator_issues_append_only before update or delete on public.operator_issues
  for each row execute function operator_private.issues_append_only();

-- Running total per carton. Written only by operator_commit_records under the carton lock.
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
  expected integer not null check (expected >= 0),          -- demand at count time (DB-computed)
  counted integer not null check (counted between 0 and 1000000),
  demand_awbs integer not null check (demand_awbs >= 0),
  demand_hash text not null check (demand_hash ~ '^[0-9a-f]{64}$'),
  pic text not null check (char_length(pic) between 1 and 200),
  note text not null default '' check (char_length(note) <= 2000),
  at timestamptz not null default now(),
  recorded_by uuid, recorder jsonb, operation_id uuid,
  legacy boolean not null default false,
  check (legacy or recorded_by is not null)
);
create index operator_sort_counts_day on public.operator_sort_counts (workspace_id, fulfil_date, product, at desc);
-- same append-only trigger as issues

-- An AWB left a day (removed, moved, later archived): makes day markers change on deletes
-- and moves, and is the delete feed #11 needs for reconnect reconciliation.
create table public.operator_order_departures (
  workspace_id uuid not null references public.operator_workspaces(id) on delete restrict,
  order_id uuid not null,
  fulfil_date date not null,
  reason text not null check (reason in ('removed', 'moved', 'archived')),
  at timestamptz not null default now(),
  operation_id uuid
);
create index operator_order_departures_day on public.operator_order_departures (workspace_id, fulfil_date);

-- Command → capability and row scope for the records path (mirrors commandRules[*].records).
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
```

`operator_commits` gains a stored result, so response-loss retries return the original
outcome:

```sql
alter table public.operator_commits
  alter column result_revision drop not null,
  add column result jsonb,
  add constraint operator_commits_result check (result_revision is not null or result is not null);
```

Demand used by the sort-count gate is computed in one place, the database:

```sql
-- Reviewed AWBs of the day containing the product; per AWB the product's expected units.
-- hash = sha256 hex of string_agg(id::text || ':' || qty, ',' order by id) (uuid byte order,
-- no collation dependence).
create function operator_private.day_demand(p_workspace uuid, p_date date, p_product text)
returns table (awbs integer, expected bigint, hash text) language sql stable ...;
create function operator_private.sort_count_current(p_workspace uuid, p_date date, p_product text)
returns boolean ... -- latest count for (day, product) exists and its demand_hash = day_demand().hash
```

### 2.3 Row-level security

No client gets INSERT, UPDATE or DELETE on any of these tables: `revoke all ... from anon,
authenticated; grant select ... to authenticated`. Writes go only through
`operator_commit_records`, and the backfill or rollback functions run by the owner.

| Table | Read policy |
|---|---|
| `operator_orders`, `operator_issues`, `operator_sort_counts`, `operator_order_departures` | `workspace_id = any ((select operator_private.order_reader_workspaces()))`: sites where the caller holds any of `orders.enter`, `orders.import`, `outbound.fulfil`, `outbound.correct`, `sources.read`, `review.comment`, `stock.receive`, `production.plan`. Packers, drivers and HR are excluded (open question 1). |
| `operator_orders`, packers | Second policy: `(workspace_id, assigned_packer) = (select s.workspace_id, s.profile_id from operator_private.packer_session() s)`. The packer sees only the AWBs assigned to the profile their PIN unlocked. |
| `operator_carton_issued` | `operator_active_role(workspace_id) is not null`: carton balances are inventory, which every member already reads in the document. |
| `operator_record_rules` | Reference data, `using (true)`. |

Both helpers are `stable security definer` and take no row argument, so in the policy they
run once per query (initplan) and leave `workspace_id = any($1)` usable by the
`(workspace_id, …)` indexes.

`operator_private.packer_session()` checks the packer session itself, so a shared packer
sign-in cannot list other packers' AWBs even with its own JWT. It reads the sealed value that
`apps/web/src/lib/packer-session.ts` already issues (`v1.<ws>.<user>.<profile>.<expMs>.<mac>`)
from `current_setting('request.headers', true)::json ->> 'x-operator-packer'`. The API server
sends this header on packer reads, copied from the HttpOnly cookie that browser JavaScript
cannot read. The helper accepts the seal only when all of these hold:

- `mac = hmac(body, hmac('operator-packer-session-v1', server_keys.commit))`, the same derived
  key as the TypeScript.
- `user = auth.uid()`.
- `now() < exp <= now() + 10 min`.
- `operator_has_capability(ws, 'packing.record')`.
- `operator_private.packer_profile_exists(ws, profile)`.

If any check fails, it returns no row.

## 3. Commands

### 3.1 One write RPC; per-family rules

The plan says "one RPC per order command family". This design uses one SQL entry point plus
a rules table, and keeps the family as the unit of rules and tests. Every family shares the
same steps: authenticate, idempotency gate, signature check, scope check, row versions,
events. Thirteen near-identical security-definer functions would give thirteen copies of
that security-critical code. The family-specific part is a data row in
`operator_record_rules` (scope) plus one `operator_private.assert_<family>` function
(invariants). The same pattern already works for `operator_command_rules`.

```sql
public.operator_commit_records(
  p_workspace     uuid,
  p_command       text,
  p_operation     uuid,
  p_fingerprint   text,      -- fingerprint(type, input) as today
  p_changes       text,      -- exact JSON text, signed (below)
  p_attestation   text,      -- HMAC-SHA256 hex
  p_packer_session text default null  -- pack-own only: the sealed packer session
) returns jsonb              -- {"replayed": bool, "result": {...}}
language plpgsql volatile security definer set search_path = ''
```

`p_changes` (at most 8 MB; server-built, never client-built):

```jsonc
{
  "orders": {
    "insert": [ { /* full row, snake_case columns, version omitted */ } ],
    "update": [ { "id": "…", "version": 3, "set": { "assigned_packer": "…" } } ],
    "delete": [ { "id": "…", "version": 2 } ]
  },
  "issues":     [ { "id": "…", "order_id": "…", "carton_id": "…", "qty": 4, "pic": "…" } ],
  "sortCounts": [ { "id": "…", "fulfil_date": "2026-10-20", "product": "cav", "counted": 98, "pic": "…", "note": "…" } ],
  "importEffects": { "rows": [ { "id": "…", "excluded": true, "reviewNote": "Removed: …" } ] },
  "events":     [ /* WP B's event shape; recorder.userId = caller */ ]
}
```

The database stamps the server-time columns (`created_at`, `updated_at`, `assigned_at`,
`pack_recorded_at`, issue and sort-count `at`, and `packed_at` for `pack-own`), plus `version`,
`created_by`, `updated_by` and `recorded_by`. It ignores any values the delta sends for them.

### 3.2 RPC steps (in this order)

1. `auth.uid()` null → `28000`. `operator_active_role(ws)` null → `42501`.
2. Read the site row `for key share`. If `order_store <> 'tables'` → `PT428`. (`move_orders_*`
   takes `for update`, so a move cannot interleave with a records commit.)
3. **Idempotency gate:**
   `insert into operator_commits (…, result_revision, result) values (…, null, null) on conflict do nothing returning 1`.
   If no row comes back, the operation already exists. A concurrent first attempt with the same
   ID makes this insert wait on the primary key until that attempt commits or aborts. Read the
   prior row:
   - user, command or fingerprint differ → `PT409`;
   - else return `{"replayed": true, "result": prior.result}`.

   A failed attempt raises and rolls back its own commits row, so only successful operations
   are recorded, as today.
4. Look up the rule (missing → `42501`). `operator_has_capability(ws, rule.capability)` → `42501`.
5. Verify the signature (3.6) → `42501`. Parse `p_changes` → `22023`.
6. **Scope:** only parts the rule allows; update `set` keys ⊆ `rule.order_columns`; inserts and
   deletes only if allowed → `42501` "outside the command scope".
7. `pack-own`: `profile := packer_session_profile(ws, p_packer_session)` (same checks as 2.3)
   or `42501` "Your packer session ended".
8. **Issues** (3.4).
9. **Orders:** apply in ascending `id` order, always, to avoid deadlocks between bulk commands:
   - deletes;
   - updates (`update … set <whitelisted cols>, version = version + 1, updated_at = now(), updated_by = uid where workspace_id = ws and id = $id and version = $v returning old/new`);
   - inserts.

   Zero rows on an update or delete → `PT412` with `detail = {"stale": [ids]}`. A unique
   violation on `(workspace_id, awb)` → `23505` "This AWB is already recorded." Then
   `operator_private.assert_<family>(command, old rows, new rows, uid, profile)` checks the
   family's invariants (3.3).
10. **Import effects** (WP A shapes), checked against the tables:
    - release: every inserted row with `import_id = upload` names its own unreleased,
      unexcluded label; set `released_order_id`; set `confirmed_at`.
    - delete: `not exists (select 1 from operator_orders where import_id = upload)` after the
      deletes; mark the upload deleted.
    - rows: each deleted row with an `import_row_id` released from that label is in
      `rows`; mark those labels excluded.
11. **Sort counts:** recompute `day_demand()`. The inserted `expected`, `demand_awbs` and
    `demand_hash` must equal it, and `demand_awbs >= 1` ("No reviewed orders for this
    product and day") → `23514`.
12. **Gates:** for `assign-package`, `assign-orders`, `issue` and `issue-orders`, every touched
    `(fulfil_date, product)` needs `sort_count_current()` → `23514` "Record a current
    supervisor count before …".
13. **Events:** WP B's appender inserts `p_changes.events` (attribution `recorder.userId =
    uid`). Audit completeness: every inserted, updated or deleted order id and every issue's
    order id has at least one event with that `entity` in this commit → `23514`.
14. **Departures:** one row per deleted order (`removed`) and per changed `fulfil_date`
    (`moved`, old day).
15. `result := {orders:[{id, op, version}], issues:[ids], sortCounts:[ids], days:[dates touched]}`.
    `update operator_commits set result = …`. Return `{replayed:false, result}`.

### 3.3 Families: scope, invariants the database enforces, events

The row version rule is the same for every update and delete. The delta carries the version
that was used to decide the change. That is the client's `expectedVersion` where the form
sends one (marked "client" in the table), otherwise the version the API read in this attempt.
A mismatch raises `PT412`. Inserts start at version 1. Issues and sort counts are
insert-only and have no version.

| Command(s) | Capability | Rows (columns) | Version from | Database invariants (`assert_<family>`) | Events (unchanged texts) |
|---|---|---|---|---|---|
| `order` | orders.enter | insert 1 | – | `review_state='pending'`, `actual` null, not printed, not dispatched, unassigned, `packer=''`, `label_pic=''`, `import_id` null; unique AWB | "AWB recorded" |
| `edit-order` | orders.enter | update 1 (`awb, product, channel, package, expected, original_expected, lines, fulfil_date`) | client | old and new `review_state='pending'`; unique AWB; lines consistent (check) | "Pending order edited" |
| `review-order` | orders.enter | update 1 (`review_state, reviewed_by`) | client | old pending → new confirmed; `reviewed_by <> ''` | "Order reviewed" |
| `remove-order` | orders.enter | delete 1; import effect `rows` | client | old `actual` null, `packed_at` null, not dispatched, no issue rows (checked explicitly for the message; the FK `restrict` also blocks it); a released label must be in `rows` | "AWB removed" |
| `split-order` | orders.enter | update the original + insert N−1 (`awb, product, package, expected, original_expected, lines, review_state, reviewed_by, assigned_packer, assigned_at, printed, packer, label_pic, note`) | client | old has ≥ 2 distinct products, no issues, `actual` null, not dispatched; results all confirmed, `lines` null, unassigned, not printed; **demand conserved**: the multiset of (product, expected) over the results equals the old lines aggregated per product; AWBs distinct and unique | "Brands separated into parcels" × N |
| `assign-package`, `assign-orders` | outbound.fulfil | update n (`assigned_packer, assigned_at`) | read | rows confirmed, not dispatched, `actual` null; new packer is an active packer profile in the document (`packer_profile_exists`); sort-count gate | "Package packer assignment" / "Packer assigned" per changed row |
| `print`, `print-orders` | outbound.fulfil | update n (`printed`) | read | confirmed; `printed` false → true only | "AWB print recorded" |
| `move-orders` | outbound.fulfil | update n (`fulfil_date`) | read | confirmed, not dispatched, `actual` null; departure row `moved` | "Fulfilment date changed" |
| `issue`, `issue-orders` | outbound.fulfil | insert issues | – (locks, 3.4) | see 3.4; sort-count gate | "Stock issued to packing" per order |
| `pack` | outbound.fulfil | update 1 (`actual, lines, packer, label_pic, packed_at, pack_recorded_at, pack_recorded_by`) | read | old `actual` null, confirmed, `assigned_packer` not null, single product; new `actual` not null; `pack_recorded_by->>'userId' = uid`; `packed_at <= now() + 5 min` | "Parcel quantity recorded" (performer, occurredAt) |
| `pack-own` | packing.record | same | read | as `pack`, plus `packer = label_pic = assigned_packer = profile` from the verified session; `packed_at = pack_recorded_at = now()` | same, "entered by the packer with their PIN" |
| `correct` | outbound.correct | update 1 (`expected, actual, lines`) | client | `actual` changes only if old `actual` not null; never back to null; `expected >= 1`; lines consistent | "Supervisor correction" / "Quantity corrected" |
| `dispatch` | outbound.fulfil | update 1 (`dispatched, handover_ref`) | client | old `actual` not null, old not dispatched; new dispatched with `handover_ref <> ''` (check) | "Courier handover" |
| `sort-count` | outbound.fulfil | insert sort count | – | step 11 | "Supervisor sort count recorded" (entity = day) |
| `import-release` | orders.import | insert n; effect `release` | – | inserted rows confirmed, unpacked, `import_id` = the upload; step 10 | "AWB imported" × n |
| `import-delete` | orders.import | delete all of the upload's AWBs; effect `delete` | read | each as `remove-order`; none of the upload's AWBs remains | "Upload batch deleted" |

Seed rows for `operator_record_rules` follow the table exactly. `import-receive` and
`import-save` stay WP A functions.

### 3.4 Stock issues: carton lock and balance

Steps for `issue` and `issue-orders`, inside `operator_commit_records`:

1. For the distinct carton IDs in `issues`, ascending:
   `perform pg_advisory_xact_lock(hashtextextended('operator-carton:' || ws || ':' || carton_id, 0))`.
   A hash collision only adds serialization.
2. Then `select … from operator_orders where workspace_id = ws and id = any($order_ids) order by id for update`.
3. Only **after** the locks, read the carton and the document sums. The function is VOLATILE
   under READ COMMITTED, so each statement takes a new snapshot and sees any adjustment
   committed while this transaction waited.
4. Per issue: the carton exists in `state->'cartons'` and is a stock carton
   (`unit = product_unit(product)`); the issue's `product` and `unit` are copied from the
   carton. The order is confirmed, `cardinality(products) = 1`, `products[1] = carton product`,
   and not dispatched. `qty` is a positive whole number (check).
5. `issue-orders` only (parity with draft.ts: single `issue` has no demand cap): per order,
   Σ new allocations ≤ product expected − already issued for that order and product
   (computed from `operator_issues` under the order row lock) → `23514` "Quantity exceeds the
   remaining demand".
6. Insert the issues. Then
   `insert into operator_carton_issued … on conflict (workspace_id, carton_id) do update set issued = issued + excluded.issued, updated_at = now()`.
7. **Balance** (`operator_private.carton_balance(ws, carton)`; the caller holds the lock):

   ```
   available = carton.qty                                   (document)
             − operator_carton_issued.issued                (table, now including this commit)
             − Σ boxing[sourceId = carton] (boxes × ratio + loss)   (document, historical)
             + Σ adjustments[cartonId = carton].delta        (document)
             + Σ returns[cartonId = carton].qty              (document)
   ```

   `available < 0` → `23514` "Not enough stock in this carton." Issues only decrease the
   balance, so unlike the document rule there is no historical-deficit allowance.

Document commits that can lower a balance must take the same lock. In `document` mode
nothing changes. In `tables` mode, `operator_commit_workspace` is replaced with the same
signature as WP B's latest version and changes as follows:

| Change | Why |
|---|---|
| `select … for update` on the site row becomes `for no key update` | FK checks on order and issue inserts take `for key share` on `operator_workspaces`, which `for update` blocks. Without this, every records commit would queue behind document commits. |
| After the site row lock, lock (ascending, same key) every carton whose `adjustments` or `boxing` entries differ between old and new | `adjust` is the only document command that lowers a balance; returns and receipts only raise it. Lock order is site row, then cartons. Records commits take cartons then order rows, never the site row lock, so there is no cycle. |
| Before `assert_transition`, inject virtual issues into both old and new: `'issues' = [{"cartonId", "qty": issued} …]` from `operator_carton_issued` | The existing conservation check then counts table issues with no change to `assert_core_transition`. The append-only and positivity checks pass because old and new are identical. |
| Refuse a document commit for any command that has an `operator_record_rules` row → `PT428`; refuse new state containing `orders`, `issues`, `sortCounts`, `cartonIssued` or `demand` → `42501` | Order data cannot slip back into the document; transient slice fields are never persisted. |

### 3.5 Operation IDs and response loss

- The client keeps today's `PendingSave` (one `operationId` per intended change; Resubmit
  reuses it).
- The API keeps the replay check as the first step of every attempt: it reads
  `operator_commits`. If a row has `result`, it returns `{replayed: true, result, records}`
  with the current rows of the result's ids. A row with only `result_revision` is a document
  replay, handled as today.
- The RPC repeats the gate atomically (3.2 step 3). Two retries racing each other apply once:
  the second waits on the primary key, then replays.
- The commits row and the business rows commit in one transaction. A replay never repeats an
  issue (the conservation test proves it) and never reapplies a pack.

### 3.6 Signed trusted commands on a set of rows

One secret, one key row: `operator_private.server_keys` `'commit'` / `OPERATOR_COMMIT_SECRET`.
A distinct first line separates the message from the document message (`operator-commit-v2`,
WP A) and from the packer-session derived key:

```
operator-records-v1
<workspace uuid>
<auth.uid() uuid>
<operation uuid>
<command>
<input fingerprint, 64 hex>
<sha256 hex of p_changes, exact UTF-8 text>
<sha256 hex of coalesce(p_packer_session, '')>
```

`attestRecords(secret, {...})` in `apps/web/src/lib/access.ts` builds this message. The API
signs only after the TypeScript rules accepted the change on the freshly loaded slice. The
signature covers every row, every expected version, the events, the import effects and the
packer session, so a holder of a user JWT without the key can commit nothing. A server bug
that signs a bad delta is still stopped by sections 2.2 to 3.4. The revision line is
dropped, because the expected versions inside `p_changes` replace it.

### 3.7 Error codes

| SQLSTATE | Meaning | API response |
|---|---|---|
| `28000` | not signed in | 401 |
| `42501` | no membership, capability, scope, signature or packer session | 403 (`packer-locked` when the session failed) |
| `PT409` | operation ID reused with different input | 409 `operation-mismatch` |
| `PT412` | stale row version | retry inside `rebaseLoop` (3 attempts). If a client `expectedVersion` was sent, the retry's domain check raises `ConflictError` → 409 `record` with the current row. When attempts run out → 409 `revision` |
| `PT428` | order store mismatch (site moved during the request) | 409 `store` → client reloads |
| `23505` | duplicate AWB | 409 `duplicate`, "This AWB is already recorded." |
| `23514` | invariant (stock, transition, gate, audit) | 409 `invariant` (existing mapping) |
| `22023` | malformed changes | 400 |
| `55000` | server key missing | 503 |

PostgREST maps `PTxyz` to HTTP status `xyz`; the API maps by `error.code`, as it does today.

## 4. Domain code strategy

**The slice approach.** The rules stay in `applyCommand`. For a records command, the API
builds a **slice**: a `Draft` holding only the document parts and rows the command needs.
It runs `applyCommand(slice, cmd)` and diffs the slice before and after into
`RecordChanges`. Every existing unit test over `createDraft()` keeps covering the same
code. No order case is rewritten as SQL or as a second TypeScript function.

New and changed code:

| File | Change |
|---|---|
| `lib/draft.ts` | `Draft` gains transient `cartonIssued?: Record<string, number>` (units issued from a carton by issue rows *not* in `s.issues`, all before any loaded issue) and `demand?: Record<"YYYY-MM-DD|product", {awbs, expected, hash}>`. `Order` gains `version?: number`. `available()` subtracts `cartonIssued[c.id]`. `dailyInventory()` adds `−cartonIssued[c.id]` to opening. `demandFingerprint()` returns `s.demand[key].hash` when present. New `tallyGate(s, date, product)` returns `{awbs, expected, count, stale}` from `s.demand` when present, else from `dailyTally`. `sort-count`, `assign-package`, `assign-orders` and `issue-orders` use `tallyGate`. `Command` gains `scope?: "document" | "slice"`; the size ceilings move to an exported `documentCeilings(s)` and run only for `document`. Optional `expectVersion(o, "This AWB")` in `edit-order`, `review-order`, `remove-order`, `split-order`, `correct` and `dispatch` (enforced only when the input carries `expectedVersion`; TS does not bump order versions, the database does). |
| `lib/draft.ts` (bug fixes) | (a) `order` and `edit-order` accept only `YYYY-MM-DD` dates (today any string; `date` columns need it). (b) `edit-order` on an order with `lines` replaces `lines` with the single edited line; today it leaves stale lines, which the lines check would reject. |
| `lib/order-records.ts` (new, isomorphic) | `orderFromRow` / `orderToRow` (snake ↔ camel, `fulfil_date` ↔ `date`), `sliceDelta(type, before, after, versions)`, `outOfScopeRows(type, before, after)` (mirrors 3.2 step 6), and the slice spec per command (table below). |
| `lib/order-records-server.ts` (new) | Loaders running each slice spec against the user-scoped client, in one RPC call per spec where possible; `stripTransient(state)`. |
| `lib/access.ts` | `attestRecords`. `outOfScopeKeys` is unchanged for document commands. For records commands it runs on the slice's **document parts only**, with an empty scope: an order command must not change the document. |
| `lib/capabilities.ts` | `commandRules[cmd].records?: {orderInsert?, orderDelete?, orderColumns?, issues?, sortCounts?, importEffects?}`. In C4, `stateKeys` of records commands becomes `[]`. |
| `app/api/draft/route.ts` | Tables-mode branch: authorize → packer session → `rebaseLoop(load slice → applyCommand(scope "slice") → outOfScopeKeys/outOfScopeRows → sign → rpc)`. Document commands in tables mode load `cartonIssued` before `applyCommand` (so `count` and `adjust` see table issues) and strip it before signing. |

Slice spec per command (what the loader reads):

| Command | Orders loaded | Issues loaded | Document parts | `demand` / sort counts |
|---|---|---|---|---|
| order | rows with the normalized AWB | – | – | – |
| edit-order, split-order | target + rows with any new AWB | of target | – | – |
| review-order, correct, dispatch, print, print-orders, move-orders | target ids | – | – | – |
| remove-order | target | of target | staffProfiles | – |
| pack, pack-own | target | – | staffProfiles | – |
| assign-orders | ids | – | staffProfiles | each (date, product) of ids |
| assign-package | reviewed, single-product AWBs of the day containing the group's product | – | staffProfiles | (date, product) |
| issue, issue-orders | ids | of ids | cartons, boxing, adjustments, returns; `cartonIssued` = total − loaded | (date, product) |
| sort-count | none | – | – | (date, product) and the latest count |
| import-release | rows whose AWB is on the upload (≤ 1,200, unique index) | – | – | upload via `operator_import_get` (WP A) |
| import-delete | `import_id = upload` | of those | – | – |

**Parity tests.**
- `tests/order-slices.test.mjs`: for every records command, apply on a full `createDraft()`
  fixture and on the slice that an in-memory loader extracts from the same fixture by the
  spec. Both must produce identical `RecordChanges`. This proves the specs load enough.
- `tests/capabilities.test.mjs` gains: the `records` scopes equal the
  `operator_record_rules` seed (parsed like the existing sections); every records command run
  through `sliceDelta` stays inside its scope; `product_unit` and the channel check match
  `products` and `channels`.

**Deleted from `applyCommand`.** Nothing in C2 and C3. In C4: the `orders`, `issues` and
`sortCounts` lines of the ceilings, and the document-mode route branch for order commands.
The order cases stay; they are the domain rules for slices.

## 5. Read model and API

All reads use the user-scoped client, so RLS applies. Read functions are `security
invoker` and return **one jsonb value**, as WP A's `operator_import_get` does, so the Data
API row limit (1,000) never truncates a 2,000-AWB day. Server-side read models reuse the
TypeScript (`packageGroups`, `dailyTally`, `dailyInventory`) over slim day projections.

| Endpoint | SQL | Shape | Notes |
|---|---|---|---|
| `GET /api/orders?workspace&date&product&package&q&status&group&after&limit` (≤ 200) | `operator_orders_page(...)`: `where workspace_id=$ws and fulfil_date=$d` + filters (`$p = any(products)`, `package=`, `strpos(lower(awb‖' '‖order_ref‖' '‖channel), lower($q))>0`, status ∈ `review / unassigned / unpacked / handover / dispatched / mismatch`, group = (product, package, per_parcel)) `and awb > $after order by awb limit $n+1`, lateral `issued` per product from `operator_issues_order` | `{orders: Order&{version, issued:{product:qty}}[], next, total, marker}` | Index `operator_orders_day`; keyset paging by AWB |
| `GET /api/orders/day?workspace&date` | `operator_orders_day(ws, d)`: slim rows `(id, awb, product, package, lines, expected, actual, review_state, assigned_packer, packer, packed_at, pack_recorded_by->>'role', dispatched)`, the day's issues `(order_id, carton_id, qty)`, the day's sort counts, `day_demand` per product; carton issued before/within the day for inventory | `{groups, tally, packerTally, inventory, sortCounts, marker}` computed on the server with `packageGroups`, `dailyTally`, `dailyInventory` | Server reads ~300 KB; the client gets aggregates only |
| `GET /api/orders/packer?workspace&date` | `operator_packer_page(ws, d)` with header `x-operator-packer` (RLS policy 2) | `{orders: slim Order[], marker}` | Assigned to the unlocked profile only |
| `GET /api/orders/packer-counts?workspace&date` | `operator_packer_counts` (definer; `packing.record` or `outbound.fulfil`) | `[{profileId, open}]` | Unlock screen: counts, no AWBs |
| `GET /api/orders/trace?workspace&q` / `&order=` / `&batch=` | exact AWB, AWB prefix ≥ 6 chars (`awb like $q‖'%'` on the C-collated unique index), exact `order_ref`, or id; batch → cartons from the document → `operator_issues_carton` → orders, paged by 100 | `{orders, issues, events}` (events from WP B's entity query) | Hot rows only until WP D adds the archive |
| Handover | the list with `status=handover` (`actual is not null and not dispatched`) plus counts in `/day` | – | No separate endpoint |
| `GET /api/orders/export?workspace&from&to` (≤ 31 days) | keyset pages of 1,000 on `(fulfil_date, awb)` | `text/csv`, one row per line, same columns as today's `exportReport` | Streamed; ~150 B per line |
| `GET /api/orders/summary?workspace&date` | counts for the day plus open backlog (`operator_orders_open`) | overview metrics | Replaces all-time counts (open question 2) |
| `POST /api/draft` | unchanged URL | Records command → `{records:{orders, deleted, issues}, result, replayed}`; document command → as today | |
| `GET /api/draft` | – | in tables mode: `state` without orders, issues and sortCounts, plus `cartonIssued`, `orderStore:"tables"`; `?since=<revision>` → 204 when unchanged | `available()` keeps working on the client |

**Day marker (cheap scoped refresh).** `operator_private.day_marker(ws, date)` =
`md5(count(orders) ‖ sum(version) ‖ count(departures) ‖ count(issues joined to the day's orders))`.
It is computed from `operator_orders_day` (include `version`) in about 1 ms. Versions and
the departure and issue counts only grow, so a commit that lands late still changes the
marker; a sequence-based cursor would miss it. Every read returns `marker` as an `ETag`.
The 60-second refresh and `visibilitychange` send `If-None-Match` and get 304 when nothing
changed. Refresh is scoped: the visible page, `/day` for the open day, and the packer's
page on a phone. The document refresh uses `?since=`.

**Realtime hook.** After a successful records commit, the API calls
`afterRecordsCommit({workspaceId, days: result.days, orderIds})`. It is a no-op in WP C.
#11 replaces it with a Broadcast to `orders:<ws>:<day>`. Departures are the delete feed for
reconnect reconciliation.

**Payloads at 2,000 AWBs a day** (order row about 550 B as JSON, gzip about 7:1; document
without per-AWB data estimated at about 40 KB for the 870 KB sandbox fixture once its orders,
label rows and events are gone, bounded by the batch and carton ceilings at about 0.5 MB):

| | Today | Tables: supervisor laptop | Tables: packer phone (about 250 AWBs) |
|---|---|---|---|
| First open | whole document, ≤ 2 MB (cannot hold the day) | document ≤ 0.5 MB + `/day` 15–30 KB + first page 200 × 550 B ≈ 110 KB → ≈ 0.2–0.6 MB raw, ≈ 40–80 KB gzip | document + packer page 250 × 250 B ≈ 62 KB raw ≈ 10 KB gzip. With the packer projection below: ≈ 70 KB raw total |
| 60-s refresh, nothing changed | whole document | 3 × 304 ≈ 1 KB | 2 × 304 ≈ 1 KB |
| 60-s refresh, day changed | whole document | ≈ 110 + 25 KB | ≈ 62 KB |
| Command response | whole document | touched rows: 1–2 KB; bulk of 200 ≈ 110 KB | ≈ 1 KB |

Packer projection (recommended in C3; coordinate with #11): `GET /api/draft` for members
whose capabilities ⊆ {`feedback.post`, `packing.record`} returns only `staffProfiles` (id,
name, role, active) and `notes`.

## 6. UI change list

A shared hook module `components/use-orders.ts` (`useDayOrders`, `useDaySummary`,
`usePackerOrders`, `useTrace`, `useOrderSummary`) holds the cache, merges the rows that
command responses return, and does the marker refresh. Preview actors see the sandbox
notice instead of order screens.

Touch points: a grep for `.orders`, `.issues`, `sortCounts`, `dailyTally`, `packageGroups`,
`orderIssued`, `orderHasActivity`, `available(`, `dailyInventory` and `.events` finds
order-workspace 31, draft-app 29, awb-intake 3, draft-primitives 2 and packer-station 1.

| Component | Today reads | After | Data needed |
|---|---|---|---|
| `order-workspace.tsx` `OrderWorkspace` | `state.orders` by day (l.70), `dailyTally` (l.83), `packageGroups` (l.88), `orderIssued` (l.365), `available` in the issue dialog (l.689), `orderHasActivity` (l.1021), `state.sortCounts` (l.1170) | props `page` (list), `summary` (`/day`); filters change the query, not an in-memory filter; "Show more"; selection across visible rows; "select group" uses `group=` filter; remove button uses `rowHasActivity(row)` = `actual≠null ‖ dispatched ‖ packedAt ‖ Σ issued>0`; issue dialog keeps `available(state, c)` (now with `cartonIssued`); forms send `expectedVersion` for edit, review, remove, split, correct and dispatch | list page, `/day` |
| `PackerPackageSummary` (same file) | `packageGroups(orders)` | unchanged on the packer's own page (small) | packer page |
| `InventoryForDay` (same file) | `dailyInventory(state)` | `summary.inventory` | `/day` |
| `draft-app.tsx` | metrics and pipeline from `state.orders` (l.1246–1585); latest activity `state.events` (l.1689, WP B); trace via `state.orders` and `state.issues` (l.1223–1269, 3260–3350, 3456); inventory issued per product from `state.issues` (l.1403); `exportReport` (l.1431); packing list `filteredOrders` (l.1223, 2268); people report (l.2579–2582); `command()` replaces state from the response | `/summary`; trace endpoint; per-product issued = Σ `cartonIssued` over the product's cartons; export link to `/api/orders/export`; `usePackerOrders`; `/api/orders/people?from&to` aggregate; `command()` handles `records` (merge and invalidate), 409 `store` (full reload), 409 `record` with the current row | summary, trace, packer page |
| `packer-station.tsx` `PackerUnlock` | `state.orders` count per profile (l.44) | `/packer-counts` | counts |
| `awb-intake.tsx` | `state.orders` by import + `orderHasActivity` (l.112–115) | WP A's upload read gains `released` and `blocked` (first 5 AWBs with activity) from `operator_orders` | upload read |
| `draft-primitives.tsx` `OrderQuantities` | `orderIssued(state, order, p)` (l.56) | `order.issued?.[p] ?? orderIssued(...)` | list rows |

Strings (English / Malay) that change or are added:

| Where | English | Malay |
|---|---|---|
| Overview metric detail (replaces "orders recorded in this workspace") | `{n} AWBs for {date} · {m} still open from earlier days` | `{n} AWB untuk {date} · {m} masih belum selesai dari hari sebelumnya` |
| Pipeline panel detail (replaces "All test records · …") | `This day's records · each stage counts its own records` | `Rekod hari ini · setiap peringkat mengira rekodnya sendiri` |
| List paging | `Showing {n} of {total} AWBs` · `Show more AWBs` | `Memaparkan {n} daripada {total} AWB` · `Tunjuk lebih banyak AWB` |
| Trace search | `Find an AWB or order number (last 90 days)` | `Cari AWB atau nombor pesanan (90 hari lepas)` |
| Freshness | `Updated {time}` · `Refreshing…` | `Dikemas kini {time}` · `Menyegar semula…` |
| Record conflict | `This AWB changed after you opened it. Review the latest record, then save again.` | `AWB ini berubah selepas anda membukanya. Semak rekod terkini, kemudian simpan semula.` |
| Store switch | `Orders on this site moved to the new storage. Reloading.` | `Pesanan tapak ini telah dipindahkan ke storan baharu. Memuat semula.` |
| Sandbox notice | `Order flows are tested on the synthetic site, not in this preview.` | `Aliran pesanan diuji di tapak sintetik, bukan dalam pratonton ini.` |
| Export button (replaces "Export parcels") | `Export AWBs (CSV)` + date range | `Eksport AWB (CSV)` + julat tarikh |
| Duplicate AWB (409 `duplicate`) | `This AWB is already recorded.` (unchanged text, now also from the database) | `AWB ini telah direkodkan.` |

## 7. Migration and cutover

**Backfill, `operator_private.move_orders_to_tables(p_workspace uuid) returns jsonb`.**
Owner-run; not granted to `authenticated`. In one transaction:

1. Lock the site row `for update`; require `order_store = 'document'`.
2. **Validate, or raise listing the offending AWBs (first 20).**
   - Every order and issue id is a UUID. Operational records always are (`id()`). The function
     does not remap them, so WP B event entities stay valid.
   - Normalized AWBs are unique.
   - Every date is `YYYY-MM-DD`.
   - Every issue's order and carton exist.
   - Lines pass `order_lines_valid`.
3. Insert `operator_orders` from `state->'orders'`, with `legacy = true`, `version = 1`,
   `review_state = coalesce(reviewState, 'confirmed')`, and timestamps through WP A's
   `try_timestamptz`.
4. Insert `operator_issues` with `legacy = true`; product and unit come from the document
   carton.
5. Insert `operator_carton_issued` = Σ qty per carton.
6. Insert `operator_sort_counts` with `legacy = true` and `demand_hash = repeat('0', 64)`, so a
   backfilled count always shows "Orders changed — recount".
7. Assert every carton's balance is equal before and after, and the row counts equal the
   array lengths.
8. `state := state - 'orders' - 'issues' - 'sortCounts'`, `revision + 1` (open tabs reload),
   `order_store := 'tables'`.
9. Return `{orders, issues, sortCounts, cartons}`.

Expected use: the synthetic site after C3; the live site (empty since the 2026-10-11 purge)
before C4.

**Reverse, `operator_private.move_orders_to_document(p_workspace)`.** Used by rollback.
- Refuses if more than 1,000 orders or 2,000 issues, or if the rebuilt state would exceed
  1.8 MB.
- Otherwise rebuilds the arrays newest first in today's `Order`, `Issue` and `SortCount` shapes
  (row-only columns such as `version`, `legacy` and `products` are dropped).
- Deletes the site's rows, summary and departures, and sets `order_store = 'document'`.
- Never runs implicitly on a site that would lose AWBs.

**Retiring document keys and rules (C4 migration `20261016090000_operator_order_store_cutover.sql`):**
- Refuse to apply unless every `operator_workspaces.order_store = 'tables'`.
- `delete from operator_command_rules where command in (<every records command>)`.
- Add `check (order_store = 'tables')` and change the column default to `'tables'`, so new
  sites start in tables mode.
- The C4 down file re-inserts the rule rows (copied from the earlier migrations) and drops
  the check. It moves no data.
- TypeScript: remove the document-mode order branch, the order ceilings, and sandbox order
  screens (notice instead).
- A test asserts no component reads `state.orders` or `state.issues`.
- `supabase/maintenance/purge-operational-data.sql` also deletes from the five new tables
  (moved into C1, so the purge stays complete from the day the tables exist).

**C1 rollback file semantics.**
1. For each site in `tables` mode, call `move_orders_to_document`. Any refusal aborts the
   whole rollback with nothing changed; the owner exports or trims first.
2. Restore WP B's `operator_commit_workspace` (site row `for update`, no virtual issues, no
   carton locks).
3. Drop `operator_commit_records`, the read functions, helpers, triggers, the five tables
   and `operator_record_rules`.
4. Drop `operator_commits.result` and restore `not null` on `result_revision` after deleting
   records-only commit rows. Their effects were just moved back; their audit entries stay in
   `operator_events`.
5. Drop `order_store`.

**`supabase/tests/operator_access.test.sql`: new sections.** Synthetic site C is moved to
tables with `move_orders_to_tables` after it is seeded with 3 orders, 2 issues and 1 sort
count. A `pg_temp.records_as(uid, ws, command, changes, op, sign, signer, packer_session)`
helper signs like the API (same style as `commit_as`). The sections cover:

- signature, scope, capability, store mode and `PT409` refusals, each changing nothing;
- every family's invariant from 3.3, refused even when signed;
- version mismatch → `PT412` with nothing applied;
- replay returns the stored result byte-identically;
- packer RLS: `set_config('request.headers', …)` with a valid seal sees own rows only, and a
  forged, expired, other-user or other-site seal sees none;
- `stock.receive` reads `operator_carton_issued` but packers and drivers read no orders;
- direct `insert`, `update` and `delete` denied on every table, and issue `update` denied
  even for the owner role;
- document `adjust` on a tables site counts table issues (book check and conservation);
- document commit carrying `orders` refused;
- `move_orders_to_tables` validation refusals;
- after every section, `pg_temp.assert_conservation()`: for each carton,
  `operator_carton_issued.issued = Σ operator_issues.qty`, and balance ≥ 0 or not lower
  than its backfilled value.

**`scripts/verify-migrations-local.sh`** (WP A has edited it; add after its entries):
- apply → tests → `supabase/tests/operator_records_concurrency.sh` (8.1) → rollback
  rehearsal: move a seeded site to tables, add rows through the RPC, run the C1 down file,
  assert the document holds the same orders and issues (compared as sets) and the tables are
  gone → re-apply and assert defaults (`order_store = 'document'` everywhere,
  `operator_record_rules` row count).
- For C4: apply refused while any site is `document`; apply after moving; down file
  re-inserts the rules.

**`tests/integration/scenario.mjs`.**
- Seed moves site A to tables (`select operator_private.move_orders_to_tables(...)` as
  administrator SQL) and keeps site B in document mode until C4.
- Helper `rows(sql)` replaces `stored(W.a).orders` and `stored(W.a).issues` in "B: office
  admin … releases it", "C: the supervisor assigns …", "C: … Ali … records his own AWB" and
  "C: five wrong PINs …".
- New checks listed in section 8.

**Retention (WP D) is not blocked.**
1. Every hot query is keyed by `(workspace_id, fulfil_date)`, so archiving is a date-range
   move.
2. Carton balances come from `operator_carton_issued`, not Σ issue rows, so archived issues
   leave balances unchanged.
3. The only foreign key into `operator_orders` is from `operator_issues` (`restrict`). The
   mover moves issues, then orders, in one transaction, with `operator.archiving = on` for
   the append-only trigger.
4. Events reference entity ids as text, and import rows hold `released_order_id` as text, so
   nothing dangles.
5. `operator_order_departures.reason` already allows `archived`.
6. AWB uniqueness is per hot table. Whether a recycled courier AWB may reappear after 90 days
   is WP D's decision (open question 4).
7. Trace reads hot rows; WP D adds a union with `operator_orders_archive` /
   `operator_issues_archive`, which have the same columns plus `archived_at`.

## 8. Test plan against the #10 acceptance criteria

| Acceptance | Database (`verify-migrations-local.sh`) | Unit (`pnpm test`) | Real stack (`scenario.mjs`) |
|---|---|---|---|
| 1. Concurrent issues against one carton cannot go negative or double-deduct | 8.1 deterministic and stress tests; adjust vs issue race; `assert_conservation` | `available` with `cartonIssued`; slice parity for issue and issue-orders | Two `issue` POSTs in `Promise.all` for 3 + 3 of a 5-unit carton → one 200, one 409 `invariant` ("Not enough stock"); `operator_carton_issued` = 3; one issue row |
| 2. Unrelated operations do not conflict through one revision | Records commits on disjoint rows prepared before each other both succeed; a document commit between them changes no row version; one records commit on a stale row fails `PT412` only for that row's command | `sliceDelta` touches only the rows it changed | `pack-own` (AWB X), `print` (AWB Y) and `feedback` in `Promise.all` → all 200 with `X-Operator-Attempts: 1`; two edits of the **same** AWB with the same `expectedVersion` → 200 and 409 `record` with `conflict.currentVersion` |
| 3. Response-loss retries return the original result without repeating mutations | Same operation twice → second `replayed:true`, identical `result`, issue count and summary unchanged; different fingerprint → `PT409`; two sessions sending the same operation concurrently → one applies, the other waits and replays | fingerprint stability (existing) | `issue` sent twice with one `operationId` → both 200, second `replayed`, one issue row, one `operator_commits` row; expired-session Resubmit flow repeated for `pack-own` |
| 4. Conservation, traceability and reasoned correction history | Issues and sort counts immutable; every changed order has an attributed event in the same operation; `correct` and `remove-order` refused without their event; removal refused with issue, pack or handover; backfill keeps per-carton sums and counts; trace query returns AWB → issues → carton → batch | `correct`, `split-order` (demand conserved), `remove-order` parity | Trace by AWB shows source cartons and events; batch trace lists the linked AWB; `correct` appears in the AWB's events with reason; CSV export rows equal `dailyTally` over the same rows |

### 8.1 Concurrency test for a double issue against one carton (`supabase/tests/operator_records_concurrency.sh`)

The test uses two `psql` sessions against the disposable cluster. Helper functions live in
schema `test_support`, created by the script, because `pg_temp` is per session.

Setup: tables-mode site T, a stock carton `C-SYN` with `qty = 5`, two confirmed
single-product AWBs, and a current sort count.

**Deterministic.**
1. Session 1: `begin; select test_support.issue(:T, 'C-SYN', order1, 5); select pg_sleep(2); commit;`
   started in the background.
2. After 0.5 s, session 2: `select test_support.issue(:T, 'C-SYN', order2, 5)`, timed.

Assert:
- session 2 returns `23514` after ≥ 1.4 s, proving it waited on the advisory lock and then
  read the new balance;
- `operator_issues` has exactly 1 row for `C-SYN`;
- `issued = 5`;
- balance = 0.

**Stress.**
- Two sessions each run 20 × issue 1 unit against a 25-unit carton, interleaved.
- Exactly 25 succeed and 15 fail with `23514`.
- The balance never goes below 0: a check after each call in each session records the
  minimum seen.
- Final `issued = Σ qty = 25`.

**Adjust vs issue.**
- Session 1 commits a signed document `adjust` with delta −3 on a 5-unit carton, holding its
  transaction for 2 s.
- Session 2 issues 4 units.
- Session 2 waits, then fails `23514`.
- Reversed order: the adjust's conservation check fails.

**Same operation twice.**
- Both sessions send identical signed changes with one operation ID.
- One returns `replayed:false`, the other `replayed:true` with an equal `result`.
- One issue row.

## 9. PR breakdown

| PR | Contents | Size | Owner applies |
|---|---|---|---|
| **C1** Schema and write RPC | Migration `20261014090000_operator_order_records.sql` (sections 2–3: tables, RLS, rules seed, `operator_commit_records`, read functions, packer-session check, `day_demand`, `move_orders_*`, `commit_workspace` changes rebased on WP B's latest text); rollback file; SQL test sections; concurrency script; verify-script entries; purge script; capabilities parity for `records` | ≈ 1,100 lines SQL, ≈ 500 lines SQL tests, ≈ 100 lines shell, 2–2.5 days | Apply `20261014090000` on the hosted project (check the selected project first). Additive: every site stays `document`, so there is no behaviour change. |
| **C2** Domain and write path | draft.ts changes and fixes (section 4); `order-records.ts` and `order-records-server.ts`; route tables-mode branch; `attestRecords`; unit tests (`order-slices`, `capabilities`, slice versions of fulfilment, package-assignment, packer-self-entry and remove-awbs cases); scenario seeds site A in tables mode and runs the API-level checks from section 8 (acceptance 1–3) | ≈ 900 lines TS, ≈ 600 lines tests, 2 days | Nothing. No site is moved yet. |
| **C3** Read model and UI | `/api/orders/*` endpoints and read functions wiring; `use-orders.ts`; component changes and strings (section 6); marker refresh; CSV export; packer projection; scenario UI checks (packer sees own AWBs, list paging, trace, export) | ≈ 1,200 lines TS/TSX, ≈ 300 lines scenario, 2–3 days | After merge: `select operator_private.move_orders_to_tables('<synthetic site id>')`, then the floor checklist on the synthetic site |
| **C4** Cutover | Migration `20261016090000_operator_order_store_cutover.sql` + down; remove document-mode order paths, order ceilings and sandbox order screens; `state.orders` guard test; docs (`production-readiness-backlog.md` #10 evidence, plan status) | ≈ 300 lines, 0.5–1 day | Move the live site (`move_orders_to_tables`; empty → trivial), then apply `20261016090000`, then merge |

Total: 6.5 to 8.5 days, within the plan's 5 to 8 days plus the backfill moved from WP D. Each
PR runs `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`,
`scripts/verify-migrations-local.sh` and the real-stack scenario in CI.

## 10. Open questions for the owner

1. **Who may read AWB rows.** Today every member reads every order in the document. Proposed:
   order-side roles, management, production and stock-in (for trace) read them; packers see
   only their own assigned AWBs; drivers and HR see none. Their screens do not use AWBs, so
   the change is customer-data minimization. Driver trace would show batches without linked
   parcels. Confirm.
2. **Overview figures.** All-time counts over 90 days of hot rows are slow and not useful.
   Proposed: figures for the chosen day plus "still open from earlier days". Confirm.
3. **Export range.** Proposed maximum 31 days per CSV (about 62,000 AWBs, about 9 MB). Is a
   longer range needed for month-end?
4. **Recycled AWB numbers.** Can a courier reuse an AWB number months later? If yes, WP D must
   allow the same AWB in the archive and the hot table. If no, uniqueness should span both.

## Implementation notes (C1)

C1 (`supabase/migrations/20261014090000_operator_order_records.sql`, rollback
`supabase/rollback/20261014090000_operator_order_records.down.sql`) implements sections 2, 3,
the read functions of section 5 and the move functions of section 7. Every site stays in
`document` mode. These notes record what C1 decided or changed; the sections above are
left as designed.

### Owner decisions (2026-10-12) on section 10

1. **AWB readers.** Office admin and stock-out read every AWB row of their site, checked by
   capability (`orders.enter`, `orders.import`, `outbound.fulfil`, `outbound.correct`).
   Packers read only the AWBs assigned to the profile their PIN unlocked. Management,
   production, stock-in, drivers and HR read no AWB rows, issues, sort counts or
   departures. This replaces the wider list in 2.3. Carton totals stay readable by every
   active member (inventory). `operator_orders_trace` gives members without AWB access a
   batch's cartons and issued totals with `parcels: false` and refuses AWB lookups.
2. **Overview figures.** Per chosen day by default. `operator_orders_summary(ws, date, p_all)`
   counts across the whole hot table when `p_all` is true. WP D adds the archive there.
   C3 builds the screen.
3. **Export.** At most 31 days per export (`operator_orders_export`, 22023 beyond that).
4. **AWB reuse.** Couriers reuse tracking numbers after roughly 90 to 365 days, so an AWB
   is never a key on its own. The primary key stays the surrogate uuid.
   - Uniqueness in the hot table is `unique (workspace_id, awb, fulfil_date)`.
   - Across days, `operator_private.assert_awb_reuse` allows the same AWB again only when
     the earlier AWB was handed over more than 30 days before the later one's fulfilment
     day. Both sides are Malaysia days; backfilled history without a handover time counts
     from its fulfilment day. Otherwise the commit fails with 23505 "This AWB is already
     recorded."
   - The check runs on every inserted row and on every row whose AWB or day changes. It
     first takes a per-(site, AWB) advisory lock, so two commits entering the same number
     on different days cannot both pass.
   - New column `operator_orders.dispatched_at` is stamped by the database on handover.
     The Order shape carries it as `dispatchedAt` when set.
   - WP D's archive should be keyed by the surrogate id with a non-unique index on
     `(awb, date)`.
   - Trace by AWB returns every occurrence, newest first.

### Changes to the design and why

- **Idempotency row.** The gate inserts `result = '{}'` (not null) and fills the result
  at the end of the same transaction. The design's null/null insert would violate its own
  `operator_commits_result` check. Nobody can read the placeholder: concurrent attempts
  wait on the primary key.
- **Stale versions** use `PT412`, as designed, with `detail = {"stale": [ids]}`. The
  other codes are those of 3.7, plus 23505 for the AWB reuse rule.
- **Sort-count gate.** The gate applies to `assign-package`, `assign-orders` and
  `issue-orders`, not to single `issue`, for parity with draft.ts (its `issue` case has no
  count check, and section 4's `tallyGate` list omits it). If the database alone refused
  it, the server would sign changes the database rejects. Adding `issue` is one line in
  step 12 if the owner wants it.
- **Audit completeness.**
  - `import-delete` writes one entry for the upload (draft.ts). That entry, whose entity
    is the upload id, covers the AWBs it removes.
  - Sort counts need an entry whose entity is the day, matching the TypeScript `log(date, …)`.
- **Extra invariants**, all parity with draft.ts:
  - `edit-order` keeps `original_expected = expected`.
  - `pack` and `pack-own` may change only `actual` inside `lines`.
  - Split parcels keep the original's channel, store, order reference, courier, upload,
    label and day.
  - Each family's row counts (one AWB, n AWBs) are enforced with 23514.
- **Server-stamped columns.** The database stamps these and ignores any values sent for
  them:
  - `assigned_at` whenever `assigned_packer` is in the set (null when unassigning);
  - `pack_recorded_at` on `pack` and `pack-own`;
  - `packed_at` on `pack-own`;
  - `dispatched_at` on handover;
  - `version`, `created_*` and `updated_*`;
  - issue and count `at` and `recorded_by`.
- **Upload references** use a composite foreign key `(import_id, workspace_id)` to
  `operator_imports`, so an AWB can only point at an upload of its own site.
- **WP A effects** run through `apply_import_effects` unchanged. The records path builds
  the document-shaped `orders` lists that the function expects from the touched rows.
- **Document commit lock.** On a tables-mode site the site row lock is `FOR NO KEY UPDATE`.
  A document-mode site still takes `FOR UPDATE`: it locks no-key first, then upgrades, so
  document mode behaves exactly as before.
- **Packer session.** The design's `x-operator-packer` header works with the PostgREST
  build used here (16.4). This was checked with curl against the real binary: with a valid
  seal, `operator_orders` returns only the packer's AWBs; without one it returns none, and
  `operator_packer_page` answers 403. The helper also requires UUID-shaped site, user and
  profile parts, as `openPackerSession` does.
- **Latest sort count.** Counts recorded in tables mode rank above every backfilled count
  (the backfill always comes first). Among backfilled counts, the recorded time decides.
  Ordering by time alone would let a backfilled count with a future time hide a new one.
- **Day marker** also counts the day's sort counts, so a new count refreshes `/day`.
- **Demand hash** uses the built-in `sha256()` (same output as pgcrypto). The member's
  read functions then do not need the `extensions` schema.
- **Rules mirror.** The TypeScript copy of `operator_record_rules` is a separate
  `recordRules` constant in `capabilities.ts`, not `commandRules[cmd].records`. This keeps
  the existing `commandRules` parity test unchanged. `tests/capabilities.test.mjs` checks:
  - `recordRules` equals the seed;
  - every records command has the same capability as its document command;
  - every document command touching orders, issues or sort counts has a records rule;
  - `product_unit` and the channel check match `products` and `channels`.
- **Moves.**
  - Both moves are no-ops on a site already in the target store.
  - `move_orders_to_tables` also refuses duplicate (AWB, day) pairs and pairs that break
    the reuse rule.
  - Times it cannot read become the epoch, which the day views treat as "before the day"
    as before.
  - Backfilled `created_at` is offset by microseconds so the way back restores the
    document's newest-first order.
  - `move_orders_to_document` refuses when issued totals and issue rows differ (archived
    rows). It gives the latest count per (day, product) a matching `demandFingerprint`
    when that count is still current.
- **Read functions** are in C1: `operator_orders_page`, `_day`, `_summary`, `_trace`,
  `_export`, `operator_packer_page` and `operator_packer_counts`. Section 6's
  `/api/orders/people` aggregate has no SQL function. C3 can build it from the export
  pages or add one.
- **Limits:** 10,000 AWBs, 2,000 issues and 20 sort counts per change; change text up to
  8 MB (22023 beyond).

### What C2 must do

- **Signing and calling.**
  - Add `attestRecords` exactly as in 3.6: lines joined by `\n`; sha256 hex of the exact
    change text and of `packerSession ?? ""`.
  - Send the session only for `pack-own`.
  - Treat a replay with `result: null` as a document-commit replay.
- **Order shape.** `Order` gains `version?` and `dispatchedAt?`. `dispatch` may set
  `dispatchedAt`; the database stamps its own time either way.
- **AWB detection rule** for `order`, `edit-order`, `split-order`, upload review and
  release:
  - A same-AWB order already in the hot table is a duplicate or conflict, unless it was
    handed over more than 30 days before the new order's day. Compare Malaysia days: the
    day of `dispatchedAt`, or the existing order's day when that is missing.
  - The slice loader for these commands must load every row with the same normalized AWB
    on any day, including `dispatched_at`, not only the target day.
  - The database gives 23505 for anything that slips through.
- **Packer reads.** Packer reads send the sealed cookie value as `x-operator-packer` on
  the user-scoped client.
