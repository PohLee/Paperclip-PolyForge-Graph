import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GraphEngine } from '../../src/core/index.mjs';
import { createDispatch } from '../../src/plugin/dispatch.mjs';
import { bindDispatchRunFromCheckout } from '../../src/plugin/store.mjs';

async function fixture() {
  const engine = new GraphEngine();
  await engine.registerPack({ id: 'pack', version: '1', roles: { maker: { documents: {} } }, graphs: [{
    id: 'graph', version: '1', start: 'make', nodes: [{ id: 'make', type: 'task', role: 'maker' }], edges: [],
  }] });
  const run = await engine.startRun({ packId: 'pack', packVersion: '1', graphId: 'graph',
    actor: { id: 'owner', kind: 'human', roles: ['human-owner'] },
    input: { paperclipIssueId: 'root', paperclipCompanyId: 'company' } });
  let row = null, callbackPromise = null, wakeupCalls = 0, checkoutCalls = 0;
  const persistence = {
    get: async () => structuredClone(row),
    claim: async (_company, _runId, nodeId, attempt, phase, agentId) => {
      if (row) return false;
      row = { issue_id: null, agent_id: agentId, agent_run_id: null, node_id: nodeId,
        attempt, phase, state: 'claimed' };
      return true;
    },
    update: async (_company, _runId, _nodeId, _attempt, _phase, patch) => {
      if (patch.issueId) {
        row.issue_id = patch.issueId;
        row.state = 'issued';
        // Simulate Paperclip's issue_assigned wakeup racing the dispatch continuation.
        callbackPromise = dispatch.assertAgentCallback({ companyId: 'company', issueId: patch.issueId,
          run, actor: { id: 'agent', kind: 'agent', roles: ['maker'], executionId: 'checked-out-run' },
          nodeId: 'make', operation: 'submit' });
        await callbackPromise;
      }
    },
    bindRun: async (_company, _runId, nodeId, attempt, phase, issueId, agentId, agentRunId) => {
      if (row.node_id !== nodeId || row.attempt !== attempt || row.phase !== phase ||
          row.issue_id !== issueId || row.agent_id !== agentId || !['issued', 'waking'].includes(row.state) || row.agent_run_id) return false;
      row.agent_run_id = agentRunId;
      row.state = 'woken';
      return true;
    },
    forIssue: async (_company, issueId, runId, nodeId) => row?.issue_id === issueId &&
      row.node_id === nodeId && runId === run.id ? structuredClone(row) : null,
    readState: async () => engine.store.read(),
  };
  const host = { manifest: { id: 'plugin' }, db: {}, agents: { get: async (id) => ({ id }) }, issues: {
    get: async (id) => id === 'root' ? { id, projectId: null } : { id, originKind: 'plugin:plugin:node' },
    list: async () => [],
    create: async () => ({ id: 'child-1' }),
    requestWakeup: async () => { wakeupCalls++; return { runId: 'duplicate-run', queued: true }; },
    assertCheckoutOwner: async ({ issueId, companyId, actorAgentId, actorRunId }) => {
      checkoutCalls++;
      assert.equal(issueId, 'child-1'); assert.equal(companyId, 'company');
      assert.equal(actorAgentId, 'agent'); assert.equal(actorRunId, 'checked-out-run');
      return { assigneeAgentId: 'agent', checkoutRunId: 'checked-out-run' };
    },
  } };
  const dispatch = createDispatch(host, async () => ({ engine, store: engine.store }),
    async () => ({ roleBindings: { 'pack:maker': 'agent' } }), persistence);
  return { engine, run, dispatch, get row() { return row; }, get callbackPromise() { return callbackPromise; },
    get wakeupCalls() { return wakeupCalls; }, get checkoutCalls() { return checkoutCalls; } };
}

test('assigned issue checkout wins the create race and Graph never queues a duplicate run', async () => {
  const f = await fixture();
  const actions = await f.dispatch.dispatchReady('company', f.engine, f.run.id,
    { roleBindings: { 'pack:maker': 'agent' } });
  await f.callbackPromise;
  assert.equal(f.row.state, 'woken');
  assert.equal(f.row.agent_run_id, 'checked-out-run');
  assert.equal(actions[0].agentRunId, 'checked-out-run');
  assert.equal(actions[0].status, 'woken');
  assert.equal(f.wakeupCalls, 0);
  assert.equal(f.checkoutCalls, 1);
});

test('checkout binding still rejects a different run, agent, or Graph attempt', async () => {
  const f = await fixture();
  await f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
  const run = await f.engine.getRun(f.run.id);
  const callback = { companyId: 'company', issueId: 'child-1', run, nodeId: 'make', operation: 'submit' };
  await assert.rejects(f.dispatch.assertAgentCallback({ ...callback,
    actor: { id: 'agent', kind: 'agent', roles: ['maker'], executionId: 'duplicate-run' } }), /run does not match/);
  await assert.rejects(f.dispatch.assertAgentCallback({ ...callback,
    actor: { id: 'other-agent', kind: 'agent', roles: ['maker'], executionId: 'checked-out-run' } }), /not bound/);
  await f.engine.retryNode({ runId: f.run.id, nodeId: 'make', actor: { id: 'owner', kind: 'human', roles: ['human-owner'] },
    reason: 'Retry after host failure' });
  await assert.rejects(f.dispatch.assertAgentCallback({ ...callback,
    run: await f.engine.getRun(f.run.id), actor: { id: 'agent', kind: 'agent', roles: ['maker'], executionId: 'checked-out-run' } }), /Stale Graph attempt/);
});

test('database checkout binding is a compare-and-set over the exact dispatch identity', async () => {
  let rowCount = 1, expectedRunId = 'checked-out-run';
  const db = { namespace: 'plugin_test', execute: async (sql, args) => {
    assert.match(sql, /company_id=\$1 AND graph_run_id=\$2 AND node_id=\$3 AND attempt=\$4 AND phase=\$5/);
    assert.match(sql, /issue_id=\$6 AND agent_id=\$7 AND state IN \('issued','waking'\) AND agent_run_id IS NULL/);
    assert.deepEqual(args, ['company', 'run', 'node', 2, 'work', 'issue', 'agent', expectedRunId]);
    return { rowCount };
  } };
  assert.equal(await bindDispatchRunFromCheckout(db, 'company', 'run', 'node', 2, 'work',
    'issue', 'agent', 'checked-out-run'), true);
  rowCount = 0; expectedRunId = 'different-run';
  assert.equal(await bindDispatchRunFromCheckout(db, 'company', 'run', 'node', 2, 'work',
    'issue', 'agent', 'different-run'), false);
});
