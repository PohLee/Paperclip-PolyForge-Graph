# Workflow composition

PolyForge keeps one governed Graph execution model for programmatic callers, Paperclip commands and Agent tools. Workflow composition is opt-in: legacy Graphs retain their existing inputs, evidence contracts and execution behavior. This implementation uses JavaScript and the existing stores; it does not require the Eino Go runtime.

## Define a contract

A graph may declare `workflowContract: { version: 1, inputSchema, outputSchema, outputMapping }`. Business input is `run.input.workflowInput`. Host-owned company, project, issue and delivery fields stay outside that business object.

Declare `compatibility.requiredCapabilities: { "workflow-composition": "^1.0.0" }` on new Packs to reject older runtimes that lack composition support. The schema validator does not coerce values. It supports explicit `object`, `array`, `string`, `number`, `integer`, `boolean` and `null` types; `properties`, `required`, `additionalProperties`, `items`, `enum`, `description`; and minimum/maximum bounds for numbers, string lengths, array lengths and object property counts. Unsupported keywords are errors. Output schemas must describe objects. Schemas are limited to depth 24, values and mapping paths to depth 64, and collections to 10,000 entries. These contracts validate structure; they do not attest that a test, review or external operation really occurred.

Map each output field to `{ source: 'input', path: ['field'] }` or `{ source: 'node', nodeId: 'check', path: ['field'] }`. Input paths start at workflowInput; node paths start at node output. Empty paths select the whole value. Paths cannot traverse prototypes, invoke code or read missing values. Node sources must be completed on the selected branch. Final output validation occurs before Core accepts completion; a malformed result does not become a successful workflow.

Existing evidence validators can opt into business input with `graph.evidenceInputSource: "workflowInput"`. This requires a workflow contract and changes only the input seen by evidence validators; it does not copy business fields into the trusted company/issue/authorization envelope.

## Run through the shared interface

```js
import { GraphEngine, createWorkflowRuntime } from './dist/core/index.js';

const engine = new GraphEngine({ store });
await engine.registerPack(pack);
const runtime = createWorkflowRuntime({ engine, dispatch: trustedHostDispatch });
const { handle } = await runtime.start({
  packId: 'example', packVersion: '1.0.0', graphId: 'verification', graphVersion: '1.0.0',
  input: { workflowInput: { candidate: { id: 'commit', version: 'v1' } } },
  actor: trustedActor, idempotencyKey: stableRequestId,
});
const current = await runtime.inspect(handle.runId);
```

The facade is a trusted embedding interface. An independent Host must authenticate callers, authorize resources and supply an execution adapter. `dispatch` is optional: omitting it does not execute Agent work. Existing MemoryStore/FileStore limitations still apply. In Paperclip, the existing authenticated command path supplies the native identity, company scope, role mapping, issue checkout and dispatch.

Handles include runId, status and exact Pack/Graph identities. Output is available only for accepted completion. A human wait or blocked child is not successful completion. Consumers retain runId and inspect later instead of holding a tool call open for human approval. Existing governed Graph commands remain the way to submit work, decide, pause, resume or retry; the new tool grants none of those permissions.

## Invoke as an Agent tool

Paperclip registers one static `workflow-run` tool through its official SDK:

```json
{
  "operation": "start",
  "issueId": "authorized-root-issue",
  "workflow": {
    "packId": "composition-demo",
    "packVersion": "1.0.0",
    "graphId": "delivery",
    "graphVersion": "1.0.0"
  },
  "workflowInput": { "candidate": { "id": "commit", "version": "v1" } },
  "idempotencyKey": "stable-request-id"
}
```

Inspect with `{ "operation": "inspect", "runId": "returned-run-id" }`. The Host derives the issue from the run and verifies access. Tool parameters cannot provide a trusted actor. The target must be an installed, enabled, contracted workflow with an exact matching version and an authorized start role.

For another embedding Host, `createFixedWorkflowTool({ workflow, authorizedCommand })` and `createWorkflowRunTool({ authorizedCommand })` are available from `dist/host/workflow-tools.js`. The fixed wrapper pins the workflow reference; the injected command must enforce authentication and access. This function wrapper does not automatically install per-Pack tools or supply authentication. Register a tool description/schema through the embedding platform's supported interface.

## Compose a child workflow

```js
{
  id: 'verify', type: 'workflow',
  workflow: { packId: 'example', packVersion: '1.0.0',
    graphId: 'verification', graphVersion: '1.0.0' },
  inputMapping: { candidate: { source: 'input', path: ['candidate'] } },
}
```

The child must have a workflow contract. Core creates the child and the parent attempt link in one CAS transition. A duplicate request uses the linked child instead of creating another one. The parent node holds childRunId; the child records parentWorkflow with runId, nodeId and attempt. Restart recovery reconstructs the relationship from stored state.

Children inherit company, project, root issue, delivery, mode and applicable product context. Declared child Graph start roles are checked against the original root initiator; a system orchestration actor does not grant that authority. They share delivery limits; child execution does not reset the budget. References are exact versions, recursion is rejected, and nesting is limited to four child levels. Child input can read only workflow input or completed upstream node output. Agent tasks, decisions and their evidence checks remain ordinary Graph operations inside the child.

The parent waits for accepted child completion, then receives the child's validated output. Evidence references needed downstream should be explicit fields of that output; a data mapping does not create a trusted verification receipt or approve a parent Gate. Stopped, failed or rework-required children block progression. Parent invalidation/retry retires the old attempt link; old child results cannot satisfy the new attempt.

Parent pause/stop fences child eligibility and callbacks. This prevents new governed progression; it is not confirmation that an already-running external process was physically cancelled. External side effects still require the Host's reconciliation protocol.

## Host limits

Paperclip validates governed child starts through the pinned trusted adapter using the original root initiator. Child creation stays atomic in Core; the Host then records the exact adapter binding. A failed binding write leaves the child undispatchable and a retry repairs the same child. Child adapters must preserve the mapped start context: input enrichment is rejected. This does not establish live Software Factory/Warren integration.

For the Creative gateway, official Paperclip plugin workers do not inherit arbitrary server environment variables. Configure `creativeHost.gatewayTokenFile` in the operator-owned `polyforge.runtime.json` to an absolute secret-file path readable by the plugin worker, such as `/run/secrets/polyforge-creative-gateway`. The file must be a regular non-symlink file of at most 4096 bytes containing one nonempty token. Use this instead of `gatewayTokenEnv`; configuring both is rejected. Environment-based tokens remain supported in embedding hosts that explicitly provide them. Neither token source can be supplied by a Pack or workflow input. Keep deployment config and secret files outside release archives.

Agent inspection requires checkout on the root issue. The runtime and tool wrappers do not add a scheduler, streaming execution, arbitrary expression evaluation, or automatic installation of a tool for every Pack. Hosts remain responsible for dispatch recovery and external side-effect reconciliation.

## Example and validation

Run `node examples/workflow-composition/run.mjs`. It starts through a fixed tool wrapper, creates a child, reconstructs the engine over the same store, waits for human approval, rejects an Agent approval, then returns the validated result. It uses synthetic observations and no real model, CI, PR, merge or deployment.

The reusable wrapper is covered by runtime artifact format v4 together with the catalog and other runtime entry points. Rebuild older candidates to create the new complete manifest before using the current verifier.

See `workflow-composition-work-packages-2026-11-18.md` for the implementation and verification ledger. Existing published ADLC Packs are not silently modified by this Core feature; they must opt in through a new reviewed release and retain their trusted Host adapter requirements.

### Native task lifecycle

On the pinned official Paperclip Host, assigned issue creation wakes the Agent. PolyForge does not issue a second wakeup. The first callback binds only after trusted checkout verification. After the Agent finishes its assigned Graph submission and any required self-review, it must also close its native Paperclip issue through the authenticated Host API; otherwise Host continuation may start another execution. Completing that assignment does not bypass Graph supervisor review or human gates.
