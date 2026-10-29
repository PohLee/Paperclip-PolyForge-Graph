# Shadow execution and recovery

## Accepted scope

The user authorized production Shadow support, same-Agent independent executions,
Graph triggers, recovery during execution, and an independent final review.
Core 0.8.1 and ADLC 0.2.1 are candidate versions on the enhancement branch.
ADLC verification Graph 0.1.4 requires `shadow-review-execution`; existing runs
remain pinned to their original Pack, Graph and goal versions.

## Execution contract

- A company owner explicitly enables Shadow execution, allowed adapter types,
  Agent and Graph triggers, same-Agent sessions, and a duration limit of at most
  900 seconds. Changes record actor, reason and an idempotency key.
- A reviewer uses an existing company-bound Agent and a fresh native task
  session. It inherits that Agent's configured adapter, tools, budget and native
  accounting checks. The runtime never supplies credentials or removes holds.
  Agent-triggered requests use that same Agent; an owner may select another
  company-bound reviewer. The accepted adapters are `process`, `codex_local`,
  `claude_local` and `opencode_local` when explicitly allowed by company policy.
- The native adapter must have a positive timeout within the company limit.
  Same-Agent execution needs concurrency headroom for the child. A Shadow
  cannot use its parent's execution ID.
- One open Shadow is allowed per parent task. Durable claims, leases and
  compare-and-set transitions precede session creation and message submission.
  Ambiguous external calls are recovered or marked for repair, never blindly
  repeated.
- The review packet pins candidate identity, version, digest and filtered run goals.
  It excludes author conversation and self-review. The native reply must be a
  bounded structured result citing the exact snapshot and candidates.
  An accept verdict with a P0 or P1 finding is rejected.
  Sensitive fields are removed from the packet; the Core audit retains the
  original goal snapshot. Oversized context is rejected, never silently truncated.
- Graph nodes declare
  `shadow: {trigger: 'before-dispatch', reviewer: 'same-agent', required: true}`.
  The main node waits for an accepted review of its current attempt and
  candidate snapshot. This does not replace its independent supervisor gate.
- Shadow executions cannot borrow their parent Agent's Graph/company API
  authority. The host still controls native tools and filesystem permissions;
  an independent session is a context boundary, not an operating-system sandbox.

## Recovery contract and host limits

The pinned Paperclip host is 2026.1023.0. Session callbacks are not replayed after
a worker restart. Reconciliation reads the declared `heartbeat_runs` core table
with exact company, Agent, task key and native run constraints, and checks the
native terminal result before closing a review.

Closing a native session does not cancel its heartbeat. A stop request records
intent and prevents acceptance; it does not claim cancellation while native work
is running. An expired queued run can outlive the review deadline because the
native adapter timeout starts when execution starts. Late results never approve
the Graph. The Board can cancel a native run through Paperclip's own controls.

The SDK cannot identify a session by task key after an uncertain session-create
acknowledgment. Such a launch is retained for operator repair instead of creating
a second session. An uncertain send can be matched to one exact durable native
run; multiple matches remain ambiguous. A full host interruption is recorded as
failure when the host marks the native run interrupted; it is not successful
review and does not trigger a replacement billable run.

## Acceptance

Validation uses the real isolated Docker host on port 3312 and deterministic
process Agents. It establishes orchestration and recovery behavior, not the
quality of paid-model reviews. Real email/Telegram outbound remains disabled.

### Executed verification — 2026-10-30 (Asia/Kuala_Lumpur)

- Core/plugin regression: **166 passed, 0 failed, 1 Docker-only test skipped**.
- Packs: **33/33 passed** against Core 0.8.1 contract snapshot
  `sha256:2256bfc6ece4b536dad2a6a2c91c2ba026b01836829ac0221baa41941ffe15cf`.
  The snapshot contains `src/core/` and `src/plugin/review-context.mjs`, not the
  complete plugin. ADLC 0.2.1 payload is
  `sha256:82948420027ec8ba6d6e3410248b6a90348761c81b52630047f8fac90f856fb5`;
  Marketing 0.0.1 remains unchanged.
- Build and desktop browser inspection passed, including company Shadow policy,
  session/execution identity, status, stop controls and parent Graph links.
- The real Docker host passed the six scenarios below using process Agents.

| Scenario | Observed result |
| --- | --- |
| Declarative Graph trigger | Shadow completed before QA's native heartbeat began; Graph retained ADLC 0.2.1 / verification 0.1.4 and its original goals |
| Same-Agent request | QA created its own second session and execution, then continued the parent task |
| Owner request and replay | Exact replay retained the original identity; changed reason with the same key was rejected |
| Worker restart during execution | Original native run succeeded; reconciliation retained its session, execution, candidate snapshot and goal versions |
| Full host restart during execution | Paperclip recorded `interrupted` / `server_shutdown_interrupted`; Core recovered it as failed, with no accepted result or replacement execution |
| Stop while executing | Stop replay retained its original timestamp; native process later succeeded but Core recorded cancelled and discarded the review |

Graph run: `ad29aed9-3ec7-4ed5-920e-09911a73a41d` in development company
`0eb56cf1-9491-4a77-bb13-bc51715870bc`. Worker recovery native execution:
`534cb2f7-049d-49cc-afe1-6de35ce4917d`; full host interruption:
`cd62cabc-5a2e-4028-ad46-1f068d4555ce`; stopped execution:
`8e67bb48-13e1-4bb1-935a-17f96ed95715`. A scoped read of the native database
confirmed exactly one execution per task key for all three cases. Private
checkpoints and credentials remain under ignored `.e2e/`.

Reproduce with `scripts/e2e-shadow-production.mjs`: default or `--phase=resume`,
then `--phase=stop`, then `--phase=restart-capture`, restart the development
Paperclip container while that captured execution is running, and run
`--phase=restart-verify`. The last case expects the host's actual interrupted
result; it does not expect the native process to continue through container death.

### Independent final review

Fresh GPT-6 Sol / High reviewers examined Standards and Spec independently from
Core `6fb359d` and Packs `7479799` through the candidate, then reviewed the repair.
Both found the stop-versus-completion race. It was fixed by resolving stop intent
inside Core's same state transaction and persisting that authoritative result in
the launch row. Both verified the repair with **no remaining P0/P1**. Standards
also noted a non-blocking canonical-serializer duplication (P2); no cosmetic
refactor was included in this runtime change.

### Remaining verification limits

No paid model was invoked, so production adapter review quality and real model
execution remain untested. Native tools and filesystem permissions are inherited
from the configured Agent. Real email/Telegram outbound remains disabled.

At this record's baseline, the pinned host intermittently exceeded its 15-second
plugin initialization deadline on the Windows-mounted development build.
Official enable retries succeeded. The subsequent
[architecture verification](architecture-deepening-2026-10-30.md#worker-startup-diagnosis)
reproduced the failure, measured the external dependency import bottleneck and
fixed the worker build by bundling its dependencies. The harness retains its
bounded retry for this explicit timeout; it is not needed to demonstrate the
measured startup repair.
Earlier failed development attempts remain in history. The 2026-10-29 checkpoint
remains historical evidence for the earlier fixture implementation.
