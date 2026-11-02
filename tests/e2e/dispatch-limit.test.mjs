import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphEngine } from '../../src/core/index.mjs';
import { createDispatch } from '../../src/plugin/dispatch.mjs';

test('Graph dispatch admits three agents and defers a fourth until a deliverable completes', async () => {
  const engine = new GraphEngine();
  const branches = ['a', 'b', 'c', 'd'];
  await engine.registerPack({ id: 'pack', version: '1', roles: { maker: { documents: {} } }, graphs: [{
    id: 'parallel', version: '1', start: 'start',
    nodes: [{ id: 'start', type: 'task' }, ...branches.map((id) => ({ id, type: 'task', role: 'maker' })),
      { id: 'join', type: 'join', mode: 'all' }, { id: 'end', type: 'end' }],
    edges: [...branches.map((id) => ({ from: 'start', to: id })),
      ...branches.map((id) => ({ from: id, to: 'join' })), { from: 'join', to: 'end' }],
  }], decisionRules: [] });
  const owner = { id: 'owner', kind: 'human', roles: ['human-owner'] };
  const run = await engine.startRun({ packId: 'pack', packVersion: '1', graphId: 'parallel', actor: owner,
    input: { paperclipIssueId: 'root', paperclipCompanyId: 'company', deliveryId: 'root' } });
  await engine.submitNode({ runId: run.id, nodeId: 'start', actor: owner });
  const rows = new Map();
  const key = (_companyId, _runId, nodeId, attempt, phase) => `${nodeId}:${attempt}:${phase}`;
  let created = 0;
  const persistence = {
    get: async (...args) => rows.get(key(...args)) ?? null,
    claim: async (...args) => {
      const id = key(...args);
      if (rows.has(id)) return false;
      rows.set(id, { agent_id: args[5], issue_id: null, agent_run_id: null, state: 'claimed' });
      return true;
    },
    wakeClaim: async (...args) => { const row = rows.get(key(...args)); row.state = 'waking'; return true; },
    update: async (...args) => {
      const row = rows.get(key(...args)); const patch = args[5];
      if (patch.issueId) { row.issue_id = patch.issueId; row.state = 'issued'; }
      if (patch.state) { row.state = patch.state; row.agent_run_id = patch.agentRunId; }
    },
    forIssue: async () => null,
    readState: async () => engine.store.read(),
  };
  const host = { manifest: { id: 'plugin' }, db: {}, agents: { get: async (id) => ({ id }) }, issues: {
    get: async (id) => id === 'root' ? { id, projectId: null } : null,
    list: async () => [],
    create: async () => ({ id: `child-${++created}` }),
    requestWakeup: async () => ({ runId: `agent-${created}`, queued: true }),
  } };
  const dispatch = createDispatch(host, null, null, persistence);
  const config = { roleBindings: { 'pack:maker': 'agent' } };
  const first = await dispatch.dispatchReady('company', engine, run.id, config);
  assert.equal(first.filter((item) => item.status === 'deferred_agent_limit').length, 1);
  assert.equal(created, 3);
  await engine.submitNode({ runId: run.id, nodeId: 'a', actor: { id: 'agent', kind: 'agent', roles: ['maker'], executionId: 'agent-1' } });
  const second = await dispatch.dispatchReady('company', engine, run.id, config);
  assert.equal(second.find((item) => item.nodeId === 'd').status, 'queued');
  assert.equal(created, 4);
});
