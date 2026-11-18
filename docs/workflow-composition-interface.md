# Workflow composition interface baseline

Implementation agreement for the feature branch. New contracts are opt-in; existing graphs retain their behavior.

## Declaration

`graph.workflowContract = { version: 1, inputSchema, outputSchema, outputMapping }`.

Business input lives at `run.input.workflowInput`; company, project, delivery and issue metadata remain in the existing trusted run input envelope. A mapping is an object of output field names to `{ source: 'input', path: string[] }` or `{ source: 'node', nodeId: string, path: string[] }`. Input paths start at workflowInput; node paths start at a completed node's output. Empty paths select the entire value. No expressions, arbitrary JavaScript or prototype traversal. Missing values fail closed. Child input mappings use the same format.

The contract module exports `validateWorkflowContract(graph)`, `validateWorkflowInput(graph, input)` (input is business input), `projectWorkflowOutput(run)`, and `resolveWorkflowMapping(mapping, run)`. Validation throws; output functions return JSON objects. Missing contracts are no-ops; no accepted workflow result is invented for legacy graphs.

## Child workflows

Node declaration: `{ id, type: 'workflow', workflow: { packId, packVersion, graphId, graphVersion }, inputMapping }`. All reference fields are exact identities, not ranges. Child contract is required. One active child is linked to each parent node attempt; nested invocations are bounded to four child levels and cannot recursively invoke the same workflow identity along an ancestor chain.

Core methods: `startChildWorkflow({runId,nodeId,actor,expectedRunDigest?,idempotencyKey?})`, `reconcileChildWorkflow({runId,nodeId,actor,expectedRunDigest?,idempotencyKey?})`. Child linking and creation are a single CAS transition. Only trusted system orchestration may invoke these methods; no model-supplied system actor. `startChildWorkflow` returns the linked child run (replayed calls return current child). `reconcileChildWorkflow` returns parent run. Link is `parent.nodeStates[nodeId].childRunId`; child holds `parentWorkflow: { runId, nodeId, attempt }`. Completed validated child output is stored on the parent workflow node. Ordinary submit cannot complete a workflow node.

Child inputs inherit company, project, root issue, delivery and applicable product context; parent linkage and workflowInput are controlled by Core. Preserve mode and delivery budget. If existing child-start authorization cannot be safely reused, fail closed and document the restriction. Host dispatch must check parent lineage before issuing work. Late child completion cannot advance an invalidated parent attempt. Parent pause/stop suspends eligibility; no claim of external process cancellation is made.

## Runtime facade

`createWorkflowRuntime({ engine, dispatch? })` from `src/core/workflow-runtime.mjs` exposes:

- `start(args)`: same trusted args as engine.startRun, returning `{ run, handle }`; calls engine then optional dispatch(run).
- `inspect(runId)`: returns `{ run, handle }` or throws if not found.
- `reconcile(runId, actor)`: reconciles ready/active workflow children with trusted system actor; returns `{ run, handle }`. It never executes Agent tasks or approves decision gates.

Handle: `{ runId, status, workflow: {packId,packVersion,graphId,graphVersion}, output? }`. Output appears only for completed contracted workflows. Status distinguishes running, waiting_for_human, blocked, paused, rework_required, failed, stopped and completed; inspect takes child waits into account. Raw run status remains available. The facade is a trusted embedding interface; remote identity/access authorization remains Host-owned.

## Host and Agent tools

Existing Graph start routes use runtime.start after existing authentication, role, checkout, Pack readiness and admission checks. New static `workflow-run` tool supports `start` and `inspect`, with issueId and exact workflow reference for start, runId for inspect. Start requires a contracted workflow. It returns handles rather than waiting for human gates. The wrapper calls the same authorized worker command path, never Core directly with caller-provided identity. No separate approval or resume operation is exposed by this tool.

Dispatch handles workflow items internally before ordinary work; it dispatches linked children and reconciles parents after callbacks. Preserve existing trusted Pack adapter requirements. Export a reusable tool wrapper accepting an authorized command callback so a fixed workflow can be exposed by an embedding host without creating a second execution engine. Tool wrapping does not automatically install arbitrary per-Pack tools into the Paperclip manifest.
