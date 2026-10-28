# Core 0.4.0 / ADLC 0.1.7 implementation notes

This revision implements the verified Factory/Blueprint recommendations locally. It does not deploy the plugin or certify a release. The existing acceptance ledger records results for its original pinned versions.

## Migration

1. Build Core/plugin 0.4.0 with ADLC 0.1.7 available to the host. Reload the new pack version, preserving old pinned runs. No database schema migration is needed.
2. Include `architecture_context` for new implementation runs: actual accepted baseline reference and decision, or a reviewed not-applicable rationale. Principal Engineer selects the implementation shape after planning; the final handoff is the integrated candidate.
3. Include the complete reviewed `acceptance_criteria` list for new verification runs. QA submits the matrix after the three report branches. Human exceptions require reason, risk and exact matrix version; failed criteria cannot be waived by this contract.
4. Start optional system-architecture and code-delivery graphs only when applicable. The host verifies current baseline selection, live repository observations, reviewer eligibility and external sources. These graphs perform no PR or production mutation.
5. Bind the [host check runner](host-check-runner.md) explicitly to authorized tooling. The library supports injected agent checks; the CLI supports command checks. Store logs and manifests as sourced artifacts before using them in acceptance evidence.

The pack carries full payload examples in `policyDocuments.evidenceContracts`, also included in contracted task/gate dispatch instructions. The Graph API accepts the structured output and exception fields through existing submit/decision operations. Inputs are additive opt-in contracts; older snapshots retain their old behavior.

Contracted artifacts are immutable per attempt and cannot reuse an existing artifact ID/version. Their first self review hands off to the supervisor so corrections use rework and a fresh structured submission. This avoids output/artifact drift.

## Local validation

Core and plugin regression tests cover ordinary and escalated acceptance, version binding, architecture acceptance and invariant continuity, delivery checks and merge observations, and backward compatibility. Runner tests execute actual local Node processes and cover setup, retry feedback, retry limits, missing executables, infrastructure exits, timeout, output bounds and literal argument passing. Pack scenarios exercise all four implementation shapes and both optional workflows.

Run `npm test`, `npm run build`, and sibling pack `node --test`. The Docker test is opt-in and skips without its environment flag; it is not evidence that the installed Paperclip instance has been upgraded. Docker/model-provider/external PR/production validation was not performed for this revision.

Current fixture scripts use the new contract inputs and integrated handoff. The real-model starter reads its six acceptance checks from the approved brief and requires an explicit architecture context for a new implementation run: `node scripts/e2e-real.mjs start-implementation --architecture-context <file.json>`. Existing saved run IDs keep their original snapshots. Fixture pass observations are marked synthetic and do not establish application correctness.

Validated locally on 2026-10-28: Core/plugin tests 58 passed, one Docker test skipped; pack tests 22 passed; plugin and standalone runner build succeeded. These counts exclude external-host acceptance.
