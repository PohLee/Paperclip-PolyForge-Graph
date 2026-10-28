# Graph Core contract (MVP)

Import `GraphEngine`, `MemoryStore`, `FileStore`, and `RevisionConflict` from `src/core/index.mjs`. The engine is host neutral and never invokes an agent. Every method is asynchronous. The host selects a ready node, invokes the right runtime, and commits the result back to the engine.

## Pack schema

```js
{
  id: 'adlc', version: '0.1.0',
  graphs: [{
    id: 'implementation', version: '0.1.0', start: 'plan',
    nodes: [
      { id: 'plan', type: 'task', role: 'principal-engineer' },
      { id: 'build', type: 'task', role: 'lead-engineer',
        review: { supervisorRole: 'principal-engineer', maxSelfReviews: 5 } },
    { id: 'gate', type: 'decision', role: 'cto', decisionType: 'implementation_acceptance',
        candidateNodes: ['build'], candidateKinds: ['implementation_candidate'],
        reworkTarget: 'plan', maxReworks: 3 },
      { id: 'done', type: 'end' }
    ],
    edges: [{ from: 'plan', to: 'build' }, { from: 'build', to: 'gate' },
      { from: 'gate', to: 'done', when: 'accept' }]
  }],
  decisionRules: [
    { type: 'implementation_acceptance', mode: 'manual',
      allowedKinds: ['human'], allowedRoles: ['owner'], requiredEvidence: ['qa'] }
  ]
}
```

Other Pack metadata, such as role documents, skills, and policies, is copied into the pinned run snapshot. Graphs are DAGs. Nodes are `task`, `decision`, `join` (with `mode:'all'`), or `end`. `role` is an optional dispatch and authorization role. `independentOf:['node-id']` requires a different trusted execution ID from prior work at those nodes; if an execution ID is unavailable, it requires a different actor ID. A Pack may require distinct actor IDs as a stricter policy. Edge `when` matches a decision `outcome` or task `output.route`. Omit `when` for unconditional routing. Multiple matching edges activate parallel paths. A normal node with several incoming edges uses OR activation; an ALL join waits for every active incoming branch, including a branch whose execution is still pending. A decision may use `reworkTarget` to restart an earlier stage without a cyclic edge. `maxReworks` defaults to 3 until the Pack configures a bound; reaching the bound pauses for human resolution.

Pack `requiredInputs` are executable: each named kind must exist as a nonempty `run.input[kind]` or a current, completed upstream artifact `{kind,id,version}`. A start node with missing inputs rejects `startRun`; other nodes are omitted from `getReadyNodes` until inputs exist and appear in `getBlockedNodes` with `missingInputs`. `requiredInputAny:[['kind-a','kind-b']]` requires at least one member of each group. A task with `produces:['kind-a','kind-b']` must submit one versioned artifact for each kind. Cross-Graph handoffs accept `{id,version}` or `{artifactId,version}` identities for `versioned_*` and `*_identity`; `implementation_candidate` may be a composite `{artifacts:[{artifactId,version},...]}`. If any node declares `product_decision_refs`, `startRun` requires `input.feature` and a nonempty `input.product_decision_refs` array whose IDs exactly cover the approved active product decisions for that feature. Unknown, superseded, and other-feature IDs are rejected. A parallel `input.productDecisionRefs` alias must agree. Feature-scoped task submission checks the current active decisions again, so supersession during a run requires updated references.

Decision rules are selected by exact `type` and run `mode`. `allowedKinds`, `allowedRoles`, `requiredEvidence`, `requiresHuman`, and `allowUnresolvedSevere` are supported. A missing rule rejects the decision. Set reviewed task `review.decisionType` to a Pack rule type (ADLC uses `review-disposition`). The Pack's Markdown decision documents can be parsed by the integration adapter into this array. Registering a changed Pack under an existing `id@version` fails; a run copies the complete selected Pack and Graph at start. Pack equality and idempotency fingerprints canonicalize object key order to survive PostgreSQL JSONB reloads; array order remains significant.

### Final selection

A decision that chooses a single final design can opt in with `selection: { sourceNodeId:'filter-finalists', outputKey:'selectedFinalists', frozenNodeIds:['freeze-a1','freeze-b1'] }`. The source task must precede the decision and submit an output array of `{artifactId,version}` references. The frozen task nodes must also precede the decision. On `accept`, `decideNode` and `resolveHumanGate` require exactly one decision artifact `{id,version}` that appears in the current completed source shortlist **and** in a current completed frozen node's artifacts. A stale version, an unshortlisted candidate, or two selected artifacts rejects the decision without recording it. Other outcomes and older pinned graphs without `selection` keep their existing behavior. The comparison and rejection rationale remain in the Pack's experiment artifact and the decision reason/evidence; the engine validates identity, not design quality.

## Runtime calls

```js
const core = new GraphEngine({ store });
await core.registerPack(pack);
const run = await core.startRun({ packId:'adlc', packVersion:'0.1.0',
  graphId:'implementation', mode:'manual', input:{...}, actor, idempotencyKey });
const ready = await core.getReadyNodes(run.id); // query only; no dispatch side effects
const work = await core.getWorkItems(run.id); // pinned rules classify work for the host
await core.submitNode({ runId:run.id, nodeId:'plan', actor, output:{...},
  artifacts:[{kind:'implementation_plan',id:'plan',version:'v1'}], evidence:[], idempotencyKey });
```

The **trusted** `actor` comes from the host invocation context, separately from `input`, `output`, and issue payloads: `{id,kind:'human'|'agent'|'system',roles:[...],executionId}`. Agent actions require an execution ID. The core ignores identity claims inside task payloads. A host must not fill this context from model output or a caller controlled field. It should bind Paperclip actor and invocation identity itself.

Use `decideNode({runId,nodeId,actor,outcome,reason,evidence,artifacts,options,idempotencyKey})` for decision nodes. It saves a Decision Record before the route becomes effective. On a node with `candidateNodes`, each required evidence item must contain `subjectRefs:[{artifactId,version}]` covering every current candidate artifact. `candidateKinds` selects candidate artifact kinds when those nodes also produce reports. Old reports cannot authorize a changed candidate. Reviewed work uses `submitNode` to enter `awaiting_self_review`, `recordSelfReview({runId,nodeId,actor,artifactVersion,findings,fixes,evidence,revisedArtifact?,idempotencyKey})` for up to five rounds, and `reviewWork({runId,nodeId,actor,outcome:'accept'|'rework',reason,evidence,knownRisks,idempotencyKey})` for an independent supervisor. Self review must reference the latest submitted or revised artifact version; clearing prior P0/P1 requires a newly versioned artifact. Review evidence required by a rule binds to that latest artifact. A severe unresolved finding needs both explicit risk handling and `allowUnresolvedSevere:true` in the rule to be accepted. `reviewWork` rework resubmits the same node; a decision node's `reworkTarget` restarts a whole stage and conservatively invalidates every downstream node.

`pauseRun` and `resumeRun` preserve the pinned version and pending state. A ready decision node can call `escalateNode` (or `decideNode` with `outcome:'human'`) to record escalation and pause. `resolveHumanGate` requires a trusted human with `human-owner` role, records a linked decision, and routes or reworks. `openConflict` stores both CPO/CTO positions and unresolved items, records escalation, and pauses. `resolveConflict` and `resolveReworkLimit` also require a trusted human with `human-owner` role. `end` nodes with `output:'human_decision_pending'` pause; `output:'rework_required'` set a distinct `rework_required` run status. Neither counts as accepted completion. `invalidateEvidence` can conservatively reset a changed node and all downstream evidence while retaining historical attempts; it does not clear a human wait. `recordProductDecision`, `getProductMemory`, and `assertProductChangeAllowed` support product decision history and supersession. Only an **approved** successor retires an old approval. A standalone agent cannot approve a product decision without a run policy. For feature scoped runs (`input.feature`), each task submission checks current active decisions and references. If `input.changesBehavior` is true, submission also requires `approvedChangeDecisionId` referencing an approved superseding decision with a matching `changeScope`; these may be supplied on `submitNode` if the decision is made after run start. Missing context blocks work. `getRun`, `listDecisions`, and `getAudit` expose traceability.

For an interrupted or failed host execution, `retryNode({runId,nodeId,actor,reason,idempotencyKey})` requires a trusted human with `human-owner` role. It records a `node_retry` decision and `node.retry_requested` audit event, retains prior attempts, clears the node and dependent evidence, and returns `nextAttempt` for a fresh dispatch key. A pending node with no callback receives an `abandoned_before_submission` attempt to prevent the host from reusing a dead dispatch key. It rejects paused runs and unresolved human gates; the host should show the current dispatch issue and host run ID so the owner can investigate before retrying. It does not infer a failed heartbeat or retry automatically.

The Paperclip adapter dispatches work from authenticated commands and callbacks. Recovery after a worker restart uses an explicit owner `dispatch` command on the root issue with a reason. Each authenticated request is appended before dispatch to the company-scoped `graph_dispatch_requests` table with actor, issue, run, feature, pinned versions, reason, time, and idempotency fingerprint. This keeps concurrent requests auditable without rewriting the complete Graph state; same-run dispatch work is shared only while in flight. Exact retries return the original record, and changed requests with a reused key fail. Historical `paperclip_dispatch_recovery` records and keys in core state remain valid and are returned without creating a second record. Dashboard decision lists merge both stores by record ID. This adapter-specific audit table does not change the GraphEngine storage contract. The adapter must not issue host wakeups from a raw setup timer, which has no valid host invocation scope. A `waking` dispatch may bind an early callback's host run ID only after the host confirms the exact child issue checkout for the same agent and run, and a storage CAS confirms the current run/node/attempt/phase/issue/agent row. A later wakeup response with a different run ID fails closed. A `claimed` or `issued` dispatch cannot bind from a callback. The host may separately start its assigned issue through its own liveness mechanism; exact checkout and CAS apply there as well.

For host configuration, Pack reload, provisioning, or dispatch choices outside a Graph run, call `recordDecision({type,status,outcome,reason,actor,issueId?,projectId?,taskId?,affectedRefs?,idempotencyKey?})`. It writes an append-only Decision Record using the same CAS commit boundary. The host must authorize the operation before calling it; this generic recorder does not grant permission to perform the operation.

Pass a stable `idempotencyKey` from the host event for each mutating callback. The engine saves result values under scoped keys so retries have one effect, and rejects reuse of a key with a different actor or request. For a missing key, duplicate submissions after a node advances are rejected. Ready-node queries have no claim/lease mechanism; the adapter should ensure one dispatch per ready node or use a stable event key on commit. No LLM call is represented as completed merely because a node is ready.

`getWorkItems` describes eligible work using the run's pinned Pack rule. It includes ready nodes and independent reviews, classifies each item as `automatic`, `agent`, `human`, or `blocked`, and reports paused human resolutions. The host still binds a real actor and checks the actual callback. This query grants no authority and has no dispatch side effects.

### Explicit work and product choices

A newer pinned Pack can set `decisionTraceRequired: true` on important task nodes. Before `submitNode`, the current trusted actor calls `recordWorkDecision` with a concrete question, named options, a selected option ID, reason, and sourced evidence. One option is valid when the actor cites a pinned `ruleRef`, such as `node:<nodeId>`; it represents applying a rule, not an invented alternative. Evidence uses `sourceRef` to a present run input, active product decision, current upstream artifact ID and version, same-run decision, or external HTTP URL. The returned Decision Record is append-only and binds actor ID, kind, execution ID, node ID, and current attempt. `submitNode({...,decisionIds:[record.id]})` rejects a missing or mismatched record. Legacy pinned Pack tasks without the flag retain their prior submit contract. This records explicit choices supplied through the tool; it does not reveal a model's hidden reasoning or intercept arbitrary host side effects.

For a feature-scoped flagged task, each work choice must state `behaviorImpact: 'none' | 'changes' | 'unknown'`. Unknown impact can be recorded but blocks submission. A change additionally names `changeScope`; submission requires an active approved product decision that supersedes the previous approval and covers that scope. The work choice and submit must cite the current active `productDecisionRefs`. The new Pack may set `policies.productMemory.proposalRequired:true`: when a run approves a superseding product decision, a prior `status:'proposed'` record with the same feature, predecessor, outcome, and change scopes must be linked by `proposalId`. Standalone human approvals can also link a proposal, but there is no pinned run policy to require it. Dispatch records that current product memory was included in the issue context; that event is evidence of context preparation, not proof the agent read it.

`policies.cpoCtoConflict.protocolVersion:2` activates the signed conflict protocol for new runs. Each trusted CPO and CTO/CAIO role calls `recordConflictPosition` with a stance, comparison dimensions, constraints, and sourced evidence on a ready task attempt. `openConflict` references both current position Decision IDs from the same run and saves negotiation proposals, each side's response, unresolved items, and human options. Each option declares `disposition:'continue'|'rework'|'stop'`; rework also names an upstream `targetNodeId`. It pauses the run. `resolveConflict` requires the human owner to choose a recorded option with sourced evidence; its Decision Record automatically links the positions and negotiation dossier. Continue resumes the gate, whose next decision evidence must cite `{kind:'conflict_resolution',decisionId:<human resolution id>}`; rework resets the target and downstream while retaining history; stop ends the run. The rework option observes the gate's bounded rework count. The scoped Graph read exposes the human resolution for an agent already waiting at the gate. Older pinned runs retain the original conflict API. A host must dispatch each role through an authorized execution for two actual agent positions; core records cannot stand in for an invocation that never happened.

## Optional structured evidence (Core 0.4.0)

Graphs opt in through `inputContracts`; task nodes use `outputContract`; decision nodes use `decisionContract: {type, sourceNode}`. Registration validates supported types and an upstream source with the matching output contract. Existing pinned graphs without these fields retain their behavior.

| Input contract | Task output contract | Decision contract |
| --- | --- | --- |
| acceptance-criteria | acceptance-matrix | acceptance-proof |
| architecture-context (consumer) | architecture-baseline (producer) | architecture-approval |
| delivery-target | delivery-report | delivery-readiness |

Start validates input contracts. Submission validates structured output and exactly one matching output artifact with a fresh identity/version. Contracted artifacts cannot be replaced during self review; the first self review hands off to the supervisor, whose rework permits a new structured submission and version. Prior attempts remain immutable. Both ordinary decisions and human resolution validate gate contracts before recording approval.

Acceptance matrices cover every input criterion once and bind to the exact candidate references. Pass/fail need observed proof; fail blocks accept. Unverified needs an authenticated human-owner and `acceptance_exception` evidence per criterion with reason, risk and exact matrix subjectRefs. Generic Decision Records cannot supply architecture acceptance: references must identify the actual accepted graph attempt and system. Baseline revisions preserve INV IDs and explain rule/status changes. Delivery readiness checks configured check names, approval count, independent review verdict, findings, mergeability and SHA consistency; merged requires a matching observed merge event.

The ADLC pack's pinned `policyDocuments.evidenceContracts` contains the payload schemas and examples. The host establishes the completeness of approved criteria, the current applicable architecture baseline, external source authenticity, reviewer eligibility and actual execution. Core performs no network verification, PR mutation or production execution. The optional [host check runner](../../docs/host-check-runner.md) supplies bounded local execution separately from the state machine.

## Storage boundary

`store.read(): Promise<State|null>` and `store.write(nextState, expectedRevision): Promise<void>`. The initial revision is 0. `write` must atomically compare the persisted revision with `expectedRevision`, then replace the snapshot; on conflict it throws `RevisionConflict` (or an error with that name). The engine retries conflicts up to eight times. This is the required implementation for a multi-worker Paperclip `ctx.db` adapter. `MemoryStore` implements CAS for tests. `FileStore` writes through an atomic rename but its revision check supports only a **single writer process**; use an atomic database CAS adapter for concurrent workers.

The store holds full run snapshots, immutable Pack versions, decisions, audit events, and idempotency results. Store writes are the commit boundary: a failed write means the transition is not effective. Historical attempts, reports, product decisions, and invalidated evidence stay queryable.
