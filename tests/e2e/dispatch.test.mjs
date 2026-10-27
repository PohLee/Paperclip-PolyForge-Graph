import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GraphEngine } from '../../src/core/index.mjs';
import { createDispatch } from '../../src/plugin/dispatch.mjs';

test('dispatch recovers a wakeup write failure without creating another issue or host run', async () => {
  const engine = new GraphEngine();
  await engine.registerPack({ id: 'pack', version: '1', roles: { maker: { documents: {} } }, graphs: [{
    id: 'graph', version: '1', start: 'make',
    nodes: [{ id: 'make', type: 'task', role: 'maker' }, { id: 'end', type: 'end' }],
    edges: [{ from: 'make', to: 'end' }],
  }] });
  const human = { id: 'owner', kind: 'human', roles: ['human-owner'] };
  const run = await engine.startRun({ packId: 'pack', packVersion: '1', graphId: 'graph', actor: human,
    input: { paperclipIssueId: 'root', paperclipCompanyId: 'company' } });
  const rows = new Map(), issues = new Map(), wakeups = new Map();
  let created = 0, wakeupCalls = 0, failWokenWrite = true, failIssueWrite = false;
  const key = (companyId, runId, nodeId, attempt, phase) => [companyId, runId, nodeId, attempt, phase].join(':');
  const persistence = {
    get: async (...args) => structuredClone(rows.get(key(...args)) ?? null),
    claim: async (companyId, runId, nodeId, attempt, phase, agentId) => {
      const id = key(companyId, runId, nodeId, attempt, phase);
      if (!rows.has(id)) rows.set(id, { issue_id: null, agent_id: agentId, agent_run_id: null,
        node_id: nodeId, attempt, phase, state: 'claimed' });
      return !rows.get(id).issue_id;
    },
    update: async (companyId, runId, nodeId, attempt, phase, patch) => {
      if (patch.issueId && failIssueWrite) { failIssueWrite = false; throw new Error('issue write interrupted'); }
      if (patch.state === 'woken' && failWokenWrite) { failWokenWrite = false; throw new Error('write interrupted'); }
      const row = rows.get(key(companyId, runId, nodeId, attempt, phase));
      if (patch.issueId) { row.issue_id = patch.issueId; row.state = 'issued'; }
      if (patch.state === 'woken') { row.agent_run_id = patch.agentRunId; row.state = 'woken'; }
    },
    forIssue: async (companyId, issueId, runId, nodeId) =>
      [...rows.entries()].filter(([id, row]) => id.startsWith(`${companyId}:${runId}:${nodeId}:`) && row.issue_id === issueId)
        .map(([, row]) => row).sort((a, b) => b.attempt - a.attempt)[0] ?? null,
    companies: async () => ['company'],
    readState: async () => engine.store.read(),
  };
  const host = { manifest: { id: 'plugin' }, db: {}, logger: { warn() {} },
    agents: { get: async (id) => ({ id }) }, issues: {
      get: async (id) => id === 'root' ? { id, projectId: null } : null,
      list: async ({ originId }) => [...issues.values()].filter((issue) => issue.originId === originId),
      create: async ({ originId }) => {
        created++;
        const issue = { id: `child-${created}`, originId };
        issues.set(issue.id, issue);
        return issue;
      },
      requestWakeup: async (_issueId, _companyId, { idempotencyKey }) => {
        wakeupCalls++;
        if (!wakeups.has(idempotencyKey)) wakeups.set(idempotencyKey, { runId: `host-${wakeups.size + 1}`, queued: true });
        return wakeups.get(idempotencyKey);
      },
      assertCheckoutOwner: async () => {},
    } };
  const dispatch = createDispatch(host, async () => ({ engine, store: engine.store }),
    async () => ({ roleBindings: { maker: 'agent' } }), persistence);
  const config = { roleBindings: { maker: 'agent' } };
  await assert.rejects(dispatch.dispatchReady('company', engine, run.id, config), /write interrupted/);
  assert.equal(created, 1);
  const actions = await dispatch.dispatchReady('company', engine, run.id, config);
  assert.equal(actions[0].status, 'queued');
  assert.equal(actions[0].agentRunId, 'host-1');
  assert.equal(created, 1);
  assert.equal(wakeupCalls, 2);
  assert.equal(wakeups.size, 1);
  assert.equal((await dispatch.currentDispatches('company', await engine.getRun(run.id)))[0].state, 'woken');

  await engine.retryNode({ runId: run.id, nodeId: 'make', actor: human, reason: 'Host run failed' });
  const retried = await engine.getRun(run.id);
  await assert.rejects(dispatch.assertAgentCallback({ companyId: 'company', issueId: 'child-1', run: retried,
    actor: { id: 'agent', kind: 'agent', roles: ['maker'], executionId: 'host-1' },
    nodeId: 'make', operation: 'submit' }), /Stale Graph attempt/);
  failIssueWrite = true;
  await assert.rejects(dispatch.dispatchReady('company', engine, run.id, config), /issue write interrupted/);
  assert.equal(created, 2);
  const next = await dispatch.dispatchReady('company', engine, run.id, config);
  assert.equal(next[0].issueId, 'child-2');
  assert.equal(next[0].agentRunId, 'host-2');
  assert.equal(created, 2);
});
