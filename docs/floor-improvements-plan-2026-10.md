# Floor improvements plan (October 2026)

Status: plan, approved for execution. Written 2026-10-09 from the owner's request list after a
full read of the domain rules (`apps/web/src/lib/draft.ts`), the write path
(`apps/web/src/app/api/draft/route.ts`, `apps/web/src/lib/access.ts`), the database
invariants (`supabase/migrations/20261005090000_operator_trusted_commands.sql` and the two
later migrations) and every screen component. No code was changed while planning.

Read [role-based entry and the five-stage route](sv-entry-and-sachet-route.md) first: it
describes the trust boundary every work package below must respect.

## Ground rules for the executor

1. **The API server validates, the database re-checks.** Every new command needs: a case in
   `applyCommand`, a row in `commandRules` (`apps/web/src/lib/capabilities.ts`) **and** the same
   row seeded into `public.operator_command_rules` by a migration; `tests/capabilities.test.mjs`
   fails until both match (extend its `merged()` helper to read the new migration files).
2. **Append-only history stays append-only.** New record lists (returns, drop-offs) get the
   same treatment in `operator_private.assert_core_transition` / `assert_trip_transition`:
   never removed, never rewritten, new entries attributed to `auth.uid()`.
3. **Migrations are additive and rehearsed, never applied to the hosted project by the
   agent.** Each migration gets a rollback file under `supabase/rollback/`, cases in
   `supabase/tests/operator_access.test.sql`, and an entry in
   `scripts/verify-migrations-local.sh` (it currently hard-codes the rollback order; keep it
   current). The owner applies migrations to `operator-effen` after review, in the order they
   are numbered. The app must keep working on a database that has not received them yet
   where that is cheap (see how `resolveAccess` tolerates the missing `factory` column);
   where it is not, say so in the PR.
4. **Toolchain.** Node 24 (`.nvmrc`), pnpm 11.16.0, `pnpm install --frozen-lockfile`. Before
   every push: `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, and
   `scripts/verify-migrations-local.sh` whenever a migration changed (Postgres 16 binaries are
   at `/usr/lib/postgresql/16/bin`).
5. **Bilingual UI.** Every new string goes through `t(en, ms)` / `tr(lang, en, ms)`.
6. **Live data exists.** Site `operator` has real batches, orders and trips since 2026-10-06.
   Every change must read old records unchanged (optional new fields, no re-interpretation of
   existing values) and `createDraft()` (the sandbox seed) must still pass every test.
7. **Docs.** Update `README.md` and `docs/sv-entry-and-sachet-route.md` where a rule they
   state changes (several do: transfer gate, trip fields, packer entry, admin screens).

## Delivery order

Ship as separate PRs on the designated branch, in this order. Each PR must be green on its
own. Packages marked **DB** carry a migration; number them `202610090900xx` in the order
below so rollback order stays obvious.

| # | Package | DB | Why this order |
|---|---|---|---|
| 1 | WP10 Error visibility | no | Every later PR benefits; smallest risk. |
| 2 | WP9 Conflict bug | no | Removes the most-reported blocker; purely server/client. |
| 3 | WP1 Capsule single QC count | no | Domain + UI only; unblocks Faris. |
| 4 | WP2 Adypocide factory/warehouse stages | **yes** | Helmi and Nurul; needs the relaxed transfer gate. |
| 5 | WP3 Stock returns by batch | **yes** | Nurul; new append-only list. |
| 6 | WP5 Daily tally inventory | no | Derived view only. |
| 7 | WP6 Admin screens | no | `landing.ts` only (view-only decision below). |
| 8 | WP7 PDF intake (cover page, OCR, verification) | no | Client parsing + import rules. |
| 9 | WP4 Driver assistants and drop-offs | **yes** | Trip invariants change. |
| 10 | WP8 Packer self-declared counts | **yes** | Largest: new capability, identity bridge, invariant. |

---

## WP1 — Capsule (bottle) process: one QC count at the end

**Request.** "For Capsuling process, no need to input each machine output. Just QC kick in
number at the end of the machine, that's it."

**Today.** Bottle batches have four fixed steps (`bottleSteps`, `draft.ts:92-97`). The
`step` command (`draft.ts:1577-1621`) requires `pic`, `qty`, `qc` for **every** step and sets
`b.actual` from the last step's quantity. The production card (`production-workspace.tsx:302-426`)
opens a form with PIC, output quantity, start/end time and QC result for each step, and shows
each step's output. `BatchRecord` (`production-workspace.tsx:1098-1202`) prints Output per step.

**Decision.** Steps 1–3 (Filling Machine; Capsule Counter & Silica Gel; Bottle Cap & Capping
Machine) record **PIC only** (optional start/end time kept). Step 4 (Batching, Sticker & QC)
records the **QC count** which becomes the batch's finished quantity `b.actual`, plus the
existing QC result select. No per-machine output anywhere.

**Changes.**
- `draft.ts` `step`: `qty` is required and read only when `index === b.steps.length - 1`; for
  earlier steps set `qty: null` and ignore any `qty` input. `qc` is required only on the last
  step (earlier steps store `"not-recorded"`). Keep the `start`/`end` optional fields. Keep the
  rule that a done step cannot be re-recorded. Event text: earlier steps log
  `"<step> · <pic>"`, the last logs `"QC count <n> bottles · QC: …"`.
- Add `isQcStep(b, index)` helper (last bottle step) and use it in UI and tests.
- `production-workspace.tsx`: the step form shows the quantity and QC fields only for the QC
  step; its title says "QC count (finished bottles)". Process rows show the output only on the
  QC step; the card's "Finished" stat stays `b.actual`. `BatchRecord` shows "—" for output on
  non-QC steps and labels the QC step column "QC count".
- Plan form (`BatchPlanForm`) copy: "Assign PICs now or later. The QC count is recorded on the
  last step." Keep `target` (planned bottles).
- Transfer (`transfer` for bottles) is unchanged: needs all steps done and `qty <= actual - sent`.
- Tests: `tests/draft.test.mjs`, `tests/production-pic.test.mjs`, `tests/capabilities.test.mjs`,
  `tests/factory-scope.test.mjs`, `tests/sachet-route.test.mjs` all call `step` with `qty` on
  every step; update them and add: (a) a non-QC step ignores/does not require `qty`; (b) the
  QC step requires `qty` and sets `actual`; (c) historical batches whose early steps carry a
  `qty` still display and transfer.
- Docs: README "Production PIC planning and changes" and the Overview copy "Record batches,
  machine responsibilities and bottle output".

**Acceptance.** Faris records a capsule batch with three PIC-only entries and one QC count;
the batch shows finished = QC count and can be sent to fulfilment. Old batches render as before.

---

## WP2 — Adypocide: production records 2 stages, stock-in records the last 3 before the box count

**Request.** "Adypocide: remove last 3 machines under production (Helmi fills the first 2
only); the rest are filled on Stock-in." and "To finalize sachet stock count, Nurul needs to
key in the last 3 machine PICs to finalize."

**Today.** The five-stage route `sachet-v2` (`draft.ts:135-152`): mixing, filling, batching,
hologram, wrapping. Production **and** Stock-in can already record any stage (`machine`
command, `draft.ts:1331-1380`, capability `stage.record` held by both roles). But:
- `transfer` (`draft.ts:1622-1645`) refuses unless `batchComplete(b)` (all route stages done).
- The database transfer gate (`20261005090000…sql:394-414`, now inside
  `assert_core_transition`) independently refuses a newly transferred batch with a route
  snapshot unless **every** route stage is done with a PIC.
- `stock-in-ady` (`draft.ts:1718-1755`) creates box stock with no stage check at all.
- The production card (`AdypocideProductionCard`, `production-workspace.tsx:765-849`) and the
  Stock-in panel (`SachetProductionRecords`, `sachet-records.tsx:881-983`) both render all five
  stages through `StageRecords`.
- `tests/sachet-route.test.mjs:75` and the SQL test "five-stage transfer without Hologram"
  pin the current gate.

**Decision.** Split every sachet route into **factory stages** (`mixing`, `filling`) and
**warehouse stages** (everything after). Rules:
1. Production may record any stage (unchanged capability) but the production screen shows only
   the factory stages; the warehouse stages appear there read-only as "Recorded at stock-in".
2. **Send to warehouse** requires the factory stages complete with a PIC. Warehouse stages are
   not required and are normally still open.
3. Stock-in records the warehouse stages (batching, hologram, wrapping) on the receipt
   awaiting boxing. **Finalize box count** (`stock-in-ady`) requires every stage of the route
   complete with a PIC; the button stays disabled with the count "2 of 3 warehouse stages
   recorded" until then.
4. The database enforces both gates: transfer needs the factory stages; a new carton for a
   sachet batch with a route snapshot needs all route stages.

Keep the route id `sachet-v2` (same stage list; only the gates move). The split is by stage
key, defined once in TypeScript (`factoryStages = ["mixing", "filling"]`) and once in SQL, with
a parity test like `tests/factory-scope.test.mjs` does for `product_factory`.

**Changes.**
- `draft.ts`: export `factoryStages`; add `factoryStagesDone(b)` and `warehouseStages(b)` /
  `warehouseStagesDone(b)` next to `batchComplete`. `transfer` for sachet: require
  `factoryStagesDone`; error text "Record a machine and PIC for the mixing and filling stages
  before sending to the warehouse." `stock-in-ady`: require `batchComplete(batch)` (all stages);
  error "Record the warehouse stages (batching, hologram, wrapping) with their PICs before
  finalizing the box count." Legacy batches without a route snapshot (`legacy-freeform`) skip
  the box-count gate (they are historical).
- `machine` command currently refuses once `batchTransferred(b)` ("already sent to the
  warehouse", `draft.ts:1336`). Lift that for **warehouse stages** (they are recorded after
  transfer by design); keep it for factory stages. Same for `stage-rework` (allow warehouse
  stage rework until the box count is finalized). `markRevision` should **not** flag a
  warehouse-stage completion after transfer as a "revision" — it is the normal flow. Flag it
  only for factory-stage corrections and for any change after the receipt is stocked in.
- Migration `20261009090001_operator_warehouse_stages.sql`: `create or replace`
  `operator_private.assert_core_transition` with (a) the transfer gate checking only route
  stages whose key is in `('mixing','filling')`; (b) a new gate: every carton that is **new** in
  this transition and whose batch has a non-null `route` must have every route stage done with
  a non-empty PIC in the **new** state (`unit` box; cartons of bottle batches have no route so
  they pass). Add `operator_private.factory_stage(text)` returning boolean for the parity test.
  Rollback restores the 20261005 body (the 20261006 trips migration renamed it; mind the name).
- SQL tests: change "five-stage transfer without Hologram" to expect `ok` once mixing and
  filling are done; add "transfer without filling" → `23514`; add "box carton before warehouse
  stages" → `23514`; add "box carton after all stages" → `ok`.
- UI, production: `AdypocideProductionCard` passes `stages={factory}` to `StageRecords` (add a
  `stageFilter` prop) and renders the warehouse stages as a compact read-only list with a
  "Recorded at stock-in" caption. The transfer button enables on `factoryStagesDone`. Copy:
  "Record the mixing and filling PICs, then send the batch to the warehouse. Batching,
  hologram and wrapping are recorded by stock-in before the box count."
- UI, stock-in (`draft-app.tsx:1464-1579` receipts table + `finalizeAdypocide`): each receipt
  awaiting boxing shows its three warehouse stages inline (`StageRecords` with the warehouse
  filter, editable with `show`/`pic`) and a progress pill "n/3 warehouse stages". "Finalize box
  count" disabled until 3/3 (tooltip/hint says why). Keep `SachetProductionRecords` (full
  five-stage view) below for history and corrections.
- Plan form copy for sachet: "Five fixed stages. Production records mixing and filling; the
  warehouse records batching, hologram and wrapping during stock-in."
- Tests (`tests/sachet-route.test.mjs`, `tests/draft.test.mjs:89`): transfer after two factory
  stages; transfer refused with only mixing; `stock-in-ady` refused until all five; intake
  records warehouse stages after transfer without a revision flag; a production correction of
  a factory stage after transfer still flags a revision; legacy `sachet-v1` batch follows the
  same split (mixing, filling → transfer; batching, wrapping → box count).
- Docs: `docs/sv-entry-and-sachet-route.md` "Five-stage sachet route" and "Write path" bullet
  "a batch with a route snapshot needs every stage completed with a PIC before transfer" become
  the two-gate rule; README "Adypocide production and stock-in".

**Open point for the owner (does not block).** If a sachet batch was transferred before this
change with all five stages done, nothing changes for it. If one is currently in production
with only some stages done, it will transfer as soon as mixing and filling are done.

---

## WP3 — Stock returns by batch

**Request.** "Return by batch (select batch, then add return). User should be able to click
past batches and key in a return amount, so that batch then has stock back."

**Today.** Carton balance `available()` (`draft.ts:537-545`) = received − issued − boxed +
adjustments. The only way to add stock back is `count` + `adjust` (requires a physical count
first, `stock.adjust`, and refuses if stock moved since the count). Nothing models a return.

**Decision.** A new append-only record `Return` and command `return` (capability
`stock.receive`, Stock-in supervisor). A return goes **back into an existing stock carton of
the batch** (its rack), increases that carton's available balance, and is never edited or
removed. It is not a stock issue reversal: existing `issues` stay as recorded (traceability),
the return is its own movement with reason, PIC, optional AWB reference and optional note.

**Changes.**
- `draft.ts`: `interface Return { id; cartonId; qty; reason; pic; awb?; at; recordedBy? }`,
  `Draft.returns?: Return[]`; `available()` adds `+ returns`; `batchReturned(s, b)` helper.
  Command `return`: `allow("intake")`; `cartonId` must be a stock carton
  (`c.unit === product(c.product).unit`); `qty` ≥ 1; `reason` required; `awb` optional
  (normalized with `normalizeAwb`, max 40 chars, not validated against orders — the parcel may
  predate Operator); log "Stock returned to rack" on the batch entity. Add `returns` to the
  "workspace full" limits (≤ 2000).
- `capabilities.ts`: `return: { capability: "stock.receive", stateKeys: ["returns", "events"] }`.
- Migration `20261009090002_operator_stock_returns.sql`: insert the command rule; in
  `assert_core_transition` add `returns` to the append-only list, require each return to have
  an id, a positive whole `qty` and a `cartonId` that exists in `cartons`, and include
  `+ returns` in the balance CTE so the "below zero" check stays exact. SQL tests: return to a
  carton (`ok`), return with qty 0 (`23514`), rewrite an existing return (`23514`), return to an
  unknown carton (`23514`).
- UI (Stock-in page, `draft-app.tsx` warehouse view): toolbar button **Record a return**. Form:
  step 1 select batch (all batches with at least one stock carton, newest first, label
  "Product · batch code · rack(s) · available"); step 2 carton (auto-selected when the batch
  has one carton; otherwise a select), quantity, reason, optional AWB, PIC. Implement as one
  `ActionForm` whose carton options are computed from the chosen batch — `ActionForm` has no
  dependent fields today, so add a small `dependsOn` mechanism or render the carton choice in
  the form spec after a first "Choose batch" dialog (two-step is acceptable and simpler).
- "On the racks" table: add a **Returned** column; the trace sheet lists returns under the
  carton with reason and AWB; `stockTable()` (Overview and Reports) adds "Returned".
- Tests (`tests/draft.test.mjs`): return raises `available`; cannot return to a loose-sachet
  carton or an unknown carton; reason required; issued stock plus return reconcile in the
  carton trace; `outOfScopeKeys` stays empty.
- Docs: README "Stock in" paragraph and the invariants list in `sv-entry-and-sachet-route.md`.

---

## WP4 — Driver trips: several assistants, several drop-offs with photo and time

**Request.** "Assistant driver more than one (click to add more)." and "A plus button to add a
drop-off add-on; each drop-off needs a picture and time as proof, so one trip can have multiple
drop-offs."

**Today.** `Trip` (`draft.ts:411-428`) has one `assistant` string, `pickupAt`, optional
`arriveAt`, optional `photo`. `trip-update` (`draft.ts:2409-2442`) may only add a missing
arrival or photo. The database (`20261006090000…sql`, `assert_trip_transition`) allows an
existing trip to gain only the keys `arriveAt`, `arrivalRecordedAt`, `photo`,
`photoRecordedAt`, and only by its own driver; new photo paths must be in the driver's folder.
`ActionForm` (`draft-primitives.tsx:790-963`) has no repeatable field and no "required photo".

**Decision.**
- `Trip.assistants: string[]` (new, 0–5 names, each 1–100 chars, trimmed, distinct). Keep
  `assistant` for old trips and set it to the first name on new trips so every reader of the
  old field keeps working; display joins `assistants` when present.
- `Trip.dropoffs?: Dropoff[]` with `{ id, at, photo, note?, recordedAt }`; **photo and time
  are both required** per drop-off. New command `trip-dropoff` (capability `trips.log`,
  stateKeys `trips, events`): only the trip's own driver; `at` ≥ `pickupAt`, not in the future
  (reuse `tripTime`), ≤ `arriveAt` when arrival is already recorded is **not** enforced (a
  driver may log arrival first and backfill a drop-off; keep `at` ≤ now only); photo path
  validated with `tripPhotoPath` and the server-side storage check (`requireTripPhoto` already
  runs for any `trip*` command with `input.photo`). Max 20 drop-offs per trip.
- `trip-update` stays as is (arrival/photo).

**Changes.**
- `draft-primitives.tsx`: new `Field.type = "list"` (text inputs with "+ Add another" and
  remove buttons, serialized as `name_0`, `name_1`, …; the domain reads `assistants` by
  collecting `assistant_<i>` keys) — or accept a JSON hidden input; pick one and document it.
  Photo field gains `required`: `TripPhotoInput` sets `setCustomValidity` on the file input
  while `path` is empty and `required` is true, so native validation blocks submit.
- `driver-trips.tsx`: "Log a trip" form uses the list field for assistants; trip cards and the
  table get a **+ Drop-off** button (own, open trips and also trips with arrival already logged
  — a driver may still add proof after arrival); drop-offs render as a sub-list (time, photo
  thumbnail via `TripPhoto`, note) under each trip for the driver and for `trips.read`
  reviewers; metrics add "Drop-offs today".
- `api/trip-photos/route.ts`: unchanged (same bucket and folder rules apply to drop-off photos).
- Migration `20261009090003_operator_trip_dropoffs.sql`: insert command rule
  `('trip-dropoff','trips.log','{trips,events}')`; `create or replace`
  `assert_trip_transition`: allow `dropoffs` to be **appended** on an existing trip by its own
  driver (old `dropoffs` ⊆ new `dropoffs` element-wise, nothing else on the trip changed), each
  new drop-off needs `id`, `at`, and a `photo` matching the driver's folder pattern; `at` ≥
  `pickupAt`. Also allow `assistants` on new trips (no rule needed beyond "new trip attributed
  to the driver"). SQL tests: add a drop-off (`ok`), another driver adds one (`23514`), rewrite
  an existing drop-off (`23514`), drop-off without photo (`23514`), drop-off photo in another
  driver's folder (`23514`).
- Tests (`tests/driver-trips.test.mjs`): assistants list validation; drop-off happy path and
  refusals; old single-`assistant` trips still read; `outOfScopeKeys` empty.
- Docs: `sv-entry-and-sachet-route.md` "Driver trips" and README "Driver trips".

---

## WP5 — Daily tally: inventory in sync with issued stock

**Request.** "For the Daily tally tab, inventory out in sync with current inventory count
(show inventory count after deduction), so QC is easy on a daily basis."

**Today.** `dailyTally` (`draft.ts:613-637`) shows required, supervisor count, issued, packed
per product; the current rack balance is only on the Stock-in page and Overview.

**Decision.** Add a derived **Inventory** block to the Daily tally screen (and the same figures
to the CSV export): per product, for the selected day in Malaysia time:
`opening on rack` (balance before that day's movements) · `issued that day` · `returned that
day` · `received that day` · `on rack now` (today) or `closing` (past days). Derived only from
cartons, issues, returns, boxing and adjustments by their `at` timestamps — no new records.

**Changes.**
- `draft.ts`: `dailyInventory(s, date)` → per product `{ opening, received, issued, returned,
  adjusted, closing }` using `toMyt(at).slice(0,10)` to assign movements to a day. Define
  `closing = opening + received + returned + adjusted − issued`, and assert in a test that
  `closing` for today equals the sum of `available()` over the product's stock cartons.
- `order-workspace.tsx` (`mode === "tally"`): new panel "Inventory for the day" under the tally
  table with those columns plus a Δ against the tally's `issued` so a mismatch between "issued
  to packing" (demand side) and "left the rack" (stock side) is visible — they should be equal.
- `exportReport()` in `draft-app.tsx`: append an inventory section or a second file; keep the
  parcel CSV columns unchanged.
- Tests: `tests/fulfilment.test.mjs` day boundary at midnight MYT; return (WP3) counted in.

---

## WP6 — Office admin can open Stock-in and Stock-out screens

**Request.** "Admin: access to stock out and stock in."

**Today.** `apps/web/src/lib/landing.ts` `views`: admin may open `input`, `orders`, `overview`,
`feedback`. The Stock-in screen (`warehouse`) is intake-only; `tally` and `packing` exclude
admin. Capabilities (`capabilities.ts`): admin has `orders.import`, `orders.enter`,
`sources.read`, `feedback.post` — no stock capabilities, in the database too.

**Decision (recommended, implement now): view-only.** Add `admin` to the `warehouse`, `tally`
and `packing` views in `landing.ts`. Every action on those screens is already gated by
capability checks (`can("stage.record")`, `role === "outbound"`, etc.), so Hadera sees the
records without buttons she cannot use. Sidebar order: keep her home on `input`.

**Not done unless the owner asks:** letting admin *record* stock-in/stock-out needs
`stock.receive` / `outbound.fulfil` added to the admin role in `capabilities.ts` **and** in
`operator_role_capabilities` by migration, and the `allow("intake")` / `allow("outbound")`
role checks in `applyCommand` loosened. Flag this as a question in the PR description; do not
guess.

**Changes.** `landing.ts` roles arrays; `tests/landing.test.mjs`; README "Staff accounts" role
table in `sv-entry-and-sachet-route.md` ("Office admin: … read stock-in and stock-out screens").
Check the warehouse view renders without `show`/`pic` for a role lacking `stage.record`
(it already passes `undefined` when the capability is missing).

---

## WP7 — PDF intake: skip the cover page, make OCR automatic, stop verifying every page

**Requests.** (a) "OCR: remove the first page of the PDF; usually the first page is the title."
(b) "Remove the requirement to click OCR?" (c) "Remove the need to verify all pages."

**Today.**
- `read-awb-pdf.ts:56-57`: a page is OCR'd only when `forceOcr` is set or its extracted text is
  under 60 non-space characters. Pages that have a little real text (a header, a store name)
  but the label as an image are **not** OCR'd, so no AWB is found and the admin learned to tick
  "Use OCR on every page" (`awb-intake.tsx:501-512`) every time. That checkbox is the "click
  OCR" the request refers to.
- `parsePages` (`awb-import.ts:159-337`) creates one row per page even when nothing was found
  (`awb: ""` → "Unidentified label"), so a cover page becomes a row that must be excluded with
  a note before the batch can be confirmed.
- Every OCR'd page gets the warning "Check OCR transcription against the PDF"
  (`awb-import.ts:272-273`); `rowProblems` (`awb-import.ts:371`) treats any warning on an
  unreviewed row as a problem, and `validateImport` (`awb-import.ts:536-537`) refuses a
  reviewed row without a `reviewNote`. Result: with OCR on, **every page** needs the "I checked"
  box **and** a typed note. That is the "verify all pages" burden.

**Decisions.**
1. **Automatic OCR, no checkbox.** OCR a page when text extraction finds no tracking number and
   no order reference (run the same detection `parsePages` uses; extract the regexes into a
   shared `detectReferences(text)` helper), not only when the text is short. Keep the checkbox
   but relabel it as the fallback "Force OCR on every page (slow)" and unticked by default.
2. **Non-label pages are skipped, not turned into rows.** A page with no tracking number, no
   order reference and no known SKU token is recorded as skipped (`ImportFile.skippedPages:
   number[]`, shown as "1 page skipped (cover/title)" in the review summary) and produces no
   row. "Add missed label" still lets the admin point at any page, so nothing is lost. Do not
   special-case page 1; the same rule removes separators and summary pages.
3. **Verification only where there is something to verify.** The OCR warning becomes
   informational: shown in the editor as "Read by OCR — compare with the PDF" but **not** a
   blocking problem. `rowProblems` keeps blocking on real issues (missing AWB/order/courier/
   product, multiple labels on one page, conflicting quantities, gift lines, repeated SKU).
   `reviewed` keeps its note requirement only for `excluded` rows; a reviewed row needs no note.
   The "I checked the flagged fields" box is required only when the row has blocking warnings.

**Changes.** `read-awb-pdf.ts` (page decision), `awb-import.ts` (`detectReferences`, skipped
pages, warning class split into `warnings` vs `notes`, `rowProblems`, `validateImport`),
`awb-intake.tsx` (summary, editor, checkbox copy, hint text), `tests/awb-import.test.mjs`
(cover page skipped; OCR note non-blocking; excluded still needs a note; a page with text but
no references triggers OCR — unit-test the decision function, not Tesseract). Keep the 200
page / 200 row limits. Docs: README "Input orders".

---

## WP8 — Packers record their own parcel counts

**Request.** "Packers should do the count-in: when they complete a parcel they key in the
product number."

**Today.** `pack` (`draft.ts:2175-2233`) is `allow("outbound")`: the stock-out supervisor
records the actual packer's count. Packer role has only `feedback.post` (and the DB seed
agrees). The packing screen (`draft-app.tsx:1809-1995`) makes a packer **choose a packer
profile from a dropdown** and shows "Your supervisor records this count." Assignments use
`assignedPacker` = a staff profile id when `state.staffProfiles` exists, else a name from the
sample `people` list — and the live site has no `staffProfiles`, so today's live assignments
use the sample names. A signed-in packer has `membership.display_name` and an optional
`staff_profile_id` (`supabase/server.ts`), neither of which the packing screen uses.

**Decision.** Packers get a capability `packing.declare` and a command `pack-own` that records
the count for a parcel **assigned to them**. Identity is bridged on the server: a member's
packer id is `staff_profile_id ?? user_id`; the server exposes the site's packer memberships to
supervisors so assignments use the same ids. The supervisor path (`pack`, `correct`) stays.

**Changes.**
- `capabilities.ts`: `packer: ["packing.declare", "feedback.post"]`; `"pack-own": {
  capability: "packing.declare", stateKeys: ["orders", "events"] }`. Update
  `authorizeMember` in `access.ts` so a packer's denial text mentions their own parcels.
- Server, `GET /api/draft` (`route.ts`): for members, add `actor.packerId` (`staffProfileId ??
  userId`) and `staff: { id, name, role }[]` = active packer (and driver) memberships of the
  workspace that RLS lets the caller read (supervisors can; packers get an empty list). Client
  `packerOptions` (`draft-app.tsx:933-939`, `order-workspace.tsx:88-94`) prefer `staff` over
  `state.staffProfiles` over `people`. The domain's packer validation (`assign-package`,
  `assign-orders`, `pack`) must accept ids from `cmd.staff` passed by the server (add
  `Command.staff?: { id, role }[]`; validation order: `staff` → `staffProfiles` → `people`).
- `draft.ts` `pack-own`: `allow("packer")`; order must be reviewed, single-product, not
  dispatched, `actual === null`, and `o.assignedPacker === recorder.packerId` (add
  `Recorder.packerId`; in the preview sandbox fall back to the `pic` input so the demo keeps
  working); reads `actual` (or `actual_<product>` for line orders) and optional `occurredAt`;
  sets `actual`, `packer = assignedPacker`, `labelPic = packer` (one person packs and attaches
  the label unless the supervisor says otherwise), `packedAt`, `packRecordedAt`,
  `packRecordedBy`. Log "Parcel quantity declared by packer".
- Migration `20261009090004_operator_packer_declarations.sql`: seed the capability and command
  rows; in `assert_core_transition` add an **orders** rule that applies when the caller's active
  role is `packer` (pass `v_role` into the assertion or read it inside): every order that
  differs between old and new must (a) have `assignedPacker` equal to the caller's
  `coalesce(staff_profile_id, user_id::text)` at that workspace, (b) have had `actual` null
  before, and (c) differ only in `actual`, `lines[*].actual`, `packer`, `labelPic`, `packedAt`,
  `packRecordedAt`, `packRecordedBy`. SQL tests: packer declares own parcel (`ok`), another
  packer's parcel (`23514`), re-declares (`23514`), edits `expected` (`23514`), supervisor path
  unchanged (`ok`).
- UI, packing screen: for a packer member, no dropdown — the screen opens on their own
  parcels (`assignedPacker === actor.packerId`), each card has **Record my count** → `pack-own`
  with one number per product line and the optional "when" field; after saving the card shows
  the count and "Entered by you". Supervisors keep the current screen and can still record or
  correct. Packer summary (`PackerPackageSummary`) unchanged.
- Daily tally "Tally by assigned packer": add a column "Entered by" (packer / supervisor) from
  `packRecordedBy.role`.
- Tests: `tests/draft.test.mjs:398` family, new `tests/packer-count.test.mjs` (own parcel ok;
  other packer refused; unassigned refused; cannot overwrite; `outOfScopeKeys` empty; sandbox
  fallback), `tests/capabilities.test.mjs` parity with the new migration.
- Docs: README "Packing station" and "Prepared boundary for staff accounts" (now partly
  delivered), role table in `sv-entry-and-sachet-route.md` (Packer: declare own parcel counts).
- **Owner action after deploy:** packer accounts must exist (none today) and be granted at the
  site; if the owner wants assignment names to differ from login names, set
  `staff_profile_id` on the packer memberships.

---

## WP9 — Bug: "A teammate changed the shared records. Refresh to load their changes before trying again."

**Today.** One JSON document and one revision per site (`docs/sv-entry-and-sachet-route.md`
"Known limits", readiness issue #10). The client sends the revision it loaded
(`draft-app.tsx:456`); the server (`route.ts:185-193` sandbox, `route.ts:301-308` members)
returns 409 whenever **anyone** has saved since, even an unrelated record (a driver logging a
trip blocks a packer's count). The client never refreshes on its own, so after any colleague's
save the next action fails until the person presses Refresh. With 11–14 concurrent users this
is constant. The message is also shown at the top of the page or inside the form only.

**Decision.** Two layers, no storage redesign:
1. **Server-side rebase.** On a revision mismatch the server reloads the latest state and
   re-applies the command on top, up to 3 attempts, then commits with the fresh revision. This
   is safe because `applyCommand` validates every command against the state it is applied to
   (stock availability, duplicate AWBs, stale `expectedVersion`, import `updatedAt`, receipt
   already stocked, …) and the database re-checks invariants; the operation id makes retries
   idempotent. True record-level conflicts still surface as `ConflictError` (409 `record`). The
   client's `revision` becomes a hint, not a lock. Apply the same loop to the sandbox path. Log
   nothing new; the `operator_commits` row already records the result revision.
   Implementation: wrap "load → validate/apply → commit" in a function; retry when the RPC
   returns no row (stale `p_expected_revision`) or the sandbox `update … eq(revision)` matches
   nothing. Keep the operation-id replay check **inside** the loop (first thing after load).
2. **Client freshness.** `draft-app.tsx`: refresh the workspace on `visibilitychange` (tab
   becomes visible) and every 60 s while idle (no open form, not busy), silently, keeping the
   open screen and selections; after a successful save the response state is already applied.
   On a 409 that survives the rebase (`code: "record"` or `"revision"`), reload the state
   automatically, keep the form open with the user's values, and show the error next to the
   submit button with a **Try again** action (WP10 makes it prominent). Rename the message:
   "Someone else changed this record while you were editing. The latest version has been
   loaded — check it, then save again."

**Tests.** `tests/sv-entry.test.mjs` or a new `tests/rebase.test.mjs` exercising the server
loop with a stubbed `db` (two writers, second one rebases; a stale `expectedVersion` still
conflicts; the same operation id replays). Integration scenario (`tests/integration/
scenario.mjs`) gets a two-browser case: A saves, B saves without refreshing, B succeeds.

**Docs.** `sv-entry-and-sachet-route.md` "Known limits" first bullet and README "Refresh
retrieves other users' changes; optimistic revision checks prevent concurrent overwrites".

---

## WP10 — Errors that are impossible to miss

**Request.** "Make errors easy to see (popup, colour change). The error is too far from the
button; show it closer to the button, or bigger and obvious."

**Today.** `.form-error` (`globals.css:1390-1398`) is 12 px text in a pale red box. Page-level
errors render under the page heading (`draft-app.tsx:2601-2612`); `BatchPlanForm` (`production-
workspace.tsx:851-1058`) and `AwbIntake` (`awb-intake.tsx:411-415`) surface errors at the top
of the page/tab, far from their submit buttons at the bottom. `ActionForm` shows its error
above the buttons but does not scroll to it or mark the field. Server validation messages use
field keys ("Please complete pic.").

**Changes.**
- New `FormError` component in `draft-primitives.tsx`: 14–15 px, strong red border and
  background, `AlertTriangle` icon, `role="alert"`, `tabIndex=-1`; on mount it
  `scrollIntoView({ block: "nearest" })` and takes focus; optional `action` slot (e.g. "Try
  again"). Replace every `div.form-error` with it.
- Place errors **next to the button that caused them**: `BatchPlanForm` gets its own error
  state above its "Save batch plan" button (`onSave` must return the error instead of relying
  on page-level `setError`); `AwbIntake` renders its error above the "Read PDFs" / "Confirm
  orders" buttons; the import-receive form likewise. In `ActionForm`, keep the error above the
  buttons and additionally outline the submit button red (`aria-describedby` to the error) for
  the next 3 s.
- Page-level errors (outside any form) also appear as a fixed bottom toast (`.toast-error`,
  high contrast, dismiss button, auto-hides after 8 s unless hovered) so they are visible
  regardless of scroll position. Keep the inline copy too.
- Map server messages to fields: in `command()`, when the message matches
  `/Please (complete|enter) ([a-zA-Z_]+)\./`, replace the key with the field's label from the
  open `FormSpec` ("Person responsible (PIC) is required") and set `aria-invalid` on that input
  (`ActionForm` accepts `invalidField`). Server messages are unchanged.
- Native validation: before submit, `ActionForm` calls `reportValidity()` so the browser
  scrolls to the first invalid field; add a visible helper under required fields left empty on
  a failed submit.
- Dark theme: verify contrast of the new tokens in both themes (`:root` and `.dark`).
- Tests: none for CSS; a small DOM test is not in the stack — verify in `pnpm build` and a
  manual pass; the integration scenario can assert the alert is focused after a refused save.

---

## Owner decisions (decided 2026-10-09)

The owner confirmed every default on 2026-10-09. These are now the rules; the alternatives
are kept for the record only.

| Topic | Decision | Alternative not taken |
|---|---|---|
| WP6 Admin on stock screens | View-only access to Stock-in, Daily tally and Packing station; no new capabilities | Grant record capabilities (migration + capability change) |
| WP7 "click OCR" | Automatic OCR when a page's text yields no AWB or order reference; checkbox kept as a slow, unticked fallback | Remove the checkbox entirely |
| WP7 cover page | Skip any page with no tracking number, no order reference and no known SKU; "Add missed label" can still point at it | Always skip page 1 |
| WP3 returns | Back into an existing stock carton of the batch, on its rack | New carton/rack per return |
| WP4 drop-off time vs arrival | Drop-offs may be logged before or after arrival, never in the future | Require drop-offs before arrival |
| WP8 label PIC | The packer who declares the count is also "AWB attached by" | Ask for a second name |

Also confirmed: no packer or driver accounts exist yet; WP8 ships with the identity bridge and
the owner creates packer logins and memberships afterwards.

## Verification checklist (every PR)

- `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`
- `scripts/verify-migrations-local.sh` when a migration changed (updates to its rollback
  order and reference-row checks included)
- `tests/capabilities.test.mjs` passes against the new migration files (extend `merged()`)
- README and `docs/sv-entry-and-sachet-route.md` describe the new rule; the go-live record is
  not rewritten, a dated section is added
- No hosted database command was run; migrations are listed in the PR for the owner to apply
