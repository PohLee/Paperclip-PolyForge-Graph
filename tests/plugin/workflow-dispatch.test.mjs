import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphEngine, MemoryStore } from '../../src/core/index.mjs';
import { createDispatch } from '../../src/plugin/dispatch.mjs';

const companyId = 'company-a';
const human = { id: 'owner-a', kind: 'human', roles: ['human-owner', 'owner'], executionId: null };
const contract = (source, nodeId) => ({ version: 1,
  inputSchema: { type: 'object', additionalProperties: false, required: ['request'],
    properties: { request: { type: 'string' } } },
  outputSchema: { type: 'object', additionalProperties: false, required: ['request'],
    properties: { request: { type: 'string' } } },
  outputMapping: { request: source === 'node'
    ? { source: 'node', nodeId, path: ['request'] }
    : { source: 'input', path: ['request'] } },
});

async function fixture() {
  const store = new MemoryStore();
  const engine = new GraphEngine({ store });
  const childGraph = { id: 'child', version: '1', start: 'gate',
    nodes: [{ id: 'gate', type: 'decision', role: 'owner' }, { id: 'end', type: 'end' }],
    edges: [{ from: 'gate', to: 'end', when: 'approve' }],
    workflowContract: contract('input') };
  const parentGraph = { id: 'parent', version: '1', start: 'call',
    nodes: [{ id: 'call', type: 'workflow', workflow: {
      packId: 'example', packVersion: '1', graphId: 'child', graphVersion: '1' },
      inputMapping: { request: { source: 'input', path: ['request'] } } },
    { id: 'end', type: 'end' }], edges: [{ from: 'call', to: 'end' }],
    workflowContract: contract('node', 'call') };
  await engine.registerPack({ id: 'example', version: '1', graphs: [parentGraph, childGraph],
    decisionRules: [{ type: 'gate', mode: 'manual', allowedKinds: ['human'], requiresHuman: true }] });
  const run = await engine.startRun({ packId: 'example', packVersion: '1', graphId: 'parent', actor: human,
    input: { paperclipCompanyId: companyId, paperclipIssueId: 'issue-root', workflowInput: { request: 'Review' } } });
  const host = { manifest: { id: 'plugin.test' }, logger: { warn() {}, info() {} },
    issues: { get: async (id, company) => id === 'issue-root' && company === companyId
      ? { id, companyId: company, projectId: 'project-a' } : null,
      create: async () => { throw new Error('Workflow node must not create an Agent issue'); } } };
  const persistence = { get: async () => null, readState: () => store.read(),
    reconcileSlots: async () => [], reserveSlot: async () => true };
  const dispatch = createDispatch(host, async () => ({ engine }), async () => ({}), persistence);
  return { engine, run, dispatch };
}

test('dispatch starts one linked child, waits for human, and reconciles after child callback', async () => {
  const { engine, run, dispatch } = await fixture();
  const first = await dispatch.dispatchReady(companyId, engine, run.id, {});
  const parent = await engine.getRun(run.id);
  const childId = parent.nodeStates.call.childRunId;
  const child = await engine.getRun(childId);
  assert.equal(parent.nodeStates.call.status, 'waiting_child');
  assert.deepEqual(child.parentWorkflow, { runId: run.id, nodeId: 'call', attempt: 1 });
  assert.equal(child.input.paperclipIssueId, 'issue-root');
  assert.equal(first.some((action) => action.nodeId === 'call' && action.status === 'workflow_child'), true);
  assert.equal(first.some((action) => action.nodeId === 'gate' && action.status === 'waiting_human'), true);
  await dispatch.dispatchReady(companyId, engine, run.id, {});
  assert.equal((await engine.getRun(run.id)).nodeStates.call.childRunId, childId);
  await engine.decideNode({ runId: childId, nodeId: 'gate', actor: human,
    outcome: 'approve', reason: 'Approved by owner' });
  await dispatch.dispatchReady(companyId, engine, childId, {});
  const completed = await engine.getRun(run.id);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.nodeStates.call.output, { request: 'Review' });
});

test('paused ancestor prevents linked child dispatch and reconciliation', async () => {
  const { engine, run, dispatch } = await fixture();
  await dispatch.dispatchReady(companyId, engine, run.id, {});
  const childId = (await engine.getRun(run.id)).nodeStates.call.childRunId;
  await engine.pauseRun({ runId: run.id, actor: human, reason: 'Hold' });
  assert.deepEqual(await dispatch.dispatchReady(companyId, engine, childId, {}), []);
  assert.equal((await engine.getRun(run.id)).nodeStates.call.status, 'waiting_child');
});

test('root pause during child issue lookup prevents the pending wakeup', async () => {
  const store = new MemoryStore();
  const engine = new GraphEngine({ store });
  const childGraph = { id: 'child-task', version: '1', start: 'make',
    nodes: [{ id: 'make', type: 'task', role: 'maker' }, { id: 'end', type: 'end' }],
    edges: [{ from: 'make', to: 'end' }], workflowContract: contract('input') };
  const parentGraph = { id: 'parent-task', version: '1', start: 'call',
    nodes: [{ id: 'call', type: 'workflow', workflow: {
      packId: 'example', packVersion: '1', graphId: 'child-task', graphVersion: '1' },
      inputMapping: { request: { source: 'input', path: ['request'] } } },
    { id: 'end', type: 'end' }], edges: [{ from: 'call', to: 'end' }],
    workflowContract: contract('node', 'call') };
  await engine.registerPack({ id: 'example', version: '1', roles: { maker: { documents: {} } },
    graphs: [parentGraph, childGraph] });
  const root = await engine.startRun({ packId: 'example', packVersion: '1', graphId: 'parent-task',
    actor: human, input: { paperclipCompanyId: companyId, paperclipIssueId: 'issue-root',
      workflowInput: { request: 'Review' } } });
  const rows = new Map();
  const key = (_company, runId, nodeId, attempt, phase) => `${runId}:${nodeId}:${attempt}:${phase}`;
  const persistence = {
    get: async (...args) => rows.get(key(...args)) ?? null,
    claim: async (...args) => { rows.set(key(...args), { agent_id: args[5], issue_id: null,
      agent_run_id: null, state: 'claimed' }); return true; },
    update: async (...args) => { const row = rows.get(key(...args));
      if (args[5].issueId) { row.issue_id = args[5].issueId; row.state = 'issued'; } },
    wakeClaim: async (...args) => { rows.get(key(...args)).state = 'waking'; return true; },
    wakeRelease: async (...args) => { rows.get(key(...args)).state = 'issued'; },
    readState: () => store.read(), reconcileSlots: async () => [], reserveSlot: async () => true,
  };
  let lookups = 0, created = 0, wakeups = 0;
  const host = { manifest: { id: 'plugin.test' }, logger: { info() {}, warn() {} },
    agents: { get: async id => ({ id }) }, issues: {
      get: async id => id === 'issue-root' ? { id, companyId } : null,
      list: async () => {
        lookups++;
        await engine.pauseRun({ runId: root.id, actor: human, reason: 'Owner paused root' });
        return [{ id: 'existing-agent-issue' }];
      },
      create: async () => { created++; return { id: 'new-agent-issue' }; },
      requestWakeup: async () => { wakeups++; return { runId: 'native-run' }; },
    } };
  const dispatch = createDispatch(host, async () => ({ engine }), async () => ({}), persistence);
  const actions = await dispatch.dispatchReady(companyId, engine, root.id,
    { roleBindings: { 'example:maker': 'maker-agent' } });
  assert.equal(lookups, 1);
  assert.equal(created, 0);
  assert.equal(wakeups, 0);
  assert.equal(actions.some((item) => item.nodeId === 'make' && item.status === 'stale_attempt'), true);
  assert.equal((await engine.getRun(root.id)).status, 'paused');
});
