# Temporary Agents

Temporary Agents are bounded executions delegated by an existing organizational Agent. They retain a parent execution and task link. The parent remains accountable for their output. Creating one does not create a new Agent in the company structure.

## Modes

| Kind | Context at start | Suitable work |
| --- | --- | --- |
| Sub-Agent | New clean session with an explicit brief | Independent review, research, analysis, implementation |
| Shadow-Agent | Native fork of the parent's available conversation and context at the fork boundary | Context-heavy research, analysis, implementation |

A Shadow-Agent receives no automatic conversation updates after its fork. A summary inserted into a new session is not a fork. The host must return a native fork receipt with the source parent session, child session, fork reference and fork time. For a Sub-Agent, the host returns a new-session receipt. Core checks the receipt's shape and identity separation; the host is responsible for verifying that its runtime actually performed the claimed operation.

Independent review always uses a fresh Sub-Agent. This avoids giving a reviewer the author's conversation. The existing `Shadow Task` and Shadow review records predate this formal distinction. They retain their original names and semantics. Existing records without a verified native fork receipt must not be relabeled as Shadow-Agents. New Graph review dispatches can keep their existing Shadow lifecycle while requesting a formal Sub-Agent execution.

## Request and authority

`validateTemporaryAgentRequest` accepts a version 1 policy and trusted parent authority. Policy defaults to disabled, at most three concurrent children per parent, one delegation level, and a fifteen minute duration. A caller cannot increase a parent's action permissions, deadline or cost ceiling. The host resolves parent authority from its authenticated work and Graph context; request fields alone do not grant authority.

Every request names its parent Agent and execution, requested kind and context mode, and a brief with objective, scope, output format, boundaries, input/evidence references, acceptance criteria, allowed actions and deadline. A child gets one task and one concurrent session. Initially, children cannot create grandchildren. Review, research and analysis use read-only workspace access. Implementation requires an exclusive writer. In a shared workspace, the host must grant a single writer lease and the policy and parent authority must both allow it. Read-only children can run in parallel within the parent cap. The host supplies current active children to enforce the concurrency bound atomically at reservation time.

The request asks for `fresh` or `fork`; it does not invent a child session or fork timestamp. After session creation, `validateTemporaryAgentContextReceipt` checks host-returned mode, distinct parent/child execution and session identities, and creation provenance. The host must ensure the fork captures only context available at that instant and cannot silently replace a requested native fork with a summary.

## Terminal result

`validateTemporaryAgentResult` accepts completed, failed, cancelled or timed-out results. Every terminal result identifies its execution and session, finish time and summary. A completed result includes bounded output or an output reference plus at least one evidence reference. The parent reviews this result and remains responsible for accepting, correcting or rejecting it. The result does not autonomously approve a Graph gate or organization decision.

## Contract modules

The pure validators and defaults live in `src/core/temporary-agent-contract.mjs`. They perform no host calls, session creation, filesystem writes or Agent registration. Runtime wiring must pair their request and receipt checks with atomic active-child reservation, actual session creation, stop/reconcile behavior and audit persistence. The existing `src/core/shadow-contract.mjs` continues to validate legacy Shadow review results against their reserved candidate snapshot.

## Current Paperclip host limits

The pinned Paperclip SDK can create and message a fresh Agent session but does not expose a native session fork, scoped native tools or native run cancellation. This host therefore offers read-only Sub-Agent delegation for review, research and analysis. It rejects Shadow-Agent and implementation requests before launch unless future host capabilities make their required guarantees enforceable. The read-only restriction is a Graph authorization and prompt boundary; the native Agent profile retains its configured operating-system and tool permissions, so it is not an OS sandbox.

The parent resolver requires an authenticated running heartbeat, an enabled company role binding and an issue checked out by that exact Agent execution. A Graph child issue must also have a matching active dispatch on its pinned run. When the heartbeat exposes a native session ID, the resolver uses it as the parent context reference. Otherwise a fresh child uses a stable `native-execution:<runId>` reference; this reference cannot establish a Shadow-Agent fork. Callers may omit the parent context reference, in which case the runtime inserts the resolver's trusted value before validating the request. A caller-supplied reference must match that value.

## Ambiguous native session repair

Session creation and send have no host idempotency key. If the worker loses a reply after either call, the launch enters `needs-repair` and retains its parent concurrency slot. Reconciliation does not retry the call. An owner can use `repair-temporary-agent` with a reason and an explicit repair decision:

- `attach-session` supplies the exact native `sessionId`. The runtime verifies that the active session belongs to the same company and Agent. If it finds one unique heartbeat with the launch task key, it checks the host recorded session ID before attaching the execution and resuming reconciliation. If the host did not record a session binding, the owner must set `confirmSessionAssociation: true`. If creation was ambiguous and no send occurred, it closes the identified session and records the launch as `abandoned`.
- `abandon-unknown-session` requires `confirmNoSession: true` and does not accept a caller supplied session ID. This is an owner attestation to abandon the uncertain launch, not proof that no session exists. Only a session ID already saved in the durable launch may be closed. The audit record notes a possible orphan when the session cannot be identified. A matching active heartbeat must be attached instead.

The repair decision, actor, reason, time, matched session and execution, and state transitions are appended to the durable launch event history. `abandoned` is distinct from `cancelled` and never accepts a child result. The owner may need to inspect the host's native sessions separately if the original session ID was lost.

Scheduled reconciliation has no company invocation context. It reads native heartbeat state and may record a terminal launch as `closing`, but does not create, message or close native sessions. A company-scoped run event or authenticated company read completes native session cleanup. If a run event was missed during restart, the next authenticated read finishes a pending close; scheduled reconciliation alone does not claim native cleanup.
