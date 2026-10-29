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
- The native adapter must have a positive timeout within the company limit.
  Same-Agent execution needs concurrency headroom for the child. A Shadow
  cannot use its parent's execution ID.
- One open Shadow is allowed per parent task. Durable claims, leases and
  compare-and-set transitions precede session creation and message submission.
  Ambiguous external calls are recovered or marked for repair, never blindly
  repeated.
- The review packet pins candidate identity, version, digest and run goals.
  It excludes author conversation and self-review. The native reply must be a
  bounded structured result citing the exact snapshot and candidates.
  An accept verdict with a P0 or P1 finding is rejected.
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

The final acceptance evidence and independent review findings are recorded after
the candidate is built and verified. The 2026-10-29 checkpoint remains historical
evidence for the earlier fixture implementation.
