import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowRuntime, GraphEngine } from '../../src/core/index.mjs';

const system = { id: 'orchestrator', kind: 'system', roles: [] };
const owner = { id: 'owner', kind: 'human', roles: ['human-owner', 'owner'] };
const maker = { id: 'maker', kind: 'agent', roles: ['maker'], executionId: 'exec' };
const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false };
const contract = (nodeId) => ({ version: 1, inputSchema: schema, outputSchema: schema,
  outputMapping: { value: nodeId ? { source: 'node', nodeId, path: ['value'] } : { source: 'input', path: ['value'] } } });
const child = { id: 'child', version: '1', start: 'make', workflowContract: contract('make'),
  nodes: [{ id: 'make', type: 'task', role: 'maker' }, { id: 'end', type: 'end' }], edges: [{ from: 'make', to: 'end' }] };
const parent = { id: 'parent', version: '1', start: 'call', workflowContract: contract('call'),
  nodes: [{ id: 'call', type: 'workflow', workflow: { packId: 'p', packVersion: '1', graphId: 'child', graphVersion: '1' },
    inputMapping: { value: { source: 'input', path: ['value'] } } }, { id: 'end', type: 'end' }], edges: [{ from: 'call', to: 'end' }] };
const legacy = { id: 'legacy', version: '1', start: 'end', nodes: [{ id: 'end', type: 'end' }], edges: [] };
const args = { packId: 'p', packVersion: '1', graphId: 'parent', actor: owner, input: { workflowInput: { value: 'in' } } };
async function setup(dispatch, childGraph = child) {
  const engine = new GraphEngine();
  await engine.registerPack({ id: 'p', version: '1', graphs: [parent, childGraph, legacy] });
  return { engine, runtime: createWorkflowRuntime({ engine, dispatch }) };
}

test('runtime returns durable handles and dispatches without claiming execution', async () => {
  const dispatched = [];
  const { engine, runtime } = await setup(run => { dispatched.push(run.id); });
  const started = await runtime.start(args);
  assert.equal(started.handle.status, 'running');
  assert.equal(started.handle.output, undefined);
  assert.deepEqual(started.handle.workflow, { packId: 'p', packVersion: '1', graphId: 'parent', graphVersion: '1' });
  assert.deepEqual(dispatched, [started.run.id]);
  const waiting = await runtime.reconcile(started.run.id, system);
  const childId = waiting.run.nodeStates.call.childRunId;
  assert.equal(waiting.handle.status, 'running');
  assert.deepEqual(dispatched, [started.run.id, childId]);
  assert.equal((await runtime.reconcile(started.run.id, system)).run.nodeStates.call.childRunId, childId);
  assert.deepEqual(dispatched, [started.run.id, childId, childId]);
  await engine.submitNode({ runId: childId, nodeId: 'make', actor: maker, output: { value: 'out' } });
  await engine.submitNode({ runId: childId, nodeId: 'end', actor: owner });
  const reconciled = await runtime.reconcile(started.run.id, system);
  assert.equal(reconciled.run.nodeStates.call.status, 'completed');
  assert.equal(reconciled.handle.status, 'running');
  await engine.submitNode({ runId: started.run.id, nodeId: 'end', actor: owner });
  assert.deepEqual((await runtime.inspect(started.run.id)).handle.output, { value: 'out' });
  await assert.rejects(runtime.inspect('missing'), /Run not found/);
});

test('runtime reports child human waits, blocked child and paused parent', async () => {
  const { engine, runtime } = await setup();
  const started = await runtime.start(args);
  const active = await runtime.reconcile(started.run.id, system);
  const childId = active.run.nodeStates.call.childRunId;
  await engine.pauseRun({ runId: childId, actor: owner, reason: 'Need review' });
  assert.equal((await runtime.inspect(started.run.id)).handle.status, 'paused');
  await engine.pauseRun({ runId: started.run.id, actor: owner, reason: 'Parent hold' });
  assert.equal((await runtime.inspect(started.run.id)).handle.status, 'paused');
  await engine.resumeRun({ runId: started.run.id, actor: owner, reason: 'Resume' });
  await engine.resumeRun({ runId: childId, actor: owner, reason: 'Resume' });
  await engine.invalidateEvidence({ runId: childId, nodeId: 'make', actor: owner, reason: 'Rework' });
  assert.equal((await runtime.inspect(started.run.id)).handle.status, 'running');
});

test('runtime refuses caller reconciliation and legacy completion has no invented output', async () => {
  const { engine, runtime } = await setup();
  const started = await runtime.start(args);
  await assert.rejects(runtime.reconcile(started.run.id, owner), /trusted system actor/);
  const old = await runtime.start({ packId: 'p', packVersion: '1', graphId: 'legacy', actor: owner });
  await engine.submitNode({ runId: old.run.id, nodeId: 'end', actor: owner });
  const finished = await runtime.inspect(old.run.id);
  assert.equal(finished.handle.status, 'completed');
  assert.equal(Object.hasOwn(finished.handle, 'output'), false);
});

test('terminal child human wait and rework never report parent completion', async () => {
  for (const [terminal, expected] of [['human_decision_pending', 'waiting_for_human'], ['rework_required', 'rework_required']]) {
    const variant = { ...child, nodes: [child.nodes[0], { ...child.nodes[1], output: terminal }] };
    const { engine, runtime } = await setup(undefined, variant);
    const root = await runtime.start(args);
    const started = await runtime.reconcile(root.run.id, system);
    const childId = started.run.nodeStates.call.childRunId;
    await engine.submitNode({ runId: childId, nodeId: 'make', actor: maker, output: { value: 'made' } });
    await engine.submitNode({ runId: childId, nodeId: 'end', actor: owner });
    const current = await runtime.reconcile(root.run.id, system);
    assert.equal(current.handle.status, expected);
    assert.equal(Object.hasOwn(current.handle, 'output'), false);
    assert.notEqual(current.run.status, 'completed');
  }
});

test('reconciliation can retry dispatch of a durably linked child after callback failure', async () => {
  let calls = 0;
  const { engine, runtime } = await setup(run => {
    if (run.graph.id === 'child' && ++calls === 1) throw new Error('Host dispatch failed');
  });
  const root = await runtime.start(args);
  await assert.rejects(runtime.reconcile(root.run.id, system), /Host dispatch failed/);
  const childId = (await engine.getRun(root.run.id)).nodeStates.call.childRunId;
  assert.ok(childId);
  const retry = await runtime.reconcile(root.run.id, system);
  assert.equal(retry.run.nodeStates.call.childRunId, childId);
  assert.equal(calls, 2);
});

test('blocked policy work and failed runs have distinct runtime statuses', async () => {
  const blockedGraph = { id: 'policy-blocked', version: '1', start: 'gate',
    nodes: [{ id: 'gate', type: 'decision', role: 'owner' }, { id: 'end', type: 'end' }],
    edges: [{ from: 'gate', to: 'end', when: 'go' }] };
  const engine = new GraphEngine();
  await engine.registerPack({ id: 'blocked', version: '1', graphs: [blockedGraph],
    decisionRules: [{ type: 'gate', mode: 'autonomous', allowedKinds: ['human'] }] });
  const runtime = createWorkflowRuntime({ engine });
  const run = await runtime.start({ packId: 'blocked', packVersion: '1', graphId: 'policy-blocked', actor: owner });
  assert.equal((await engine.getWorkItems(run.run.id))[0].kind, 'blocked');
  assert.equal((await runtime.inspect(run.run.id)).handle.status, 'blocked');
  const state = await engine.store.read();
  state.runs[run.run.id].status = 'failed'; state.revision++;
  await engine.store.write(state, state.revision - 1);
  assert.equal((await runtime.inspect(run.run.id)).handle.status, 'failed');
});

test('a failed linked child reports failure without completing its parent', async () => {
  const { engine, runtime } = await setup();
  const root = await runtime.start(args);
  const childRun = await engine.startChildWorkflow({ runId: root.run.id, nodeId: 'call', actor: system });
  const state = await engine.store.read();
  state.runs[childRun.id].status = 'failed'; state.revision++;
  await engine.store.write(state, state.revision - 1);
  const current = await runtime.reconcile(root.run.id, system);
  assert.equal(current.handle.status, 'failed');
  assert.equal(current.run.nodeStates.call.status, 'child_blocked');
  assert.equal(current.run.status, 'running');
});
