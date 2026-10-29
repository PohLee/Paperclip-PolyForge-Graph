import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanyApi } from '../../src/plugin/company-api.mjs';

test('execution mode is audited, admin scoped and old replay cannot undo a newer choice', async () => {
  const events = [], keys = new Map();
  let config = { roleBindings: {}, userRoles: {}, defaultMode: 'manual' };
  const engine = {
    listDecisions: async () => events,
    recordDecision: async (request) => {
      if (keys.has(request.idempotencyKey)) return keys.get(request.idempotencyKey);
      const event = { ...request, id: `decision-${events.length + 1}` };
      events.push(event); keys.set(request.idempotencyKey, event); return event;
    },
  };
  const api = createCompanyApi({ host: { db: {}, manifest: { id: 'test.graph' } }, catalog: () => [],
    engineFor: async () => ({ engine }), getConfig: async () => config,
    setConfig: async (_db, _companyId, value) => { config = value; },
    trustedActor: async (_companyId, hostActor) => ({ actor: { id: hostActor.userId,
      kind: 'human', roles: ['human-owner'] }, isAdministrator: hostActor.userId === 'admin' }),
    capabilitiesFor: async () => ({}), getEvidenceProviders: async () => [] });
  const call = (defaultMode, key, userId = 'admin') => api.command({ companyId: 'company-a',
    hostActor: { userId }, body: { operation: 'configure-execution', defaultMode,
      reason: 'Set company execution policy', idempotencyKey: key } });
  await assert.rejects(call('autonomous', 'unauthorized', 'viewer'), /company owner or admin/);
  const first = await call('assisted', 'mode-1');
  assert.equal(first.defaultMode, 'assisted');
  assert.equal(events.length, 2);
  await call('manual', 'mode-2');
  const replay = await call('assisted', 'mode-1');
  assert.equal(replay.replayed, true);
  assert.equal(replay.defaultMode, 'manual');
  assert.equal(config.defaultMode, 'manual');
  assert.equal(events.length, 4);
  await assert.rejects(call('autonomous', 'mode-1'), /Idempotency key reused/);
});

test('runtime preflight checks enabled and pinned active releases without changing configuration', async () => {
  const decisions = [];
  const pack = { id: 'pack-a', version: '1.0.0', compatibility: { coreRange: '>=0.8.0 <0.9.0' },
    graphs: [{ id: 'graph-a', nodes: [], edges: [] }] };
  const run = { id: 'run-a', packId: 'pack-a', packVersion: '1.0.0', pack,
    graph: pack.graphs[0], status: 'running' };
  const store = { read: async () => ({ packs: { 'pack-a@1.0.0': pack }, runs: { 'run-a': run } }) };
  const engine = { recordDecision: async (entry) => {
    decisions.push(entry); return { id: 'preflight-decision' };
  } };
  const control = { getSetup: async () => ({ enabledPacks: [{ packId: 'pack-a', version: '1.0.0' }] }) };
  const api = createCompanyApi({ host: { db: {}, manifest: { id: 'test.graph' } }, catalog: () => [],
    engineFor: async () => ({ store, engine, control }), getConfig: async () => ({}),
    trustedActor: async () => ({ actor: { id: 'admin', kind: 'human', roles: ['human-owner'] },
      isAdministrator: true }), capabilitiesFor: async () => ({}), getEvidenceProviders: async () => [] });
  const result = await api.command({ companyId: 'company-a', hostActor: { userId: 'admin' }, body: {
    operation: 'preflight-runtime', reason: 'Check a prospective Core upgrade', idempotencyKey: 'preflight-1',
    runtime: { version: '0.9.0', schemaVersion: 1, contracts: { graph: 1, decision: 1, evidence: 1 },
      capabilities: { 'company-control': '1.0.0' } } } });
  assert.equal(result.ok, false);
  assert.equal(result.candidateVerified, false);
  assert.match(result.issues.join(' '), /pack-a@1.0.0.*Core|Active run run-a.*Core/);
  assert.equal(decisions[0].type, 'runtime_preflight');
  assert.equal(decisions[0].status, 'blocked');
});
