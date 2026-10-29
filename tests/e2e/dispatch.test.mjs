import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GraphEngine } from '../../src/core/index.mjs';
import { createDispatch } from '../../src/plugin/dispatch.mjs';

test('dispatch fails closed after an uncertain wakeup write and owner retry uses a new attempt', async () => {
  const engine = new GraphEngine();
  await engine.registerPack({ id: 'pack', version: '1', roles: { maker: { documents: {} } }, graphs: [{
    id: 'graph', version: '1', start: 'make',
    nodes: [{ id: 'make', type: 'task', role: 'maker' }, { id: 'end', type: 'end' }],
    edges: [{ from: 'make', to: 'end' }],
  }] });
  const human = { id: 'owner', kind: 'human', roles: ['human-owner'] };
  const productDecision = await engine.recordProductDecision({ feature: 'login', actor: human,
    outcome: 'Keep password fallback', reason: 'Approved product constraint' });
  const run = await engine.startRun({ packId: 'pack', packVersion: '1', graphId: 'graph', actor: human,
    input: { paperclipIssueId: 'root', paperclipCompanyId: 'company', feature: 'login', product_decision_refs: [productDecision.id] } });
  let agentGets = 0, memoryReads = 0, decisionCalls = 0;
  const getProductMemory = engine.getProductMemory.bind(engine);
  engine.getProductMemory = async (...args) => { memoryReads++; return getProductMemory(...args); };
  const recordDecision = engine.recordDecision.bind(engine);
  engine.recordDecision = async (...args) => { decisionCalls++; return recordDecision(...args); };
  const rows = new Map(), issues = new Map(), wakeups = new Map();
  let created = 0, wakeupCalls = 0, failWokenWrite = true, failIssueWrite = false, createdDescription = '';
  const key = (companyId, runId, nodeId, attempt, phase) => [companyId, runId, nodeId, attempt, phase].join(':');
  const persistence = {
    get: async (...args) => structuredClone(rows.get(key(...args)) ?? null),
    claim: async (companyId, runId, nodeId, attempt, phase, agentId) => {
      const id = key(companyId, runId, nodeId, attempt, phase);
      if (!rows.has(id)) rows.set(id, { issue_id: null, agent_id: agentId, agent_run_id: null,
        node_id: nodeId, attempt, phase, state: 'claimed' });
      return !rows.get(id).issue_id;
    },
    wakeClaim: async (...args) => {
      const row = rows.get(key(...args));
      if (row.state !== 'issued') return false;
      row.state = 'waking';
      return true;
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
    agents: { get: async (id) => { agentGets++; return { id }; } }, issues: {
      get: async (id) => id === 'root' ? { id, projectId: null } : null,
      list: async ({ originId }) => [...issues.values()].filter((issue) => issue.originId === originId),
      create: async ({ originId, description }) => {
        created++;
        createdDescription = description;
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
    async () => ({ roleBindings: { 'pack:maker': 'agent' } }), persistence);
  const config = { roleBindings: { 'pack:maker': 'agent' } };
  await assert.rejects(dispatch.dispatchReady('company', engine, run.id, config), /write interrupted/);
  assert.equal(created, 1);
  assert.match(createdDescription, /Keep password fallback/);
  assert.equal((await engine.listDecisions({ runId: run.id })).filter((item) => item.type === 'product_memory_context').length, 1);
  const wakingReads = [agentGets, memoryReads, decisionCalls];
  const actions = await dispatch.dispatchReady('company', engine, run.id, config);
  assert.equal(actions[0].status, 'waking');
  assert.equal(actions[0].agentRunId, null);
  assert.deepEqual([agentGets, memoryReads, decisionCalls], wakingReads);
  assert.equal(created, 1);
  assert.equal(wakeupCalls, 1);
  assert.equal(wakeups.size, 1);
  assert.equal((await dispatch.currentDispatches('company', await engine.getRun(run.id)))[0].state, 'waking');

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
  const wokenReads = [agentGets, memoryReads, decisionCalls];
  const repeated = await dispatch.dispatchReady('company', engine, run.id, config);
  assert.equal(repeated[0].status, 'woken');
  assert.equal(repeated[0].agentRunId, 'host-2');
  assert.deepEqual([agentGets, memoryReads, decisionCalls], wokenReads);
  assert.equal(wakeupCalls, 2);
});

test('concurrent dispatch callers issue one wakeup and pin only its host run', async () => {
  const engine = new GraphEngine();
  await engine.registerPack({ id: 'pack', version: '1', roles: { maker: { documents: {} } }, graphs: [{
    id: 'graph', version: '1', start: 'make', nodes: [{ id: 'make', type: 'task', role: 'maker' }], edges: [],
  }] });
  const run = await engine.startRun({ packId: 'pack', packVersion: '1', graphId: 'graph',
    actor: { id: 'owner', kind: 'human', roles: ['human-owner'] },
    input: { paperclipIssueId: 'root', paperclipCompanyId: 'company' } });
  let row = null, wakeupCalls = 0, releaseWakeup, wakeupStarted;
  const wakeupGate = new Promise((resolve) => { releaseWakeup = resolve; });
  const started = new Promise((resolve) => { wakeupStarted = resolve; });
  const persistence = {
    get: async () => structuredClone(row),
    claim: async (_companyId, _runId, _nodeId, _attempt, _phase, agentId) => {
      if (row) return false;
      row = { issue_id: null, agent_id: agentId, agent_run_id: null, attempt: 1, phase: 'work', state: 'claimed' };
      return true;
    },
    wakeClaim: async () => {
      if (row.state !== 'issued') return false;
      row.state = 'waking';
      return true;
    },
    update: async (_companyId, _runId, _nodeId, _attempt, _phase, patch) => {
      if (patch.issueId) { row.issue_id = patch.issueId; row.state = 'issued'; }
      if (patch.state === 'woken') {
        assert.equal(row.state, 'waking');
        row.agent_run_id = patch.agentRunId; row.state = 'woken';
      }
    },
    forIssue: async (_companyId, issueId) => row?.issue_id === issueId ? structuredClone(row) : null,
  };
  const host = { manifest: { id: 'plugin' }, db: {}, agents: { get: async (id) => ({ id }) }, issues: {
    get: async (id) => id === 'root' ? { id, projectId: null } : null,
    list: async () => [],
    create: async () => ({ id: 'child' }),
    requestWakeup: async () => {
      wakeupCalls++;
      wakeupStarted();
      await wakeupGate;
      return { runId: 'host-1', queued: true };
    },
    assertCheckoutOwner: async () => {},
  } };
  const dispatch = createDispatch(host, async () => ({ engine, store: engine.store }),
    async () => ({ roleBindings: { 'pack:maker': 'agent' } }), persistence);
  const config = { roleBindings: { 'pack:maker': 'agent' } };
  const first = dispatch.dispatchReady('company', engine, run.id, config);
  await started;
  const secondPending = dispatch.dispatchReady('company', engine, run.id, config);
  await new Promise((resolve) => setTimeout(resolve, 5));
  releaseWakeup();
  const [original, second] = await Promise.all([first, secondPending]);
  assert.ok(['waking', 'woken'].includes(second[0].status));
  assert.equal(original[0].agentRunId, 'host-1');
  assert.equal(wakeupCalls, 1);
  assert.equal((await dispatch.currentDispatches('company', await engine.getRun(run.id)))[0].agentRunId, 'host-1');
  const callback = { companyId: 'company', issueId: 'child', run: await engine.getRun(run.id),
    nodeId: 'make', operation: 'submit' };
  await dispatch.assertAgentCallback({ ...callback,
    actor: { id: 'agent', kind: 'agent', roles: ['maker'], executionId: 'host-1' } });
  await assert.rejects(dispatch.assertAgentCallback({ ...callback,
    actor: { id: 'agent', kind: 'agent', roles: ['maker'], executionId: 'host-2' } }), /run does not match/);
});

test('a trusted current checkout pins an early callback before wakeup returns', async () => {
  for (const returnedRunId of ['host-1', 'host-2']) {
    const engine = new GraphEngine();
    await engine.registerPack({ id: 'pack', version: '1', roles: { maker: { documents: {} } }, graphs: [{
      id: 'graph', version: '1', start: 'make', nodes: [{ id: 'make', type: 'task', role: 'maker' }], edges: [],
    }] });
    const run = await engine.startRun({ packId: 'pack', packVersion: '1', graphId: 'graph',
      actor: { id: 'owner', kind: 'human', roles: ['human-owner'] },
      input: { paperclipIssueId: 'root', paperclipCompanyId: 'company' } });
    let row = null, wakeupCalls = 0, checkoutRunId = 'host-1', signalWakeup, releaseWakeup;
    const started = new Promise((resolve) => { signalWakeup = resolve; });
    const gate = new Promise((resolve) => { releaseWakeup = resolve; });
    const persistence = {
      get: async () => structuredClone(row),
      claim: async (_companyId, _runId, _nodeId, _attempt, _phase, agentId) => {
        if (row) return false;
        row = { issue_id: null, agent_id: agentId, agent_run_id: null, attempt: 1, phase: 'work', state: 'claimed' };
        return true;
      },
      wakeClaim: async () => {
        if (row.state !== 'issued') return false;
        row.state = 'waking'; return true;
      },
      bindRun: async (_companyId, _runId, _nodeId, attempt, phase, issueId, agentId, agentRunId) => {
        if (row.state !== 'waking' || row.agent_run_id || row.attempt !== attempt || row.phase !== phase ||
          row.issue_id !== issueId || row.agent_id !== agentId) return false;
        row.state = 'woken'; row.agent_run_id = agentRunId; return true;
      },
      update: async (_companyId, _runId, _nodeId, _attempt, _phase, patch) => {
        if (patch.issueId) { row.issue_id = patch.issueId; row.state = 'issued'; }
        if (patch.state === 'woken') {
          if (row.state === 'woken' && row.agent_run_id === patch.agentRunId) return;
          if (row.state !== 'waking' || row.agent_run_id) throw new Error('confirmed host run differs from checkout');
          row.state = 'woken'; row.agent_run_id = patch.agentRunId;
        }
      },
      forIssue: async (_companyId, issueId) => row?.issue_id === issueId ? structuredClone(row) : null,
    };
    const host = { manifest: { id: 'plugin' }, db: {}, agents: { get: async (id) => ({ id }) }, issues: {
      get: async (id) => id === 'root' ? { id, projectId: null } : null,
      list: async () => [], create: async () => ({ id: 'child' }),
      requestWakeup: async () => { wakeupCalls++; signalWakeup(); await gate; return { runId: returnedRunId, queued: true }; },
      assertCheckoutOwner: async ({ actorAgentId, actorRunId }) => {
        if (actorAgentId !== 'agent' || actorRunId !== 'host-1') throw new Error('Host checkout denied');
        return { assigneeAgentId: 'agent', checkoutRunId };
      },
    } };
    const dispatch = createDispatch(host, async () => ({ engine, store: engine.store }),
      async () => ({ roleBindings: { 'pack:maker': 'agent' } }), persistence);
    const config = { roleBindings: { 'pack:maker': 'agent' } };
    const pending = dispatch.dispatchReady('company', engine, run.id, config);
    await started;
    const callback = { companyId: 'company', issueId: 'child', run: await engine.getRun(run.id),
      nodeId: 'make', operation: 'submit' };
    const validActor = { id: 'agent', kind: 'agent', roles: ['maker'], executionId: 'host-1' };
    assert.equal(row.state, 'waking');
    await assert.rejects(dispatch.assertAgentCallback({ ...callback,
      actor: { ...validActor, id: 'other-agent' } }), /not bound/);
    row.attempt = 2;
    await assert.rejects(dispatch.assertAgentCallback({ ...callback, actor: validActor }), /Stale Graph attempt/);
    row.attempt = 1;
    for (const state of ['claimed', 'issued']) {
      row.state = state;
      await assert.rejects(dispatch.assertAgentCallback({ ...callback, actor: validActor }), /run does not match/);
      assert.equal(row.agent_run_id, null);
    }
    row.state = 'waking'; checkoutRunId = 'host-other';
    await assert.rejects(dispatch.assertAgentCallback({ ...callback, actor: validActor }), /checkout does not identify/);
    assert.equal(row.agent_run_id, null);
    checkoutRunId = 'host-1';
    await dispatch.assertAgentCallback({ ...callback, actor: validActor });
    assert.equal(row.agent_run_id, 'host-1');
    assert.equal(row.state, 'woken');
    releaseWakeup();
    if (returnedRunId === 'host-1') await pending;
    else await assert.rejects(pending, /confirmed host run differs from checkout/);
    assert.equal(row.agent_run_id, 'host-1');
    assert.equal(wakeupCalls, 1);
  }
});

test('a queued wakeup with no returned run ID can bind its later exact checkout once', async () => {
  const engine = new GraphEngine();
  await engine.registerPack({ id: 'pack', version: '1', roles: { maker: { documents: {} } }, graphs: [{
    id: 'graph', version: '1', start: 'make', nodes: [{ id: 'make', type: 'task', role: 'maker' }], edges: [],
  }] });
  const run = await engine.startRun({ packId: 'pack', packVersion: '1', graphId: 'graph',
    actor: { id: 'owner', kind: 'human', roles: ['human-owner'] },
    input: { paperclipIssueId: 'root', paperclipCompanyId: 'company' } });
  let row, wakeups = 0;
  const persistence = {
    get: async () => structuredClone(row ?? null),
    claim: async (_companyId, _runId, _nodeId, _attempt, _phase, agentId) => {
      if (row) return false;
      row = { issue_id: null, agent_id: agentId, agent_run_id: null, attempt: 1, phase: 'work', state: 'claimed' };
      return true;
    },
    wakeClaim: async () => { row.state = 'waking'; return true; },
    bindRun: async (_companyId, _runId, _nodeId, attempt, phase, issueId, agentId, agentRunId) => {
      if (row.state !== 'waking' || row.attempt !== attempt || row.phase !== phase ||
          row.issue_id !== issueId || row.agent_id !== agentId) return false;
      row.state = 'woken'; row.agent_run_id = agentRunId; return true;
    },
    update: async (_companyId, _runId, _nodeId, _attempt, _phase, patch) => {
      if (patch.issueId) { row.issue_id = patch.issueId; row.state = 'issued'; }
    },
    forIssue: async (_companyId, issueId) => row?.issue_id === issueId ? structuredClone(row) : null,
  };
  const host = { manifest: { id: 'plugin' }, db: {}, agents: { get: async (id) => ({ id }) }, issues: {
    get: async (id) => id === 'root' ? { id } : null,
    list: async () => [], create: async () => ({ id: 'child' }),
    requestWakeup: async () => { wakeups++; return { queued: true, runId: null }; },
    assertCheckoutOwner: async ({ actorAgentId, actorRunId }) =>
      ({ assigneeAgentId: actorAgentId, checkoutRunId: actorRunId }),
  } };
  const dispatch = createDispatch(host, async () => ({ engine, store: engine.store }),
    async () => ({ roleBindings: { 'pack:maker': 'agent' } }), persistence);
  const config = { roleBindings: { 'pack:maker': 'agent' } };
  const first = await dispatch.dispatchReady('company', engine, run.id, config);
  assert.equal(first[0].status, 'queued');
  assert.equal(row.state, 'waking');
  assert.equal(row.agent_run_id, null);
  await dispatch.assertAgentCallback({ companyId: 'company', issueId: 'child', run: await engine.getRun(run.id),
    nodeId: 'make', operation: 'submit',
    actor: { id: 'agent', kind: 'agent', roles: ['maker'], executionId: 'later-host-run' } });
  const repeated = await dispatch.dispatchReady('company', engine, run.id, config);
  assert.equal(repeated[0].agentRunId, 'later-host-run');
  assert.equal(repeated[0].status, 'woken');
  assert.equal(wakeups, 1);
});
