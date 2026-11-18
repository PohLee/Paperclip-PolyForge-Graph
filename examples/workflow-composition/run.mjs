import assert from 'node:assert/strict';
import { GraphEngine, MemoryStore, createWorkflowRuntime } from '../../src/core/index.mjs';
import { createFixedWorkflowTool } from '../../src/plugin/workflow-tools.mjs';
import { compositionPack } from './pack.mjs';

// Trusted actors supplied by this local fixture Host, never by tool arguments.
const owner = { id: 'demo-owner', kind: 'human', roles: ['owner', 'human-owner'], executionId: 'demo-ui' };
const verifier = { id: 'demo-verifier', kind: 'agent', roles: ['verifier'], executionId: 'demo-check' };
const orchestrator = { id: 'demo-host', kind: 'system', roles: [], executionId: null };
const store = new MemoryStore();
let engine = new GraphEngine({ store });
await engine.registerPack(compositionPack);
let runtime = createWorkflowRuntime({ engine });
const workflow = { packId: compositionPack.id, packVersion: compositionPack.version,
  graphId: 'delivery', graphVersion: '1.0.0' };

// A real embedding Host must authenticate invocation and authorize issue access.
// Paperclip's workflow-run tool already performs its native identity checks.
const tool = createFixedWorkflowTool({ workflow, authorizedCommand: async (request, invocation) => {
  assert.equal(invocation, owner);
  if (request.operation === 'workflow-inspect') return runtime.inspect(request.runId);
  return runtime.start({ ...workflow, actor: owner, mode: 'manual', idempotencyKey: request.idempotencyKey,
    input: { workflowInput: request.workflowInput, paperclipCompanyId: 'demo',
      paperclipIssueId: request.issueId, projectId: 'demo-project', deliveryId: request.issueId } });
} });

const { handle: started } = await tool({ operation: 'start', issueId: 'demo-issue',
  workflowInput: { candidate: { id: 'fixture-commit', version: '1' } }, idempotencyKey: 'demo-start' }, owner);
console.log('Started:', started.status);
const child = await engine.startChildWorkflow({ runId: started.runId, nodeId: 'verify', actor: orchestrator });
await engine.submitNode({ runId: child.id, nodeId: 'check', actor: verifier, output: { checkPassed: true } });
await engine.submitNode({ runId: child.id, nodeId: 'end', actor: orchestrator });

// Reconstruct the engine over the same durable-state interface before reconciliation.
engine = new GraphEngine({ store });
runtime = createWorkflowRuntime({ engine });
await engine.reconcileChildWorkflow({ runId: started.runId, nodeId: 'verify', actor: orchestrator });
const waiting = await tool({ operation: 'inspect', runId: started.runId }, owner);
assert.equal(waiting.handle.status, 'waiting_for_human');
assert.equal(Object.hasOwn(waiting.handle, 'output'), false);
console.log('After child completion:', waiting.handle.status);

await assert.rejects(engine.decideNode({ runId: started.runId, nodeId: 'approve', actor: verifier,
  outcome: 'accept', reason: 'Agent cannot replace human approval', evidence: [{ kind: 'verification', summary: 'fixture' }] }));
await engine.decideNode({ runId: started.runId, nodeId: 'approve', actor: owner,
  outcome: 'accept', reason: 'Human accepts the demonstration result',
  evidence: [{ kind: 'verification', summary: 'Fixture observation; not a real engineering verification', childRunId: child.id }] });
await engine.submitNode({ runId: started.runId, nodeId: 'end', actor: orchestrator });
const completed = await tool({ operation: 'inspect', runId: started.runId }, owner);
assert.equal(completed.handle.status, 'completed');
assert.deepEqual(completed.handle.output, { candidate: { id: 'fixture-commit', version: '1' }, checkPassed: true });
console.log('Approved result:', JSON.stringify(completed.handle));
console.log('Fixture only: no real model, CI, PR, merge or deployment was executed.');
