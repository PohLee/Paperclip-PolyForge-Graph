# November P0 hardening implementation and verification

Date: 2026-11-19, Asia/Kuala_Lumpur. Source baseline: `f998cb9c67dab1b04c3edb210fb0a67419720f83` (Core 0.8.10). Changes are an uncommitted source candidate; no release, installation or deployment was performed.

## Delegation and implementation

The lead delegated implementation to three sub-agents, each explicitly configured as `gpt-6.1-terra` with `high` reasoning. Two further agents using the same model/settings independently reviewed documented standards and the P0 specification. The [work packages](p0-hardening-work-packages-2026-11-19.md) define scope and ownership.

| Package | Implemented in this candidate | Acceptance boundary |
| --- | --- | --- |
| WP1: workspace | Bounded Git metadata resolution, authorized roots, shared common-directory contention identity, PostgreSQL fencing lease primitive; declared exclusive writes denied before assignment on the current Host | Partial: physical fencing, writer revocation, credential isolation, automatic setup compensation and lease/slot lifecycle are not implemented by the current Paperclip Host adapter. Undeclared legacy work remains unmanaged. A database lease is not process isolation. |
| WP2: approvals | Direct, UI, native and adapter-backed resolutions require displayed pending decision ID and run digest; consume through Core CAS; approval replay binds original digest | Implemented and regression-tested through local Core/Host fixtures. External clients of `resolveHumanGate` / `resolveReworkLimit` must send the new required preconditions. |
| WP3: lifecycle | Separate normalized dispatch/start proof and trusted dependency/finalize assessment; phase-specific blockers; declared privileged Agent/automatic/child-workflow progression denied without confirmed finalize facts | Partial: current Host does not supply the new lifecycle assessment hook. Legacy nodes remain unmanaged. No workspace finalize operation or merge/deploy executor is added. |
| WP4: effects/retry | Durable assigned-issue operation identity, request fingerprint, one-send authority, immutable confirmed outcome, unknown-result reconciliation, strict origin identity; existing reset limits preserved across pause/resume | Implemented for assigned issue creation. Arbitrary tools, merge/deploy and a general semantic retry ledger remain outside this integration; this is not a universal effect executor. |
| WP5: MCP | Secret-free operator inventory CLI, explicit fixed-version minima, rejection of affected npm date versions, bounded config traversal without regex execution | Partial: no deployed MCP service inventory or live gateway request path is available in this repository. The checker neither installs patches nor establishes that a deployment is secure. |

Implementation details and focused verification are in [approval completion](p0-approval-completion-2026-11-19.md), [dispatch/effects completion](p0-dispatch-effects-completion-2026-11-19.md), and [workspace/security completion](p0-workspace-security-completion-2026-11-19.md).

## Review and corrective work

Standards and specification were reviewed separately against the initial commit and the working tree, including untracked additions. No issue-tracker configuration was present; this chat and the checked-in work packages were the specification. The lead also reviewed identity binding, migration numbering, version ordering and failure paths.

Standards review found that the Pack facade could replace the displayed approval digest with a fresh digest. Both facade layers now preserve the original precondition, including installed trusted adapters that recompute a digest. A regression uses the installed ADLC adapter.

Spec review found that a human retry could bypass an unresolved issue-creation record, automatic/child-workflow paths could bypass lifecycle admission, and approval idempotent replay accepted changed or missing digests. Corrective work and regressions cover these paths. Follow-up review identified irreversible retirement before a rejected retry and a concurrent identical retry retiring its successor's operation. The worker now validates the reason before retirement, reads idempotency and run state from one snapshot, and passes that snapshot's digest to Core. Atomic cancellation records compete with send claims, so a retired operation cannot subsequently send. If a concurrent change still rejects the Graph mutation after retirement, the old unsent operation deliberately remains blocked; a fresh authorized retry is the tested recovery path. It is never silently relabelled safe to send. Both independent reviewers confirmed their concrete blockers addressed after targeted re-review. The lead also corrected duplicate migration numbering and the npm date-version ordering loophole. Live Host requirements in the table remain open rather than being counted as passed.

## Verification ledger

Final verification after all source corrections:

| Check | Result |
| --- | --- |
| `node --test tests/core/*.test.mjs tests/e2e/*.test.mjs tests/plugin/*.test.mjs` | 407 total, 398 passed, 9 skipped, 0 failed |
| `node scripts/build.mjs` | Passed, including built worker initialization over official SDK JSON-RPC |
| `verifyRuntimeArtifact(process.cwd())` from `scripts/runtime-artifact.mjs` | Passed, `polyforge-runtime-artifact-v4`, 12 file digests and 18 migrations |
| `git diff --check` | Passed |
| Standards re-review | Reported approval precondition violation closed; 56 focused Core/adapter tests passed |
| Spec re-review | Reported approval, progression and retry race findings closed; explicit fresh-retry recovery limit retained |

Node version: `v25.2.1`. Raw local logs are under `.audit/p0-hardening-tests-2026-11-19.log` and `.audit/p0-hardening-build-2026-11-19.log`. Build output is ignored local output, not a published package.

The initial baseline suite reported 374 passed, 1 failed and 9 skipped. The failure was the existing independent-test subprocess check; its isolated rerun passed all four tests. The first integrated suite exposed a pause-during-origin-lookup regression, which was corrected by rechecking eligibility before recovery. Final results above supersede intermediate runs.

Environment-dependent PostgreSQL tests are skipped without their explicit test database configuration. Neither `docker` nor `psql` was available on PATH during this task. PostgreSQL migrations and physical Host fencing were not exercised on a live service. The existing November 18 release acceptance is historical evidence for that release, not acceptance of this source candidate.

## Remaining work packages before full P0 closure

1. Implement a real Host workspace adapter with a shared fencing authority, handle-based identity checks, idempotent attempt admission, slot compensation, renewals, writer revocation and terminal release. Classify and compensate partial worktree creation, including database registration. Verify with two physical writers and crash/restart tests on the target Windows Host.
2. Supply authenticated, current phase/dependency/finalize facts from the deployed Paperclip integration; validate the review-after-blocker and finalize-failure recovery scenarios on the real Host. Migrate selected reviewed Pack versions to explicit declarations; undeclared legacy work is not automatically protected by the new contracts.
3. Execute migrations 017/018 and concurrency tests against a dedicated PostgreSQL test database. Validate contention across runs/companies and recovery across processes; fake database tests cannot establish PostgreSQL behavior.
4. Obtain the deployment MCP inventory, patch actual servers, and attach budgets/confinement enforcement to the actual gateway. Test malicious Git config, symlink/junction replacement, alternates and IPv6/private-address cases inside an appropriate isolated test environment. The inventory CLI is a policy input, not those regressions.
5. Extend the effect/retry model when actual external tool or publication executors are introduced, keeping stable business operation IDs, bounded counters and reconciliation. Rebuild and publish a new reviewed Core/Pack version only after target Host acceptance.

The repository safety changes are reviewable, but full operational closure of all five P0 issues requires the Host/deployment work above.
