import test from 'node:test';
import assert from 'node:assert/strict';
import { applyGraphConfigChange } from '../../src/plugin/graph-config-change.mjs';

function fixture() {
  const decisions = [], byKey = new Map();
  let config = { roleBindings: { maker: 'agent-a' }, userRoles: {}, defaultMode: 'manual',
    deliveryLimits: { parallelAgents: 3 }, revision: 1 };
  let beforeCompare = null;
  const engine = {
    listDecisions: async () => decisions,
    recordDecision: async (request) => {
      if (byKey.has(request.idempotencyKey)) return byKey.get(request.idempotencyKey);
      const decision = { ...request, id: `decision-${decisions.length + 1}` };
      decisions.push(decision);
      byKey.set(request.idempotencyKey, decision);
      return decision;
    },
  };
  const getConfig = async () => structuredClone(config);
  const compareAndSet = async (_db, _companyId, expectedRevision, next) => {
    if (beforeCompare) {
      const callback = beforeCompare;
      beforeCompare = null;
      await callback();
    }
    if (config.revision !== expectedRevision) return false;
    config = { ...structuredClone(next), revision: config.revision + 1 };
    return true;
  };
  const change = (key, patch) => applyGraphConfigChange({ companyId: 'company', db: {}, engine,
    actor: { id: 'owner', kind: 'human' }, reason: 'Configure delivery', idempotencyKey: key,
    type: 'actor_binding_configuration', kind: 'actor_binding_change', patch,
    getConfig, compareAndSet });
  return { change, getConfig, decisions,
    external: (patch) => { config = { ...config, ...patch, revision: config.revision + 1 }; },
    beforeCompare: (callback) => { beforeCompare = callback; } };
}

test('mode change retries a concurrent revision and preserves independently changed delivery limits', async () => {
  const f = fixture();
  f.beforeCompare(() => f.external({ deliveryLimits: { parallelAgents: 2 } }));
  const result = await f.change('mode-1', { defaultMode: 'assisted' });
  assert.equal(result.config.defaultMode, 'assisted');
  assert.deepEqual(result.config.deliveryLimits, { parallelAgents: 2 });
  const replay = await f.change('mode-1', { defaultMode: 'assisted' });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.config.deliveryLimits, { parallelAgents: 2 });
  assert.equal(f.decisions.length, 2);
});

test('unapplied intent can resume after an unrelated config write but rejects a conflicting choice', async () => {
  const f = fixture();
  f.beforeCompare(() => { throw new Error('database connection lost'); });
  await assert.rejects(f.change('mode-2', { defaultMode: 'assisted' }), /database connection lost/);
  assert.equal(f.decisions.length, 1);
  f.external({ deliveryLimits: { parallelAgents: 2 } });
  const result = await f.change('mode-2', { defaultMode: 'assisted' });
  assert.equal(result.config.defaultMode, 'assisted');
  assert.deepEqual(result.config.deliveryLimits, { parallelAgents: 2 });

  const conflict = fixture();
  conflict.beforeCompare(() => { throw new Error('database connection lost'); });
  await assert.rejects(conflict.change('mode-3', { defaultMode: 'assisted' }), /database connection lost/);
  conflict.external({ defaultMode: 'autonomous' });
  await assert.rejects(conflict.change('mode-3', { defaultMode: 'assisted' }), /changed after this request/);
});
