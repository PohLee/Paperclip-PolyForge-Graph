import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { GraphEngine, RevisionConflict, runValidationDigest } from '../../src/core/index.mjs';
import { createDispatch } from '../../src/plugin/dispatch.mjs';
import { AuthorizationError } from '../../src/plugin/auth-error.mjs';
import { syncGraphDecision } from '../../src/plugin/native-decisions.mjs';
import plugin from '../../src/plugin/worker.mjs';
import manifest from '../../src/plugin/manifest.mjs';
import { bindDispatchRunFromCheckout, claimDispatch, getDispatch, updateDispatch } from '../../src/plugin/store.mjs';
import { normalizeDispatchState } from '../../src/plugin/dispatch-state.mjs';
import * as assignmentLedger from '../../src/plugin/assignment-ledger.mjs';
import { beginEffect } from '../../src/plugin/effect-ledger.mjs';
import { createPostgresShadowDatabase, postgresShadowAvailable } from '../helpers/postgres-shadow.mjs';

const pendingWorkLifecycle = { managed: false, workStatus: 'pending', executionStage: 'work',
  dependencyReadiness: 'unmanaged', reviewPath: 'work', workspaceFinalize: 'unmanaged', admission: 'unmanaged', reason: undefined };

async function fixture(options = {}) {
  const engine = new GraphEngine({ now: options.now });
  await engine.registerPack({ id: 'pack', version: '1', workspace: options.packWorkspace,
    roles: { maker: { documents: options.roleDocuments ?? {} } }, decisionRules: options.decisionRules,
    ...(options.evidenceInstructions && { policyDocuments: { evidenceContracts: options.evidenceInstructions } }), graphs: [{
    id: 'graph', version: '1', start: 'make', nodes: [{ id: 'make', type: 'task', role: 'maker', ...options.node }], edges: [],
    ...options.graph,
  }, ...(options.extraGraphs ?? [])] });
  const run = await engine.startRun({ packId: 'pack', packVersion: '1', graphId: 'graph', deliveryLimits: options.deliveryLimits,
    actor: { id: 'owner', kind: 'human', roles: ['human-owner'] },
    input: { paperclipIssueId: 'root', paperclipCompanyId: 'company', ...options.input } });
  let row = null, callbackPromise = null, wakeupCalls = 0, checkoutCalls = 0;
  const rows = new Map(), assignments = new Map();
  const dispatchKey = (_company, _runId, nodeId, attempt, phase) => `${nodeId}:${attempt}:${phase}`;
  const persistence = {
    get: async (...args) => structuredClone(rows.get(dispatchKey(...args)) ?? null),
    claim: async (_company, _runId, nodeId, attempt, phase, agentId) => {
      const key = dispatchKey(_company, _runId, nodeId, attempt, phase);
      if (rows.has(key)) return Boolean(options.reclaim);
      row = { issue_id: null, agent_id: agentId, agent_run_id: null, node_id: nodeId,
        attempt, phase, state: 'claimed' };
      rows.set(key, row);
      return true;
    },
    update: async (_company, _runId, _nodeId, _attempt, _phase, patch) => {
      if (patch.issueId) {
        row.issue_id = patch.issueId;
        row.state = 'issued';
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
    get: options.getIssue ?? (async (id) => id === 'root' ? { id, projectId: null }
      : { id, originKind: 'plugin:plugin:node', assigneeAgentId: assignments.get(id) }),
    list: options.list ?? (async () => []),
    create: options.create ?? (async () => ({ id: 'child-1' })),
    update: async (issueId, patch, companyId) => {
      assert.equal(companyId, 'company');
      if (!patch.assigneeAgentId) return;
      assert.equal(row.issue_id, issueId);
      assignments.set(issueId, patch.assigneeAgentId);
      // Simulate recovery's issue_assigned wakeup racing the assignment response.
      if (options.noCallback) return;
      callbackPromise = dispatch.assertAgentCallback({ companyId, issueId,
        run, actor: { id: 'agent', kind: 'agent', roles: ['maker'], executionId: 'checked-out-run' },
        nodeId: 'make', operation: 'submit' });
      await callbackPromise;
    },
    requestWakeup: async () => { wakeupCalls++; return { runId: 'duplicate-run', queued: true }; },
    assertCheckoutOwner: async ({ issueId, companyId, actorAgentId, actorRunId }) => {
      checkoutCalls++;
      assert.equal(issueId, 'child-1'); assert.equal(companyId, 'company');
      assert.equal(actorAgentId, 'agent'); assert.equal(actorRunId, 'checked-out-run');
      return { assigneeAgentId: 'agent', checkoutRunId: 'checked-out-run' };
    },
  } };
  Object.assign(persistence, options.persistence ?? {});
  if (options.assess) host.assessGraphDispatchLifecycle = options.assess;
  const dispatch = createDispatch(host, async () => ({ engine, store: engine.store }),
    async () => ({ roleBindings: { 'pack:maker': 'agent' } }), persistence, options.shadowRuntime ?? null, options.dispatchOptions);
  return { engine, run, dispatch, host, persistence, get row() { return row; }, get callbackPromise() { return callbackPromise; },
    get wakeupCalls() { return wakeupCalls; }, get checkoutCalls() { return checkoutCalls; } };
}

function effectPersistence(dbNow = Date.parse('2026-11-19T00:00:00.000Z')) {
  const effects = new Map(), marker = { cancelled_before_send: true };
  const persistence = {
    getEffect: async (_company, id) => structuredClone(effects.get(id) ?? null),
    beginEffect: async (_company, id, request) => {
      const prior = effects.get(id);
      if (prior) {
        assert.deepEqual(prior.request, request);
        return { owner: false, ...structuredClone(prior) };
      }
      effects.set(id, { request: structuredClone(request), outcome: 'unknown', created_at: new Date().toISOString() });
      return { owner: true, outcome: 'unknown' };
    },
    retireEffect: async (_company, id) => {
      const inserted = !effects.has(id);
      if (inserted) effects.set(id, { request: marker, outcome: 'confirmed_failure', result: marker, created_at: new Date().toISOString() });
      return { ...structuredClone(effects.get(id)), inserted };
    },
    confirmEffect: async (_company, id, outcome, result) => {
      const effect = effects.get(id);
      assert.equal(effect.outcome, 'unknown');
      Object.assign(effect, { outcome, result });
    },
    settleAbsentEffect: async (_company, id, graceMs, result) => {
      const effect = effects.get(id);
      assert.equal(effect.outcome, 'unknown');
      const retryAt = effect.created_at == null ? NaN : new Date(effect.created_at).getTime() + graceMs;
      if (!Number.isFinite(retryAt) || dbNow < retryAt) return { settled: false, outcome: effect.outcome,
        retryAt: Number.isFinite(retryAt) ? new Date(retryAt).toISOString() : null };
      Object.assign(effect, { outcome: 'confirmed_failure', result });
      return { settled: true };
    },
    cancelRetirements: async (_company, ids) => {
      for (const id of ids) {
        const effect = effects.get(id);
        if (effect?.outcome === 'confirmed_failure' && JSON.stringify(effect.result) === JSON.stringify(marker)) effects.delete(id);
      }
    },
  };
  return { effects, persistence };
}

function workerDatabase(f, { effects, persistence }, { onEffectDelete } = {}) {
  const assignment = assignmentPersistence();
  return { namespace: 'plugin_test',
    async query(sql, args = []) {
      if (sql.includes('graph_state')) {
        const document = await f.engine.store.read();
        return [{ revision: document.revision, document }];
      }
      if (sql.includes('graph_issue_assignment') && sql.includes('starts_with')) {
        return [...assignment.assignments].filter(([, row]) => row.retirement_owners.some(owner => owner.startsWith(args[1])))
          .map(([id, row]) => ({ operation_id: id, retirement_owners: row.retirement_owners }));
      }
      if (sql.includes('graph_issue_assignment')) {
        const row = await assignment.persistence.getAssignment(...args);
        return row ? [row] : [];
      }
      if (sql.includes('graph_external_effect')) {
        const effect = await persistence.getEffect(...args);
        return effect ? [effect] : [];
      }
      return [];
    },
    async execute(sql, args = []) {
      if (sql.includes('graph_state')) {
        try { await f.engine.store.write(JSON.parse(args[2]), args[3] ?? 0); return { rowCount: 1 }; }
        catch (error) { if (error instanceof RevisionConflict) return { rowCount: 0 }; throw error; }
      }
      if (sql.includes('graph_issue_assignment')) {
        if (sql.includes('INSERT INTO')) await assignment.persistence.retireAssignment(...args);
        else if (sql.includes('UPDATE')) await assignment.persistence.cancelAssignments(args[0], JSON.parse(args[1]), args[2]);
        return { rowCount: 1 };
      }
      if (sql.includes('graph_external_effect')) {
        if (sql.includes('DELETE FROM')) {
          await onEffectDelete?.();
          const count = effects.size;
          await persistence.cancelRetirements(args[0], JSON.parse(args[1]));
          return { rowCount: count - effects.size };
        }
        assert.ok(sql.includes('INSERT INTO'), `Unexpected effect mutation: ${sql}`);
        const effect = await persistence.retireEffect(args[0], args[1]);
        return { rowCount: effect.inserted ? 1 : 0 };
      }
      assert.ok(sql.includes('DELETE FROM plugin_test.graph_dispatch_slot'), `Unexpected database mutation: ${sql}`);
      return { rowCount: 0 };
    },
  };
}

test('a losing retry keeps the tombstone shared with a committed retry', async (t) => {
  const { effects, persistence } = effectPersistence();
  const f = await fixture({ persistence });
  assert.equal(typeof f.dispatch.retryNode, 'function');
  const input = { runId: f.run.id, nodeId: 'make', actor: { id: 'owner', kind: 'human', roles: ['human-owner'] } };
  const retry = f.engine.retryNode.bind(f.engine);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  t.mock.method(f.engine, 'retryNode', async (args) => {
    if (args.reason === 'A') { enter(); await released; }
    return retry(args);
  });
  const loser = f.dispatch.retryNode('company', f.engine, { ...input, reason: 'A', idempotencyKey: 'A' });
  const rejected = assert.rejects(loser, /changed since validation/);
  await entered;
  assert.equal((await f.dispatch.retryNode('company', f.engine, { ...input, reason: 'B', idempotencyKey: 'B' })).nextAttempt, 2);
  release();
  await rejected;
  const operationId = `issue-create:${f.run.id}:make:1:work`;
  assert.deepEqual(effects.get(operationId).result, { cancelled_before_send: true });
  await assert.rejects(persistence.beginEffect('company', operationId, { title: 'delayed create' }));
});

test('committed retry reasserts shared tombstones removed by an in-flight compensation', async (t) => {
  for (const sendInGap of [false, true]) await t.test(`send in gap=${sendInGap}`, async (t) => {
    const { effects, persistence } = effectPersistence();
    let enter, release, finish;
    const entered = new Promise(resolve => { enter = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    const finished = new Promise(resolve => { finish = resolve; });
    const f = await fixture({ persistence: { ...persistence, cancelRetirements: async (...args) => {
      enter(); await released;
      await persistence.cancelRetirements(...args);
      if (sendInGap) await persistence.beginEffect('company', args[1][0], { title: 'delayed create' });
      finish();
    } } });
    assert.equal(typeof f.dispatch.retryNode, 'function');
    const warnings = [];
    f.host.logger = { warn: (...args) => warnings.push(args) };
    const input = { runId: f.run.id, nodeId: 'make', actor: { id: 'owner', kind: 'human', roles: ['human-owner'] } };
    const retry = f.engine.retryNode.bind(f.engine), failure = new Error('retry rejected');
    t.mock.method(f.engine, 'retryNode', async (args) => {
      if (args.reason === 'A') throw failure;
      const result = await retry(args);
      release(); await finished;
      return result;
    });
    const rejected = assert.rejects(f.dispatch.retryNode('company', f.engine, { ...input, reason: 'A' }), error => error === failure);
    await entered;
    const result = await f.dispatch.retryNode('company', f.engine, { ...input, reason: 'B' });
    await rejected;
    assert.equal(result.nextAttempt, 2);
    const operationId = `issue-create:${f.run.id}:make:1:work`;
    assert.equal(effects.get(operationId).outcome, sendInGap ? 'unknown' : 'confirmed_failure');
    if (sendInGap) {
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0][0], 'Paperclip issue creation began for an attempt abandoned by retry');
      assert.equal(warnings[0][1].operationId, operationId);
    } else assert.deepEqual(warnings, []);
  });
});

test('committed retry reasserts only retirements it did not insert', async (t) => {
  const { effects, persistence } = effectPersistence();
  const f = await fixture({ persistence });
  const id = suffix => `issue-create:${f.run.id}:make:${suffix}`;
  await persistence.retireEffect('company', id('1:work'));
  effects.set(id('1:supervisor'), { outcome: 'unknown', created_at: '2000-01-01T00:00:00.000Z' });
  t.mock.method(f.persistence, 'readState', async () => {
    const snapshot = await f.engine.store.read(), run = snapshot.runs[f.run.id];
    run.graph.nodes[0].review = { supervisorRole: 'maker' };
    run.nodeStates.make.attempts = [{}];
    return snapshot;
  });
  const retired = [];
  t.mock.method(f.persistence, 'retireEffect', async (...args) => { retired.push(args[1]); return persistence.retireEffect(...args); });
  t.mock.method(f.engine, 'retryNode', async () => ({ nextAttempt: 3 }));
  assert.equal((await f.dispatch.retryNode('company', f.engine, { runId: f.run.id, nodeId: 'make' })).nextAttempt, 3);
  assert.deepEqual(retired, ['1:work', '1:supervisor', '2:work', '1:work', '1:supervisor'].map(id));
});

test('retry compensation cancels only the freshly dispatchable attempt and phase', async (t) => {
  for (const source of ['snapshot', 'engine']) {
    for (const status of ['pending', 'awaiting_self_review', 'awaiting_supervisor_review', 'accepted']) {
      await t.test(`${source}, ${status}`, async (t) => {
        const { effects, persistence } = effectPersistence();
        const f = await fixture({ persistence });
        assert.equal(typeof f.dispatch.retryNode, 'function');
        const run = await f.engine.getRun(f.run.id);
        run.graph.nodes[0].review = { supervisorRole: 'maker' };
        Object.assign(run.nodeStates.make, { attempts: [{}], status: 'pending' });
        t.mock.method(f.engine, 'getRun', async () => structuredClone(run));
        f.persistence.readState = source === 'snapshot' ? async () => ({ runs: { [run.id]: structuredClone(run) } }) : undefined;
        const failure = new Error('retry rejected');
        t.mock.method(f.engine, 'retryNode', async () => { run.nodeStates.make.status = status; throw failure; });
        await assert.rejects(f.dispatch.retryNode('company', f.engine, { runId: run.id, nodeId: 'make', reason: 'Recover' }), error => error === failure);
        const cancelled = status === 'pending' ? ['2:work'] : status === 'awaiting_self_review' ? ['1:work', '1:supervisor']
          : status === 'awaiting_supervisor_review' ? ['1:supervisor'] : [];
        for (const suffix of ['1:work', '1:supervisor', '2:work']) {
          assert.equal(effects.has(`issue-create:${run.id}:make:${suffix}`), !cancelled.includes(suffix));
        }
      });
    }
  }
});

test('retry preserves the original AuthorizationError when compensation fails', async (t) => {
  const { effects, persistence } = effectPersistence();
  const rollbackError = new Error('database unavailable'), failure = new AuthorizationError('Retry denied');
  const f = await fixture({ persistence: { ...persistence, cancelRetirements: async () => { throw rollbackError; } } });
  const errors = [];
  f.host.logger = { error: (...args) => errors.push(args) };
  t.mock.method(f.engine, 'retryNode', async () => { throw failure; });
  await assert.rejects(f.dispatch.retryNode('company', f.engine, { runId: f.run.id, nodeId: 'make', reason: 'Recover' }), error => error === failure);
  assert.equal(failure.status, 403);
  assert.deepEqual(errors, [['Retry effect rollback failed; leftover tombstones need operator review', {
    operationIds: [`issue-create:${f.run.id}:make:1:work`], error: rollbackError.message,
  }]]);
  assert.equal(effects.size, 1);
});

test('owner retry settles absent unknown creation and dispatches a distinct attempt', async (t) => {
  for (const failure of ['throw', 'mismatched receipt']) await t.test(failure, async () => {
    const { effects, persistence } = effectPersistence();
    let sends = 0, parentGets = 0;
    const origins = [];
    const f = await fixture({ noCallback: true, reclaim: true, persistence,
      getIssue: async (id) => { parentGets++; return { id, companyId: 'company', projectId: 'project' }; },
      create: async (request) => {
        sends++; origins.push(request.originId);
        if (sends > 1) return { id: 'new-child' };
        if (failure === 'throw') throw new Error('receipt lost');
        return { id: 'wrong-child', parentId: 'wrong-parent' };
      } });
    const config = { roleBindings: { 'pack:maker': 'agent' } };
    for (let i = 0; i < 2; i++) assert.equal((await f.dispatch.dispatchReady('company', f.engine, f.run.id, config))[0].status, 'effect_unknown');
    assert.equal(sends, 1);
    effects.get(`issue-create:${origins[0]}`).created_at = '2000-01-01T00:00:00.000Z';
    parentGets = 0;
    const guard = await f.dispatch.assertRetrySafe('company', f.engine, f.run.id, 'make', 'recover');
    assert.equal(parentGets, 1);
    assert.deepEqual(guard.retiredOperations.filter(item => item.inserted).map(item => item.operationId), []);
    assert.equal(effects.get(`issue-create:${origins[0]}`).outcome, 'confirmed_failure');
    assert.deepEqual(effects.get(`issue-create:${origins[0]}`).result, { settledBy: 'owner-retry', lookup: 'absent' });
    const result = await f.engine.retryNode({ runId: f.run.id, nodeId: 'make',
      actor: { id: 'owner', kind: 'human', roles: ['human-owner'] }, reason: 'Recover lost send',
      idempotencyKey: 'recover', expectedRunDigest: guard.expectedRunDigest });
    assert.equal(result.nextAttempt, 2);
    assert.equal((await f.dispatch.dispatchReady('company', f.engine, f.run.id, config))[0].issueId, 'new-child');
    assert.equal(sends, 2);
    assert.notEqual(origins[0], origins[1]);
    assert.ok(origins[1].endsWith(':2:work'));
    const before = structuredClone([...effects]);
    assert.equal(await f.dispatch.assertRetrySafe('company', f.engine, f.run.id, 'make', 'recover'), undefined);
    assert.deepEqual([...effects], before);
  });
});

test('retry reconciles an attached issue despite a changed assignment without an origin lookup', async (t) => {
  for (const assigneeAgentId of ['other-agent', null]) await t.test(String(assigneeAgentId), async (t) => {
    const { effects, persistence } = effectPersistence();
    const reconciliations = [];
    const f = await fixture({ noCallback: true, persistence: { ...persistence,
      confirmEffect: async () => { throw new Error('database unavailable'); },
      reconcileEffect: async (companyId, operationId, result) => {
        reconciliations.push({ companyId, operationId, result });
        await persistence.confirmEffect(companyId, operationId, 'confirmed_success', result);
      },
    } });
    const config = { roleBindings: { 'pack:maker': 'agent' } };
    assert.equal((await f.dispatch.dispatchReady('company', f.engine, f.run.id, config))[0].status, 'issued');
    const operationId = `issue-create:${f.run.id}:make:1:work`;
    assert.equal(f.row.issue_id, 'child-1');
    assert.equal(effects.get(operationId).outcome, 'unknown');
    const list = t.mock.method(f.host.issues, 'list', async ({ companyId, originKind, originId }) => [
      { id: 'child-1', companyId, originKind, originId, parentId: 'root', projectId: null, assigneeAgentId },
    ]);
    assert.equal((await f.dispatch.dispatchReady('company', f.engine, f.run.id, config))[0].status, 'issued');
    assert.deepEqual(reconciliations, []);
    await f.dispatch.assertRetrySafe('company', f.engine, f.run.id, 'make');
    assert.equal(list.mock.callCount(), 0);
    assert.deepEqual(reconciliations, [{ companyId: 'company', operationId, result: { issueId: 'child-1' } }]);
    assert.equal(effects.get(operationId).outcome, 'confirmed_success');
    assert.deepEqual(effects.get(operationId).result, { issueId: 'child-1' });
  });
});

test('retry uses origin lookup for an unknown effect without an attached issue', async (t) => {
  const { effects, persistence } = effectPersistence();
  const f = await fixture({ persistence });
  await f.persistence.claim('company', f.run.id, 'make', 1, 'work', 'agent');
  const operationId = `issue-create:${f.run.id}:make:1:work`;
  effects.set(operationId, { outcome: 'unknown', created_at: '2000-01-01T00:00:00.000Z' });
  const list = t.mock.method(f.host.issues, 'list', async () => []);
  await f.dispatch.assertRetrySafe('company', f.engine, f.run.id, 'make');
  assert.equal(list.mock.callCount(), 1);
  assert.deepEqual(list.mock.calls[0].arguments, [{ companyId: 'company', originKind: 'plugin:plugin:node',
    originId: `${f.run.id}:make:1:work`, limit: 1000 }]);
  assert.equal(effects.get(operationId).outcome, 'confirmed_failure');
});

test('retry continues to the next phase when absent settlement observes a concurrent success', async (t) => {
  const { effects, persistence } = effectPersistence();
  const f = await fixture({ persistence });
  t.mock.method(f.persistence, 'readState', async () => {
    const snapshot = await f.engine.store.read(), run = snapshot.runs[f.run.id];
    run.graph.nodes[0].review = { supervisorRole: 'maker' };
    run.nodeStates.make.attempts = [{}];
    return snapshot;
  });
  const operationId = `issue-create:${f.run.id}:make:1:work`;
  const result = { issueId: 'concurrently-created' };
  effects.set(operationId, { outcome: 'unknown', created_at: '2000-01-01T00:00:00.000Z' });
  const settlement = t.mock.method(f.persistence, 'settleAbsentEffect', async (companyId, id) => {
    await persistence.confirmEffect(companyId, id, 'confirmed_success', result);
    return { settled: false, outcome: 'confirmed_success', result };
  });
  const list = t.mock.method(f.host.issues, 'list', async () => []);
  await f.dispatch.assertRetrySafe('company', f.engine, f.run.id, 'make');
  assert.equal(list.mock.callCount(), 1);
  assert.equal(settlement.mock.callCount(), 1);
  assert.equal(effects.get(operationId).outcome, 'confirmed_success');
  assert.deepEqual(effects.get(operationId).result, result);
  assert.deepEqual(effects.get(`issue-create:${f.run.id}:make:1:supervisor`).result, { cancelled_before_send: true });
  assert.deepEqual(effects.get(`issue-create:${f.run.id}:make:2:work`).result, { cancelled_before_send: true });
});

test('retry preserves young or undated unknown effects despite an ahead worker clock', async (t) => {
  const dbNow = Date.parse('2026-11-19T00:00:00.000Z'), effectSettleGraceMs = 60_000;
  for (const created_at of ['2026-11-18T23:59:59.000Z', undefined, null, 'invalid']) {
    await t.test(String(created_at), async (t) => {
      t.mock.method(Date, 'now', () => dbNow + 3_600_000);
      const { effects, persistence } = effectPersistence(dbNow);
      let f;
      f = await fixture({ noCallback: true, dispatchOptions: { effectSettleGraceMs },
        persistence: { ...persistence, readState: async () => {
          const snapshot = await f.engine.store.read(), run = snapshot.runs[f.run.id];
          run.graph.nodes[0].review = { supervisorRole: 'maker' };
          run.nodeStates.make.attempts = [{}];
          return snapshot;
        } } });
      const operationId = `issue-create:${f.run.id}:make:1:supervisor`;
      effects.set(operationId, { outcome: 'unknown', request: {}, created_at });
      const before = structuredClone(effects.get(operationId));
      await assert.rejects(f.dispatch.assertRetrySafe('company', f.engine, f.run.id, 'make'), (error) => {
        assert.match(error.message, /issue creation may still be in progress/);
        assert.match(error.message, created_at?.startsWith('2026-')
          ? /retry after 2026-11-19T00:00:59.000Z/ : /60000ms.*grace|grace.*60000ms/);
        return true;
      });
      assert.deepEqual(effects.get(operationId), before);
      assert.deepEqual(effects.get(`issue-create:${f.run.id}:make:1:work`).result, { cancelled_before_send: true });
    });
  }
});

test('retry settles an absent effect once its creation grace has elapsed', async () => {
  const { effects, persistence } = effectPersistence();
  const f = await fixture({ persistence, dispatchOptions: { effectSettleGraceMs: 60_000 } });
  const operationId = `issue-create:${f.run.id}:make:1:work`;
  effects.set(operationId, { outcome: 'unknown', request: {}, created_at: new Date('2026-11-18T23:58:59.000Z') });
  await f.dispatch.assertRetrySafe('company', f.engine, f.run.id, 'make');
  assert.equal(effects.get(operationId).outcome, 'confirmed_failure');
  assert.deepEqual(effects.get(operationId).result, { settledBy: 'owner-retry', lookup: 'absent' });
});

test('retry refuses absent settlement when custom persistence cannot use the database clock', async () => {
  const { effects, persistence } = effectPersistence();
  const f = await fixture({ persistence: { ...persistence, settleAbsentEffect: undefined },
    dispatchOptions: { effectSettleGraceMs: 60_000 } });
  const operationId = `issue-create:${f.run.id}:make:1:work`;
  effects.set(operationId, { outcome: 'unknown', request: {}, created_at: '2000-01-01T00:00:00.000Z' });
  await assert.rejects(f.dispatch.assertRetrySafe('company', f.engine, f.run.id, 'make'),
    /issue creation may still be in progress.*60000ms.*grace/);
  assert.equal(effects.get(operationId).outcome, 'unknown');
});

test('a retired creation confirmation leaves its issue unattached and dispatches the next ready node', async () => {
  const { effects, persistence } = effectPersistence();
  const warnings = [], updates = [];
  const f = await fixture({ noCallback: true, graph: {
    start: 'start', nodes: [{ id: 'start', type: 'task' },
      { id: 'retired', type: 'task', role: 'maker' }, { id: 'normal', type: 'task', role: 'maker' }],
    edges: [{ from: 'start', to: 'retired' }, { from: 'start', to: 'normal' }],
  }, persistence: { ...persistence, confirmEffect: async (companyId, operationId, outcome, result) => {
    if (operationId.endsWith(':retired:1:work')) {
      effects.get(operationId).outcome = 'confirmed_failure';
      throw new Error('External effect outcome conflicts with existing confirmation');
    }
    await persistence.confirmEffect(companyId, operationId, outcome, result);
  } }, create: async (request) => {
    assert.equal(Object.hasOwn(request, 'assigneeAgentId'), false);
    return { id: request.originId.includes(':retired:') ? 'orphan-issue' : 'normal-issue' };
  } });
  f.host.logger = { warn: (...args) => warnings.push(args) };
  f.host.issues.update = async (...args) => { updates.push(args); };
  await f.engine.submitNode({ runId: f.run.id, nodeId: 'start',
    actor: { id: 'owner', kind: 'human', roles: ['human-owner'] } });
  const actions = await f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
  const operationId = `issue-create:${f.run.id}:retired:1:work`;
  assert.deepEqual(actions[0], { nodeId: 'retired', phase: 'work', status: 'effect_orphaned',
    operationId, issueId: 'orphan-issue', lifecycle: pendingWorkLifecycle, contained: true });
  assert.deepEqual(updates, [['orphan-issue', { status: 'cancelled' }, 'company'],
    ['normal-issue', { assigneeAgentId: 'agent' }, 'company']]);
  assert.equal((await f.persistence.get('company', f.run.id, 'retired', 1, 'work')).issue_id, null);
  assert.equal(actions[1].status, 'issued');
  assert.equal(actions[1].issueId, 'normal-issue');
  assert.equal((await f.persistence.get('company', f.run.id, 'normal', 1, 'work')).issue_id, 'normal-issue');
  assert.equal(warnings[0][0], 'Paperclip issue created for a retired dispatch attempt');
  assert.equal(warnings[0][1].operationId, operationId);
  assert.equal(warnings[0][1].issueId, 'orphan-issue');
});

test('orphan containment failure leaves the issue unattached and warns without throwing', async (t) => {
  for (const update of ['reject', 'missing']) await t.test(update, async () => {
    const warnings = [];
    const f = await fixture({ noCallback: true, persistence: {
      confirmEffect: async () => { throw new Error('External effect outcome conflicts with existing confirmation'); },
      getEffect: async () => ({ outcome: 'confirmed_failure' }),
    } });
    f.host.logger = { warn: (...args) => warnings.push(args) };
    if (update === 'reject') f.host.issues.update = async () => { throw new Error('update unavailable'); };
    else delete f.host.issues.update;
    const [action] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
    assert.deepEqual(action, { nodeId: 'make', phase: 'work', status: 'effect_orphaned',
      operationId: `issue-create:${f.run.id}:make:1:work`, issueId: 'child-1', lifecycle: pendingWorkLifecycle, contained: false });
    assert.equal(f.row.issue_id, null);
    assert.equal(f.checkoutCalls, 0);
    const warning = warnings.find(([message]) => message === 'Orphaned Paperclip issue could not be cancelled; operator cleanup required');
    assert.ok(warning);
    assert.equal(warning[1].operationId, action.operationId);
    assert.equal(warning[1].issueId, 'child-1');
    assert.ok(warning[1].error);
  });
});

test('a failed creation confirmation attaches only an unknown effect or a failed reread', async (t) => {
  for (const lookup of ['unknown', 'unavailable', 'throw']) for (const noCallback of [false, true]) {
    await t.test(`${lookup}, noCallback=${noCallback}`, async () => {
      const { effects, persistence } = effectPersistence();
      const warnings = [], documents = [];
      const f = await fixture({ noCallback, persistence: { ...persistence,
        confirmEffect: async () => { throw new Error('database unavailable'); },
        getEffect: lookup === 'unavailable' ? undefined : async () => {
          if (lookup === 'throw') throw new Error('database still unavailable');
          return { outcome: 'unknown' };
        },
      } });
      f.host.logger = { warn: (...args) => warnings.push(args) };
      f.host.issues.documents = { get: async () => null, upsert: async (document) => { documents.push(document); } };
      const [action] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
      if (lookup === 'unavailable') {
        assert.deepEqual(action, { nodeId: 'make', phase: 'work', status: 'effect_unknown',
          operationId: `issue-create:${f.run.id}:make:1:work`, issueId: 'child-1', lifecycle: pendingWorkLifecycle });
        assert.equal(f.row.issue_id, null);
        assert.deepEqual(documents, []);
        assert.equal(f.checkoutCalls, 0);
      } else {
        assert.deepEqual(action, { nodeId: 'make', phase: 'work', status: noCallback ? 'issued' : 'woken',
          issueId: 'child-1', agentId: 'agent', agentRunId: noCallback ? null : 'checked-out-run', lifecycle: pendingWorkLifecycle });
        assert.equal(f.row.issue_id, 'child-1');
        assert.equal(documents.length, 1);
        assert.equal(documents[0].issueId, 'child-1');
        assert.equal(documents[0].key, 'goal');
        assert.equal(f.checkoutCalls, noCallback ? 0 : 1);
      }
      assert.equal(effects.get(`issue-create:${f.run.id}:make:1:work`).outcome, 'unknown');
      assert.equal(f.wakeupCalls, 0);
      assert.equal(warnings.at(-1)[0], 'Paperclip issue creation effect confirmation deferred');
      assert.equal(warnings.at(-1)[1].issueId, 'child-1');
      if (lookup === 'throw') assert.equal(warnings.at(-1)[1].lookupError, 'database still unavailable');
    });
  }
});

test('a failed creation confirmation stays unattached when eligibility is lost or cannot be checked', async (t) => {
  for (const eligibility of ['stale', 'throw']) await t.test(eligibility, async (t) => {
    const { effects, persistence } = effectPersistence();
    const f = await fixture({ noCallback: true, persistence: { ...persistence,
      confirmEffect: async () => {
        t.mock.method(f.engine, 'getWorkItems', async () => {
          if (eligibility === 'throw') throw new Error('eligibility unavailable');
          return [];
        });
        throw new Error('database unavailable');
      },
    } });
    const [action] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
    assert.deepEqual(action, { nodeId: 'make', phase: 'work', status: 'effect_unknown',
      operationId: `issue-create:${f.run.id}:make:1:work`, issueId: 'child-1', lifecycle: pendingWorkLifecycle });
    assert.equal(f.row.issue_id, null);
    assert.equal(effects.get(action.operationId).outcome, 'unknown');
    assert.equal(f.checkoutCalls, 0);
  });
});

test('dispatch carries the parent project and strategy and instructs native agents to submit before finishing', async () => {
  let gets = 0;
  const f = await fixture({ noCallback: true,
    getIssue: async (id) => { gets++; return { id, companyId: 'company', projectId: 'project',
      executionWorkspaceId: 'parent-workspace', executionWorkspacePreference: 'reuse_existing',
      executionWorkspaceSettings: { existingBranch: 'unmerged-parent-branch' } }; },
    create: async (request) => {
      assert.equal(request.parentId, 'root'); assert.equal(request.projectId, 'project');
      assert.equal(request.inheritExecutionWorkspaceFromIssueId, 'root');
      assert.equal(Object.hasOwn(request, 'executionWorkspaceId'), false);
      assert.equal(Object.hasOwn(request, 'executionWorkspacePreference'), false);
      assert.equal(Object.hasOwn(request, 'executionWorkspaceSettings'), false);
      assert.match(request.description, /isolated child checkouts start from the project base/);
      assert.match(request.description, /push or merge the changes and cite the accessible commit or ref/);
      assert.match(request.description, /call submit/);
      assert.match(request.description, /get_task_context and call_api with operationId "POST \/api\/plugins\/tools\/execute"/);
      assert.match(request.description, /tool to "plugin:graph-command"/);
      assert.match(request.description, /use activeTask\.id as parameters\.issueId/i);
      assert.match(request.description, /After Graph accepts the required commands, report the outcome with paperclip_finish/);
      assert.match(request.description, /use paperclip_block with the reason/);
      return { id: 'child-1' };
    } });
  await f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
  assert.equal(gets, 2);
});

test('node creation stays unassigned until confirmation, attachment, and GOAL.md are complete', async (t) => {
  for (const assignee of [{}, { assigneeAgentId: null }, { assignee_agent_id: null },
    { assigneeAgentId: 'agent' }]) await t.test(JSON.stringify(assignee), async (t) => {
    const { effects, persistence } = effectPersistence();
    const events = [];
    const f = await fixture({ persistence: { ...persistence, confirmEffect: async (...args) => {
      await persistence.confirmEffect(...args); events.push('confirmed');
    } }, create: async (request) => {
      assert.equal(Object.hasOwn(request, 'assigneeAgentId'), false);
      assert.equal(Object.hasOwn(request, 'intendedAssigneeAgentId'), false);
      assert.equal(request.status, 'todo');
      assert.equal(request.parentId, 'root');
      assert.equal(request.companyId, 'company');
      assert.equal(request.originKind, 'plugin:plugin:node');
      assert.equal(request.originId, `${f.run.id}:make:1:work`);
      const effect = effects.get(`issue-create:${request.originId}`);
      assert.deepEqual(effect.request, { ...request, intendedAssigneeAgentId: 'agent' });
      events.push('created');
      return { id: 'child-1', ...assignee };
    } });
    const update = f.persistence.update;
    t.mock.method(f.persistence, 'update', async (...args) => { await update(...args); events.push('attached'); });
    f.host.issues.documents = { get: async () => null, upsert: async (document) => {
      assert.equal(f.row.issue_id, document.issueId);
      assert.equal(document.key, 'goal'); events.push('goal');
    } };
    const assign = f.host.issues.update;
    t.mock.method(f.host.issues, 'update', async (...args) => {
      assert.deepEqual(args, ['child-1', { assigneeAgentId: 'agent' }, 'company']);
      events.push('assigned'); await assign(...args);
    });
    const get = t.mock.method(f.host.issues, 'get');
    const config = { roleBindings: { 'pack:maker': 'agent' } };
    const [action] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, config);
    assert.equal(action.status, 'woken');
    assert.deepEqual(events, ['created', 'confirmed', 'attached', 'goal', 'assigned']);
    await f.dispatch.dispatchReady('company', f.engine, f.run.id, config);
    assert.deepEqual(get.mock.calls.map(call => call.arguments), [
      ['root', 'company'], ['child-1', 'company'], ['child-1', 'company'],
    ]);
    assert.equal(f.wakeupCalls, 0);
  });
});

const missingBaseRevision = 'Document update requires baseRevisionId. GET the current document, read its body and latestRevisionId, then set baseRevisionId to that latestRevisionId when updating.';

test('concurrent GOAL.md creation accepts only the same pinned body on a fresh scoped read', async (t) => {
  const collisions = { 'duplicate key': 'Document key already exists on this issue', 'missing base revision': missingBaseRevision };
  const cases = Object.entries(collisions).flatMap(([label, message]) =>
    ['matching', 'different', 'missing'].map(outcome => ({ label, message, outcome })));
  cases.push({ label: 'store failure', message: 'Native document store unavailable', outcome: 'unrelated' },
    { label: 'stale revision', message: 'Document revision conflict', outcome: 'unrelated' });
  for (const { label, message, outcome } of cases) await t.test(`${label} / ${outcome}`, async t => {
    const f = await fixture();
    const failure = new Error(message);
    let proposed;
    const get = t.mock.fn(async (issueId, key, companyId) => {
      assert.deepEqual([issueId, key, companyId], ['child-1', 'goal', 'company']);
      if (!proposed || outcome === 'missing') return null;
      return { body: outcome === 'different' ? 'Changed commitments from another run' : proposed.body };
    });
    const upsert = t.mock.fn(async document => { proposed = document; throw failure; });
    f.host.issues.documents = { get, upsert };
    const update = t.mock.method(f.host.issues, 'update');
    const execute = f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
    if (outcome === 'matching') {
      const [action] = await execute;
      assert.equal(action.status, 'woken');
      assert.equal(update.mock.callCount(), 1);
    } else {
      await assert.rejects(execute, outcome === 'different' ? /GOAL.md differs from pinned goal revision/ : error => error === failure);
      assert.equal(update.mock.callCount(), 0);
    }
    assert.equal(get.mock.callCount(), outcome === 'unrelated' ? 1 : 2);
    assert.equal(upsert.mock.callCount(), 1, 'collision must never overwrite or retry the pinned document');
  });
});

test('assignment failure stays attached and the next pass recovers without another creation', async (t) => {
  for (const applied of [false, true]) await t.test(`applied before response lost=${applied}`, async (t) => {
    const warnings = [];
    const f = await fixture({ noCallback: true });
    f.host.logger = { warn: (...args) => warnings.push(args) };
    let goal;
    const upsert = t.mock.fn(async (document) => { goal = document; });
    f.host.issues.documents = { get: async () => goal, upsert };
    const assign = f.host.issues.update;
    let assignments = 0;
    const update = t.mock.method(f.host.issues, 'update', async (...args) => {
      assert.ok(goal);
      if (++assignments === 1) {
        if (applied) await assign(...args);
        throw new Error('assignment response lost');
      }
      await assign(...args);
    });
    const get = t.mock.method(f.host.issues, 'get'), create = t.mock.method(f.host.issues, 'create');
    const config = { roleBindings: { 'pack:maker': 'agent' } };
    const [pending] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, config);
    assert.deepEqual(pending, { nodeId: 'make', phase: 'work', status: 'assignment_pending',
      issueId: 'child-1', agentId: 'agent', lifecycle: pendingWorkLifecycle });
    assert.equal(f.row.issue_id, 'child-1');
    assert.equal(f.row.state, 'issued');
    assert.equal(warnings[0][0], 'Paperclip issue assignment deferred');
    assert.equal(warnings[0][1].error, 'assignment response lost');
    const [recovered] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, config);
    assert.equal(recovered.status, 'issued');
    assert.equal(update.mock.callCount(), applied ? 1 : 2);
    assert.equal(create.mock.callCount(), 1);
    assert.deepEqual(get.mock.calls.map(call => call.arguments), [
      ['root', 'company'], ...Array.from({ length: applied ? 2 : 3 }, () => ['child-1', 'company']),
    ]);
    assert.equal(upsert.mock.callCount(), 1);
  });
});

test('a stale attempt is never assigned after GOAL.md, including assignment recovery', async (t) => {
  for (const recovery of [false, true]) await t.test(`recovery=${recovery}`, async (t) => {
    const f = await fixture({ noCallback: true });
    const config = { roleBindings: { 'pack:maker': 'agent' } };
    const update = t.mock.method(f.host.issues, 'update', async () => { throw new Error('assignment unavailable'); });
    if (recovery) {
      assert.equal((await f.dispatch.dispatchReady('company', f.engine, f.run.id, config))[0].status, 'assignment_pending');
    }
    f.host.issues.documents = { get: async () => null, upsert: async () => {
      await f.engine.pauseRun({ runId: f.run.id,
        actor: { id: 'owner', kind: 'human', roles: ['human-owner'] }, reason: 'Paused before assignment' });
    } };
    const [action] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, config);
    assert.deepEqual(action, { nodeId: 'make', phase: 'work', status: 'stale_attempt', issueId: 'child-1', agentId: 'agent' });
    assert.equal(update.mock.callCount(), recovery ? 1 : 0);
    assert.equal(f.row.issue_id, 'child-1');
    assert.equal(f.checkoutCalls, 0);
  });
});

test('origin recovery attaches and assigns an unassigned own issue after reconciliation and GOAL.md', async (t) => {
  for (const assignee of [{}, { assigneeAgentId: null }, { assignee_agent_id: null }]) {
    await t.test(JSON.stringify(assignee), async (t) => {
      const events = [];
      const f = await fixture({ list: async ({ companyId, originKind, originId }) => [
        { id: 'child-1', companyId, originKind, originId, parentId: 'root', projectId: null, ...assignee },
      ], create: async () => assert.fail('Origin recovery must not create another issue'),
      persistence: { reconcileEffect: async (...args) => {
        assert.deepEqual(args, ['company', `issue-create:${f.run.id}:make:1:work`, { issueId: 'child-1' }]);
        events.push('reconciled');
      } } });
      f.host.issues.documents = { get: async () => null, upsert: async () => {
        assert.equal(f.row.issue_id, 'child-1'); events.push('goal');
      } };
      const assign = f.host.issues.update;
      t.mock.method(f.host.issues, 'update', async (...args) => { events.push('assigned'); await assign(...args); });
      const [action] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
      assert.equal(action.status, 'woken');
      assert.deepEqual(events, ['reconciled', 'goal', 'assigned']);
    });
  }
});

test('retry reconciles an unassigned retired origin without attaching or assigning it', async (t) => {
  for (const assignee of [{}, { assigneeAgentId: null }, { assignee_agent_id: null }]) {
    await t.test(JSON.stringify(assignee), async (t) => {
      const { effects, persistence } = effectPersistence();
      const f = await fixture({ persistence: { ...persistence,
        reconcileEffect: async (companyId, operationId, result) => persistence.confirmEffect(companyId, operationId, 'confirmed_success', result),
      }, list: async ({ companyId, originKind, originId }) => [
        { id: 'child-1', companyId, originKind, originId, parentId: 'root', projectId: null, ...assignee },
      ] });
      await f.persistence.claim('company', f.run.id, 'make', 1, 'work', 'agent');
      const operationId = `issue-create:${f.run.id}:make:1:work`;
      effects.set(operationId, { outcome: 'unknown', request: {}, created_at: '2000-01-01T00:00:00.000Z' });
      await f.engine.retryNode({ runId: f.run.id, nodeId: 'make', reason: 'Retire prior attempt',
        actor: { id: 'owner', kind: 'human', roles: ['human-owner'] } });
      const update = t.mock.method(f.host.issues, 'update');
      await f.dispatch.assertRetrySafe('company', f.engine, f.run.id, 'make');
      assert.equal(effects.get(operationId).outcome, 'confirmed_success');
      assert.deepEqual(effects.get(operationId).result, { issueId: 'child-1' });
      assert.equal(f.row.issue_id, null);
      assert.equal(update.mock.callCount(), 0);
    });
  }
});

test('human-owned origin matches remain unresolved and cannot be attached, assigned, or retired as success', async (t) => {
  for (const userField of ['assigneeUserId', 'assignee_user_id']) await t.test(userField, async (t) => {
    const { effects, persistence } = effectPersistence();
    const f = await fixture({ noCallback: true, persistence: { ...persistence,
      reconcileEffect: async () => assert.fail('Human ownership must not be reconciled as assignment evidence'),
    }, list: async ({ companyId, originKind, originId }) => [{ id: 'child-1', companyId, originKind, originId,
      parentId: 'root', projectId: null, assigneeAgentId: null, [userField]: 'human-owner' }] });
    const operationId = `issue-create:${f.run.id}:make:1:work`;
    effects.set(operationId, { outcome: 'unknown', request: {}, created_at: '2000-01-01T00:00:00.000Z' });
    const update = t.mock.method(f.host.issues, 'update'), create = t.mock.method(f.host.issues, 'create');
    const [action] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
    assert.equal(action.status, 'ownership_conflict');
    assert.equal(action.issueId, 'child-1'); assert.equal(action.assigneeUserId, 'human-owner');
    assert.equal(f.row.issue_id, null);
    await assert.rejects(f.dispatch.retryNode('company', f.engine, { runId: f.run.id, nodeId: 'make',
      actor: { id: 'owner', kind: 'human', roles: ['human-owner'] }, reason: 'Recover' }), /human.*ownership.*Paperclip/i);
    assert.equal(effects.get(operationId).outcome, 'unknown');
    assert.equal((await f.engine.getRun(f.run.id)).nodeStates.make.attempts.length, 0);
    assert.equal(update.mock.callCount(), 0); assert.equal(create.mock.callCount(), 0);
  });
});

test('human ownership on attached issues blocks recovery and retry receipt reconciliation', async (t) => {
  for (const userField of ['assigneeUserId', 'assignee_user_id']) await t.test(userField, async (t) => {
    const { effects, persistence } = effectPersistence();
    const f = await fixture({ noCallback: true, persistence: { ...persistence,
      confirmEffect: async () => { throw new Error('database unavailable'); },
      reconcileEffect: async () => assert.fail('Human-owned attached issues must not be reconciled as success'),
    } });
    const config = { roleBindings: { 'pack:maker': 'agent' } };
    await f.dispatch.dispatchReady('company', f.engine, f.run.id, config);
    t.mock.method(f.host.issues, 'get', async id => ({ id, assigneeAgentId: null, [userField]: 'human-owner' }));
    const update = t.mock.method(f.host.issues, 'update');
    const [action] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, config);
    assert.equal(action.status, 'ownership_conflict');
    assert.equal(action.issueId, 'child-1'); assert.equal(action.assigneeUserId, 'human-owner');
    await assert.rejects(f.dispatch.assertRetrySafe('company', f.engine, f.run.id, 'make'), /human.*ownership.*Paperclip/i);
    assert.equal(effects.get(`issue-create:${f.run.id}:make:1:work`).outcome, 'unknown');
    assert.equal(update.mock.callCount(), 0);
  });
});

test('a human-owned creation receipt never confirms creation or triggers assignment', async (t) => {
  for (const userField of ['assigneeUserId', 'assignee_user_id']) await t.test(userField, async (t) => {
    const { effects, persistence } = effectPersistence();
    const f = await fixture({ noCallback: true, persistence,
      create: async () => ({ id: 'child-1', assigneeAgentId: null, [userField]: 'human-owner' }) });
    const update = t.mock.method(f.host.issues, 'update');
    const [action] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
    assert.equal(action.status, 'ownership_conflict');
    assert.equal(effects.get(`issue-create:${f.run.id}:make:1:work`).outcome, 'unknown');
    assert.equal(f.row.issue_id, null); assert.equal(update.mock.callCount(), 0);
  });
});

test('recovering a confirmed creation receipt rechecks human ownership before attachment', async (t) => {
  for (const userField of ['assigneeUserId', 'assignee_user_id']) await t.test(userField, async (t) => {
    const f = await fixture({ noCallback: true,
      getIssue: async id => ({ id, assigneeAgentId: null, ...(id === 'child-1' ? { [userField]: 'human-owner' } : {}) }),
      persistence: { beginEffect: async () => ({ owner: false, outcome: 'confirmed_success', result: { issueId: 'child-1' } }) },
    });
    const update = t.mock.method(f.host.issues, 'update'), create = t.mock.method(f.host.issues, 'create');
    const [action] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
    assert.equal(action.status, 'ownership_conflict');
    assert.equal(action.assigneeUserId, 'human-owner');
    assert.equal(f.row.issue_id, null);
    assert.equal(update.mock.callCount(), 0); assert.equal(create.mock.callCount(), 0);
  });
});

test('the creation ledger rejects a reused operation ID with a different intended agent', async () => {
  let recorded;
  const db = { namespace: 'plugin_test', execute: async (_sql, args) => {
    if (recorded) return { rowCount: 0 };
    recorded = { companyId: args[0], operationId: args[1], request: JSON.parse(args[2]), outcome: 'unknown' };
    return { rowCount: 1 };
  }, query: async () => [recorded] };
  const f = await fixture({ reclaim: true, create: async () => { throw new Error('create response lost'); },
    persistence: { beginEffect: (...args) => beginEffect(db, ...args) } });
  const config = { roleBindings: { 'pack:maker': 'agent' } };
  assert.equal((await f.dispatch.dispatchReady('company', f.engine, f.run.id, config))[0].status, 'effect_unknown');
  assert.equal(recorded.request.intendedAssigneeAgentId, 'agent');
  assert.equal(Object.hasOwn(recorded.request, 'assigneeAgentId'), false);
  assert.equal((await beginEffect(db, recorded.companyId, recorded.operationId, recorded.request)).owner, false);
  await assert.rejects(beginEffect(db, recorded.companyId, recorded.operationId,
    { ...recorded.request, intendedAssigneeAgentId: 'other-agent' }),
    /External effect operation ID reused with a different request/);
  assert.equal(recorded.request.intendedAssigneeAgentId, 'agent');
});

test('historical unresolved issue creates remain fenced across instruction upgrades', async (t) => {
  // Captured from the pre-upgrade and initial Runner dispatchers. Only the generated run ID varies.
  const receipts = JSON.parse(await readFile(new URL('./fixtures/issue-create-receipts.json', import.meta.url), 'utf8'));
  for (const [kind, captured] of Object.entries(receipts.beforeUpgrade)) {
    for (const runner of [false, true]) await t.test(`${kind} task, Runner guidance=${runner}`, async () => {
      let recorded;
      let creates = 0;
      const db = { namespace: 'plugin_test', execute: async () => ({ rowCount: 0 }), query: async () => [recorded] };
      const f = await fixture({ reclaim: true, node: kind === 'traced' ? { decisionTraceRequired: true } : {},
        create: async () => { creates++; throw new Error('Unexpected issue creation'); },
        persistence: { beginEffect: (...args) => beginEffect(db, ...args) } });
      const request = JSON.parse(JSON.stringify(captured).replaceAll('{runId}', f.run.id));
      if (runner) request.description += receipts.runnerSuffix;
      recorded = { outcome: 'unknown', request: JSON.stringify(request) };
      const config = { roleBindings: { 'pack:maker': 'agent' } };
      const dispatch = () => f.dispatch.dispatchReady('company', f.engine, f.run.id, config);
      const [recovered] = await dispatch();
      assert.equal(recovered.status, 'effect_unknown');
      assert.equal(f.row.issue_id, null);

      for (const mismatch of [{ intendedAssigneeAgentId: 'different-agent' }, { description: request.description + 'changed' }]) {
        recorded.request = JSON.stringify({ ...request, ...mismatch });
        await assert.rejects(dispatch(), /External effect operation ID reused with a different request/);
      }
      assert.equal(creates, 0);
    });
  }
});

const reviewedContract = {
  node: { review: { supervisorRole: 'maker' }, outputContract: 'architecture-baseline', purpose: 'Check the data flow.' },
  input: { system_id: 'orders' },
  roleDocuments: { role: 'Inspect pinned evidence.', goal: 'Maintain independent disposition.', instruction: 'Long unrelated role guide.' },
  evidenceInstructions: 'Producer architecture submission contract.',
};
const architectureOutput = { systemId: 'orders', summary: 'Orders API', diagram: 'API to store', implementationStatus: 'proposed',
  invariants: [{ id: 'INV-1', rule: 'Only the API writes', enforcement: 'Scoped writers', proof: 'ACL inspection', status: 'active' }] };
const architectureArtifacts = [{ id: 'candidate', kind: 'architecture_baseline', version: '2' }, { id: 'note', kind: 'notes', version: '2' }];

test('citation supervisor can read the original evidence on its own child and recover the same pinned document', async () => {
  const source = { id: 'report-123', version: 'v2', kind: 'finding' };
  const rule = { reportKind: 'brief', sources: [{ nodeId: 'research', kind: 'finding' }] };
  let description;
  const f = await fixture({ noCallback: true, decisionRules: [{ type: 'review', mode: 'manual' }],
    graph: { start: 'research', nodes: [
      { id: 'research', type: 'task', role: 'maker', produces: ['finding'], review: { supervisorRole: 'maker' } },
      { id: 'make', type: 'task', role: 'maker', produces: ['brief'], review: { supervisorRole: 'maker', requiredSourceRefs: rule } },
    ], edges: [{ from: 'research', to: 'make' }] },
    create: async request => { description = request.description; return { id: 'review-issue' }; },
  });
  const docs = new Map();
  f.host.issues.documents = { get: async (issueId, key) => docs.get(issueId + '/' + key),
    upsert: async doc => { docs.set(doc.issueId + '/' + doc.key, doc); } };
  const actor = { id: 'author', kind: 'agent', roles: ['maker'], executionId: 'author-run' };
  const findings = { details: { raw: { observations: [{ sourceText: 'Observed at the original review' }] } } };
  for (const [nodeId, artifact, output] of [['research', source, { finding: findings }],
    ['make', { id: 'brief-1', kind: 'brief', version: 'v2' }, { brief: { researchRefs: [source] } }]]) {
    const scope = { runId: f.run.id, nodeId };
    await f.engine.submitNode({ ...scope, actor, artifacts: [artifact], output });
    await f.engine.recordSelfReview({ ...scope, actor, artifactVersion: 'v2', fixes: ['Private author assessment'] });
    if (nodeId === 'research') await f.engine.reviewWork({ ...scope, actor: { ...actor, id: 'pm', executionId: 'pm-run' },
      outcome: 'accept', reason: 'Inspected the source' });
  }
  const dispatch = () => f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
  await dispatch();
  assert.match(description, /research-citations/);
  assert.match(description, /"submitted":\[\{"kind":"finding","id":"report-123","version":"v2"\}\]/);
  const key = 'review-issue/research-citations', original = docs.get(key).body;
  const doc = JSON.parse(original);
  assert.deepEqual(doc.candidate.output.brief.researchRefs, [source]);
  assert.deepEqual(doc.acceptedSourceReports[0].artifacts[0].body, findings);
  assert.doesNotMatch(original, /Private author assessment|nested content omitted/);
  docs.delete(key);
  await dispatch();
  assert.equal(docs.get(key).body, original);
  docs.delete(key);
  f.host.issues.documents.upsert = async doc => {
    assert.equal(doc.key, 'research-citations');
    assert.equal(doc.baseRevisionId, undefined);
    docs.set(key, { body: original, latestRevisionId: 'concurrent-revision' });
    throw new Error(missingBaseRevision);
  };
  await dispatch();
  assert.equal(docs.get(key).latestRevisionId, 'concurrent-revision');
  docs.set(key, { body: 'Different document' });
  await assert.rejects(dispatch(), /differs from the pinned review attempt/);
});

test('supervisor issue starts with complete review arguments and focuses on independent evidence', async () => {
  let issue, effect;
  const requiredEvidence = ['artifact_version', 'review_findings', 'self_review_history'];
  const f = await fixture({ ...reviewedContract, noCallback: true,
    decisionRules: [{ type: 'review', mode: 'manual', requiredEvidence }],
    persistence: { beginEffect: async (companyId, operationId, request, previous) => {
      effect = { companyId, operationId, request, previous };
      return { owner: true };
    } },
    create: async request => { issue = request; return { id: 'review-issue' }; } });
  const actor = { id: 'author', kind: 'agent', roles: ['maker'], executionId: 'author-run' };
  const action = { runId: f.run.id, nodeId: 'make' };
  await f.engine.submitNode({ ...action, actor, artifacts: architectureArtifacts, output: architectureOutput });
  await f.engine.recordSelfReview({ ...action, actor, artifactVersion: '2',
    findings: [{ severity: 'P2', detail: 'private author finding' }],
    fixes: ['private author fix'], evidence: [{ kind: 'private author evidence' }] });

  const [result] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
  assert.equal(result.issueId, 'review-issue');
  const [templateMatch, templateJson] = issue.description.match(/```json\n([\s\S]*?)\n```/);
  const reviewOnly = 'Use `review` as your only Graph write for this assigned supervisor phase. Record the disposition, findings and reason in that same call. Read the packet here or via the scoped GET.';
  assert.equal(issue.description.split('\n\n')[1], reviewOnly);
  assert.ok(issue.description.indexOf(templateMatch) < 950);
  const template = JSON.parse(templateJson);
  const packet = JSON.parse(issue.description.split('## Pinned node contract and work context\n\n')[1].split('\n\n')[0]);
  assert.deepEqual(packet.requiredEvidence, requiredEvidence);
  assert.deepEqual(packet.candidateRefs, [{ artifactId: 'candidate', version: '2' }, { artifactId: 'note', version: '2' }]);
  assert.deepEqual(packet.selfReviewRef, { ...action, attempt: 1, round: 1 });
  assert.equal(template.operation, 'review');
  assert.equal(template.issueId, '<activeTask.id>');
  assert.equal(template.runId, action.runId);
  assert.equal(template.nodeId, action.nodeId);
  assert.equal(template.outcome, 'rework');
  assert.match(template.reason, /Replace with/);
  assert.deepEqual(template.evidence.map(item => item.kind), requiredEvidence);
  for (const item of template.evidence) {
    assert.match(item.summary, /Replace with/);
    assert.deepEqual(item.subjectRefs, packet.candidateRefs);
    assert.deepEqual(item.selfReviewRef, item.kind === 'self_review_history' ? packet.selfReviewRef : undefined);
  }
  assert.match(issue.description, /Choose `accept`[\s\S]*Choose `rework`[\s\S]*`activeTask.id`[\s\S]*POST \/api\/plugins\/tools\/execute/);
  assert.match(issue.description, /Check the data flow\.[\s\S]*Inspect pinned evidence\.[\s\S]*Maintain independent disposition\./);
  assert.doesNotMatch(issue.description, /private author|author-run|"selfReviews"|Producer architecture submission contract|Submit structured output|Long unrelated role guide/);
  assert.equal(issue.inheritExecutionWorkspaceFromIssueId, 'root');
  const preceding = { ...effect.request, description: issue.description.replace(`\n\n${reviewOnly}\n\n`, '\n\n') };
  assert.equal(effect.previous.filter(item => item.description === preceding.description).length, 1);
  const db = { namespace: 'plugin_test', execute: async () => ({ rowCount: 0 }),
    query: async () => [{ outcome: 'unknown', request: JSON.stringify(preceding) }] };
  assert.equal((await beginEffect(db, effect.companyId, effect.operationId, effect.request, effect.previous)).owner, false);
  const accepted = await f.engine.reviewWork({ ...template, issueId: result.issueId, outcome: 'accept',
    actor: { id: 'agent', kind: 'agent', roles: ['maker'], executionId: 'review-run' }, reason: 'ACL inspection confirms the declared writer.',
    evidence: template.evidence.map(item => ({ ...item, summary: 'Inspected the pinned architecture and occurrence reference.' })),
  });
  assert.equal(accepted.decision.outcome, 'accept');
  assert.equal(accepted.node.status, 'completed');
});

test('released supervisor issue receipts remain fenced with and without Runner instructions', async (t) => {
  const { runnerSuffix } = JSON.parse(await readFile(new URL('./fixtures/issue-create-receipts.json', import.meta.url), 'utf8'));
  for (const preceding of [false, true]) for (const runner of [false, true]) await t.test(`Evidence checklist=${preceding}, Runner instructions=${runner}`, async () => {
    let recorded;
    let issueCreates = 0;
    const db = { namespace: 'plugin_test', execute: async () => ({ rowCount: 0 }), query: async () => [recorded] };
    const f = await fixture({ ...reviewedContract, reclaim: true, noCallback: true,
      getIssue: async id => ({ id, projectId: 'project' }),
      decisionRules: [{ type: 'review', mode: 'manual', requiredEvidence: ['artifact_version'] }],
      create: async () => { issueCreates++; throw new Error('Unexpected creation'); },
      persistence: { beginEffect: (...args) => beginEffect(db, ...args) } });
    const runId = f.run.id;
    const action = { runId, nodeId: 'make', actor: { id: 'author', kind: 'agent', roles: ['maker'], executionId: 'writer' } };
    await f.engine.submitNode({ ...action, artifacts: architectureArtifacts, output: architectureOutput });
    await f.engine.recordSelfReview({ ...action, artifactVersion: '2' });
    const packet = { schemaVersion: 1, runId, graphId: 'graph', graphVersion: '1', packId: 'pack', packVersion: '1',
      reviewNodeId: 'make', phase: 'supervisor', freshContextRequired: false,
      requirementsAndConstraints: { paperclipIssueId: 'root', paperclipCompanyId: 'company', system_id: 'orders' },
      candidates: [{ nodeId: 'make', status: 'awaiting_supervisor_review', artifacts: architectureArtifacts, output: architectureOutput, evidence: [] }],
      sourceArtifacts: [],
      note: 'Read candidate artifacts and cited source evidence directly. Record findings with severity and location. Author self-review is available after the independent disposition.',
      ...(preceding && { requiredEvidence: ['artifact_version'], candidateRefs: [{ artifactId: 'candidate', version: '2' }, { artifactId: 'note', version: '2' }],
        selfReviewRef: { runId, nodeId: 'make', attempt: 1, round: 1 } }) };
    const description = [
      `PolyForge Graph run ${runId}, node make, attempt 1.`, 'Graph version 1; Pack pack@1.',
      'Use the plugin:graph-command tool. Pass this Paperclip issue ID, Graph run ID and node ID.',
      `Read the scoped Graph API for current status and full pinned context: GET /api/plugins/plugin/api/issues/<this-issue-id>/graph?runId=${runId}. Submit results through the Graph command with the host-provided Paperclip run identity.`,
      preceding
        ? 'Independently inspect the submitted artifacts and evidence, then call review with outcome accept or rework. Include evidence for each kind in requiredEvidence and copy candidateRefs into each item’s subjectRefs. Cite actual review observations and sources. If the rule asks for self-review history, copy the occurrence reference into that evidence item’s selfReviewRef.'
        : 'Independently inspect the submitted artifact and evidence, then call review with outcome accept or rework. Do not approve your own execution.',
      'Root Paperclip issue: root.', `## Pinned node contract and work context\n\n${JSON.stringify(packet, null, 2)}`,
      'Submit structured output matching the pinned output contract. Contract artifacts and output are immutable per attempt; correct them through supervisor rework and a new artifact version. Missing checks stay unverified; only authenticated humans can record acceptance exceptions.',
      'Producer architecture submission contract.',
      '## role.md\n\nInspect pinned evidence.\n\n## goal.md\n\nMaintain independent disposition.\n\n## instruction.md\n\nLong unrelated role guide.',
    ].join('\n\n') + (runner ? runnerSuffix : '');
    const request = { companyId: 'company', originKind: 'plugin:plugin:node', originId: `${runId}:make:1:supervisor`,
      parentId: 'root', projectId: 'project', inheritExecutionWorkspaceFromIssueId: 'root', title: 'graph · make review',
      description, status: 'todo', priority: 'medium', intendedAssigneeAgentId: 'agent' };
    recorded = { outcome: 'unknown', request: JSON.stringify(request) };
    const dispatch = () => f.dispatch.dispatchReady('company', f.engine, runId, { roleBindings: { 'pack:maker': 'agent' } });
    assert.equal((await dispatch())[0].status, 'effect_unknown');
    recorded.request = JSON.stringify({ ...request, description: description + ' altered' });
    await assert.rejects(dispatch(), /External effect operation ID reused with a different request/);
    assert.equal(issueCreates, 0);
  });
});

test('worker compensates only its new tombstones when retry does not advance', async (t) => {
  for (const failure of ['null', 'throw']) for (const preexisting of [false, true]) {
    await t.test(`${failure}, preexisting=${preexisting}`, async (t) => {
      const { effects, persistence } = effectPersistence();
      const f = await fixture({ noCallback: true, persistence });
      const actor = { id: 'owner', kind: 'human', roles: ['human-owner'] };
      const oldId = `issue-create:${f.run.id}:make:1:work`;
      if (preexisting) {
        await f.engine.retryNode({ runId: f.run.id, nodeId: 'make', actor, reason: 'Earlier retry' });
        await persistence.retireEffect('company', oldId);
      }
      const currentId = `issue-create:${f.run.id}:make:${preexisting ? 2 : 1}:work`;
      const before = await f.engine.getRun(f.run.id);
      // Exercise the real worker entry point with the same durable Core and
      // effect records as the standalone dispatch fixture.
      const db = workerDatabase(f, { effects, persistence });
      await plugin.definition.setup({ ...f.host, manifest: { ...manifest, id: 'plugin' }, db,
        logger: { warn() {}, info() {} },
        access: { members: { list: async () => [{ principalType: 'user', principalId: 'owner', status: 'active', membershipRole: 'owner' }] } },
        events: { on() {} }, jobs: { register() {} }, actions: { register() {} }, tools: { register() {} } });
      let retries = 0;
      const retryMock = t.mock.method(GraphEngine.prototype, 'retryNode', async function (args) {
        retries++;
        assert.equal(typeof args.expectedRunDigest, 'string');
        assert.equal(effects.get(currentId).outcome, 'confirmed_failure');
        if (failure === 'throw') throw new Error('Run changed since validation');
        return { run: await this.getRun(args.runId), nextAttempt: null };
      });
      // Keep the worker's post-command dispatch quiet; test the pending send
      // separately after the mock is restored.
      const workMock = t.mock.method(GraphEngine.prototype, 'getWorkItems', async () => []);
      const response = await plugin.definition.onApiRequest({ routeKey: 'graph-command', companyId: 'company',
        params: { issueId: 'root' }, actor: { actorType: 'user', userId: 'owner' },
        body: { operation: 'retry-node', runId: f.run.id, nodeId: 'make', reason: 'Recover', idempotencyKey: 'no-advance' } });
      assert.equal(retries, 1, JSON.stringify(response.body));
      if (failure === 'throw') assert.match(response.body.error, /Run changed since validation/);
      else { assert.equal(response.body.error, undefined); assert.equal(response.body.result.nextAttempt, null); }
      assert.equal(effects.has(currentId), false);
      if (preexisting) assert.equal(effects.get(oldId).outcome, 'confirmed_failure');
      assert.deepEqual((await f.engine.getRun(f.run.id)).nodeStates.make, before.nodeStates.make);
      retryMock.mock.restore(); workMock.mock.restore();
      const [action] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
      assert.equal(action.issueId, 'child-1');
      assert.equal(effects.get(currentId).outcome, 'confirmed_success');
      if (preexisting) assert.equal(effects.get(oldId).outcome, 'confirmed_failure');
    });
  }
});

test('worker preserves retry authorization status when compensation also fails', async (t) => {
  const { effects, persistence } = effectPersistence();
  const f = await fixture({ noCallback: true, persistence });
  const failure = new AuthorizationError('Retry denied'), rollbackError = new Error('database unavailable');
  const errors = [];
  let cancellations = 0;
  const db = workerDatabase(f, { effects, persistence }, {
    onEffectDelete: () => { cancellations++; throw rollbackError; },
  });
  await plugin.definition.setup({ ...f.host, manifest: { ...manifest, id: 'plugin' }, db,
    logger: { warn() {}, info() {}, error: (...args) => errors.push(args) },
    access: { members: { list: async () => [{ principalType: 'user', principalId: 'owner', status: 'active', membershipRole: 'owner' }] } },
    events: { on() {} }, jobs: { register() {} }, actions: { register() {} }, tools: { register() {} } });
  const retryMock = t.mock.method(GraphEngine.prototype, 'retryNode', async () => { throw failure; });
  const response = await plugin.definition.onApiRequest({ routeKey: 'graph-command', companyId: 'company',
    params: { issueId: 'root' }, actor: { actorType: 'user', userId: 'owner' },
    body: { operation: 'retry-node', runId: f.run.id, nodeId: 'make', reason: 'Recover' } });
  assert.equal(retryMock.mock.callCount(), 1, JSON.stringify(response.body));
  assert.equal(cancellations, 1);
  assert.equal(response.status, 403);
  assert.deepEqual(response.body, { error: failure.message });
  assert.equal(effects.size, 1);
  assert.deepEqual(errors, [['Retry effect rollback failed; leftover tombstones need operator review', {
    operationIds: [`issue-create:${f.run.id}:make:1:work`], error: rollbackError.message,
  }]]);
});

test('retry shares one parent across origin lookups and compensates a partially failed guard', async (t) => {
  for (const lookup of ['absent', 'ambiguous', 'throw']) await t.test(lookup, async () => {
    const { effects, persistence } = effectPersistence();
    let parentGets = 0, f;
    f = await fixture({ noCallback: true, persistence: { ...persistence,
      readState: async () => {
        const snapshot = await f.engine.store.read(), run = snapshot.runs[f.run.id];
        run.graph.nodes[0].review = { supervisorRole: 'reviewer' };
        run.nodeStates.make.attempts = [{}];
        return snapshot;
      } },
      getIssue: async (id) => { parentGets++; return { id, companyId: 'company' }; },
      list: async () => {
        if (lookup === 'throw') throw new Error('origin lookup unavailable');
        return lookup === 'ambiguous' ? [{ id: 'one' }, { id: 'two' }] : [];
      } });
    const id = (attempt, phase) => `issue-create:${f.run.id}:make:${attempt}:${phase}`;
    for (const operationId of [id(1, 'supervisor'), id(2, 'work')]) {
      effects.set(operationId, { outcome: 'unknown', request: {}, created_at: '2000-01-01T00:00:00.000Z' });
    }
    if (lookup === 'absent') {
      const guard = await f.dispatch.assertRetrySafe('company', f.engine, f.run.id, 'make');
      assert.deepEqual(guard.retiredOperations.filter(item => item.inserted).map(item => item.operationId), [id(1, 'work')]);
      for (const operationId of [id(1, 'supervisor'), id(2, 'work')]) {
        assert.deepEqual(effects.get(operationId).result, { settledBy: 'owner-retry', lookup: 'absent' });
      }
    } else {
      await assert.rejects(f.dispatch.assertRetrySafe('company', f.engine, f.run.id, 'make'),
        lookup === 'throw' ? /origin lookup unavailable/ : /unresolved.*ambiguous/);
      assert.deepEqual(effects.get(id(1, 'work')).result, { cancelled_before_send: true });
      assert.equal(effects.get(id(1, 'supervisor')).outcome, 'unknown');
    }
    assert.equal(parentGets, 1);
    assert.equal(effects.has(id(2, 'supervisor')), false);
  });
});

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


test('unknown assigned issue creation is reconciled after the host returns exact evidence', async () => {
  let attempts = 0, record, visible = false, reconciled = 0;
  const persistence = {
    beginEffect: async (_company, operationId, request) => {
      if (!record) { record = { operationId, request: structuredClone(request), outcome: 'unknown' }; return { owner: true }; }
      assert.equal(operationId, record.operationId);
      assert.deepEqual(request, record.request);
      return { owner: false, outcome: record.outcome, result: record.result };
    },
    reconcileEffect: async (companyId, operationId, result) => {
      assert.equal(companyId, 'company');
      assert.equal(operationId, record.operationId);
      assert.deepEqual(result, { issueId: 'child-1' });
      record.outcome = 'confirmed_success'; record.result = result; reconciled++;
    },
  };
  const f = await fixture({ reclaim: true, persistence,
    getIssue: async (id) => ({ id, company_id: 'company', project_id: 'project' }),
    list: async ({ companyId, originKind, originId }) => visible ? [{ id: 'child-1', company_id: companyId,
      origin_kind: originKind, origin_id: originId, assignee_agent_id: 'agent', parent_id: 'root', project_id: 'project' }] : [],
    create: async (request) => {
      assert.equal(request.projectId, 'project');
      attempts++;
      throw new Error('connection lost');
    } });
  const config = { roleBindings: { 'pack:maker': 'agent' } };
  assert.equal((await f.dispatch.dispatchReady('company', f.engine, f.run.id, config))[0].status, 'effect_unknown');
  assert.equal((await f.dispatch.dispatchReady('company', f.engine, f.run.id, config))[0].status, 'effect_unknown');
  assert.equal(reconciled, 0);
  visible = true;
  const [action] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, config);
  assert.equal(action.status, 'woken');
  assert.equal(action.issueId, 'child-1');
  assert.equal(attempts, 1);
  assert.equal(reconciled, 1);
  assert.equal(f.wakeupCalls, 0);
});

test('an applied native decision replays safely while its child issue receipt is lost and recovered', async (t) => {
  const { effects, persistence } = effectPersistence();
  const { assignments, persistence: assignment } = assignmentPersistence();
  const owner = { id: 'owner', kind: 'human', roles: ['human-owner'] };
  const config = { roleBindings: { 'pack:maker': 'agent' } };
  let child, originResults = [];
  const f = await fixture({ noCallback: true, reclaim: true,
    persistence: { ...persistence, ...assignment, reconcileEffect: (companyId, operationId, result) =>
      persistence.confirmEffect(companyId, operationId, 'confirmed_success', result) },
    graph: { start: 'gate', nodes: [{ id: 'gate', type: 'decision', outcomes: ['go'] },
      { id: 'make', type: 'task', role: 'maker' }], edges: [{ from: 'gate', to: 'make', when: 'go' }] },
    decisionRules: [{ type: 'gate', mode: 'manual', allowedKinds: ['human'] }],
    list: async () => originResults,
    getIssue: async (id) => id === 'root' ? { id, companyId: 'company', projectId: 'project' } : child,
    create: async ({ companyId, originKind, originId, parentId, projectId }) => {
      assert.equal(child, undefined, 'the host must never receive a second create');
      child = { id: 'child-1', companyId, originKind, originId, parentId, projectId, assigneeAgentId: null };
      throw new Error('Host persisted the child but its reply was lost');
    } });
  const createCall = t.mock.method(f.host.issues, 'create');
  const assign = f.host.issues.update;
  const assignmentCall = t.mock.method(f.host.issues, 'update', async (id, patch, companyId) => {
    await assign(id, patch, companyId);
    Object.assign(child, patch);
  });
  const escalation = await f.engine.escalateNode({ runId: f.run.id, nodeId: 'gate', actor: owner, reason: 'Owner needed' });
  const paused = await f.engine.getRun(f.run.id);
  const cards = [], actions = [];
  f.host.issues.listInteractions = async () => cards;
  f.host.issues.askUserQuestions = async (_issue, spec) => {
    const card = { ...spec, id: 'card-1', status: 'resolved', resolvedByUserId: owner.id,
      result: { answers: [{ questionId: 'choice', optionIds: ['go'] }, { questionId: 'reason', otherText: 'Proceed' }] } };
    cards.push(card);
    return card;
  };
  const sync = (dispatch, run = paused) => syncGraphDecision({ host: f.host, companyId: 'company', run, engine: f.engine,
    config, control: { getSetup: async () => ({ organization: { board: { id: owner.id } } }) },
    trustedActor: async () => ({ actor: owner }),
    dispatchReady: async (...args) => { actions.push(...await dispatch.dispatchReady(...args)); } });

  const [recorded] = await sync(f.dispatch);
  assert.equal(recorded.syncError, null);
  const operationId = `issue-create:${f.run.id}:make:1:work`;
  assert.equal(effects.get(operationId).outcome, 'unknown');
  assert.equal(f.row.issue_id, null);
  const resumed = await f.engine.getRun(f.run.id);
  assert.equal(resumed.status, 'running');
  const legacy = { ...resumed, deliveryKey: undefined };
  const replacement = createDispatch(f.host, async () => ({ engine: f.engine }), async () => config, f.persistence);
  assert.deepEqual(await replacement.currentDispatches('company', legacy), []);
  const [admission] = await replacement.currentDispatches('company', resumed);
  assert.equal(admission.receiptStatus, undefined);
  const [unresolved] = await replacement.currentDispatches('company', legacy, { includeReceipts: true });
  assert.equal(unresolved.issueId, null);
  assert.equal(unresolved.receiptStatus, 'effect_unknown');
  assert.deepEqual(await sync(replacement), [recorded]);
  originResults = [{ ...child, parentId: 'other-issue' }];
  assert.deepEqual(await sync(replacement), [recorded]);
  assert.deepEqual(actions.map(({ status }) => status), ['effect_unknown', 'effect_unknown', 'effect_mismatched']);
  assert.ok(actions.every((action) => action.operationId === operationId));
  assert.equal(effects.get(operationId).outcome, 'unknown');
  assert.equal(f.row.issue_id, null);
  assert.equal(assignmentCall.mock.callCount(), 0);

  originResults = [child];
  assert.deepEqual(await sync(replacement), [recorded]);
  assert.deepEqual(await sync(replacement), [recorded]);
  assert.deepEqual(await sync(replacement, await f.engine.getRun(f.run.id)), []);
  assert.deepEqual(actions.slice(-2).map(({ status, issueId }) => ({ status, issueId })),
    [{ status: 'issued', issueId: child.id }, { status: 'issued', issueId: child.id }]);
  assert.equal(effects.get(operationId).outcome, 'confirmed_success');
  assert.deepEqual(effects.get(operationId).result, { issueId: child.id });
  const [resolved] = await replacement.currentDispatches('company', legacy, { includeReceipts: true });
  assert.equal(resolved.issueId, child.id);
  assert.equal(resolved.receiptStatus, undefined);
  assert.deepEqual([...assignments.values()].map(({ generation, outcome }) => ({ generation, outcome })),
    [{ generation: 1, outcome: 'confirmed_success' }]);
  assert.equal(createCall.mock.callCount(), 1);
  assert.equal(assignmentCall.mock.callCount(), 1);
  assert.equal(f.wakeupCalls, 0);
  assert.equal(cards.length, 1);
  const decisions = await f.engine.listDecisions({ runId: f.run.id });
  assert.deepEqual(decisions.filter((item) => item.supersedes === escalation.decision.id).map((item) => item.outcome), ['go']);
  assert.equal(decisions.filter((item) => item.type === 'paperclip_node_dispatch').length, 1);
});

test('a malformed or contradictory create receipt cannot confirm the send or trigger another creation', async () => {
  for (const receipt of [{ id: 42 }, { id: 'child-1', companyId: 'other' },
    { id: 'child-1', assignee_agent_id: 'other' }, { id: 'child-1', parentId: 'root', parent_id: 'other' }]) {
    let sends = 0;
    const f = await fixture({ reclaim: true, create: async () => { sends++; return receipt; }, persistence: {
      beginEffect: async () => ({ owner: sends === 0, outcome: 'unknown' }),
      confirmEffect: () => assert.fail('Contradictory receipt must not confirm creation'),
    } });
    const config = { roleBindings: { 'pack:maker': 'agent' } };
    for (let sync = 0; sync < 2; sync++) {
      const [result] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, config);
      assert.equal(result.status, 'effect_unknown');
    }
    assert.equal(sends, 1);
    assert.ok(!f.row.issue_id);
  }
});

test('dispatch status requires authenticated checkout proof for started', () => {
  assert.equal(normalizeDispatchState(null), 'requested');
  assert.equal(normalizeDispatchState({ state: 'claimed' }), 'admitted');
  assert.equal(normalizeDispatchState({ state: 'woken', issue_id: 'i', agent_run_id: 'r' }), 'dispatched');
  assert.equal(normalizeDispatchState({ issue_id: 'i', agent_run_id: 'r', checkout_verified_at: 'now' }), 'started');
});


test('dispatch and retry reject ambiguous and mismatched assigned issue evidence', async (t) => {
  const cases = {
    duplicate: (match) => [match, { ...match, id: 'second' }],
    missingId: (match) => [{ ...match, id: undefined }],
    wrongCompany: (match) => [{ ...match, companyId: 'other' }],
    wrongOriginKind: (match) => [{ ...match, originKind: 'other' }],
    wrongOriginId: (match) => [{ ...match, originId: 'other' }],
    wrongAgent: (match) => [{ ...match, assigneeAgentId: 'other' }],
    wrongParent: (match) => [{ ...match, parentId: 'other' }],
    wrongProject: (match) => [{ ...match, projectId: 'other' }],
  };
  for (const [kind, matches] of Object.entries(cases)) {
    await t.test(kind, async () => {
      const f = await fixture({
        list: async ({ companyId, originKind, originId }) => matches({ id: 'child-1', companyId, originKind,
          originId, assigneeAgentId: 'agent', parentId: 'root', projectId: null }),
        create: async () => assert.fail('Conflicting assignment evidence must block issue creation'),
        persistence: { getEffect: async () => ({ outcome: 'unknown' }),
          confirmEffect: async () => assert.fail('Conflicting assignment evidence must block owner settlement'),
          reconcileEffect: async () => assert.fail('Conflicting assignment evidence must block reconciliation') },
      });
      const [action] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
      assert.equal(action.status, kind === 'duplicate' ? 'effect_ambiguous' : 'effect_mismatched');
      assert.equal(action.operationId, `issue-create:${f.run.id}:make:1:work`);
      assert.equal(f.row.issue_id, null);
      await assert.rejects(f.dispatch.assertRetrySafe('company', f.engine, f.run.id, 'make'),
        kind === 'duplicate' ? /unresolved.*ambiguous/ : /unresolved.*mismatched/);
      assert.equal(f.wakeupCalls, 0);
    });
  }
});

test('dispatch rechecks eligibility after matched issue evidence loads its parent', async () => {
  const actor = { id: 'owner', kind: 'human', roles: ['human-owner'] };
  const f = await fixture({
    list: async ({ companyId, originKind, originId }) => [{ id: 'child-1', companyId, originKind,
      originId, assigneeAgentId: 'agent', parentId: 'root', projectId: null }],
    getIssue: async (id) => {
      await f.engine.pauseRun({ runId: f.run.id, actor, reason: 'Paused during origin verification' });
      return { id, projectId: null };
    },
    create: async () => assert.fail('Stale attempt must not create an issue'),
    persistence: { reconcileEffect: async () => assert.fail('Stale attempt must not reconcile an issue') },
  });
  const [action] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
  assert.equal(action.status, 'stale_attempt');
  assert.equal(f.row.issue_id, null);
});

test('PostgreSQL issue recovery preserves a checkout when a delayed sender attaches the same issue',
  { skip: !postgresShadowAvailable && 'Set POLYFORGE_RUN_POSTGRES_TESTS=1 to run against PostgreSQL' },
  async (t) => {
    const { db, sql, namespace, companyId } = await createPostgresShadowDatabase(t);
    await sql.unsafe(`CREATE TABLE ${namespace}.issues (id uuid PRIMARY KEY)`);
    await sql.unsafe(`CREATE TABLE ${namespace}.agents (id uuid PRIMARY KEY)`);
    for (const migration of ['001_graph_state.sql', '017_dispatch_effects.sql']) {
      const source = await readFile(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8');
      await sql.unsafe(source.replaceAll('plugin_polyforge_graph_ff7d84e8bb', namespace)
        .replaceAll('REFERENCES public.', `REFERENCES ${namespace}.`));
    }
    const [issueId, otherIssueId, agentId, agentRunId] = Array.from({ length: 4 }, () => randomUUID());
    await sql.unsafe(`INSERT INTO ${namespace}.issues VALUES ($1),($2)`, [issueId, otherIssueId]);
    await sql.unsafe(`INSERT INTO ${namespace}.agents VALUES ($1)`, [agentId]);
    const attempt = [db, companyId, 'run', 'node', 1, 'work'];
    assert.equal(await claimDispatch(...attempt, agentId), true);
    await updateDispatch(...attempt, { issueId }); // Reconciler attaches the recovered issue first.
    assert.equal(await bindDispatchRunFromCheckout(...attempt, issueId, agentId, agentRunId), true);
    const checkedOut = await getDispatch(...attempt);
    assert.equal(checkedOut.state, 'woken');
    assert.equal(checkedOut.agent_run_id, agentRunId);
    assert.ok(checkedOut.checkout_verified_at);
    await updateDispatch(...attempt, { issueId });
    await assert.rejects(updateDispatch(...attempt, { issueId: otherIssueId }), RevisionConflict);
    assert.deepEqual(await getDispatch(...attempt), checkedOut);
  });


test('workspace refusal blocks only its node before reserving a slot or creating an issue', async () => {
  const reservations = [], creations = [];
  const f = await fixture({ noCallback: true, deliveryLimits: { parallelAgents: 1 }, graph: {
    start: 'start', nodes: [{ id: 'start', type: 'task' },
      { id: 'exclusive', type: 'task', role: 'maker', workspace: { writeAccess: 'exclusive' } },
      { id: 'normal', type: 'task', role: 'maker' }],
    edges: [{ from: 'start', to: 'exclusive' }, { from: 'start', to: 'normal' }],
  }, persistence: { reserveSlot: async (request) => { reservations.push(request); return true; } },
  create: async (request) => { creations.push(request); return { id: 'normal-issue' }; } });
  // Even a capable host must remain unwired on this path.
  let workspaceCalls = 0;
  f.host.workspaceCapabilities = { fencedWrites: true, revokesExpiredWriter: true, isolatedGitCredentials: true };
  f.host.resolveTrustedWorkspace = f.host.admitFencedWorkspace = async () => { workspaceCalls++; assert.fail('Workspace host must remain unwired'); };
  await f.engine.submitNode({ runId: f.run.id, nodeId: 'start',
    actor: { id: 'owner', kind: 'human', roles: ['human-owner'] } });
  const actions = await f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
  assert.deepEqual(actions.find((action) => action.nodeId === 'exclusive'), {
    nodeId: 'exclusive', phase: 'work', status: 'blocked', reason: 'workspace_admission_unavailable', code: 'host_capability_missing',
    lifecycle: pendingWorkLifecycle,
  });
  assert.equal(actions.find((action) => action.nodeId === 'normal').status, 'issued');
  assert.equal(creations.length, 1);
  assert.ok(creations[0].originId.endsWith(':normal:1:work'));
  assert.deepEqual(reservations.map(({ attemptKey }) => JSON.parse(attemptKey)[1]), ['normal']);
  assert.equal(await f.persistence.get('company', f.run.id, 'exclusive', 1, 'work'), null);
  assert.equal(workspaceCalls, 0);
});

test('invalid node or Pack workspace declarations block dispatch without throwing', async (t) => {
  for (const source of ['node', 'Pack']) await t.test(source, async () => {
    let reservations = 0, creations = 0;
    const f = await fixture({ noCallback: true,
      ...(source === 'node' ? { node: { workspace: { writeAccess: 'shared' } } }
        : { node: { workspace: { writeAccess: 'none' } }, packWorkspace: { writeAccess: 'shared' } }),
      persistence: { reserveSlot: async () => { reservations++; return true; } },
      create: async () => { creations++; return { id: 'unexpected' }; } });
    assert.deepEqual(await f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } }), [
      { nodeId: 'make', phase: 'work', status: 'blocked', reason: 'invalid_workspace_declaration', lifecycle: pendingWorkLifecycle },
    ]);
    assert.equal(reservations, 0);
    assert.equal(creations, 0);
  });
});

test('Pack exclusive declaration blocks a node declaring no workspace writes', async () => {
  let reservations = 0, creations = 0;
  const f = await fixture({ node: { workspace: { writeAccess: 'none' } }, packWorkspace: { writeAccess: 'exclusive' },
    persistence: { reserveSlot: async () => { reservations++; return true; } },
    create: async () => { creations++; return { id: 'unexpected' }; } });
  const [action] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
  assert.equal(action.status, 'blocked');
  assert.equal(action.reason, 'workspace_admission_unavailable');
  assert.equal(action.code, 'host_capability_missing');
  assert.equal(reservations, 0);
  assert.equal(creations, 0);
});

test('shadow execution obeys lifecycle and workspace admission before starting without taking a slot', async (t) => {
  for (const blockedBy of ['dependency', 'finalization', 'node workspace', 'Pack workspace']) await t.test(blockedBy, async (t) => {
    const f = await fixture({ noCallback: true,
      node: { shadow: { trigger: 'before-dispatch', reviewer: 'same-agent', required: true },
        ...(blockedBy === 'finalization' ? { hostLifecycle: { privileged: true } } : {}),
        ...(blockedBy === 'node workspace' ? { workspace: { writeAccess: 'exclusive' } } : {}) },
      packWorkspace: blockedBy === 'Pack workspace' ? { writeAccess: 'exclusive' } : undefined,
      assess: async () => ({ dependencies: blockedBy === 'dependency' ? [{ applyAt: 'before_work', status: 'blocked' }] : [],
        workspaceFinalize: 'unknown' }),
      shadowRuntime: { beforeDispatch: async () => assert.fail('Blocked work must not start a native shadow session') },
      persistence: { reserveSlot: async () => assert.fail('Blocked work must not reserve a slot') },
    });
    const claim = t.mock.method(f.persistence, 'claim'), create = t.mock.method(f.host.issues, 'create');
    const [action] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
    assert.equal(action.status, 'blocked');
    assert.equal(action.reason, blockedBy === 'dependency' ? 'dependency_blocked'
      : blockedBy === 'finalization' ? 'workspace_finalize_unknown' : 'workspace_admission_unavailable');
    assert.equal(claim.mock.callCount(), 0);
    assert.equal(create.mock.callCount(), 0);
  });
});

test('shadow waiting leaves capacity available and settled dispatch recovery does not rerun the shadow', async (t) => {
  let shadows = 0, reservations = 0, ready = false;
  const f = await fixture({ noCallback: true,
    node: { shadow: { trigger: 'before-dispatch', reviewer: 'same-agent', required: true } },
    shadowRuntime: { beforeDispatch: async () => { shadows++; return { ready, status: 'waiting_shadow' }; } },
    persistence: { reserveSlot: async () => { reservations++; return true; } },
  });
  const config = { roleBindings: { 'pack:maker': 'agent' } };
  const claim = t.mock.method(f.persistence, 'claim');
  assert.equal((await f.dispatch.dispatchReady('company', f.engine, f.run.id, config))[0].status, 'waiting_shadow');
  assert.equal(reservations, 0); assert.equal(claim.mock.callCount(), 0);
  ready = true;
  assert.equal((await f.dispatch.dispatchReady('company', f.engine, f.run.id, config))[0].status, 'issued');
  assert.equal((await f.dispatch.dispatchReady('company', f.engine, f.run.id, config))[0].status, 'issued');
  assert.equal(shadows, 2); assert.equal(reservations, 1); assert.equal(claim.mock.callCount(), 1);
});

test('a retry during shadow admission cannot start a session for the stale attempt', async (t) => {
  const f = await fixture({ noCallback: true,
    node: { shadow: { trigger: 'before-dispatch', reviewer: 'same-agent', required: true } },
    shadowRuntime: { beforeDispatch: async () => assert.fail('Stale work must not start a shadow session') },
  });
  let retried = false;
  f.host.assessGraphDispatchLifecycle = async () => {
    if (!retried) {
      retried = true;
      await f.engine.retryNode({ runId: f.run.id, nodeId: 'make',
        actor: { id: 'owner', kind: 'human', roles: ['human-owner'] }, reason: 'Supersede dispatch' });
    }
    return { dependencies: [], workspaceFinalize: 'confirmed_success' };
  };
  const [action] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
  assert.equal(action.status, 'stale_attempt');
  assert.equal(f.row, null);
});

test('parent dispatch rechecks eligibility and lifecycle after shadow execution before reserving capacity', async (t) => {
  for (const change of ['retry', 'lifecycle']) await t.test(change, async () => {
    let blocked = false;
    const f = await fixture({ noCallback: true,
      node: { shadow: { trigger: 'before-dispatch', reviewer: 'same-agent', required: true } },
      assess: async () => ({ dependencies: blocked ? [{ applyAt: 'before_work', status: 'blocked' }] : [] }),
      persistence: { reserveSlot: async () => assert.fail('Parent lost admission while shadow was running') },
      shadowRuntime: { beforeDispatch: async () => {
        if (change === 'retry') await f.engine.retryNode({ runId: f.run.id, nodeId: 'make',
          actor: { id: 'owner', kind: 'human', roles: ['human-owner'] }, reason: 'Supersede parent' });
        else blocked = true;
        return { ready: true };
      } },
    });
    const [action] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
    assert.equal(action.status, change === 'retry' ? 'stale_attempt' : 'blocked');
    assert.equal(f.row, null);
  });
});

test('existing exclusive dispatch reports its state and still occupies capacity', async (t) => {
  for (const state of ['issued', 'waking', 'woken']) await t.test(state, async () => {
    let reservations = 0, creations = 0;
    const existing = { issue_id: 'existing-issue', agent_id: 'agent', state,
      agent_run_id: state === 'woken' ? 'existing-run' : null };
    const f = await fixture({ noCallback: true, deliveryLimits: { parallelAgents: 1 }, graph: {
      start: 'start', nodes: [{ id: 'start', type: 'task' },
        { id: 'exclusive', type: 'task', role: 'maker', workspace: { writeAccess: 'exclusive' } },
        { id: 'normal', type: 'task', role: 'maker' }],
      edges: [{ from: 'start', to: 'exclusive' }, { from: 'start', to: 'normal' }],
    }, persistence: {
      get: async (_company, _runId, nodeId) => nodeId === 'exclusive' ? existing : null,
      reserveSlot: async () => { reservations++; return true; },
    }, getIssue: async (id) => ({ id, assigneeAgentId: 'agent' }),
    create: async () => { creations++; return { id: 'unexpected' }; } });
    await f.engine.submitNode({ runId: f.run.id, nodeId: 'start',
      actor: { id: 'owner', kind: 'human', roles: ['human-owner'] } });
    const actions = await f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
    const action = actions.find((action) => action.nodeId === 'exclusive');
    assert.equal(action.status, state);
    assert.equal(action.issueId, existing.issue_id);
    assert.equal(action.agentId, existing.agent_id);
    assert.equal(action.agentRunId, existing.agent_run_id);
    assert.deepEqual(actions.find((action) => action.nodeId === 'normal'), {
      nodeId: 'normal', phase: 'work', status: 'deferred_agent_limit', lifecycle: pendingWorkLifecycle,
    });
    assert.equal(reservations, 0);
    assert.equal(creations, 0);
  });
});

test('dispatch blocks a privileged stage until trusted workspace finalization succeeds', async () => {
  let status = 'unknown', creates = 0;
  const f = await fixture({ node: { hostLifecycle: { privileged: true } },
    assess: async () => ({ dependencies: [], workspaceFinalize: status }),
    create: async () => { creates++; return { id: 'child-1' }; } });
  const config = { roleBindings: { 'pack:maker': 'agent' } };
  for (const value of ['unknown', 'confirmed_failure']) {
    status = value;
    const [result] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, config);
    assert.equal(result.reason, 'workspace_finalize_' + value); assert.equal(creates, 0);
  }
  status = 'confirmed_success';
  await f.dispatch.dispatchReady('company', f.engine, f.run.id, config);
  assert.equal(creates, 1);
});

test('post-review dependency does not block supervisor assessment', async () => {
  const { assessDispatchLifecycle } = await import('../../src/plugin/dispatch-lifecycle.mjs');
  const node = { id: 'make' }, run = { id: 'run', nodeStates: { make: { status: 'awaiting_supervisor_review' } } };
  const host = { assessGraphDispatchLifecycle: async () => ({ dependencies: [{ applyAt: 'after_review', status: 'blocked' }], workspaceFinalize: 'unknown' }) };
  const result = await assessDispatchLifecycle({ host, companyId: 'company', run, node, attempt: 1, phase: 'supervisor' });
  assert.equal(result.dependencyReadiness, 'ready'); assert.equal(result.admission, 'admitted');
});


test('dispatchReady admits supervisor despite an after-review blocker', async () => {
  let creates = 0;
  const f = await fixture({ noCallback: true, assess: async () => ({
    dependencies: [{ applyAt: 'after_review', status: 'blocked' }], workspaceFinalize: 'unknown' }),
    create: async () => { creates++; return { id: 'review-issue' }; } });
  const originalGetRun = f.engine.getRun.bind(f.engine);
  f.engine.getRun = async (...args) => {
    const run = await originalGetRun(...args);
    run.graph.nodes[0].review = { supervisorRole: 'maker' };
    run.nodeStates.make.status = 'awaiting_supervisor_review';
    run.nodeStates.make.attempts = [{ artifacts: [], evidence: [], selfReviews: [] }];
    return run;
  };
  f.engine.getWorkItems = async () => [{ nodeId: 'make', phase: 'supervisor', role: 'maker' }];
  const actions = await f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
  assert.equal(actions[0].status, 'issued'); assert.equal(creates, 1);
});


test('retry guard blocks unknown creation and reconciles only exact host evidence', async () => {
  let found = false, confirmed = 0;
  const f = await fixture({ reclaim: true, create: async () => { throw new Error('lost'); },
    list: async ({ companyId, originKind, originId }) => found
      ? [{ id: 'child-1', companyId, originKind, originId, assigneeAgentId: 'agent', parentId: 'root', projectId: null }] : [],
    persistence: { beginEffect: async () => ({ owner: true }),
      getEffect: async (_company, id) => id.endsWith(':1:work') ? { outcome: 'unknown' } : null,
      reconcileEffect: async () => { confirmed++; } } });
  await f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
  await assert.rejects(f.dispatch.assertRetrySafe('company', f.engine, f.run.id, 'make'), /issue creation may still be in progress/);
  found = true;
  await f.dispatch.assertRetrySafe('company', f.engine, f.run.id, 'make');
  assert.equal(confirmed, 1);
});

test('automatic progression cannot bypass privileged finalization', async () => {
  const f = await fixture({ node: { hostLifecycle: { privileged: true } },
    assess: async () => ({ dependencies: [], workspaceFinalize: 'unknown' }) });
  f.engine.getWorkItems = async () => [{ nodeId: 'make', kind: 'automatic', phase: 'work' }];
  let submits = 0; f.engine.submitNode = async () => { submits++; };
  const [action] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, {});
  assert.equal(action.reason, 'workspace_finalize_unknown'); assert.equal(submits, 0);
});


test('retry retires only previous attempts', async () => {
  const retired = [];
  const f = await fixture({ persistence: { readState: undefined, getEffect: async () => null,
    retireEffect: async (_company, id) => { retired.push(id); return { outcome: 'confirmed_failure' }; } } });
  const original = f.engine.getRun.bind(f.engine);
  f.engine.getRun = async (...args) => { const run = await original(...args);
    run.nodeStates.make.status = 'completed'; run.nodeStates.make.attempts = [{}]; return run; };
  await f.dispatch.assertRetrySafe('company', f.engine, f.run.id, 'make');
  assert.deepEqual(retired.map((id) => id.slice(id.lastIndexOf(':make:'))), [':make:1:work']);
});

test('concurrent identical retry uses one pre-commit snapshot and cannot retire its new attempt', async () => {
  let release, captured;
  const gate = new Promise((resolve) => { release = resolve; });
  const snapshotCaptured = new Promise((resolve) => { captured = resolve; });
  let f, reads = 0; const retired = [];
  const persistence = {
    getEffect: async () => null,
    retireEffect: async (_company, id) => { retired.push(id); return { outcome: 'confirmed_failure' }; },
    readState: async () => {
      const snapshot = await f.engine.store.read();
      if (++reads === 1) { captured(); await gate; }
      return snapshot;
    },
  };
  f = await fixture({ persistence });
  const actor = { id: 'owner', kind: 'human', roles: ['human-owner'] };
  const args = { runId: f.run.id, nodeId: 'make', actor, reason: 'retry', idempotencyKey: 'same' };
  const delayed = f.dispatch.assertRetrySafe('company', f.engine, f.run.id, 'make', 'same');
  await snapshotCaptured;
  const { expectedRunDigest: firstDigest } = await f.dispatch.assertRetrySafe('company', f.engine, f.run.id, 'make', 'same');
  await f.engine.retryNode({ ...args, expectedRunDigest: firstDigest });
  release();
  const { expectedRunDigest: secondDigest } = await delayed;
  await f.engine.retryNode({ ...args, expectedRunDigest: secondDigest });
  assert.equal((await f.engine.getRun(f.run.id)).nodeStates.make.attempts.length, 1);
  assert.ok(retired.every((id) => id.includes(':make:1:')));
});

test('fresh retry recovers after a stale digest rejects a retired operation', async () => {
  const retired = [];
  let timestamp = Date.UTC(2026, 0, 1);
  const f = await fixture({ now: () => new Date(timestamp++).toISOString(), persistence: { getEffect: async () => null,
    retireEffect: async (_company, id) => { retired.push(id); return { outcome: 'confirmed_failure' }; } } });
  const actor = { id: 'owner', kind: 'human', roles: ['human-owner'] };
  const { expectedRunDigest: digest } = await f.dispatch.assertRetrySafe('company', f.engine, f.run.id, 'make', 'old');
  await f.engine.pauseRun({ runId: f.run.id, actor, reason: 'hold' });
  await f.engine.resumeRun({ runId: f.run.id, actor, reason: 'resume' });
  await assert.rejects(f.engine.retryNode({ runId: f.run.id, nodeId: 'make', actor, reason: 'retry',
    idempotencyKey: 'old', expectedRunDigest: digest }), /changed since validation/);
  const { expectedRunDigest: fresh } = await f.dispatch.assertRetrySafe('company', f.engine, f.run.id, 'make', 'new');
  const result = await f.engine.retryNode({ runId: f.run.id, nodeId: 'make', actor, reason: 'retry',
    idempotencyKey: 'new', expectedRunDigest: fresh });
  assert.equal(result.nextAttempt, 2);
  assert.ok(retired.every((id) => id.includes(':make:1:')));
});


test('failed owner retry restores supervisor creation before and across self-review transition', async (t) => {
  for (const transition of [false, true]) await t.test(`transition=${transition}`, async (t) => {
    const { effects, persistence } = effectPersistence();
    const f = await fixture({ noCallback: true, persistence, decisionRules: [{ type: 'review', mode: 'manual', roles: ['maker'], requiredEvidence: [] }], node: { review: { supervisorRole: 'maker' } } });
    const actor = { id: 'agent', kind: 'agent', roles: ['maker'], executionId: 'producer' };
    await f.engine.submitNode({ runId: f.run.id, nodeId: 'make', actor, output: {},
      artifacts: [{ id: 'artifact', version: '1', kind: 'document' }] });
    const failure = new AuthorizationError('Retry denied');
    t.mock.method(f.engine, 'retryNode', async () => {
      if (transition) await f.engine.recordSelfReview({ runId: f.run.id, nodeId: 'make', actor, artifactVersion: '1' });
      throw failure;
    });
    await assert.rejects(f.dispatch.retryNode('company', f.engine, { runId: f.run.id, nodeId: 'make', reason: 'Recover' }), error => error === failure);
    assert.equal(effects.has(`issue-create:${f.run.id}:make:1:supervisor`), false);
    if (!transition) await f.engine.recordSelfReview({ runId: f.run.id, nodeId: 'make', actor, artifactVersion: '1' });
    const [action] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
    assert.equal(action.phase, 'supervisor');
    assert.equal(action.status, 'issued');
  });
});


function assignmentPersistence() {
  const assignments = new Map();
  return { assignments, persistence: {
    getAssignment: async (_company, id) => structuredClone(assignments.get(id) ?? null),
    beginAssignment: async (_company, id, request, context = {}) => {
      let row = assignments.get(id);
      if (row?.request) assert.deepEqual(row.request, request);
      const owner = !row || (row.request && ['confirmed_success', 'confirmed_failure'].includes(row.outcome) && !row.retirement_owners.length);
      if (owner) {
        row = { request, context, outcome: 'unknown', generation: (row?.generation ?? 0) + 1, retirement_owners: [] };
        assignments.set(id, row);
      }
      return { ...structuredClone(row), owner };
    },
    confirmAssignment: async (_company, id, generation, result, outcome = 'confirmed_success') => {
      const row = assignments.get(id);
      assert.equal(row.generation, generation);
      if (row.outcome !== 'unknown') { assert.equal(row.outcome, outcome); assert.deepEqual(row.result, result); }
      Object.assign(row, { outcome, result });
    },
    retireAssignment: async (_company, id, owner, context = {}) => {
      let row = assignments.get(id);
      if (!row) { row = { request: null, outcome: 'confirmed_failure', generation: 0, retirement_owners: [] }; assignments.set(id, row); }
      row.context = context;
      if (!row.retirement_owners.includes(owner)) row.retirement_owners.push(owner);
      return { ...structuredClone(row), inserted: true };
    },
    listAssignmentRetirements: async (_company, prefix) => [...assignments].flatMap(([id, row]) =>
      row.retirement_owners.filter(owner => owner.startsWith(prefix)).map(owner => ({ operationId: id,
        ...row.context, retirementOwner: owner, kind: 'assignment', inserted: true }))),
    cancelAssignments: async (_company, ids, owner) => {
      for (const id of ids) {
        const row = assignments.get(id);
        row.retirement_owners = row.retirement_owners.filter(item => item !== owner);
        if (!row.request && !row.retirement_owners.length) assignments.delete(id);
      }
    },
  } };
}

test('assignment rechecks human ownership after awaited preparation and settles the unsent generation', async (t) => {
  for (const recovery of [false, true]) for (const window of ['goal update', 'assignment claim']) {
    for (const userField of ['assigneeUserId', 'assignee_user_id']) await t.test(`${window}, recovery=${recovery}, ${userField}`, async (t) => {
      const assignment = assignmentPersistence();
      const f = await fixture({ noCallback: true, persistence: assignment.persistence });
      const config = { roleBindings: { 'pack:maker': 'agent' } };
      if (recovery) await f.dispatch.dispatchReady('company', f.engine, f.run.id, config);
      let humanOwner = null;
      t.mock.method(f.host.issues, 'get', async id => ({ id, assigneeAgentId: null, [userField]: humanOwner }));
      if (window === 'goal update') f.host.issues.documents = { get: async () => null,
        upsert: async () => { humanOwner = 'human-owner'; } };
      else {
        const begin = assignment.persistence.beginAssignment;
        t.mock.method(f.persistence, 'beginAssignment', async (...args) => {
          const record = await begin(...args);
          humanOwner = 'human-owner';
          return record;
        });
      }
      const update = t.mock.method(f.host.issues, 'update');
      const [action] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, config);
      assert.equal(action.status, 'ownership_conflict');
      assert.equal(action.assigneeUserId, 'human-owner');
      const receipt = assignment.assignments.get(`issue-assign:${f.run.id}:make:1:work`);
      assert.equal(receipt.generation, recovery ? 2 : 1);
      assert.equal(receipt.outcome, 'confirmed_failure');
      assert.equal(receipt.result.notSent, true);
      assert.equal(update.mock.callCount(), 0);
      assert.equal(f.wakeupCalls, 0); assert.equal(f.checkoutCalls, 0);
      const [again] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, config);
      assert.equal(again.status, 'ownership_conflict');
      assert.equal(receipt.outcome, 'confirmed_failure');
      assert.equal(update.mock.callCount(), 0);
    });
  }
});

test('an ownership read failure before assignment records a definite no-send outcome and permits recovery', async (t) => {
  const assignment = assignmentPersistence();
  const f = await fixture({ noCallback: true, persistence: assignment.persistence });
  const begin = assignment.persistence.beginAssignment, failure = new Error('ownership read unavailable');
  const get = f.host.issues.get;
  t.mock.method(f.persistence, 'beginAssignment', async (...args) => {
    const record = await begin(...args);
    f.host.issues.get = async () => { throw failure; };
    return record;
  });
  const update = t.mock.method(f.host.issues, 'update');
  const config = { roleBindings: { 'pack:maker': 'agent' } };
  await assert.rejects(f.dispatch.dispatchReady('company', f.engine, f.run.id, config), error => error === failure);
  const operationId = `issue-assign:${f.run.id}:make:1:work`;
  assert.equal(assignment.assignments.get(operationId).outcome, 'confirmed_failure');
  assert.equal(assignment.assignments.get(operationId).result.notSent, true);
  assert.equal(update.mock.callCount(), 0); assert.equal(f.wakeupCalls, 0);
  f.host.issues.get = get;
  f.persistence.beginAssignment = begin;
  assert.equal((await f.dispatch.dispatchReady('company', f.engine, f.run.id, config))[0].status, 'issued');
  assert.equal(assignment.assignments.get(operationId).generation, 2);
  assert.equal(assignment.assignments.get(operationId).outcome, 'confirmed_success');
  assert.equal(update.mock.callCount(), 1);
});

test('owner retry cannot pass an in-flight assignment or dispatch a replacement', async (t) => {
  const assignment = assignmentPersistence();
  const creation = effectPersistence();
  const f = await fixture({ noCallback: true, persistence: { ...creation.persistence, ...assignment.persistence } });
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const update = f.host.issues.update;
  t.mock.method(f.host.issues, 'update', async (...args) => { enter(); await gate; return update(...args); });
  const config = { roleBindings: { 'pack:maker': 'agent' } };
  const pending = f.dispatch.dispatchReady('company', f.engine, f.run.id, config);
  await entered;
  const args = { runId: f.run.id, nodeId: 'make', actor: { id: 'owner', kind: 'human', roles: ['human-owner'] }, reason: 'Recover' };
  try {
    await assert.rejects(f.dispatch.retryNode('company', f.engine, args), /assignment.*(progress|unresolved)/);
    assert.equal((await f.engine.getRun(f.run.id)).nodeStates.make.attempts.length, 0);
    const [action] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, config);
    assert.equal(action.status, 'assignment_pending');
  } finally { release(); await pending; }
  assert.equal((await f.dispatch.retryNode('company', f.engine, args)).nextAttempt, 2);
});


test('unknown assignment survives process replacement and cannot be resolved by an assigned snapshot', async (t) => {
  for (const applied of [false, true]) await t.test(`applied=${applied}`, async (t) => {
    const assignment = assignmentPersistence();
    const creation = effectPersistence();
    const f = await fixture({ noCallback: true, persistence: { ...creation.persistence, ...assignment.persistence } });
    const update = f.host.issues.update;
    const sender = t.mock.method(f.host.issues, 'update', async (...args) => {
      if (applied) await update(...args);
      throw new Error('response lost');
    });
    const config = { roleBindings: { 'pack:maker': 'agent' } };
    const [first] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, config);
    assert.equal(first.status, 'assignment_pending');
    assert.equal(first.operationId, `issue-assign:${f.run.id}:make:1:work`);
    const replacement = createDispatch(f.host, async () => ({ engine: f.engine }), async () => config, f.persistence);
    const [next] = await replacement.dispatchReady('company', f.engine, f.run.id, config);
    assert.equal(next.status, 'assignment_pending');
    assert.equal(sender.mock.callCount(), 1);
    await assert.rejects(replacement.retryNode('company', f.engine, { runId: f.run.id, nodeId: 'make',
      actor: { id: 'owner', kind: 'human', roles: ['human-owner'] }, reason: 'Recover' }), /assignment.*unresolved/);
    const record = assignment.assignments.get(first.operationId);
    assert.equal(record.outcome, 'unknown');
    assert.deepEqual(record.request, { issueId: 'child-1', agentId: 'agent' });
    assert.deepEqual(record.retirement_owners, []);
    const run = { ...await f.engine.getRun(f.run.id), deliveryKey: undefined };
    const [unresolved] = await replacement.currentDispatches('company', run, { includeReceipts: true });
    assert.equal(unresolved.issueId, 'child-1');
    assert.equal(unresolved.state, 'issued');
    assert.equal(unresolved.receiptStatus, 'assignment_pending');
    if (applied) {
      await assignment.persistence.confirmAssignment('company', first.operationId, record.generation, record.request);
      const [resolved] = await replacement.currentDispatches('company', run, { includeReceipts: true });
      assert.equal(resolved.receiptStatus, undefined);
    }
    assert.equal(sender.mock.callCount(), 1);
  });
});

test('assignment confirmation retries one transient database failure without repeating the host update', async (t) => {
  const assignment = assignmentPersistence();
  const f = await fixture({ noCallback: true, persistence: assignment.persistence });
  const confirm = assignment.persistence.confirmAssignment;
  let confirmations = 0;
  t.mock.method(f.persistence, 'confirmAssignment', async (...args) => {
    if (++confirmations === 1) throw new Error('temporary database failure');
    return confirm(...args);
  });
  const sender = t.mock.method(f.host.issues, 'update');
  const [action] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
  assert.equal(action.status, 'issued');
  assert.equal(sender.mock.callCount(), 1);
  assert.equal(confirmations, 2);
  assert.equal(assignment.assignments.get(`issue-assign:${f.run.id}:make:1:work`).outcome, 'confirmed_success');
});

test('an unassigned settled issue obtains a new fenced assignment generation', async (t) => {
  const assignment = assignmentPersistence();
  const f = await fixture({ noCallback: true, persistence: assignment.persistence });
  const config = { roleBindings: { 'pack:maker': 'agent' } };
  await f.dispatch.dispatchReady('company', f.engine, f.run.id, config);
  t.mock.method(f.host.issues, 'get', async id => ({ id, assigneeAgentId: null }));
  const sender = t.mock.method(f.host.issues, 'update');
  const [action] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, config);
  assert.equal(action.status, 'issued');
  assert.equal(sender.mock.callCount(), 1);
  assert.equal(assignment.assignments.get(`issue-assign:${f.run.id}:make:1:work`).generation, 2);
});

test('retry retirement winning between assignment lookup and claim suppresses the host write', async (t) => {
  const assignment = assignmentPersistence();
  const f = await fixture({ noCallback: true, persistence: assignment.persistence });
  const begin = assignment.persistence.beginAssignment;
  t.mock.method(f.persistence, 'beginAssignment', async (...args) => {
    await assignment.persistence.retireAssignment(args[0], args[1], 'other-retry');
    return begin(...args);
  });
  const sender = t.mock.method(f.host.issues, 'update');
  const [action] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
  assert.equal(action.status, 'stale_attempt');
  assert.equal(sender.mock.callCount(), 0);
});

test('an upstream retry fences descendant assignments and releases surviving pending attempt identities', async (t) => {
  const assignment = assignmentPersistence();
  const f = await fixture({ noCallback: true, persistence: assignment.persistence, graph: {
    nodes: [{ id: 'make', type: 'task', role: 'maker' }, { id: 'next', type: 'task', role: 'maker' }],
    edges: [{ from: 'make', to: 'next' }],
  } });
  const actor = { id: 'agent', kind: 'agent', roles: ['maker'], executionId: 'producer' };
  await f.engine.submitNode({ runId: f.run.id, nodeId: 'make', actor, output: {} });
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const update = f.host.issues.update;
  t.mock.method(f.host.issues, 'update', async (...args) => { enter(); await gate; return update(...args); });
  const config = { roleBindings: { 'pack:maker': 'agent' } };
  const pending = f.dispatch.dispatchReady('company', f.engine, f.run.id, config);
  await entered;
  const input = { runId: f.run.id, nodeId: 'make', actor: { id: 'owner', kind: 'human', roles: ['human-owner'] }, reason: 'Recover' };
  try { await assert.rejects(f.dispatch.retryNode('company', f.engine, input), /assignment.*unresolved/); }
  finally { release(); await pending; }
  assert.equal((await f.dispatch.retryNode('company', f.engine, input)).nextAttempt, 2);
  assert.deepEqual(assignment.assignments.get(`issue-assign:${f.run.id}:next:1:work`).retirement_owners, []);
  // A fresh pending descendant without a dispatch record also survives the retry.
  await f.engine.submitNode({ runId: f.run.id, nodeId: 'make', actor, output: {} });
  assert.equal((await f.dispatch.dispatchReady('company', f.engine, f.run.id, config))[0].status, 'issued');
});


test('only documented pre-execution host denials settle a failed assignment for safe retry', async (t) => {
  for (const code of [-32001, -32005, -32003, undefined, 'CAPABILITY_DENIED']) await t.test(String(code), async (t) => {
    const assignment = assignmentPersistence();
    const f = await fixture({ noCallback: true, persistence: assignment.persistence });
    t.mock.method(f.host.issues, 'update', async () => { throw Object.assign(new Error('host rejected'), { code }); });
    const config = { roleBindings: { 'pack:maker': 'agent' } };
    assert.equal((await f.dispatch.dispatchReady('company', f.engine, f.run.id, config))[0].status, 'assignment_pending');
    const retry = f.dispatch.retryNode('company', f.engine, { runId: f.run.id, nodeId: 'make',
      actor: { id: 'owner', kind: 'human', roles: ['human-owner'] }, reason: 'Recover' });
    if ([-32001, -32005].includes(code)) assert.equal((await retry).nextAttempt, 2);
    else await assert.rejects(retry, /assignment.*unresolved/);
  });
});


test('a surviving descendant rechecks readiness after its assignment claim and can reopen a provably unsent generation', async (t) => {
  const assignment = assignmentPersistence();
  const f = await fixture({ noCallback: true, persistence: assignment.persistence, graph: {
    nodes: [{ id: 'make', type: 'task', role: 'maker' }, { id: 'next', type: 'task', role: 'maker' }],
    edges: [{ from: 'make', to: 'next' }],
  } });
  const actor = { id: 'agent', kind: 'agent', roles: ['maker'], executionId: 'producer' };
  await f.engine.submitNode({ runId: f.run.id, nodeId: 'make', actor, output: {} });
  const begin = assignment.persistence.beginAssignment;
  let retried = false;
  t.mock.method(f.persistence, 'beginAssignment', async (...args) => {
    if (!retried) {
      retried = true;
      await f.dispatch.retryNode('company', f.engine, { runId: f.run.id, nodeId: 'make',
        actor: { id: 'owner', kind: 'human', roles: ['human-owner'] }, reason: 'Recover upstream' });
    }
    return begin(...args);
  });
  const sender = t.mock.method(f.host.issues, 'update');
  const config = { roleBindings: { 'pack:maker': 'agent' } };
  assert.equal((await f.dispatch.dispatchReady('company', f.engine, f.run.id, config))[0].status, 'stale_attempt');
  assert.equal(sender.mock.callCount(), 0);
  const record = assignment.assignments.get(`issue-assign:${f.run.id}:next:1:work`);
  assert.equal(record.outcome, 'confirmed_failure');
  assert.equal(record.result.notSent, true);
  await f.engine.submitNode({ runId: f.run.id, nodeId: 'make', actor, output: {} });
  assert.equal((await f.dispatch.dispatchReady('company', f.engine, f.run.id, config))[0].status, 'issued');
  assert.equal(sender.mock.callCount(), 1);
  assert.equal(assignment.assignments.get(`issue-assign:${f.run.id}:next:1:work`).generation, 2);
});

test('upstream retry protects an in-flight linked-child assignment and rejects abandoned lineage', async (t) => {
  const { assignment, f, child } = await linkedAssignmentFixture();
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const update = f.host.issues.update;
  t.mock.method(f.host.issues, 'update', async (...args) => { enter(); await gate; return update(...args); });
  const pending = f.dispatch.dispatchReady('company', f.engine, child.id, { roleBindings: { 'pack:maker': 'agent' } });
  await entered;
  const input = { runId: f.run.id, nodeId: 'make', actor: { id: 'owner', kind: 'human', roles: ['human-owner'] }, reason: 'Recover' };
  try { await assert.rejects(f.dispatch.retryNode('company', f.engine, input), /assignment.*unresolved/); }
  finally { release(); await pending; }
  await f.dispatch.retryNode('company', f.engine, input);
  assert.equal(assignment.assignments.get(`issue-assign:${child.id}:child-work:1:work`).retirement_owners.length, 0);
  assert.deepEqual(await f.dispatch.dispatchReady('company', f.engine, child.id, {}), []);
});


test('a transient eligibility read failure after claiming assignment records a definite no-send outcome', async (t) => {
  const assignment = assignmentPersistence();
  const f = await fixture({ noCallback: true, persistence: assignment.persistence });
  const begin = assignment.persistence.beginAssignment;
  const getWork = f.engine.getWorkItems.bind(f.engine);
  const failure = new Error('temporary eligibility read failure');
  t.mock.method(f.persistence, 'beginAssignment', async (...args) => {
    const effect = await begin(...args);
    f.engine.getWorkItems = async () => { throw failure; };
    return effect;
  });
  const sender = t.mock.method(f.host.issues, 'update');
  const config = { roleBindings: { 'pack:maker': 'agent' } };
  await assert.rejects(f.dispatch.dispatchReady('company', f.engine, f.run.id, config), error => error === failure);
  assert.equal(sender.mock.callCount(), 0);
  const record = assignment.assignments.get(`issue-assign:${f.run.id}:make:1:work`);
  assert.equal(record.outcome, 'confirmed_failure'); assert.equal(record.result.notSent, true);
  f.engine.getWorkItems = getWork;
  f.persistence.beginAssignment = begin;
  assert.equal((await f.dispatch.dispatchReady('company', f.engine, f.run.id, config))[0].status, 'issued');
});

test('committed retry reports deferred assignment cleanup and same-key replay completes it without another reset', async (t) => {
  const assignment = assignmentPersistence();
  const f = await fixture({ noCallback: true, persistence: assignment.persistence });
  const cleanup = assignment.persistence.cancelAssignments;
  let unavailable = true;
  t.mock.method(f.persistence, 'cancelAssignments', async (...args) => {
    if (unavailable) throw new Error('cleanup database unavailable');
    return cleanup(...args);
  });
  const input = { runId: f.run.id, nodeId: 'make', actor: { id: 'owner', kind: 'human', roles: ['human-owner'] },
    reason: 'Recover', idempotencyKey: 'recover-cleanup' };
  const result = await f.dispatch.retryNode('company', f.engine, input);
  assert.equal(result.nextAttempt, 2); assert.equal(result.dispatchCleanupPending, true);
  assert.ok([...assignment.assignments.values()].some(row => row.retirement_owners.length));
  unavailable = false;
  const replay = await f.dispatch.retryNode('company', f.engine, input);
  assert.equal(replay.nextAttempt, 2); assert.equal(replay.dispatchCleanupPending, undefined);
  assert.equal((await f.engine.getRun(f.run.id)).nodeStates.make.attempts.length, 1);
  assert.ok([...assignment.assignments.values()].every(row => !row.retirement_owners.length));
});

async function linkedAssignmentFixture() {
  const assignment = assignmentPersistence();
  const childGraph = { id: 'child', version: '1', start: 'child-work',
    nodes: [{ id: 'child-work', type: 'task', role: 'maker' }, { id: 'child-end', type: 'end' }],
    edges: [{ from: 'child-work', to: 'child-end' }],
    workflowContract: { version: 1, inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', properties: {} }, outputMapping: {} } };
  const f = await fixture({ noCallback: true, persistence: assignment.persistence, graph: {
    nodes: [{ id: 'make', type: 'task', role: 'maker' }, { id: 'call', type: 'workflow', workflow: {
      packId: 'pack', packVersion: '1', graphId: 'child', graphVersion: '1' }, inputMapping: {} }, { id: 'end', type: 'end' }],
    edges: [{ from: 'make', to: 'call' }, { from: 'call', to: 'end' }],
  }, extraGraphs: [childGraph] });
  await f.engine.submitNode({ runId: f.run.id, nodeId: 'make',
    actor: { id: 'agent', kind: 'agent', roles: ['maker'], executionId: 'producer' }, output: {} });
  const child = await f.engine.startChildWorkflow({ runId: f.run.id, nodeId: 'call',
    actor: { id: 'plugin', kind: 'system', roles: [] } });
  return { assignment, f, child };
}


test('parent retry atomically rejects a linked child advancing beyond the guarded attempt', async (t) => {
  const { f, child } = await linkedAssignmentFixture();
  const retry = f.engine.retryNode.bind(f.engine);
  const before = runValidationDigest(await f.engine.getRun(f.run.id));
  t.mock.method(f.engine, 'retryNode', async args => {
    await retry({ runId: child.id, nodeId: 'child-work',
      actor: { id: 'owner', kind: 'human', roles: ['human-owner'] }, reason: 'Advance child' });
    assert.equal(runValidationDigest(await f.engine.getRun(f.run.id)), before);
    return retry(args);
  });
  await assert.rejects(f.dispatch.retryNode('company', f.engine, { runId: f.run.id, nodeId: 'make',
    actor: { id: 'owner', kind: 'human', roles: ['human-owner'] }, reason: 'Parent retry' }), /Linked run changed since dispatch validation/);
  assert.equal((await f.engine.getRun(f.run.id)).nodeStates.call.childRunId, child.id);
  assert.equal((await f.engine.getRun(f.run.id)).nodeStates.make.status, 'completed');
});

test('concurrent same-key retries retain independent assignment guard owners until commit', async (t) => {
  const assignment = assignmentPersistence();
  const f = await fixture({ noCallback: true, persistence: assignment.persistence });
  const original = f.engine.retryNode.bind(f.engine);
  let enterA, enterB, releaseA, releaseB, calls = 0;
  const enteredA = new Promise(resolve => { enterA = resolve; });
  const enteredB = new Promise(resolve => { enterB = resolve; });
  const gateA = new Promise(resolve => { releaseA = resolve; });
  const gateB = new Promise(resolve => { releaseB = resolve; });
  const denied = new AuthorizationError('First request rejected');
  t.mock.method(f.engine, 'retryNode', async args => {
    if (++calls === 1) { enterA(); await gateA; throw denied; }
    enterB(); await gateB; return original(args);
  });
  const input = { runId: f.run.id, nodeId: 'make', actor: { id: 'owner', kind: 'human', roles: ['human-owner'] },
    reason: 'Recover', idempotencyKey: 'same-key' };
  const first = f.dispatch.retryNode('company', f.engine, input);
  const rejected = assert.rejects(first, error => error === denied);
  await enteredA;
  const second = f.dispatch.retryNode('company', f.engine, input);
  await enteredB;
  const operationId = `issue-assign:${f.run.id}:make:1:work`;
  assert.equal(assignment.assignments.get(operationId).retirement_owners.length, 2);
  releaseA(); await rejected;
  assert.equal(assignment.assignments.get(operationId).retirement_owners.length, 1);
  const sender = t.mock.method(f.host.issues, 'update');
  const [stale] = await f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
  assert.equal(stale.status, 'stale_attempt'); assert.equal(sender.mock.callCount(), 0);
  releaseB();
  assert.equal((await second).nextAttempt, 2);
  assert.equal(assignment.assignments.has(operationId), false);
});


test('PostgreSQL assignment bridge blocks retry during host update and releases guards on keyed commit',
  { skip: !postgresShadowAvailable && 'Set POLYFORGE_RUN_POSTGRES_TESTS=1 to run against PostgreSQL' }, async t => {
    const { db, sql, namespace, companyId } = await createPostgresShadowDatabase(t);
    const migration = await readFile(new URL('../../migrations/019_issue_assignment.sql', import.meta.url), 'utf8');
    await sql.unsafe(migration.replaceAll('plugin_polyforge_graph_ff7d84e8bb', namespace)
      .replaceAll('REFERENCES public.', `REFERENCES ${namespace}.`));
    const persistence = Object.fromEntries(['getAssignment', 'beginAssignment', 'confirmAssignment', 'retireAssignment', 'listAssignmentRetirements']
      .map(name => [name, (_company, ...args) => assignmentLedger[name](db, companyId, ...args)]));
    persistence.cancelAssignments = (_company, ...args) => assignmentLedger.cancelAssignmentRetirements(db, companyId, ...args);
    const f = await fixture({ noCallback: true, persistence });
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const update = f.host.issues.update;
    t.mock.method(f.host.issues, 'update', async (...args) => { enter(); await gate; return update(...args); });
    const pending = f.dispatch.dispatchReady('company', f.engine, f.run.id, { roleBindings: { 'pack:maker': 'agent' } });
    await entered;
    const input = { runId: f.run.id, nodeId: 'make', actor: { id: 'owner', kind: 'human', roles: ['human-owner'] },
      reason: 'Recover', idempotencyKey: 'sql-bridge' };
    try { await assert.rejects(f.dispatch.retryNode('company', f.engine, input), /assignment.*unresolved/); }
    finally { release(); await pending; }
    const id = `issue-assign:${f.run.id}:make:1:work`;
    assert.equal((await assignmentLedger.getAssignment(db, companyId, id)).outcome, 'confirmed_success');
    assert.equal((await f.dispatch.retryNode('company', f.engine, input)).nextAttempt, 2);
    assert.deepEqual((await assignmentLedger.getAssignment(db, companyId, id)).retirement_owners, []);
    assert.equal((await f.dispatch.retryNode('company', f.engine, input)).nextAttempt, 2);
  });
