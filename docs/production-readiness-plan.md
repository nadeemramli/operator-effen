# Operator EFFEN — production readiness analysis

Status: planning backlog; implementation is not complete. Published 2026-10-02 from the 2026-09-24 readiness discussion and subsequent owner sizing clarification.

## Recommendation and scope

Keep Next.js, React, Supabase/Postgres and the existing design system. Prioritize authenticated shared operational records, transactional inventory, safe retries and offline command capture. Optimize screens against measured workloads.

The user confirmed the staffing and outage requirements below. Architecture, library choices, latency targets, offline permissions and recovery targets remain proposals until the relevant planning issues record acceptance. This publication authorizes documentation and issue tracking; it does not approve a live rollout, hosted schema changes or a production-data migration.

The implementation baseline was checked against the publication branch derived from GitHub main on 2026-10-02. No performance benchmark, hosted configuration audit, security certification or load test was performed. Future work must recheck main and coordinate with any staff-onboarding implementation already in progress. Keep private owner requirements separate and reconcile them before changing operational behavior.

See the [execution backlog and continuation guide](production-readiness-backlog.md) for issue dependencies, evidence requirements and how to resume on another computer.

Owner-provided sizing: 7–10 packers on phones, up to 2 production users on laptops and 2 supervisors on laptops: 11–14 concurrent users. Required internet-outage continuity is approximately 2–3 hours. Plan for 14 active users at normal peak, test 30 mixed active users for headroom, and validate a full 3-hour offline period with a proposed 4-hour buffer test. These are acceptance workloads, not measured current capacity.

Still open: phone operating systems/browser versions and ownership, shift-change login pattern, orders and stock movements per hour/day, retained history, PDFs per day, number of sites, and acceptable interruption/data-loss windows. Confirm whether supervisors must issue fresh shared stock during outages or whether previously allocated work is sufficient.

## Design implications of the confirmed workload

At this user count, the source findings do not justify replacing the framework or introducing distributed services. Prioritize shared-write correctness, small phone payloads and recovery from intermittent connectivity. Transaction frequency, PDF processing and retained data volume still need measurement; user count alone does not establish capacity.

- Give packers a focused phone workflow containing their downloaded assignments, product/unit details, required traceability references and durable pending declarations. Keep unrelated management views and import/OCR code out of the packer workflow's initial load. Avoid caching full AWB PDFs/customer data unless the packing task actually requires it.
- While online, prepare enough exclusive assignments and reserved/issued stock for the intended outage window. Size this from measured peak packing throughput per person, not an arbitrary order count. Show whether the phone has downloaded the assigned work and whether it has unsynced records.
- Bind each offline assignment to an authorized staff identity and a registered device/assignment version. A second device must not independently gain the same offline work authority. Establish controlled device handover/recovery procedures.
- Freeze reassignment and reuse of reserved stock while the assigned phone may be working offline. Do not automatically release a reservation merely because a three-hour timer elapsed. Reconcile the device or follow a supervisor recovery procedure before reallocating; otherwise physical duplicate packing can occur even if the database later rejects a declaration.
- Let the two production laptops capture approved process observations and counts offline as pending records. New stock availability, final approvals and shared stock allocation remain online actions in the initial design.
- Supervisors see only the last synchronized progress while phones are disconnected. Make that staleness explicit; the central dashboard cannot display offline phone activity until a connection returns.
- Require an online setup/login before offline operation, define a bounded offline access policy on approved devices and recheck identity/permissions at synchronization. Preserve rejected or expired-session work for accountable review instead of silently discarding it.
- Validate on the weakest actual phone and every supported browser: screen lock, background suspension, app/browser termination, phone restart, storage pressure and reopen without internet. Flush pending work when the app is reopened/foregrounded; do not promise background uploads while the phone is locked.
- Reconnect all 14 devices together after the outage and verify every pending action's outcome. Use backoff/jitter to spread retries, safe operation IDs to prevent duplicates and a visible supervisor reconciliation view. Test queue capacity at four hours of measured peak action rate with headroom.

The initial architecture recommendation is cloud-backed operation with controlled offline capture for preassigned work. A local factory server becomes a separate decision only if fresh shared-stock allocation and cross-device coordination must continue during a WAN outage. It is not required solely because there are 14 users or because an outage lasts three hours.

## Implementation baseline at publication

These are repository observations, not measurements of hosted capacity. Recheck them before implementation.

| Observation | Repository reference | Planning implication |
|---|---|---|
| Operational draft stored as one JSON workspace per Auth user | [Workspace migration](../supabase/migrations/20260921023258_ui_draft_workspace.sql) | Individual staff identities need a shared workspace/membership model, rather than separate operational copies. |
| Each command reads, transforms, rewrites and returns the workspace; application state is capped at 1,800,000 serialized bytes | [Draft endpoint](../apps/web/src/app/api/draft/route.ts) | Replace whole-workspace operations with scoped records and payloads; simply raising limits is not the scaling solution. |
| One conditional revision protects the entire workspace | [Draft endpoint](../apps/web/src/app/api/draft/route.ts) | Keep overwrite protection while removing contention between unrelated actions. |
| Staff roles and PICs are preview selections in the published baseline | [Workspace client](../apps/web/src/components/draft-app.tsx), [command rules](../apps/web/src/lib/draft.ts) | Integrate authenticated membership and actor identity; reconcile existing staff-onboarding work before building overlapping functionality. |
| Workspace fetched on load/refresh; no durable offline command queue in the reviewed baseline | [Workspace client](../apps/web/src/components/draft-app.tsx) | Add scoped live updates, reconnect reconciliation and persistent pending operations. |
| Broad client workspace and lists of matching records | [Workspace client](../apps/web/src/components/draft-app.tsx), [orders](../apps/web/src/components/order-workspace.tsx) | Measure bundle/rendering costs, then split workflows and paginate. Source length alone does not prove slowness. |
| Auth lookup in both proxy and server helper | [Proxy](../apps/web/src/proxy.ts), [server helper](../apps/web/src/lib/supabase/server.ts) | Measure repeated verification work without weakening action-level authorization. |
| Bulk AWB intake already implemented with embedded text and browser OCR | [PDF reader](../apps/web/src/lib/read-awb-pdf.ts), [intake](../apps/web/src/components/awb-intake.tsx) | Preserve existing intake and lazy PDF/OCR workers. Validate original layouts through approved private fixtures before production. |
| Private files, access policies, origin checks, business-invariant tests and CI exist | [File endpoint](../apps/web/src/app/api/awb-files/route.ts), [tests](../tests), [CI](../.github/workflows/ci.yml) | Extend these foundations with authenticated access tests, database-boundary rules and recovery evidence. |

Authoritative inventory must enforce its rules through every database/API write path. Workflow validation in a preview UI is not a substitute for production authorization and transactional constraints.

## Readiness framework

Evaluate quality through explicit scenarios and acceptance criteria:

| Dimension | Factory question | Evidence required |
|---|---|---|
| Performance | Can a low-end workstation scan, find an order and record work without waiting? | Real-device interaction timings, payload sizes and production-build traces |
| Capacity | Can a shift log in and work concurrently? | Login burst, concurrent reads/writes, same-carton contention and long-running load tests |
| Correctness | Can stock be deducted twice, go negative or lose batch linkage? | Transactional constraints, duplicate-request tests and conservation checks |
| Reliability | What happens when the response disappears after a successful save? | Durable operation IDs and safe retry/reconciliation tests |
| Availability | Can staff complete critical tasks throughout a shift? | User-journey monitoring, incident response and network/power fallback |
| Security/privacy | Can a packer read another assignment or impersonate a supervisor? | Authenticated roles, database access tests, file-access tests and threat review |
| Offline continuity | What may continue without shared current data? | Explicit per-action policy, durable capture and conflict recovery |
| Recoverability | Can records, PDFs and configuration be restored? | Timed restore drill with reconciled counts and traceability |
| Auditability | Who changed a count, why, and what was the previous value? | Server-attributed append-only events and correction records |
| Operability | Will someone know a station is failing or a queue is stuck? | Alerts, ownership, runbooks and visible sync status |
| Usability | Can staff avoid wrong units, duplicate scans and wrong labels? | Operator trials on actual devices, clear units and accessible feedback |
| Maintainability/cost | Can upgrades and growth happen safely and affordably? | Migration/rollback rehearsals, retention policy and usage budgets |

Use [Google SRE service-level objectives and error budgets](https://sre.google/workbook/implementing-slos/) to define and measure operational reliability. Use [OWASP ASVS](https://github.com/OWASP/ASVS) as a security verification checklist, selecting applicable Level 2 requirements for review rather than claiming certification. Maintain a small failure-mode register: cause, operational consequence, prevention, detection, recovery and owner.

## Proposed architecture

Keep one application with clear production, inventory, orders, packing and reporting modules. Introduce separate records for workspaces/sites, memberships, batches/processes, cartons, stock movements, orders/order lines, assignments, packing declarations, import jobs and audit events.

- Give each staff member an individual identity and server-controlled membership. Apply access scope to API responses, database rows, realtime channels and PDF objects. A role selector must not grant permissions.
- Make critical writes transactional: authorization, stock validation, stock movement, order/assignment update, audit record and operation result commit together. Protect business rules at the database boundary; do not leave an unrestricted direct-table path around them.
- Use unique operation IDs with stored results. A retry with the same ID returns the original result; the same ID with different input is rejected. The deduplication record and business update must commit atomically.
- Use record-level version checks and appropriately scoped locking/conditional updates for shared stock. Preserve corrections as reversing/adjusting movements with reasons rather than overwriting history. Do not require a full event-sourcing rewrite.
- Paginate and filter by site, date, status and assignment; return only needed fields. Design indexes from actual query plans, including membership/access predicates. Keep historical reports out of frequent transaction paths.
- Use authorized, narrow realtime notifications after commit. Supabase recommends Broadcast for scalability/security; evaluate it as the default with measured fan-out. Realtime tells the client to update/refetch a relevant record; it is not the authoritative stock ledger. Reconcile on reconnect using a server-issued cursor/version or scoped snapshot, including deletes and access changes. [Supabase guidance](https://supabase.com/docs/guides/realtime/subscribing-to-database-changes)
- Cache immutable assets and slowly changing reference data. User-specific caches must be scoped by identity and workspace. Display stock freshness and revalidate availability inside every authoritative write.

## Making the app lighter

First measure cold load, warm navigation, search, save, PDF import and an entire shift on representative hardware and realistic retained history. Record compressed initial JavaScript, response sizes, browser memory, long tasks, server timings and database timings.

Then prioritize smaller scoped responses, workflow-level code splitting, pagination, indexed queries, fewer request waterfalls and less repeated derived computation. Preserve dynamic PDF/OCR loading; evaluate caching versioned worker/model assets and moving sustained heavy import/report work to durable background jobs if measurements warrant it. Avoid assuming worker execution makes PDF handling free on weak devices.

Measure application/database region latency from Malaysia and colocate their compute appropriately. Examine the repeated Auth calls without removing action-level checks. Set payload/bundle budgets from the measured baseline. Next.js already provides useful rendering and code-splitting facilities; a framework replacement is not justified by the source findings. [Next.js production checklist](https://nextjs.org/docs/app/guides/production-checklist)

## Offline policy and synchronization

A cached page alone does not preserve work. Use an offline-capable app shell plus transactional local storage and a durable outbox. A previously provisioned device may reopen cached workflows during an outage; first-time login and first-time installation still require connectivity.

| Action | Proposed initial offline policy |
|---|---|
| View cached assignments/reference data | Allowed, clearly displaying last synchronization time |
| Draft a production observation, count or note | Save locally as pending; validate and attribute on sync |
| Capture packing work for previously assigned/reserved stock | Allow only under a defined reservation/ownership policy; keep pending status until accepted |
| Allocate shared stock or finalize a new stock issue | Require connectivity initially |
| Change permissions, approve adjustments or close a day | Require connectivity initially |
| Courier dispatch | Require confirmation initially, or separately design a controlled offline manifest workflow |

For example, if two disconnected stations each see the last ten units, neither can independently promise all ten. Safe offline allocation requires stock reserved exclusively before disconnection, with explicit release/reconciliation rules. If all stations must coordinate shared stock throughout a long WAN outage, assess a local factory server on the LAN with cloud synchronization. That entails local backups, UPS, patching and an explicit authority/failover model; a browser cache cannot provide that coordination.

Suggested outbox behavior:

1. Commit the pending operation locally before displaying “Saved on this device.” Store a stable operation ID, original actor/workspace, target/version, device sequence, schema version and payload.
2. Show separate states: pending, syncing, accepted, needs review, rejected. Show queue count and age.
3. Retry transient failures with backoff and jitter; preserve dependency order. Coordinate multiple tabs to avoid competing upload loops, while retaining server deduplication as the final protection.
4. Reauthenticate on reconnect; enforce current permissions on the server. Never replay one employee's queue as another employee. Record device-observed and server-accepted timestamps separately; do not trust device clock order for stock authority.
5. Keep failed/conflicting operations for supervised resolution. Delete local pending work only after authoritative acknowledgement or an explicit, auditable resolution.
6. Support foreground/reopen/manual sync. Do not depend exclusively on Background Sync, which has limited browser availability. [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API)
7. Test expired sessions, role revocation, device restart, storage-full errors, browser updates, service-worker upgrades, changed payload schemas and a connection lost after commit.

Browser storage can be evicted or manually cleared, and a damaged/lost device can lose unsynced work. Request persistent storage where supported, monitor space, restrict cached personal data and define managed-device/logout retention policy. Never silently purge another employee's pending work. These measures reduce loss; they do not establish an unconditional zero-loss guarantee. [MDN storage limitations](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)

## Candidate libraries and frameworks

| Candidate | Role | Decision |
|---|---|---|
| Existing Next.js + Supabase/Postgres | UI, identity, transactional data and realtime | Retain, with the data/authorization redesign above |
| TanStack Query | Scoped server-data cache, invalidation and mutation lifecycle | Evaluate for replacing bespoke fetch/state flows; persistence and safe retries require explicit configuration and server support. [Documentation](https://tanstack.com/query/latest/docs/framework/react/guides/mutations) |
| Dexie + IndexedDB | Transactional local drafts and command outbox | Starting candidate for a limited offline scope. Dexie supplies storage, not inventory conflict rules or a complete sync service. [Documentation](https://dexie.org/docs/API-Reference) |
| PowerSync | Broader local-first data replication | Compare if many workflows need offline queries/sync. Adds a synchronization dependency and operating cost; writes still need backend validation. [Supabase integration description](https://supabase.com/partners/integrations/powersync) |
| Service worker / PWA | Cached application shell and installability | Required design component for offline reopening; validate lifecycle and browser support on factory devices |

Choose one ownership model for persisted operational data. Do not independently persist the same authoritative records in several libraries without clear synchronization rules. No library purchases, installations or vendor selections are made by this plan.

## Reliability, security and recovery work

Create isolated development, staging and live environments. Verify actual deployed access policies, admin MFA, session lifecycle, login/import rate limits, security headers/CSP, dependency updates, secret handling, input limits and file validation. Log operational IDs and timings without customer names, addresses, document contents or credentials. Add integration tests that try direct Data API writes as well as normal UI actions.

Monitor critical journeys externally and collect application errors, latency percentiles, database contention, realtime lag, failed jobs, oldest unsynced operation and storage usage. Assign an incident owner and escalation path. Keep safe manual downtime procedures, numbered records and reconciliation instructions available to staff.

Set up and rehearse database recovery, file recovery and configuration recovery together. Supabase database backups exclude Storage object contents, so AWB PDFs need separate protection. Select backup/PITR coverage after agreeing recovery targets and verifying service-tier capabilities. [Supabase backups](https://supabase.com/docs/guides/platform/backups)

Plan backward-compatible database and API changes: old clients may return after being offline. Test rollback and forward repair. Do not activate a new service worker or migration in a way that destroys pending queues mid-shift. Include factory Wi-Fi coverage, backup internet and UPS in availability planning.

## Provisional targets and release gates

These are proposed acceptance targets, not current measurements or platform guarantees. Confirm them after device/workload discovery.

| Measure | Initial proposal |
|---|---|
| Routine scan/click feedback | p95 under 200 ms on the weakest supported device |
| Online save acknowledged after database commit | p95 under 1 second under agreed peak load, with p99 reported |
| Useful cold workspace | Within 3 seconds on the agreed factory connection/device |
| Remote update visibility | p95 within 2 seconds of commit while connected |
| Availability | Discuss 99.9% versus 99.95% for critical journeys; over a 30-day 24/7 month these permit about 43 versus 22 minutes of unavailability |
| Recovery | Initial discussion target: restore service within 60 minutes and cloud disaster recovery point within 5 minutes; validate cost and feasibility through drills |
| Offline continuity | Support 3 hours of approved work on previously provisioned devices; propose a 4-hour buffer test. Size downloaded assignments and queues from measured peak throughput. Cloud recovery-point targets do not protect unsynced device-only work. |
| Correctness | No double deduction, negative stock, silent overwrite or unexplained missing acknowledged operation in the acceptance suite |

Load testing must include mixed real workflows, not just simultaneous logins. Use synthetic data in staging at expected retained volume: 10 packer phone sessions plus 2 production and 2 supervisor laptop sessions for normal peak; then test 30 mixed active sessions for headroom. Include a shift-length soak, a 3-hour outage followed by all-device reconnection, a proposed 4-hour offline buffer test, concurrent issue from the same carton, double scans, missing responses after commit and large imports alongside packing work. Measure recovery/drain time as well as request latency. Confirm both success rates and resulting inventory/audit correctness.

## Delivery sequence

1. **Baseline and operating decisions.** Agree scale, device/browser support, critical journeys, offline permissions and SLO/recovery targets. Capture timings and a failure-mode register.
2. **Production data and security foundation.** Introduce shared workspace memberships, normalized records, transactional stock operations, operation IDs and audit records. Design offline-compatible command contracts now. Gate: permissions cannot be bypassed and concurrency/retry tests preserve inventory.
3. **Speed and live updates.** Implement scoped/paginated reads, measured indexes, workflow splitting, authorized realtime and reconnect reconciliation. Gate: latency/payload targets hold under representative load.
4. **Offline pilot.** Implement durable drafts/outbox for explicitly allowed workflows on selected devices. Gate: work survives restart and synchronizes safely after the agreed outage, including conflicts and expired sessions.
5. **Recovery and controlled rollout.** Complete monitoring, security verification, restore/rollback drills, operator training and downtime procedures. Pilot one station or shift, reconcile records, then expand based on evidence.

Start observability and backup design in the foundation phase; the last phase verifies readiness rather than introducing these controls for the first time. Staffing, calendar estimates and hosting spend should follow the unresolved workload/offline decisions.

## Continuation and decision policy

Track completion and accepted decisions in the linked issues. Every implementation issue should attach its PR, dated verification evidence, unresolved limitations and any operational decision it depends on. Do not close the overall readiness epic when documentation is merged; close it only after the pilot and release gates are satisfied.

Preserve these operational distinctions throughout implementation: planned assignments versus completed work, factory handoff versus counted receipt, stock issue versus packing, and packing versus courier handover. Keep original records and audit history intact. Existing bulk AWB PDF intake is implemented and should be extended rather than recreated from stale placeholder descriptions.

Use synthetic data in committed fixtures. Keep secrets, staff rosters, customer documents, private discovery notes and recovery material outside the repository and issue bodies.
