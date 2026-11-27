# Review findings remediation — 2026-11-19

Status: implemented in the working tree on `main`, not committed. Scope: the nine findings from the high-effort review of the uncommitted P0 hardening changes (effect ledger, approval preconditions, reporting lifecycle, workspace admission).

Implementation was delegated to Codex (`gpt-6.1-sol`, high reasoning) in five work packages with disjoint file ownership; each diff was reviewed against a pre-change snapshot before integration. WP3's Codex sandbox could not write to the repository, so its verified patch was reviewed and applied by the orchestrator.

## Verification

| Check | Before | After |
| --- | --- | --- |
| `npm test` | 455 tests, 445 pass, 0 fail, 10 skipped | 504 tests, 494 pass, 0 fail, 10 skipped |
| `npm run build` | — | passes; built worker initializes over JSON-RPC |
| `git diff --check` | — | clean |

Both runs used Node v25.2.1 (Node 24.11, the declared engine, is not installed on this host). The 10 skips are opt-in PostgreSQL tests (`POLYFORGE_RUN_POSTGRES_TESTS=1`); the new ledger SQL (`cancelUnsentEffects`) is covered only by fakes until those run.

No existing test was deleted. Three tests were renamed or replaced because their expected behavior changed intentionally (alignment conflict wording; "legacy" card generations renamed to released/snapshot/projected). Other test edits follow the new `assertRetrySafe` return shape and the skipped supervisor tombstone for nodes without review.

## Work packages

### WP1 — Dispatch external-effect recovery (findings 1, 2, 6, 9)

Files: `src/plugin/dispatch.mjs`, `src/plugin/effect-ledger.mjs`, `src/plugin/worker.mjs` (retry-node block), `tests/e2e/dispatch.test.mjs`, `tests/plugin/effect-ledger.test.mjs`.

- **Failed create no longer deadlocks a node.** Automatic dispatch still never resends an `unknown` effect. An authorized owner retry now settles an `unknown` effect whose origin lookup is definitively `absent` as `confirmed_failure` with `{ settledBy: 'owner-retry', lookup: 'absent' }`. `ambiguous` and `mismatched` lookups still block the retry, and the error names the lookup status.
- **Retry tombstones are compensable.** `retireUnsentEffect` reports `inserted` (true only when this call wrote the tombstone). `assertRetrySafe` now returns `{ expectedRunDigest, retiredOperationIds }` and rolls back its own tombstones if a later check throws. `worker.mjs` deletes them via the new `cancelUnsentEffects` when `engine.retryNode` throws or returns `nextAttempt: null`. Deletion is limited to the named operation IDs whose row is exactly the `cancelled_before_send` marker; pre-existing tombstones and owner-settled failures are never removed. A committed idempotent replay still returns `undefined` and touches no ledger rows.
- Supervisor-phase tombstones are written only for nodes with `review` and only for submitted attempts.
- The parent issue is fetched once per dispatch and shared by the origin lookup and the create request (and once per retry check).
- The duplicate `./store.mjs` import is merged.

### WP2 — Native decision card compatibility (finding 3)

Files: `src/plugin/native-decisions.mjs`, `tests/e2e/native-decision.test.mjs`.

- Cards are recognized across three generations: `releasedVersion` (the format in `HEAD`, no run digest), `snapshotVersion` (run digest, no options) and `projectedVersion` (run digest and options).
- An answered card wins over an unanswered one, newest generation first. An older unanswered card is reused only when its rendered options equal the current options.
- An older-generation answer must appear in both that card's rendered options and the current options. `expectedRunDigest` and `expectedDecisionId` are unchanged, so Core still rejects stale snapshots.
- If an older answer is rejected while the snapshot is unchanged, the current-generation card is opened. No card is opened after a committed transition. `candidateVersion` reports the card actually used.

### WP3 — Workspace admission blocks instead of throwing (findings 4, 7)

Files: `src/plugin/dispatch-admission.mjs`, admission call sites in `src/plugin/dispatch.mjs`, `tests/e2e/dispatch.test.mjs`, `tests/plugin/workspace-security.test.mjs`.

- `admit()` returns `{ admitted: true }`, `{ admitted: false, status: 'deferred_agent_limit' }`, or `{ admitted: false, status: 'blocked', reason: 'workspace_admission_unavailable' | 'invalid_workspace_declaration', code? }`. Only unexpected errors (node missing from the pinned graph, store failures) still throw.
- Order: workspace policy → own-key fast path → capacity → `reserveSlot`. A refused node never reserves a slot or creates an issue, and other ready nodes in the same pass still dispatch.
- The security invariant is unchanged: `exclusive` and invalid declarations are never admitted, and `admitDeclaredWorkspaceWrite` is still called with `host: null` even when a capable host is present.
- Existing `issued`/`waking`/`woken` dispatches report their persisted state without re-admission; `prepare()` still counts them against capacity.
- The duplicate capacity check and the unused `host` argument to `createDispatchAdmission` are removed.

### WP4 — Reporting alignment conflict message (finding 5)

Files: `src/plugin/alignment.mjs`, `tests/e2e/alignment.test.mjs`.

- A dedicated `ReportingConflictError` is raised before any agent read or patch and bypasses the resume/retry wrapping: "Organization alignment is blocked by existing managers that need review. No manager was changed. Review the existing manager for <roleIds>." With a Pack, it is prefixed "Roles provisioned for <pack>." Other failures keep the resume/retry wording.
- `plan.changes ?? []` is restored.

### WP5 — Explicit digest binding in Core idempotency (finding 8)

Files: `src/core/engine.mjs`, `tests/core/engine.test.mjs`.

- `#change(key, fn, request, { runResult, bindRunDigest })` replaces key-prefix sniffing. Only `resolveHumanGate` and `resolveReworkLimit` pass `bindRunDigest: true`; key formats and persisted fingerprints are unchanged. The three run-result callers moved from the positional flag to `{ runResult: true }`.

## Round 2 — review of the remediation

A second high-effort review of the remediation found seven issues. They were fixed in two sequential work packages (both own `src/plugin/dispatch.mjs`), again delegated to Codex (`gpt-6.1-sol`, high) and reviewed against snapshots taken before each package.

| Check | Before round 2 | After round 2 |
| --- | --- | --- |
| `npm test` | 504 tests, 494 pass, 0 fail, 10 skipped | 531 tests, 520 pass, 0 fail, 11 skipped |
| `npm run build` | passes | passes; built worker initializes over JSON-RPC |
| `git diff --check` | clean | clean |

The extra skip is the new opt-in PostgreSQL ledger test.

### WP6 — In-flight creates and confirmation conflicts (round-2 findings 1, 2, 7)

Files: `src/plugin/dispatch.mjs`, `src/plugin/effect-ledger.mjs`, `tests/e2e/dispatch.test.mjs`, `tests/plugin/effect-ledger.test.mjs`.

- **Owner retry no longer settles a create that may still be in flight.** `unknown` is also the state while another dispatcher awaits `host.issues.create`. An `absent` origin lookup now settles the effect as `confirmed_failure` only when the effect row is older than `EFFECT_SETTLE_GRACE_MS` (10 minutes). A younger effect, or one with a missing or unparseable `created_at`, rejects the retry with the time when it becomes possible. `getEffect` now returns `created_at`. `createDispatch` takes an optional `{ now, effectSettleGraceMs }` for tests.
- **A late confirmation conflict no longer aborts the dispatch pass.** If `confirmEffect` fails after a successful create, the effect is re-read. If it is `confirmed_failure` (the attempt was retired meanwhile), the issue is not attached and the node reports `effect_orphaned` with the issue ID and a warning. Any other failure reports `effect_unknown` without attaching, so origin-lookup recovery reconciles it later. Other ready nodes in the same pass still dispatch.
- The admission refusal result now carries `lifecycle` like every other refusal.

### WP7 — Retry compensation (round-2 findings 3, 4, 5, 6)

Files: `src/plugin/dispatch.mjs`, `src/plugin/effect-ledger.mjs`, `src/plugin/worker.mjs` (retry-node block), `tests/e2e/dispatch.test.mjs`, `tests/plugin/effect-ledger.test.mjs`.

- **One retry helper.** `dispatch.retryNode(companyId, engine, input)` runs the guard, `engine.retryNode` with `expectedRunDigest`, compensation and the post-commit re-assert. The worker's retry-node block keeps its authorization and reason checks and makes this single call.
- **Compensation never removes a tombstone another retry relies on.** The guard records the attempt and phase of each tombstone it inserted. Compensation re-reads committed state and deletes only tombstones that block the currently dispatchable attempt and phase. Tombstones of abandoned or completed phases are kept, because they are harmless and may be what a concurrent committed retry depends on.
- **Post-commit re-assert.** After a retry that advanced, all retired operation IDs are re-tombstoned (idempotent insert), so a tombstone removed by a concurrent losing retry is restored. If a create began in that gap, the effect is `unknown` and a warning is logged. Re-assert failures are logged and do not fail the already committed retry (orchestrator fix during review).
- **Original errors are preserved.** If compensation fails, the failure is logged ("leftover tombstones need operator review") and the original error is rethrown unchanged, so an `AuthorizationError` still maps to 403. The `AggregateError` wrapper is removed.
- **No array bind parameter.** `cancelUnsentEffects` passes the IDs as serialized JSON and uses `operation_id IN (SELECT jsonb_array_elements_text($2::jsonb))`, matching how the host bridge binds JSON elsewhere. A new opt-in PostgreSQL test covers the `inserted` flag and exact-marker deletion.

## Round 3 — review of round 2 (2026-11-20)

A third review found six issues. They were fixed in two sequential work packages (both own `src/plugin/dispatch.mjs`), delegated to Codex (`gpt-6.1-sol`, high) and reviewed against snapshots taken before each package. This round also ran the opt-in PostgreSQL tests for the first time, inside the `polyforge-graph-e2e` Docker stack.

| Check | Before round 3 | After round 3 |
| --- | --- | --- |
| `npm test` (local, Node 25.2.1) | 531 tests, 520 pass, 0 fail, 11 skipped | 546 tests, 535 pass, 0 fail, 11 skipped |
| Full suite in Docker (Node 24.22.2, PostgreSQL 16.10, `POLYFORGE_RUN_POSTGRES_TESTS=1`) | 529 tests, 527 pass | 544 tests, 542 pass, 1 fail, 1 skipped |
| `npm run build` | passes | passes; built worker initializes over JSON-RPC |
| `git diff --check` | clean | clean |

In Docker every PostgreSQL test passes, including the ledger tests for `inserted`, `cancelUnsentEffects` and `settleAbsentEffect`. The one failure is `tests/core/packs-packaging.test.mjs`, which cannot load esbuild inside the container; it passes locally and is unrelated to this change. The skip is the Docker-in-Docker MVP test.

How the Docker run works: the database port is not published, so the repository (and the sibling `Paperclip-PolyForge-Graph-Packs` checkout) is copied into `/tmp` of `polyforge-graph-e2e-paperclip-1` and run there, with `POLYFORGE_TEST_POSTGRES_MODULE` pointing at the container's `postgres` package and the container's `DATABASE_URL`.

### WP8 — Containing issues created during a conflict (round-3 findings 1, 5)

Files: `src/plugin/dispatch.mjs` (the `confirmEffect` failure branch in `dispatchNode`), `tests/e2e/dispatch.test.mjs`.

- **Orphaned issues are contained.** When the effect turns out to be `confirmed_failure`, the dispatcher makes a best-effort `host.issues.update(issueId, { status: 'cancelled', assigneeAgentId: null }, companyId)`, so the agent is not woken for a retired attempt. The action reports `effect_orphaned` with `contained: true|false`. If containment fails, a warning asks for operator cleanup and nothing is thrown.
- **Transient confirmation failures no longer strand an assigned issue.** If the effect is not `confirmed_failure` (or could not be re-read) and the attempt is still current, the issue is attached and dispatch continues normally. The effect stays `unknown`, and a later owner retry reconciles it through origin lookup. If the attempt is stale, or eligibility cannot be checked, the result stays `effect_unknown` and the issue is not attached.

### WP9 — Database-clock grace and retry cleanup (round-3 findings 2, 3, 4, 6)

Files: `src/plugin/dispatch.mjs` (retry path and default persistence), `src/plugin/effect-ledger.mjs`, `tests/e2e/dispatch.test.mjs`, `tests/plugin/effect-ledger.test.mjs`.

- **Grace is evaluated on the database clock.** New `settleAbsentEffect(db, companyId, operationId, graceMs, result)` settles only `WHERE outcome='unknown' AND created_at <= now() - grace`. Otherwise it returns `{ settled: false, retryAt }`, computed in SQL. An identical prior settlement counts as settled; any other concurrent outcome throws. The `now` option of `createDispatch` is removed. A persistence without `settleAbsentEffect` refuses to settle instead of falling back to the worker clock.
- **Post-commit re-assert is limited** to retired entries with `inserted === false`, the only ones a concurrent losing retry can delete.
- **`retiredOperationIds` removed.** `assertRetrySafe` returns `{ expectedRunDigest, retiredOperations }`.
- **Worker route test.** `retry-node` through the plugin route returns 403 with the original message when `engine.retryNode` rejects with `AuthorizationError` and compensation also fails.

## Round 4 — review of round 3 (2026-11-20)

A fourth review found six issues. They were fixed in two sequential work packages, delegated to Codex (`gpt-6.1-sol`, high) and reviewed against snapshots taken before each package.

| Check | Before round 4 | After round 4 |
| --- | --- | --- |
| `npm test` (local, Node 25.2.1) | 546 tests, 535 pass, 0 fail, 11 skipped | 572 tests, 561 pass, 0 fail, 11 skipped |
| Full suite in Docker (Node 24.22.2, PostgreSQL 16.10) | 544 tests, 542 pass, 1 fail | 570 tests, 568 pass, 1 fail, 1 skipped |

The Docker failure is the unrelated `packs-packaging` test (esbuild is not available in the container). All PostgreSQL tests pass.

### WP10 — Deferred confirmation, settlement and logging (round-4 findings 1, 2, 4, 5, 6)

Files: `src/plugin/dispatch.mjs`, `src/plugin/effect-ledger.mjs`, `tests/e2e/dispatch.test.mjs`, `tests/plugin/effect-ledger.test.mjs`.

- **The dispatch row settles a deferred effect.** If an `unknown` effect's dispatch row already has `issue_id`, the retry guard confirms it as `confirmed_success` from that ID without an origin lookup. A reassigned or unassigned issue therefore no longer blocks owner retries as `mismatched`. The dispatcher writes `issue_id` only after a verified create receipt or a matched lookup. The orchestrator added a `persistence.reconcileEffect` presence check during review.
- **A concurrent success no longer rejects the retry.** `settleAbsentEffect` returns `{ settled: false, outcome: 'confirmed_success' }` when the row was confirmed meanwhile, and the guard continues as with any confirmed effect.
- **No attach without evidence.** After a `confirmEffect` failure, the issue is attached only if the re-read shows `unknown` or the re-read itself failed. A persistence without `getEffect` returns `effect_unknown`.
- The rollback-failure log sends `errorMessage(error)`, so the cause survives JSON-RPC.
- The worker-route tests share one fake host database helper.

### WP11 — Create unassigned, then assign (round-4 finding 3)

Files: `src/plugin/dispatch.mjs`, `tests/e2e/dispatch.test.mjs`, and the host fixture in `tests/e2e/dispatch-limit.test.mjs` (orchestrator).

Host behavior was checked in the Paperclip 2026.1106 image (`server/dist/services/plugin-host-services.js`, `services/recovery/service.js`). The plugin's `issues.create` and `issues.update` do not wake agents. Paperclip's recovery liveness scan starts any assigned `todo`/`in_progress`/`in_review` issue, so an issue becomes runnable as soon as it is assigned.

- **Node issues are created without `assigneeAgentId`.** The ledger request records `intendedAssigneeAgentId`, so a reused operation ID with a different agent is still rejected. The create receipt may have no assignee but must not name a different agent.
- **Assignment happens last.** After the issue is attached and GOAL.md is written, eligibility is re-checked and the issue is assigned with `host.issues.update(issueId, { assigneeAgentId }, companyId)`. A stale attempt is never assigned.
- **Assignment failure is recoverable.** The action reports `assignment_pending`. On the next pass, an `issued` row without an agent run reads the issue and assigns it if it is still unassigned.
- **Orphans never become runnable.** An orphaned issue is still unassigned when it is detected; containment only sets `status: 'cancelled'`.
- **Origin recovery accepts our own unassigned issue.** A matching issue with an empty assignee is `matched` (a different assignee is still `mismatched`). Dispatch recovery assigns it; the retry guard only reconciles it and never assigns a retired attempt.

## Residual risks and follow-ups

- **Grace period is a heuristic.** A `host.issues.create` call that stays in flight longer than 10 minutes can still be settled as failed by an owner retry. The late issue is unassigned and is cancelled best-effort (`effect_orphaned`), so no agent runs it. A failed cancel leaves an unassigned open issue for operator cleanup.
- **Real-host e2e not re-run.** The Docker real-host scripts (`scripts/e2e-*.mjs`) were not re-run after WP11. They should confirm that Paperclip's liveness scan picks up issues assigned by update, as the source indicates.
- **Extra host read.** Each dispatch pass now reads the issue for `issued` rows without an agent run, to recover a pending assignment.
- **Ledger request shape changed.** Effects begun before WP11 stored `assigneeAgentId` in their request. If such an `unknown` row reaches `beginEffect` again, the request comparison rejects it. Migration 017 is not yet released, so no deployed rows exist.
- **Gap between rollback and a concurrent commit.** If a losing retry deletes a tombstone and a dispatcher begins a create before the winning retry re-asserts it, that create proceeds for the abandoned attempt. The re-assert logs it; the issue still needs operator cleanup.
- **Exhausted reset budget.** If `retryNode` returns `nextAttempt: null`, an `unknown` effect that the retry already settled as `confirmed_failure` is not reverted, so that attempt stays blocked. It was stuck as `effect_unknown` before this change, so this is not a regression; recovery still needs a reset-budget decision.
- **Rollback failure.** If compensation fails, leftover tombstones block the current attempt until an operator reviews them; the failure is logged at error level. This path is now tested.
- **Host error semantics.** A thrown `host.issues.create` is always treated as an unknown outcome; only an empty successful origin lookup counts as definitive absence.
- **PostgreSQL coverage.** Covered in round 3 against PostgreSQL 16.10 in the Docker e2e stack. Re-run before release against the production Paperclip DB bridge version.
- **Packaging test in Docker.** `packs-packaging` needs esbuild, which is not available in the Paperclip container; run it on the host.
