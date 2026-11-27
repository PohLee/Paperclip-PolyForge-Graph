# Dispatch, workspace and approval review remediation

This record covers the nine findings from the November 20 review of the working tree on `main` against `f998cb9c67dab1b04c3edb210fb0a67419720f83`. The implementation was divided among three GPT-6.1 Sol agents using high reasoning. Each package has a behavioral acceptance check.

## Technical work packages

| Package | Finding | Acceptance check |
| --- | --- | --- |
| Dispatch | Failed retry during self-review strands the supervisor phase (P1) | Reject a retry, complete self-review, then successfully dispatch the supervisor for the original attempt. |
| Dispatch | Retry can overtake an in-flight issue assignment (P1) | Hold the host assignment open during an owner retry. A replacement must wait until the assignment outcome is known. Verify recovery across dispatcher instances. |
| Workspace | Recovery of an existing unassigned issue bypasses policy (P2) | Recover an issued row whose pinned node or Pack declares exclusive writes. The host must receive no assignment. An already-assigned issue can still report its state. |
| Workspace | Workflow calls bypass the parent's exclusive-write policy (P2) | Enforce the caller's declaration before starting a child and before progressing an existing child. Exercise both node and Pack declarations. |
| Workspace | Lease mutations use the read-only SDK query API (P2) | Acquire, renew and release through the SDK write interface. Competing owners and later acquisitions by the same owner must preserve fence ownership. |
| Workspace | A missing Git common directory is accepted (P2) | A linked worktree with a dangling `commondir` reference reports partial creation. A regular repository still resolves. |
| Approvals | A released-format native card can approve a changed wait (P1) | Deliver an old answer after upstream state changes with the same decision, options and candidates. Only a card bound to the displayed snapshot can resolve the wait. |
| Approvals | The composition driver omits approval preconditions (P2) | Exercise the authorized owner and wrong-agent paths using the decision ID and digest from the displayed dashboard. |
| Approvals | The Core type declarations omit the public digest helper (P2) | A typed consumer can import `runValidationDigest` and use its result as an approval precondition. |

## Dispatch and retry

When a retry fails during self-review, rollback restores eligibility for the same attempt's future supervisor dispatch. The regression completes self-review and dispatches that supervisor. A second regression moves the attempt into supervisor review while the retry is still pending.

Migration 019 adds a company-scoped assignment record. A dispatcher claims a numbered generation, rechecks eligibility and records the result of its host call against that generation. A previously assigned issue that becomes unassigned can be assigned again through the same protocol. A definite pre-execution refusal can be retried.

An owner retry temporarily guards assignments affected by Core invalidation, including those in linked workflows. Core checks the parent and linked-run snapshots in the mutation that advances the attempt. Concurrent retry invocations each own their guards. If a retry commits and guard cleanup fails, the response includes `dispatchCleanupPending`. Replaying the original idempotency key retries cleanup without consuming another reset.

**Recovery boundary.** A host timeout or lost acknowledgement can leave an assignment outcome unknown. Dispatch reports `assignment_pending` with the operation and issue IDs. A replacement remains blocked because an assignee read cannot establish whether the original request may still complete. This case requires operator investigation.

The implementation is in [dispatch](../src/plugin/dispatch.mjs), the [assignment ledger](../src/plugin/assignment-ledger.mjs), [migration 019](../migrations/019_issue_assignment.sql) and the [Core retry mutation](../src/core/engine.mjs).

## Workspace and approvals

The dispatcher checks the pinned node and Pack policy before recovering an unassigned issue. Workflow starts, linked-child resumes and direct dispatch to a descendant also check the calling workflow's policy. A policy refusal leaves the issue unassigned. Existing assignments can still report their state without taking another slot. The host continues to block declared exclusive writers until it can enforce and revoke a physical writer's fence.

Lease acquisition reads the previous fence, competes for its successor through `db.execute`, and reads back only the exact owner and live fence it acquired. Renewal uses the same exact-fence receipt check. Release uses the affected row count. A linked worktree whose `commondir` points to a missing directory now reports partial creation.

Native decisions replace cards that lack a binding to the displayed run. The owner must answer the replacement even if the older card already has an answer. Cards from a previous format that **did** bind the same snapshot retain their compatibility path. The composition driver prepares the owner's outcome, evidence, decision ID and digest from one displayed dashboard. The wrong-agent probe requires an authorization denial. TypeScript consumers can import the digest helper from the Core entry point.

## Review and verification

Two independent reviewers examined the changes against a snapshot of the pre-task working tree. The standards review identified an incomplete public retry declaration. The final declaration includes the optional root and linked-run digest preconditions and the nullable next attempt. The acceptance review checked all nine findings, including same-key concurrency and linked-child advancement. Both reviews closed with zero open findings.

| Check | Result |
| --- | --- |
| Full local Node suite on Node 25.2.1 | 621 tests, 607 passed, 14 opt-in tests skipped, zero failures. |
| PostgreSQL-enabled selection on PostgreSQL 16.10 and Node 24.22.2 | 161 passed, zero skipped. This overlapping selection exercised all 13 database cases skipped locally, including the real dispatch-to-ledger bridge and the lease fence race. |
| Strict TypeScript 7 consumer | Compiled imports and calls to `runValidationDigest`, `resolveHumanGate` and `retryNode` under NodeNext resolution. |
| Build and artifact integrity | The bundled worker initialized through SDK JSON-RPC. The packaged runtime matched the verified working-tree build across 12 runtime files and 19 migrations. |
| Isolated Paperclip 2026.1106.0 with ADLC 0.3.3 | All three synthetic workflows completed on the final archive. Four wrong-agent probes received HTTP 403 and left the run and decisions intact. Four owner actions succeeded. |
| Whitespace | `git diff --check` passed. The remediation delta, including new files, also passed a whitespace check against the pre-task snapshot. |

The remaining opt-in test is the legacy MVP Docker scenario, which restarts the existing Compose host. Live workflow verification used a separate, disposable instance of the pinned Paperclip image. It ran `system-architecture-workflow`, `architecture-review-composed` and `code-delivery-workflow`. The final archive SHA-256 was `5986dcf9893ffae1743f230edbe6664c37cb5e6f1d6d0902f0a461c09b054f88`. The working-tree changes are uncommitted.

Local verification outputs include the [full suite log](../.audit/review-nov20-suite.log), [PostgreSQL log](../.audit/review-nov20-postgres.log), [build log](../.audit/review-nov20-build.log) and [isolated host evidence](../.e2e/review-nov20-final-eea29cea5d4e48b68b6e3d47c8725f2d/evidence.json).
