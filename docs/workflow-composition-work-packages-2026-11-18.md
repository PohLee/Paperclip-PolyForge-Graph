# Workflow composition implementation work packages

Status: completed on the feature branch; local verification passed. No live Host/model acceptance or deployment was performed.

Branch: `codex/workflow-composition`. Base: `a6cd35c`.

## Objective and scope

Preserve PolyForge's versioned Pack, GraphEngine, evidence and authorization model while adding workflow input/output contracts, a shared runtime entry point, Agent tool wrapping, and child workflows. The user's November 18 request authorizes this feature work separately from the earlier selective-salvage plan. Do not import the abandoned dynamic-workflow branch wholesale.

Reuse one governed execution path across programmatic, Paperclip and Agent callers. Do not introduce an Eino Go dependency, arbitrary executable Pack code, a scheduler, or automatic deployment. Existing graphs without the new declarations remain supported.

## Architecture constraints

- Core remains host-neutral. Trusted identity is supplied by the Host, never by model-controlled payloads.
- Pin workflow/Pack versions and contracts for each run. Input/output validation supplements existing evidence contracts; it must not replace them.
- Tool calls initiate or inspect governed runs. They do not grant approval, fabricate execution receipts, or treat waiting as completion.
- Child execution must have durable parent-run/node/attempt identity and inherit company, delivery and authorization constraints. Reject stale child results, recursive invocation and unbounded nesting.
- Output projection must reference completed, applicable results and must be validated before reporting workflow success.
- Parent retries and invalidations must not silently reuse a previous attempt's child completion. Parent pause/stop must prevent further child dispatch and parent advancement; cancellation requests must not be reported as confirmed process termination.
- Reuse existing CAS state persistence and dispatch reservations. New side effects require stable identities and reconciliation; timeout is not evidence of non-execution.

## Work packages and ownership

### WP1 — Contracts and result projection

Owner: CLI contract implementer. Primary files: new `src/core/workflow-contracts.mjs` and focused tests. Core integration locations are coordinated with WP2 to avoid concurrent engine edits.

Deliver graph-level, versioned JSON input/output contracts and deterministic output projection. Explicitly define the supported schema subset and reject unsupported schema features rather than silently ignoring them. Validate declarations at registration, inputs before run creation, and outputs before accepted completion. Preserve graphs without workflow contracts.

Acceptance: malformed declarations, missing/invalid input, unsafe property paths, missing output, invalid terminal output and legacy compatibility. No evaluator or arbitrary code execution in mappings.

### WP2 — Core composition and child lifecycle

Owner: CLI Core implementer. Primary files: `src/core/engine.mjs`, shared runtime module, exports/types, and focused Core tests. This owner integrates WP1's validator calls.

Deliver explicit child-workflow declarations and durable links with exact workflow identity, parent attempt and input digest. Make child start/link creation atomic or recoverably idempotent; concurrent reconciliation cannot create duplicate children. Resolve output only from the current linked successful child. Preserve ordinary review and decision gates. Include a bounded nesting policy, cycle rejection, inherited delivery limits, and conservative failure/pause/rework behavior.

Expose a small runtime interface for start and inspect plus governed reconciliation. Keep existing GraphEngine operations as the authority for mutations. Define statuses for running, human wait, blocked, accepted completion, failure/stop and rework without converting them all to success/error.

Acceptance: child completion, human wait, failure, duplicate start, restart recovery, stale child callback, wrong-company access, version changes, parent invalidation and nesting limits.

### WP3 — Paperclip entry points and Agent tools

Owner: CLI Host implementer. Primary files: `src/plugin/worker.mjs`, `manifest.mjs`, dispatch integration, a workflow-tool adapter and focused plugin tests.

Route existing start entry points and new workflow tools through the same authorization and runtime path. Bind identity using real invocation context. Tool definitions expose approved workflow identity and validated input contracts; caller input cannot replace trusted identity, company, policy or pinned version. If official SDK tool registration limits dynamic tools, use a documented supported static wrapper rather than private Host APIs.

Long-running tools return a durable run handle and explicit status. Inspection must enforce the same company/issue access rules as current Graph reads. Child workflow nodes must not also dispatch as ordinary Agent tasks. Parent reconciliation after child callbacks must be scoped and idempotent.

Acceptance: equivalent starts across entry points, schema rejection, unauthorized/foreign run rejection, human waits, tool registration, child dispatch and callback integration. Keep existing Agent checkout/attempt fences.

### WP4 — Integration, verification and documentation

Owner: team lead. Define and freeze exact shared interface names before parallel implementation. Review each CLI agent's patch, integrate dependent work, and resolve interface mismatches. No independent Git commits or branch changes by implementation agents.

Add a runnable example Pack showing a parent workflow calling a versioned child, a manual gate, typed results and Agent tool invocation. Document supported contracts, entry points, lifecycle rules and explicit limitations. Update Core contract/types and README to match implemented behavior.

Run focused tests first, then the repository test suite and build. Verify packaging includes the new runtime exports. Use integration fixtures for Paperclip execution and report fixture evidence separately from real Host/model acceptance. Never label installation or unit-test success as a live end-to-end acceptance result.

## Delegation and model selection

Requested: `codex-cli`, model `gpt-6.1-terra`, reasoning effort `high`.

On November 18 the actual read-only readiness request returned `model_not_found`: "The 'gpt-6.1-terra' model is not supported when using Codex with a ChatGPT account." Branch creation succeeded. The user was asked to select a substitute or resolve model availability.

At the user's request, retried the same model with `model_reasoning_effort=high` on November 18 at 08:11 UTC. CLI confirmed the requested model and high reasoning in its invocation header, but the provider again returned HTTP 400 / `model_not_found` with the same ChatGPT-account restriction. At that time delegation remained blocked; no substitute was used.

The user subsequently selected `gpt-6-sol` with `high` reasoning. Three implementation agents and one independent read-only reviewer ran through codex-cli with that exact selection. Follow-up implementation sessions addressed integration and review findings. No agent changed the branch or made a commit.

## Completion ledger

| Item | Status | Evidence |
| --- | --- | --- |
| Feature branch | Complete | `codex/workflow-composition` from `a6cd35c` |
| Initial code inspection and work packages | Complete | This document; existing engine, manifest, worker and dispatch reviewed |
| CLI model selection | Complete | User authorized `gpt-6-sol`, `model_reasoning_effort=high`; implementation and review sessions ran |
| Contract/runtime/tool/child implementation | Integrated | Three scoped CLI agents; focused Core and plugin regression tests |
| Integration and tests | Complete | 376 tests: 367 passed, 9 skipped, 0 failed; build and artifact v4 verification passed |

## Completed verification

- `node --test tests/core/*.test.mjs tests/e2e/*.test.mjs tests/plugin/*.test.mjs`: 376 tests, 367 passed, 9 environment-dependent tests skipped, 0 failed. Baseline was 335 tests, 326 passed and the same 9 skipped.
- `node scripts/build.mjs`: passed; built worker initialized over JSON-RPC within 15 seconds.
- `verifyRuntimeArtifact(process.cwd())` from `scripts/runtime-artifact.mjs`: passed, format `polyforge-runtime-artifact-v4`, 12 file digests plus migration inventory. Added the reusable Host workflow wrapper to the attested inventory; older artifact formats require regeneration.
- `node examples/workflow-composition/run.mjs`: passed, reporting running, waiting_for_human, then completed with validated output. This is a synthetic fixture, not a real verification receipt.
- `git diff --check`: passed.

The environment's npm launcher points to a missing npm-cli.js, so repository test/build scripts were run directly through Node. No dependency installation or npm configuration change was needed.

## Integrated review findings

Independent read-only CLI review found child start-role bypass, incomplete status propagation for a grandchild, and an asynchronous dispatch interval that could wake a child after its parent was paused. All three were corrected and covered by regressions. Additional integration checks corrected exact Graph version enforcement and idempotency identity, blocked/failed handle statuses, mapping declaration validation, backward compatibility for fake Host dispatch, company/adapter checks, and object-key-order-independent fixed tool matching. Tool input now accepts every JSON root allowed by the contract.

Child start roles use the original root initiator's stored identity rather than the system orchestration identity. Packs declaring graphStartRoles must authorize every child Graph; Core retains legacy behavior when that declaration is absent. Runtime handles walk every ancestor. Dispatch rechecks current attempt and lineage immediately before issue creation and wakeup; this does not claim atomic cancellation of external work already started.

## Remaining boundaries

- Paperclip child execution for Packs needing trusted adapters is deliberately rejected until child-start adapter binding exists. Published ADLC Packs were not changed or republished.
- The generic tool wrapper is reusable; Paperclip registers a static workflow-run tool, not dynamically generated per-Pack tools.
- Standalone execution needs a trusted embedding Host and optional dispatch adapter. Existing store constraints remain. Pause/stop fencing is not physical external process cancellation.
- Live Paperclip/model, Software Factory, Warren, CI, PR, merge and deployment acceptance were not run. Tests use fixtures and mocks where indicated.
- Changes remain on codex/workflow-composition for review; no commit, push or merge was performed.
