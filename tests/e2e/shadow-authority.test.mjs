import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNotShadowCommand } from '../../src/plugin/shadow-authority.mjs';

test('Shadow execution cannot borrow the parent Agent authority before or after binding', async () => {
  let params;
  const db = { query: async (sql, args) => {
    assert.match(sql, /company_id=\$1 AND agent_id=\$2 AND id=\$3/);
    params = args;
    return [{ task_key: 'plugin:graph:session:shadow:independent' }];
  } };
  await assert.rejects(assertNotShadowCommand(db, 'company', { agentId: 'agent', runId: 'child' }, 'graph'),
    /may only return/);
  assert.deepEqual(params, ['company', 'agent', 'child']);
});

test('ordinary parent execution retains its existing authority checks', async () => {
  const db = { query: async () => [{ task_key: 'issue:parent' }] };
  await assertNotShadowCommand(db, 'company', { agentId: 'agent', runId: 'parent' }, 'graph');
});

test('generic temporary execution cannot borrow its parent role or recursively delegate', async () => {
  const db = { query: async () => [{ task_key: 'plugin:graph:session:temporary:bounded' }] };
  await assert.rejects(assertNotShadowCommand(db, 'company', { agentId: 'agent', runId: 'child' }, 'graph'),
    /may only return/);
});
