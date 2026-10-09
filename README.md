# Operator EFFEN

Operator EFFEN is an authenticated operations test workspace. The workflow previews use fictional data; individual staff authentication is a later rollout step.

## Production readiness planning

The [production readiness plan](docs/production-readiness-plan.md) and [execution backlog / continuation guide](docs/production-readiness-backlog.md) cover speed, concurrent staff, transactional inventory, security, uptime, recovery and three-hour offline operation. Track implementation in [epic #7](https://github.com/nadeemramli/operator-effen/issues/7) and its seven workstream issues.

Confirmed sizing: 7–10 packers on phones, up to 2 production users and 2 supervisors on laptops (11–14 concurrent users). Architecture and release targets are proposals; publishing this plan does not establish live factory readiness. See the dated baseline and decision register before continuing on another computer.

## Stack

- Node.js 24 (see `.nvmrc`), pnpm 11.16.0
- Next.js 16.3.5, React 19.2.4, TypeScript
- Tailwind CSS 4, shadcn-compatible theme, Geist typography
- Supabase for the operational database and planned authentication; CLI pinned to 2.117.0
- Vercel for hosting

The workspace layout (`apps/web`), framework family and theme align with Fullkit. Next.js and its ESLint config use 16.3.5 to address dependency advisories affecting the original 16.2.11 baseline. The theme was copied from Fullkit commit `c56d0b4b311a8bff13582238f5ce566b6e272c57`; Geist uses its bundled font package so builds do not need Google Fonts access.

## Local setup

```sh
nvm install
nvm use
corepack enable
corepack prepare pnpm@11.16.0 --activate
pnpm install --frozen-lockfile
```

Link the checkout to the agreed Operator Supabase project and Vercel project. Get the Supabase project reference from the private environment setup record or its dashboard. Authenticate the CLIs with your own access if needed.

```sh
pnpm exec supabase link --project-ref <operator-project-ref>
pnpm dlx vercel@59.23.2 link --yes --project operator-effen --scope nadeemramlis-projects
pnpm dlx vercel@59.23.2 env pull apps/web/.env.local --environment=development --yes --scope nadeemramlis-projects
pnpm check:env
pnpm check:connection
```

Environment values are ignored by Git. `check:connection` verifies that the app URL matches the locally linked Supabase project and checks the Auth health endpoint. It does not verify login flows, RLS or application tables.

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm dev
```

The placeholder can build without a database connection. A successful build alone does not imply database or authentication readiness.

## Environments

The new Operator Supabase project is the development backend during the foundation phase. It is separate from Fullkit's database and currently contains no application tables or business records.

Vercel's **Development** and **Preview** environments receive the public Supabase URL and publishable key. Production database variables are deliberately unset. Establish database separation before introducing live operational data.

The committed `supabase/config.toml` is generated local CLI configuration, with seeding disabled until reviewed seed data exists. It has not been pushed to the hosted project's service settings. Do not run a database reset or configuration push against a hosted project as a setup shortcut.

## Hosting

Vercel is linked to this repository with root directory `apps/web`, framework Next.js, Node.js 24.x and a frozen pnpm install. Git pushes can trigger deployments. Custom domain setup is deferred.

Never put service-role or secret keys in variables beginning with `NEXT_PUBLIC_`. The app currently needs only the publishable key.

No database migrations, catalog imports, production records or user accounts are included. Authentication/access rules and the reporting connection to Fullkit are separate implementation steps.

## Repository boundary

Keep credentials, AWB/customer documents, staff rosters and private business documentation outside this repository. The requirements remain in the private Operator knowledge folder.

## Team UI draft

The deployed workspace is a shared, fictional test sandbox with an authenticated
role preview for production, stock in, stock out, office admin, packing and management.
Its English/Malay interface uses Fullkit's theme tokens and Geist fonts.

- Supabase Auth checks the administrator-controlled `ui_draft_access` app metadata.
  The shared test credentials are distributed privately, never committed.
- The only persistence table is `ui_draft_workspaces`. RLS limits access to the
  approved authenticated account's row. State revisions reject concurrent overwrites.
- Role selection previews workflows; it is not separate employee authentication.
- The database is dedicated to this draft. Vercel's **Production hosting target**
  points to this test backend so the stable Vercel URL is available to the team;
  that label does not mean live operational inventory.
- No live stock, messaging integrations or Fullkit writes are involved. Bulk AWB PDF intake is implemented; keep source documents and customer data private.

Run `pnpm test` for the stock conservation, traceability, role-action and correction
invariants. Run `pnpm lint`, `pnpm typecheck` and `pnpm build` before publishing.

The draft supports batch steps, factory transfers, carton receipt, explicit
Adypocide box-count stock-in, monthly carton counts and reasoned adjustments, manual
AWBs, stock issue, packer declarations, supervisor quantity corrections, separate
courier handover, trace lookup, management review notes, CSV export and shared feedback.
The test reset is destructive only to this sandbox and requires UI confirmation.

Known boundaries: sample packages and staff; one product per AWB and one batch per
carton; aggregate workspace reports; embedded PDF text extraction and browser-local OCR;
no external order integrations. Process-record correction and real approval permissions
need the remaining operational decisions before live use. A recorded QC grouping
does not imply QC was performed or passed. Parcel declarations and allocation logs
are evidence of recorded work, not a physical guarantee of parcel contents.

### Adypocide production and stock-in

New sachet batches use the versioned five-stage route under one batch number: Mixer
machine (mixing), Sachet filling machine (filling), Inkjet printer (batching), Hologram
machine, and Shrink machine (plastic wrapping). Each stage records its actual PIC and
optionally the physical machine and actual time, with no sachet quantities. All five
actual stage records are required before warehouse handoff. Completed four-stage batches
keep their historical route; unfinished ones need an explicit route review. Production
and Stock-in edit the same stage records. See
[role-based entry and the five-stage route](docs/sv-entry-and-sachet-route.md).
Historical free-form machine records keep their original labels and PICs; they
are not automatically mapped to the new stages. A factory handoff and warehouse receipt do not create stock.
After warehouse boxing, the stock-in supervisor finalizes the receipt with the
actual finished box count (one box is one inventory unit), stock carton reference,
and rack. The box carton retains its receipt and batch links for machine/PIC tracing.
Bottle production continues to use its existing quantity-based process.

Existing loose-sachet records remain historical data. Any remaining unboxed
contents appear as receipts awaiting a fresh finished-box count; old quantities
are never converted into box inventory. Previously counted boxes remain stock.

### Daily order fulfilment (test workspace)

- **Input orders:** Admin uploads and reviews bulk AWB PDFs. Admin or stock-out can
  manually enter an AWB, including keyboard-style barcode input, without a PDF.
  Manual entries must be reviewed before joining demand; pending records can be edited.
  Scanning a barcode supplies only the reference, not the parcel contents.
- **Order management:** Filter by Malaysia fulfilment day, product/brand, package,
  or AWB/order/channel text. Package summaries show AWBs and required bottle/box units.
- **Incoming orders:** Record already-printed labels, then save the supervisor's
  independent unit count by product. Differences and recounts require a note.
  Issue stock from a rack carton to selected AWBs, then assign them to a packer.
  Each issue retains carton/batch traceability. Bulk issues fill remaining AWB demand
  in displayed order; they cannot overdraw stock or silently allocate excess units.
- **Packing station:** On the shared packer sign-in, each packer taps their name, enters
  their own PIN and records the actual packed count for the AWBs assigned to them. The
  stock-out supervisor sets up packer profiles and PINs, can also record for a packer (a
  different actual packer needs a reason), and corrects saved counts. Unassigned AWBs are
  rejected. See [shared packer sign-in](docs/sv-entry-and-sachet-route.md#shared-packer-sign-in-and-pins).
- **Daily tally:** Compare required units, supervisor count, issued stock and actual
  packed units per product and per assigned packer. Missing entries and mismatched
  AWBs remain visible even if opposite errors cancel in the aggregate. Each count
  preserves the demand snapshot, PIC, timestamp and reason. New/changed orders mark
  the earlier count stale and require a fresh count before more allocation/assignment.
- The day changes at midnight in Asia/Kuala_Lumpur. Supervisors can manually carry
  unpacked AWBs forward; stock allocations and assignments follow the AWB, and the
  old day's checkpoint is flagged because its order set changed.

TikTok printing does not sync orders into Operator. No TikTok API, printer listener,
camera scanner or automatic ingestion integration has been added. Refresh retrieves
other users' changes; optimistic revision checks prevent concurrent overwrites.

#### Staff accounts

Individual sign-in uses workspace memberships (`operator_memberships`, migrations
`20261004090000` and `20261005090000`). The server derives role, site and capabilities
from the membership; office admin, HR and management can hold all-sites memberships.
Operational saves are server-validated, signed and re-checked by the database; source PDFs
are shared per site. See [role-based entry](docs/sv-entry-and-sachet-route.md) for the
trust boundary, membership administration, deployment prerequisites and rollback. The
paragraph below describes the earlier preview boundary.

#### Prepared boundary for staff accounts (preview)

Assignments have a separate `assignedPacker` reference and assignment timestamp;
`packer` remains the person who declared the actual contents. Optional staff profiles
separate a stable profile ID from display name and role. The test UI supports those
IDs without depending on display-name matching. No real roster is committed.

Before activating individual logins: create workspace memberships with protected
roles, link stable staff IDs to Auth users, derive role/PIC from the authenticated
server session, and apply assignment restrictions to API responses and database RLS
(including PDF sources). The current JSON workspace and role/profile selectors are
still a shared demo and do not provide private employee access. Keep staff login
rollout separate until the owner supplies the roster and access administrator.

### Driver trips

Driver and assistant driver are one role. Drivers share one sign-in and log each trip with
the driver's and assistant driver's names, pickup time, arrival time and a photo; the
arrival and photo can be added later. Stock-out supervisors and management review every trip at the site. See
[driver trips](docs/sv-entry-and-sachet-route.md#driver-trips).

### Production PIC planning and changes

Each batch plan can assign a PIC to every fixed process. These are planned
assignments: they do not complete work, create stock or enable handoff. Process
completion keeps the planned PIC and all change history.

The production log offers **Edit PIC** for a mistaken selection. **More → Shift
handover** records a real change of performer, including the takeover date/time
in Malaysia time and a reason. Both preserve the previous PIC and an audit event.
A handover must have an existing PIC, cannot precede the batch date or previous
handover, and cannot be recorded after factory transfer. Historical misclicks can
still be corrected with a reason. Process output totals are not split between PICs.

Previous batches → View record → Open production log selects that batch's work
date. A prominent date banner and date picker control the daily production list.

### Batch and carton reference

The batch number is the carton reference throughout stock-in, stock issue and
traceability. Users never enter a separate carton number. Bottle receipts can use
separate racks/receipt records under the same batch number; internal IDs preserve
balances and allocations. Sachet intake allows one pending boxing receipt per
batch; further deliveries can be recorded after that receipt is finalized.

Older saved references are retained as `legacyRef` when normalized for display
and subsequent saves. Record IDs, quantities, movement links and historical event
text are unchanged. The factory batch picker shows product name before batch code.

Sachet intake labels are generic. The catalog's factory type controls the route,
so additional sachet products use the same process and stock-in rules when added
to the catalog. This change does not invent additional product entries.

### Outbound packages (25 September 2026)

Order management is the combined daily outbound workspace; old `view=outbound`
links resolve to it. Each product has its own package table with parcel count,
units per parcel, total bottles/boxes, packer shares and recorded progress.
Search selects matching package groups, while a group's assignment always covers
its full daily workload. Individual AWB review and manual carry-over are below
in Parcel records & review. Daily tally remains the reconciliation view.

Record count captures the independent supervisor total. Printing is external to
Operator and does not block counts, stock issue or assignment; existing print
history remains intact. Stock issue works across the displayed product packages.
Assign packers sets quantities per packer for the group's remaining unpacked
parcels. The server retains current assignments where possible and automatically
allocates parcel IDs to meet the quantities. Reassignments require a reason;
completed records stay unchanged. Packers see their product/package totals and
can open the assigned parcels to enter actual contents.

Each brand is an independent parcel with its actual AWB. New mixed-brand import
rows stay in review until separated using the actual labels. Existing mixed-brand
records without stock or packing activity can be explicitly separated in Order
management with a reason and actual AWBs. Historical activity is preserved and
requires supervisor reconciliation; it is never silently split or duplicated.

### Landing screen and return after sign-in (9 October 2026)

The screen comes from `?view=` when the signed-in role may open it; otherwise the
role's home screen (`apps/web/src/lib/landing.ts`). Management's home is Overview,
even though Driver trips is its first sidebar entry; every other role opens on its
working screen. No screen is chosen until the server has said who is signed in, so a
refresh never passes through another role's screens. Management's "view as" lens lasts
for the browser tab, refreshes included, and ends with it. Signing in again after a
refresh or an expired session returns to the screen that was open; only paths on this
site are accepted as the return address.
