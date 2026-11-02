import test from 'node:test';
import assert from 'node:assert/strict';
import { getGraphConfig, setGraphConfig } from '../../src/plugin/store.mjs';

test('company Graph settings persist bounded delivery limits and supply defaults for older rows', async () => {
  let row = { role_bindings: '{}', user_roles: '{}', default_mode: 'manual', revision: 0 };
  const db = { namespace: 'plugin_polyforge_graph_ff7d84e8bb',
    async query(sql) {
      assert.match(sql, /delivery_limits/);
      return [row];
    },
    async execute(sql, args) {
      assert.match(sql, /delivery_limits=EXCLUDED\.delivery_limits/);
      if (row.revision !== args[5]) return { rowCount: 0 };
      row = { role_bindings: args[1], user_roles: args[2], default_mode: args[3],
        delivery_limits: args[4], revision: row.revision + 1 };
      return { rowCount: 1 };
    } };
  assert.equal((await getGraphConfig(db, 'company')).deliveryLimits.sliceMs, 120 * 60_000);
  const config = { roleBindings: {}, userRoles: {}, defaultMode: 'manual',
    deliveryLimits: { sliceMs: 60 * 60_000, idleMs: 15 * 60_000, parallelAgents: 2 } };
  await setGraphConfig(db, 'company', config);
  const saved = await getGraphConfig(db, 'company');
  assert.equal(saved.deliveryLimits.sliceMs, 60 * 60_000);
  assert.equal(saved.deliveryLimits.parallelAgents, 2);
  await assert.rejects(setGraphConfig(db, 'company', { ...config,
    deliveryLimits: { parallelAgents: 6 } }), /Invalid delivery limit/);
  assert.equal((await getGraphConfig(db, 'company')).deliveryLimits.parallelAgents, 2);
});
