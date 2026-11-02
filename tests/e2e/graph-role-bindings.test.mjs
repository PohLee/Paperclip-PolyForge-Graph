import test from 'node:test';
import assert from 'node:assert/strict';
import { patchGraphRoleBindings } from '../../src/plugin/store.mjs';

test('managed role provisioning preserves concurrent settings and rejects a conflicting binding', async () => {
  let row = { role_bindings: { ceo: 'agent-ceo' }, user_roles: {}, default_mode: 'manual',
    delivery_limits: { parallelAgents: 3 }, revision: 1 };
  let race = true;
  const db = { namespace: 'plugin_test_graph',
    query: async () => [structuredClone(row)],
    execute: async (_sql, parameters) => {
      if (race) {
        race = false;
        row.default_mode = 'assisted';
        row.delivery_limits = { parallelAgents: 2 };
        row.revision++;
      }
      if (row.revision !== parameters[5]) return { rowCount: 0 };
      row = { role_bindings: JSON.parse(parameters[1]), user_roles: JSON.parse(parameters[2]),
        default_mode: parameters[3], delivery_limits: JSON.parse(parameters[4]), revision: row.revision + 1 };
      return { rowCount: 1 };
    } };
  const result = await patchGraphRoleBindings(db, 'company', { 'adlc:maker': 'agent-maker' });
  assert.deepEqual(result.roleBindings, { ceo: 'agent-ceo', 'adlc:maker': 'agent-maker' });
  assert.equal(row.default_mode, 'assisted');
  assert.equal(row.delivery_limits.parallelAgents, 2);
  await assert.rejects(patchGraphRoleBindings(db, 'company', { ceo: 'another-agent' }),
    /Existing ceo binding differs/);
});
