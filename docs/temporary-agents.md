# Temporary Agents

Temporary Agents are bounded executions delegated by an existing organizational Agent. They retain a parent execution and task link. The parent remains accountable for their output. Creating one does not create a new Agent in the company structure.

## Modes

| Kind | Context at start | Suitable work |
| --- | --- | --- |
| Sub-Agent | New clean session with an explicit brief | Independent review, research, analysis, implementation |
| Shadow-Agent | An independent fresh session with a frozen handoff of the parent's work context | Context-heavy research and analysis on the current host |

A Shadow-Agent currently uses explicit `snapshot` mode. The parent supplies a compact handoff, Core adds authoritative decisions, and the host creates a separate session. The handoff remains fixed after launch. It is a context transfer, with no claim to reproduce every message or internal model state. The receipt records a new session and the snapshot's digest and capture time. Source identity is retained in the snapshot, bound by that digest, and exposed in the public context metadata. Native fork requests remain unsupported; no fork bridge is part of this implementation.

Independent review always uses a fresh Sub-Agent. This avoids giving a reviewer the author's conversation. The existing `Shadow Task` and Shadow review records predate this formal distinction. They retain their original names and semantics. Existing records without a verified native fork receipt must not be relabeled as Shadow-Agents. New Graph review dispatches can keep their existing Shadow lifecycle while requesting a formal Sub-Agent execution.

## Request and authority

`validateTemporaryAgentRequest` accepts a version 1 policy and trusted parent authority. Policy defaults to disabled, at most three concurrent children per parent, one delegation level, and a fifteen minute duration. A caller cannot increase a parent's action permissions, deadline or cost ceiling. The host resolves parent authority from its authenticated work and Graph context; request fields alone do not grant authority.

Every request names its parent Agent and execution, requested kind and context mode, and a brief with objective, scope, output format, boundaries, input/evidence references, acceptance criteria, allowed actions and deadline. A child gets one task and one concurrent session. Initially, children cannot create grandchildren. Review, research and analysis use read-only workspace access. Implementation requires an exclusive writer. In a shared workspace, the host must grant a single writer lease and the policy and parent authority must both allow it. Read-only children can run in parallel within the parent cap. The host supplies current active children to enforce the concurrency bound atomically at reservation time.

The request asks for `fresh` (Sub-Agent) or `snapshot` (Shadow-Agent). It does not supply the child session, authoritative decisions, snapshot digest or capture time. After session creation, `validateTemporaryAgentContextReceipt` checks the host-returned mode, distinct parent/child execution and session identities, and creation provenance. A request for `fork` is rejected rather than silently converted to `snapshot`.

## Snapshot handoff

The parent prepares the handoff inside its own conversation. The Paperclip SDK does not expose an API for this plugin to retrieve that entire conversation. A Shadow-Agent request supplies:

```json
{
  "kind": "shadow-agent",
  "purpose": "analyze",
  "context": {
    "mode": "snapshot",
    "snapshot": {
      "objective": "Assess the next implementation step",
      "currentState": "The existing behavior and candidate are documented in the referenced records",
      "conclusions": ["Keep the accepted product behavior"],
      "openQuestions": ["Which existing tests cover the proposed extension?"],
      "evidenceRefs": [{ "kind": "issue", "id": "the-parent-issue-id" }]
    }
  }
}
```

The existing `id`, authenticated `parent`, bounded `brief`, `limits` and `workspace` fields are still required. The parent selects task-relevant context and source references; credentials and unrelated private data do not belong in the handoff.

Core keeps the parent's advisory context separate from authoritative decision records. An assertion in the summary is not approval. For example, a claim that subtraction may become addition cannot replace the recorded rejection of that change. The child must report conflicts to its parent, and its result cannot approve or bypass a Graph gate.

The authoritative packet comes from the company's durable state under the verified parent issue and Graph scope. Product history retains approved, proposed, rejected, deferred and superseded records with their original status. Active product baselines are identified separately: a rejected replacement does not supersede an approved baseline. Ordinary issues without a trusted feature association conservatively receive company product history. Oversized or unavailable authoritative context blocks launch instead of being silently truncated.

Core records the packet before native session creation. Its source binds the company, parent Agent, execution, issue and available Graph context. Retries and restart recovery reuse that packet and verify its digest before dispatch. Later parent edits or decision changes do not rewrite it; a new delegation captures a new snapshot. Snapshot integrity proves which packet was saved and dispatched, not that the parent's narrative is correct or that a model understood it.

Independent review uses a fresh Sub-Agent with the spec and candidate evidence. A Shadow-Agent's inherited conclusions are unsuitable for that independent-review requirement.

## Terminal result

`validateTemporaryAgentResult` accepts completed, failed, cancelled or timed-out results. Every terminal result identifies its execution and session, finish time and summary. A completed result includes bounded output or an output reference plus at least one evidence reference. The parent reviews this result and remains responsible for accepting, correcting or rejecting it. The result does not autonomously approve a Graph gate or organization decision.

## Contract modules

The pure validators and defaults live in `src/core/temporary-agent-contract.mjs`. They perform no host calls, session creation, filesystem writes or Agent registration. Runtime wiring must pair their request and receipt checks with atomic active-child reservation, actual session creation, stop/reconcile behavior and audit persistence. The existing `src/core/shadow-contract.mjs` continues to validate legacy Shadow review results against their reserved candidate snapshot.

## Current Paperclip host limits

The pinned Paperclip SDK can create and message a fresh Agent session but does not expose a native session fork, scoped native tools or native run cancellation. This host offers Sub-Agent delegation for review, research and analysis, and Shadow-Agent snapshot delegation for research and analysis. Implementation and native fork requests are rejected before launch. The read-only restriction is a Graph authorization and prompt boundary; the native Agent profile retains its configured operating-system and tool permissions, so it is not an OS sandbox.

The parent resolver requires an authenticated running heartbeat, an enabled company role binding and an issue checked out by that exact Agent execution. A Graph child issue must also have a matching active dispatch on its pinned run. When the heartbeat exposes a native session ID, the resolver uses it as the parent context reference. Otherwise it uses a stable `native-execution:<runId>` provenance reference. Snapshot delegation can use this reference because it transfers an explicit handoff; it does not claim access to native history. Callers may omit the parent context reference, in which case the runtime inserts the resolver's trusted value before validating the request. A caller-supplied reference must match that value.

## Ambiguous native session repair

Session creation and send have no host idempotency key. If the worker loses a reply after either call, the launch enters `needs-repair` and retains its parent concurrency slot. Reconciliation does not retry the call. An owner can use `repair-temporary-agent` with a reason and an explicit repair decision:

- `attach-session` supplies the exact native `sessionId`. The runtime verifies that the active session belongs to the same company and Agent. If it finds one unique heartbeat with the launch task key, it checks the host recorded session ID before attaching the execution and resuming reconciliation. If the host did not record a session binding, the owner must set `confirmSessionAssociation: true`. If creation was ambiguous and no send occurred, it closes the identified session and records the launch as `abandoned`.
- `abandon-unknown-session` requires `confirmNoSession: true` and does not accept a caller supplied session ID. This is an owner attestation to abandon the uncertain launch, not proof that no session exists. Only a session ID already saved in the durable launch may be closed. The audit record notes a possible orphan when the session cannot be identified. A matching active heartbeat must be attached instead.

The repair decision, actor, reason, time, matched session and execution, and state transitions are appended to the durable launch event history. `abandoned` is distinct from `cancelled` and never accepts a child result. The owner may need to inspect the host's native sessions separately if the original session ID was lost.

Scheduled reconciliation has no company invocation context. It reads native heartbeat state and may record a terminal launch as `closing`, but does not create, message or close native sessions. A company-scoped run event or authenticated company read completes native session cleanup. If a run event was missed during restart, the next authenticated read finishes a pending close; scheduled reconciliation alone does not claim native cleanup.
