# Production readiness execution backlog

Status: planned work. Published 2026-10-02. [Readiness epic #7](https://github.com/nadeemramli/operator-effen/issues/7) tracks live completion; unchecked items below are the publication snapshot.

Read the [architecture and readiness plan](production-readiness-plan.md) first. User-confirmed sizing is 7–10 phone packers, 2 production laptop users and 2 supervisors on laptops: 11–14 concurrent users and approximately 2–3 hours without internet. Proposed acceptance workloads are 14 users at peak, 30 for headroom, 3 hours offline and a 4-hour buffer.

## Dependency map

| Workstream | Issue | Depends on |
|---|---|---|
| establish workload, device baseline and acceptance targets | [#8](https://github.com/nadeemramli/operator-effen/issues/8) | None |
| verify staff identity, workspace permissions and security controls | [#9](https://github.com/nadeemramli/operator-effen/issues/9) | [#8](https://github.com/nadeemramli/operator-effen/issues/8) |
| implement transactional records, safe retries and inventory audit | [#10](https://github.com/nadeemramli/operator-effen/issues/10) | [#8](https://github.com/nadeemramli/operator-effen/issues/8), [#9](https://github.com/nadeemramli/operator-effen/issues/9) |
| reduce phone payloads and add scoped realtime reconciliation | [#11](https://github.com/nadeemramli/operator-effen/issues/11) | [#8](https://github.com/nadeemramli/operator-effen/issues/8), [#9](https://github.com/nadeemramli/operator-effen/issues/9), [#10](https://github.com/nadeemramli/operator-effen/issues/10) |
| support three-hour offline packing with durable sync and reservations | [#12](https://github.com/nadeemramli/operator-effen/issues/12) | [#8](https://github.com/nadeemramli/operator-effen/issues/8), [#9](https://github.com/nadeemramli/operator-effen/issues/9), [#10](https://github.com/nadeemramli/operator-effen/issues/10) |
| establish monitoring, backup restore and safe release runbooks | [#13](https://github.com/nadeemramli/operator-effen/issues/13) | [#8](https://github.com/nadeemramli/operator-effen/issues/8) |
| pass load, outage and recovery gates before a factory pilot | [#14](https://github.com/nadeemramli/operator-effen/issues/14) | [#8](https://github.com/nadeemramli/operator-effen/issues/8), [#9](https://github.com/nadeemramli/operator-effen/issues/9), [#10](https://github.com/nadeemramli/operator-effen/issues/10), [#11](https://github.com/nadeemramli/operator-effen/issues/11), [#12](https://github.com/nadeemramli/operator-effen/issues/12), [#13](https://github.com/nadeemramli/operator-effen/issues/13) |

Monitoring and backup design start with the baseline, in parallel with architecture planning. Their final evidence must cover the implemented auth, data and offline workflows. Dependencies indicate required contracts/decisions; they do not require every preparatory task to wait.

## Workstream checklists

### establish workload, device baseline and acceptance targets — #8

[Track this workstream](https://github.com/nadeemramli/operator-effen/issues/8).

Scope:

- Confirm supported phone OS/browser versions, device ownership, peak packing throughput, retained record volume and PDF load.
- Benchmark production-build load, scan/search/save, phone memory and server/database latency using synthetic staging data.
- Record critical journeys, failure modes, availability/recovery targets and budget tradeoffs.
- Resolve whether outages can use preassigned work or require fresh shared-stock coordination.

Acceptance:

- [ ] Publish dated baseline measurements for the weakest supported phone and laptop.
- [ ] Record 14-user normal peak, 30-user headroom and 3-hour offline workloads; proposed 4-hour buffer.
- [ ] Document accepted targets and outstanding owner decisions; do not present proposals as guarantees.

### verify staff identity, workspace permissions and security controls — #9

[Track this workstream](https://github.com/nadeemramli/operator-effen/issues/9).

Scope:

- Reconcile and reuse any existing staff-onboarding work; avoid duplicate implementations.
- Bind roles/PIC to authenticated workspace membership; enforce assignment, record and file access in APIs and database policies.
- Review all direct database/API write paths, revocation/session behavior, admin MFA, rate limits, input/file validation and security headers.
- Use applicable OWASP ASVS requirements and redacted security evidence.

Acceptance:

- [ ] Automated access tests deny cross-assignment reads, role impersonation, unauthorized corrections and file access.
- [ ] Demonstrate that an alternate write path cannot bypass authoritative inventory rules.
- [ ] Record session revocation behavior and offline access/queue ownership policy; no real rosters or credentials in fixtures.

### implement transactional records, safe retries and inventory audit — #10

[Track this workstream](https://github.com/nadeemramli/operator-effen/issues/10).

Scope:

- Design normalized shared records for production, inventory, orders, assignments and audit; preserve batch/carton traceability and domain distinctions.
- Implement atomic stock operations with appropriate row/version protection.
- Persist operation IDs/results atomically with mutations; reject reused IDs with different payloads.
- Plan reversible migration and backward-compatible command schemas without resetting shared test records.

Acceptance:

- [ ] Concurrent issues against the same carton cannot create negative stock or double deduction.
- [ ] Unrelated operations do not conflict through one workspace-wide revision.
- [ ] Response-loss retries return the original result without repeating stock/packing mutations.
- [ ] Inventory conservation, traceability and reasoned correction history remain verified.

### reduce phone payloads and add scoped realtime reconciliation — #11

[Track this workstream](https://github.com/nadeemramli/operator-effen/issues/11).

Scope:

- Paginate/filter queries and fields by assignment/site/date; add measured indexes and workflow code splitting.
- Keep management and PDF/OCR processing out of packer initial loads; retain implemented bulk AWB intake.
- Measure region/network and repeated Auth costs while preserving authorization.
- Implement narrow authorized realtime notifications, reconnect reconciliation and visible freshness.

Acceptance:

- [ ] Publish before/after bundle, payload, memory and latency evidence under 14-user peak and 30-user headroom.
- [ ] Validate provisional targets or document accepted revisions: p95 feedback <200ms, online save <1s, remote visibility <2s; useful cold workspace within 3s.
- [ ] Reconnecting clients reconcile missed updates/deletes and access changes without treating realtime as authoritative stock.

### support three-hour offline packing with durable sync and reservations — #12

[Track this workstream](https://github.com/nadeemramli/operator-effen/issues/12).

Scope:

- Implement cached app shell, assigned-work download and transactional local outbox bound to original identity/device.
- Specify exclusive assignment/reservation, device handover and supervisor reconciliation; never reassign on timeout alone.
- Support permitted production drafts/counts and packing declarations; mark pending separately from server acceptance.
- Handle retry ordering, duplicates, expired sessions, revoked access, schema upgrades, storage pressure and foreground/manual sync.

Acceptance:

- [ ] Approved work survives 3 hours offline, screen lock, browser termination, phone restart and reopen; proposed 4-hour buffer tested.
- [ ] Downloaded work and queue sized from measured throughput; personal data minimized.
- [ ] All 14 devices can reconnect together without dropped operations, duplicate deduction or hidden conflicts.
- [ ] Supervisor sees last-sync time and queue outcomes; conflicting/rejected work remains reviewable.
- [ ] First-time login/setup and fresh shared-stock allocation boundaries are explicit; local-server decision recorded if needed.

### establish monitoring, backup restore and safe release runbooks — #13

[Track this workstream](https://github.com/nadeemramli/operator-effen/issues/13).

Scope:

- Start observability and backup design early; finalize alongside data/auth/offline changes.
- Monitor critical journeys, latency/errors, contention, realtime lag, oldest queued work and storage, using redacted telemetry.
- Protect database, PDF objects and configuration; verify actual service tier and recovery coverage.
- Prepare incident ownership, manual downtime/reconciliation, backward-compatible releases and rollback; include factory network/power fallback.

Acceptance:

- [ ] Run a timed isolated database-plus-file restore with reconciled inventory and traceability.
- [ ] Verify alert routing and incident/runbook ownership without publishing private contacts or secrets.
- [ ] Record accepted RTO/RPO and tested limits; database backups alone must not be counted as PDF backups.
- [ ] Release/rollback rehearsal preserves pending offline commands and older clients.

### pass load, outage and recovery gates before a factory pilot — #14

[Track this workstream](https://github.com/nadeemramli/operator-effen/issues/14).

Scope:

- Run synthetic mixed-workflow staging tests for 10 phone packers, 2 production and 2 supervisor sessions; test 30 active sessions for headroom.
- Run shift-length soak, imports alongside packing, stock contention, duplicate scans, response loss and all-device reconnection after outage.
- Verify permissions, offline reservation integrity, audit accuracy, restore/rollback and actual supported phone/browser behavior.
- Pilot one station/shift, train operators, reconcile results and expand only after documented acceptance.

Acceptance:

- [ ] Attach dated results, environment/commit, workload, p95/p99 latency, error rates, queue drain time and inventory invariants.
- [ ] No unexplained lost acknowledged operations, silent overwrites, double deductions or negative inventory in acceptance suite.
- [ ] Owner accepts outstanding operational decisions, pilot outcomes and live rollout scope.
- [ ] Close readiness epic only when all release gates are evidenced, not when planning docs are merged.

## Decision register

| ID | Decision | Status / continuation |
|---|---|---|
| D1 | Staffing and outage requirement | Confirmed: 7–10 phone packers, 2 production laptop users, 2 supervisor laptop users; approximately 2–3 hours offline |
| D2 | Supported phone OS/browser, personal versus managed devices | Open; record in #8 and #12 |
| D3 | Orders/actions per hour, daily PDFs and retained history | Open; measure and size downloads/outbox in #8 |
| D4 | Preassigned/reserved work versus fresh shared-stock allocation during outages | Open; initial proposal is preassigned work; assess LAN/local authority only if needed in #12 |
| D5 | Exclusive offline ownership, device handover and reservation release | Proposed; reconcile devices before reuse/reassignment; accept procedure in #12 |
| D6 | Framework and synchronization libraries | Retain current framework proposed; compare explicit outbox versus broader sync needs, bundle cost and operating cost in #10/#12 |
| D7 | Latency, availability and recovery targets/budget | Provisional targets in plan; accept after baseline and restore evidence in #8/#13 |
| D8 | Cached-data retention, session/revocation and personal-data minimization | Open; decide in #9/#12/#13 |
| D9 | Pilot acceptance and live rollout | Open; require owner acceptance and verified gates in #14 |

## Continue on another computer

1. Open the [epic](https://github.com/nadeemramli/operator-effen/issues/7), this backlog and the plan on current main. Start with #8 and reconcile any staff-onboarding PR/branch before making overlapping changes.
2. Use the existing Operator checkout; inspect its repository root, branch, worktrees and dirty/untracked files. Fetch origin and inspect divergence. If local main is clean with no divergent/unpublished commits, update using a fast-forward only; otherwise preserve the work and choose an appropriate branch/worktree. Never reset/stash/clean to make the repository appear synchronized.
3. Read the repository AGENTS.md and applicable workspace/nested instructions. Obtain the actual private Operator requirements through the approved private channel; the public proposal is not a substitute for them.
4. Select Node from .nvmrc and pnpm from package.json. Install with the frozen lockfile when needed. Keep credentials and service configuration private; do not copy secrets into an issue or doc. Verify the intended backend before commands that access it.
5. Work on a descriptive codex/ branch. Use isolated synthetic staging data for load/security/mutation tests. Existing bulk AWB text/OCR intake must be preserved. Do not reset shared records or apply hosted schema merely to establish a baseline.
6. For each workstream, attach the implementation PR, accepted decision IDs and dated verification evidence. Documentation-only changes require link/path/consistency checks; substantive application changes require the repository's test/lint/typecheck/build checks and relevant workflow tests.
7. Keep issues open until their acceptance criteria pass. Update issue checkboxes as evidence accumulates and refresh these docs when accepted architecture or requirements change. A merged planning PR does not close the epic.

## Verification evidence template

Copy this into the issue completion comment or a sanitized linked report:

~~~markdown
- Date/time and timezone:
- Issue / PR / commit:
- Environment and synthetic fixture volume:
- Supported devices / browsers:
- Workload (users, action rate, history/PDF volume):
- Commands and actual outcomes:
- Latency p95/p99, error rate and payload/bundle/memory measurements:
- Inventory/audit and permission invariants:
- Offline duration, restart cases, queue size and reconnect/drain result:
- Restore/rollback outcome, measured RTO/RPO where relevant:
- Accepted decisions / remaining limitations:
- Operator pilot acceptance where relevant:
~~~

Do not include secret values, real customer PDFs, private staff rosters or private discovery notes. Retain sanitized failures as evidence rather than declaring a gate passed from a build alone.
