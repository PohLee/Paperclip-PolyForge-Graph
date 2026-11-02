import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { GraphEngine } from '../../src/core/index.mjs';
import { createDispatch } from '../../src/plugin/dispatch.mjs';
import { reserveDispatchSlot, reconcileDispatchSlots } from '../../src/plugin/store.mjs';
import { createPostgresShadowDatabase, postgresShadowAvailable } from '../helpers/postgres-shadow.mjs';

test('simultaneous sibling Graph Runs cannot admit more assignments than the pinned limit', async () => {
  const engine = new GraphEngine();
  await engine.registerPack({ id: 'probe', version: '1', roles: { maker: { documents: {} } },
    graphs: [{ id: 'parallel', version: '1', start: 'start', nodes: [
      { id: 'start', type: 'task' }, { id: 'a', type: 'task', role: 'maker' },
      { id: 'b', type: 'task', role: 'maker' }, { id: 'end', type: 'join', mode: 'all' }],
    edges: [{ from: 'start', to: 'a' }, { from: 'start', to: 'b' },
      { from: 'a', to: 'end' }, { from: 'b', to: 'end' }] }], decisionRules: [] });
  const owner = { id: 'owner', kind: 'human', roles: ['human-owner'] };
  const runs = [];
  for (let index = 0; index < 2; index++) {
    const run = await engine.startRun({ packId: 'probe', packVersion: '1', graphId: 'parallel', actor: owner,
      input: { deliveryId: 'shared', paperclipIssueId: 'root', paperclipCompanyId: 'company' } });
    await engine.submitNode({ runId: run.id, nodeId: 'start', actor: owner });
    runs.push(run);
  }
  const dispatchRows = new Map(), slots = new Map();
  const key = (company, run, node, attempt, phase) => JSON.stringify([company, run, node, attempt, phase]);
  let reads = 0, releaseReads, created = 0;
  const barrier = new Promise((resolve) => { releaseReads = resolve; });
  const persistence = {
    get: async (...args) => dispatchRows.get(key(...args)) ?? null,
    claim: async (...args) => { const id = key(...args);
      if (dispatchRows.has(id)) return false;
      dispatchRows.set(id, { agent_id: args[5], issue_id: null, agent_run_id: null, state: 'claimed' });
      return true; },
    wakeClaim: async (...args) => { dispatchRows.get(key(...args)).state = 'waking'; return true; },
    update: async (...args) => { const row = dispatchRows.get(key(...args)), patch = args[5];
      if (patch.issueId) { row.issue_id = patch.issueId; row.state = 'issued'; }
      if (patch.state) { row.state = patch.state; row.agent_run_id = patch.agentRunId; } },
    readState: async () => { const snapshot = await engine.store.read();
      if (++reads === 2) releaseReads();
      if (reads <= 2) await barrier;
      return snapshot; },
    reconcileSlots: async (_company, _delivery, live) => { for (const key of slots.keys()) if (!live.includes(key)) slots.delete(key);
      return [...slots.keys()]; },
    reserveSlot: async ({ attemptKey, limit }) => { if (slots.has(attemptKey)) return true;
      if (slots.size >= limit) return false;
      slots.set(attemptKey, slots.size + 1); return true; },
  };
  const host = { manifest: { id: 'probe' }, db: {}, agents: { get: async (id) => ({ id }) }, issues: {
    get: async (id) => id === 'root' ? { id, projectId: null } : null,
    list: async () => [], create: async () => ({ id: `child-${++created}` }),
    requestWakeup: async () => ({ runId: `execution-${created}`, queued: true }),
  } };
  const dispatch = createDispatch(host, null, null, persistence);
  const result = await Promise.all(runs.map((run) => dispatch.dispatchReady('company', engine, run.id,
    { roleBindings: { 'probe:maker': 'agent' } })));
  assert.equal(created, 3);
  assert.equal(slots.size, 3);
  assert.equal(result.flat().filter((item) => item.status === 'deferred_agent_limit').length, 1);
});

test('PostgreSQL dispatch slots enforce simultaneous claims and release completed attempts',
  { skip: !postgresShadowAvailable && 'Set POLYFORGE_RUN_POSTGRES_TESTS=1 to run against PostgreSQL' },
  async (t) => {
    const { db, sql, namespace, companyId } = await createPostgresShadowDatabase(t);
    const migration = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../../migrations/011_dispatch_slots.sql', import.meta.url), 'utf8'));
    await sql.unsafe(migration.replaceAll('plugin_polyforge_graph_ff7d84e8bb', namespace)
      .replaceAll('REFERENCES public.companies(id)', `REFERENCES ${namespace}.companies(id)`));
    const deliveryKey = `${companyId}:project:delivery`;
    const attempts = Array.from({ length: 8 }, (_, index) => JSON.stringify([randomUUID(), `node-${index}`, 1, 'work']));
    const results = await Promise.all(attempts.map((attemptKey) => reserveDispatchSlot(db,
      { companyId, deliveryKey, attemptKey, limit: 3 })));
    assert.equal(results.filter(Boolean).length, 3);
    const held = await reconcileDispatchSlots(db, companyId, deliveryKey, attempts.filter((_, index) => results[index]));
    assert.equal(held.length, 3);
    await reconcileDispatchSlots(db, companyId, deliveryKey, held.slice(1));
    assert.equal(await reserveDispatchSlot(db, { companyId, deliveryKey, attemptKey: attempts[7], limit: 3 }), true);
  });
