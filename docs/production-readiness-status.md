# Production readiness — status review (9 October 2026)

Status: review of the repository and hosted configuration against the
[readiness plan](production-readiness-plan.md) and [execution backlog](production-readiness-backlog.md).
Reviewed on `main` at commit `2c3f7f3` plus the changes in this review's branch; hosted
state read from the `operator-effen` Supabase project and the `operator-effen` Vercel project
(read-only: migration list, tables, advisors, environment-variable names and targets).
No real customer data, credentials or staff rosters were read or recorded.

Summary: the **foundation phase** (workstreams #9 and #10 as far as the current one-document
model allows) is implemented and tested well beyond what the plan assumed at publication.
Workstreams #8, #11, #12, #13 and #14 have not started. The tracking process the backlog
prescribes is not being followed: no issue carries evidence or ticked acceptance boxes, and
the live database runs one migration that `main` does not yet contain.

## What this review changed

- Browser security policy (workstream #9 "security headers/CSP"): per-request nonce-based
  Content Security Policy from `apps/web/src/proxy.ts`, plus `X-Frame-Options`,
  `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` and
  `Cross-Origin-Opener-Policy` on every response (`apps/web/src/lib/security-headers.ts`,
  `apps/web/next.config.ts`, `tests/security-headers.test.mjs`). Verified in a production
  build driven through Chromium: sign-in, navigation, hydration, the PDF reader and the OCR
  workers run with zero policy violations; the nonce changes per request; `/vendor` workers
  carry no policy; API responses carry it.
- Dependency advisories (workstream #9 "dependency updates"): Next.js 16.3.5 → 16.3.8
  (closes the critical `next/og` and high image-SSRF advisories plus four moderate ones);
  `source-map-js` and `@modelcontextprotocol/sdk` pinned in `pnpm-workspace.yaml`.
  `pnpm audit --prod` went from 1 critical / 5 high / 4 moderate / 1 low to 1 high:
  `braces` (reached only through the shadcn and ESLint tooling at build time; no patched
  release was published as of this date).
- README corrected: it still described the project as a pre-authentication test workspace
  with an empty database.

## Workstream status

| # | Workstream | Status | Evidence in repository | Open |
|---|---|---|---|---|
| 8 | Workload, device baseline, targets | Not started | None. The lab numbers below are not a device baseline. | Device/browser list (D2), hourly volumes (D3), accepted targets (D7) |
| 9 | Identity, permissions, security | Largely implemented | See below | MFA for HR/management accounts, leaked-password protection, membership-admin screen, evidence on the issue |
| 10 | Transactional records, safe retries, audit | Partly implemented | See below | Normalized records; one revision per site still serializes unrelated saves |
| 11 | Phone payloads, realtime, reconciliation | Not started | Lazy PDF/OCR loading only | Workflow splitting, scoped reads, realtime, freshness indicator, measurements |
| 12 | Three-hour offline packing | Not started | One pending save kept in `localStorage` and resubmitted after sign-in | App shell, outbox, reservations, device policy (D4, D5, D8) |
| 13 | Monitoring, backup restore, runbooks | Not started | Rollback scripts and a local rehearsal script exist | Monitoring, alerting, restore drill, PDF/photo backup, runbooks, RTO/RPO |
| 14 | Load, outage and recovery gates, pilot | Not started | None | Everything |

### #9 — identity, permissions and security controls

Implemented and tested (`tests/*.test.mjs`, `supabase/tests/operator_access.test.sql`,
`tests/integration/scenario.mjs`):

- Individual accounts with server-controlled site memberships and roles; the client-sent
  role is ignored; capabilities per role with site policies that can only narrow them.
- Row Level Security on every `public.operator_*` table; no insert/update/delete policies;
  the only write path is the signed `operator_commit_workspace` RPC under the caller's JWT.
- Private file access: upload and signed read URLs only after authorization, storage RLS
  re-checks, uniform 404 for unknown and unauthorized paths, 60-second URL life.
- Same-origin check on every mutating API route; input size limits; revocation takes
  effect on the next request; session-only versus remembered sign-in; access reasons are
  only revealed after a correct password.
- Integration scenarios cover cross-site reads and writes, packer write attempts through
  the API and the Data API, direct RPC with a replacement state, guessed file paths,
  revocation and expired sessions.
- Security headers and CSP (this review); dependency advisories patched (this review).

Hosted checks (read-only, 9 October 2026):

- Vercel: `OPERATOR_COMMIT_SECRET` exists for Production only. Development and Preview
  Supabase variables were disconnected from the live project at go-live, as the go-live
  record says.
- Supabase security advisor: 13 `SECURITY DEFINER` functions are executable by signed-in
  users. This is the design (each re-checks `auth.uid()`, membership and capability inside
  the function and nothing is callable without a signature or a grantor role); record it as
  an accepted finding on the issue. **Leaked-password protection is disabled**: enable it in
  Auth settings. The advisor also flags `operator_private.server_keys` and
  `operator_private.staff_pins` with RLS off; the schema is not exposed through the API and
  all privileges are revoked from `anon` and `authenticated`, so it is not reachable, but
  enabling RLS on both tables is harmless and should go into the next migration.
- Not verifiable from here and not recorded anywhere: MFA on the HR and management
  accounts, Auth rate limits beyond Supabase defaults, admin access to the Supabase and
  Vercel dashboards.

Gaps against the acceptance list: the automated access tests exist but their results are
not attached to issue #9; the SQL tests and the integration scenario are not run in CI
(CI runs unit tests, lint, typecheck and build only); the membership-admin screen is still
the documented follow-up, so membership changes need SQL.

### #10 — transactional records, safe retries and inventory audit

Implemented and tested:

- Operation IDs: the commit, its audit row and the idempotency record (`operator_commits`)
  are one transaction; a retry with the same ID returns the established result; the same
  ID with a different payload is rejected (tested in SQL, unit and integration tests).
- The workspace row is locked `FOR UPDATE` for the whole commit, so two saves against the
  same carton cannot both deduct; invariants (append-only events, non-negative cartons,
  immutable receipts, fixed custody facts, route completion before transfer, factory
  scope) are enforced in SQL, not only in the API.
- Conservation, traceability and reasoned-correction tests pass (107 unit tests before
  this review, 111 after).

Not done, and acknowledged in the SV-entry document's "Known limits":

- Records are still one JSON document per site with one revision. The acceptance item
  "unrelated operations do not conflict through one workspace-wide revision" fails by
  design today: any two saves at a site conflict, the loser gets a 409 and must refresh.
- The document is capped at 1.8 MB serialized; the whole state is sent on every load and
  save. Growth of retained history is not measured (D3).
- Domain rules not re-expressed in SQL rely on the API server (documented trust boundary).

### #11 — payloads and realtime

Lab measurement in this review (production build, local server, Chromium, synthetic
accounts, empty site state; **not** a device baseline):

| Measure | Packer home (Packing station) | Management home (Overview) |
|---|---|---|
| Script and style files on first load | 10 | 10 |
| Transfer size, gzip | 228 KB | 228 KB |
| Uncompressed | 797 KB | 797 KB |
| `/api/draft` response (empty site) | 7.1 KB | 7.1 KB |
| Reload to usable screen, local | ≈650 ms | ≈650 ms |

Every role downloads the same bundle: the packer screen carries the management, production
and order workspaces. PDF and OCR code is already lazy-loaded and served from `/vendor`
(54 MB of assets, fetched only when OCR runs). There is no realtime channel; staff refresh
by hand and conflicts surface as 409s. Nothing here has been measured on a factory phone or
over the factory connection.

### #12 — offline

Only the single most recent unacknowledged save is kept on the device and offered back to
the same user and workspace after sign-in. There is no cached app shell (an offline
refresh shows the browser error page), no outbox, no reservation or device policy. The
plan's offline table remains entirely proposed.

### #13 — monitoring, backups and runbooks

In the repository: rollback scripts for all four operational migrations, a local rehearsal
that applies, tests, rolls back and re-applies them (`scripts/verify-migrations-local.sh`),
and a go-live record. Not in the repository or recorded anywhere: error and latency
monitoring, alert routing, an incident owner, a restore drill, a backup plan for the PDF and
photo buckets (database backups do not include Storage objects), or RTO/RPO decisions.
Supabase's performance advisor also reports two unindexed foreign keys
(`operator_membership_audit.workspace_id`, `operator_memberships.granted_by`), an unused
index (`operator_commits_user`) and two permissive `SELECT` policies on
`operator_memberships`; all minor at current volume.

### #14 — gates and pilot

Not started. Note that the system has been live for staff since 6 October without the
pilot, load, outage or restore gates the plan requires; the owner accepted that go-live.

## Process findings

1. **Schema drift.** The live project has seven migrations applied; `main` carries six.
   `20261008090000_operator_packer_self_entry` (packer PINs, `operator_private.staff_pins`,
   four new RPCs) is applied to the live database but lives only on the open pull request
   [nadeemramli/operator-effen#20](https://github.com/nadeemramli/operator-effen/pull/20).
   The production deployment is built from `main`, so the app that staff use does not
   contain the code that goes with the live schema. Decide: merge #20 (after review of the
   PIN verification path for rate limiting and lockout) or roll the migration back with its
   `.down.sql`. Pull request [#19](https://github.com/nadeemramli/operator-effen/pull/19)
   carries only the factory-scope rollout record and should be merged.
2. **No evidence on the issues.** Every acceptance box on #8–#14 is unticked and none of
   the issues has a comment, although #9 and #10 have substantial, dated evidence in the
   repository. Use the backlog's evidence template on #9 and #10 now; it is what the plan
   says closes a workstream.
3. **CI does not run the strongest tests.** `supabase/tests/operator_access.test.sql` and
   `tests/integration/scenario.mjs` only run by hand. Add a PostgreSQL service job for the
   SQL tests and a `pnpm audit --prod --audit-level=high` step.
4. **Documentation drift.** The README described a pre-authentication placeholder; fixed
   in this review. Keep the go-live record (currently on #19 and #20) on `main`.

## Recommended order of work

1. Settle #19 and #20 so `main`, the deployment and the live schema agree.
2. Enable leaked-password protection; decide and record MFA for HR and management; next
   migration: RLS on the two `operator_private` tables and the two missing indexes.
3. Run the SQL access tests and dependency audit in CI.
4. Post evidence on #9 and #10 with the template; tick what passes; leave the one-revision
   item on #10 open.
5. Start #8 on real devices and the factory connection; without it #11 and #12 have no
   targets to design against. Decisions D2–D5 and D7 are owner decisions.
6. #13 can start now independent of the rest: external uptime check on `/login`, error
   capture, a scheduled Storage export for the two private buckets, and a timed restore
   drill on a disposable project.
