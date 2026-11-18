import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphEngine, MemoryStore, createWorkflowRuntime } from '../../src/core/index.mjs';
import { createFixedWorkflowTool } from '../../src/plugin/workflow-tools.mjs';
import { compositionPack } from '../../examples/workflow-composition/pack.mjs';

const owner = { id: 'owner', kind: 'human', roles: ['owner', 'human-owner'], executionId: 'ui' };
const verifier = { id: 'verifier', kind: 'agent', roles: ['verifier'], executionId: 'agent-run' };
const system = { id: 'host', kind: 'system', roles: [], executionId: null };
const workflow = { packId: compositionPack.id, packVersion: compositionPack.version,
  graphId: 'delivery', graphVersion: '1.0.0' };
const businessInput = { candidate: { id: 'commit', version: 'v1' } };

test('direct grandchild inspection follows paused and invalidated root attempts', async () => {
  const engine = new GraphEngine();
  const contract = { version: 1, inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, outputMapping: {} };
  const graphs = ['root', 'middle', 'leaf'].map((id, index, ids) => ({
    id, version: '1', start: 'work', workflowContract: contract,
    nodes: [index === 2 ? { id: 'work', type: 'task' } : {
      id: 'work', type: 'workflow', workflow: { packId: 'nested', packVersion: '1', graphId: ids[index + 1], graphVersion: '1' }, inputMapping: {},
    }, { id: 'end', type: 'end' }], edges: [{ from: 'work', to: 'end' }],
  }));
  await engine.registerPack({ id: 'nested', version: '1', graphs });
  const root = await engine.startRun({ packId: 'nested', packVersion: '1', graphId: 'root', actor: owner, input: { workflowInput: {} } });
  const middle = await engine.startChildWorkflow({ runId: root.id, nodeId: 'work', actor: system });
  const leaf = await engine.startChildWorkflow({ runId: middle.id, nodeId: 'work', actor: system });
  const runtime = createWorkflowRuntime({ engine });
  await engine.pauseRun({ runId: root.id, actor: owner, reason: 'Hold all descendants' });
  assert.equal((await runtime.inspect(leaf.id)).handle.status, 'paused');
  await engine.resumeRun({ runId: root.id, actor: owner, reason: 'Resume' });
  await engine.invalidateEvidence({ runId: root.id, nodeId: 'work', actor: owner, reason: 'New parent attempt' });
  assert.equal((await runtime.inspect(leaf.id)).handle.status, 'blocked');
});

test('direct and fixed Agent-tool entry points preserve identical child and human-gate semantics', async () => {
  const outputs = [];
  for (const entry of ['direct', 'tool']) {
    const store = new MemoryStore();
    let engine = new GraphEngine({ store });
    await engine.registerPack(compositionPack);
    let runtime = createWorkflowRuntime({ engine });
    const input = { workflowInput: businessInput, paperclipCompanyId: 'company', paperclipIssueId: `issue-${entry}`,
      deliveryId: `issue-${entry}`, projectId: 'project' };
    const tool = createFixedWorkflowTool({ workflow, authorizedCommand: async (request, actor) => {
      assert.equal(actor, owner);
      if (request.operation === 'workflow-inspect') return runtime.inspect(request.runId);
      return runtime.start({ ...workflow, input: { ...input, workflowInput: request.workflowInput }, actor,
        idempotencyKey: request.idempotencyKey });
    } });
    const { handle } = entry === 'direct'
      ? await runtime.start({ ...workflow, input, actor: owner, idempotencyKey: entry })
      : await tool({ operation: 'start', issueId: input.paperclipIssueId, workflowInput: businessInput, idempotencyKey: entry }, owner);
    assert.equal(handle.status, 'running');
    assert.equal(Object.hasOwn(handle, 'output'), false);
    const [child, duplicate] = await Promise.all([
      engine.startChildWorkflow({ runId: handle.runId, nodeId: 'verify', actor: system }),
      engine.startChildWorkflow({ runId: handle.runId, nodeId: 'verify', actor: system }),
    ]);
    assert.equal(child.id, duplicate.id);
    await engine.submitNode({ runId: child.id, nodeId: 'check', actor: verifier, output: { checkPassed: true } });
    await engine.submitNode({ runId: child.id, nodeId: 'end', actor: system });
    engine = new GraphEngine({ store });
    runtime = createWorkflowRuntime({ engine });
    await runtime.reconcile(handle.runId, system);
    const waiting = await runtime.inspect(handle.runId);
    assert.equal(waiting.handle.status, 'waiting_for_human');
    const before = await store.read();
    await assert.rejects(engine.decideNode({ runId: handle.runId, nodeId: 'approve', actor: verifier,
      outcome: 'accept', reason: 'Unauthorized Agent approval', evidence: [{ kind: 'verification', summary: 'fixture' }] }));
    assert.deepEqual(await store.read(), before);
    await engine.decideNode({ runId: handle.runId, nodeId: 'approve', actor: owner,
      outcome: 'accept', reason: 'Human approves fixture', evidence: [{ kind: 'verification', summary: 'fixture' }] });
    await engine.submitNode({ runId: handle.runId, nodeId: 'end', actor: system });
    const result = await tool({ operation: 'inspect', runId: handle.runId }, owner);
    assert.equal(result.handle.status, 'completed');
    outputs.push(result.handle.output);
  }
  assert.deepEqual(outputs[0], outputs[1]);
  assert.deepEqual(outputs[0], { candidate: businessInput.candidate, checkPassed: true });
});

test('invalid workflow input is rejected before persisting any run', async () => {
  const store = new MemoryStore(), engine = new GraphEngine({ store });
  await engine.registerPack(compositionPack);
  const before = await store.read();
  await assert.rejects(createWorkflowRuntime({ engine }).start({ ...workflow, actor: owner,
    input: { workflowInput: { candidate: { id: 'commit' } } } }), /version/);
  assert.deepEqual(await store.read(), before);
});
