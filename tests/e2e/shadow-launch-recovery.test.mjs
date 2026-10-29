import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowLaunchStore } from '../../src/plugin/shadow-launch-store.mjs';

function database() {
  const rows = new Map(), statements = [];
  const db = { namespace: 'plugin_test',
    async execute(sql, args) {
      statements.push(sql);
      if (sql.includes('INSERT INTO')) {
        const [company_id, request_key, fingerprint, agent_id, parent_run_id,
          parent_task_id, deadline_at, data] = args;
        const key = `${company_id}/${request_key}`;
        if (rows.has(key) || [...rows.values()].some(row => row.company_id === company_id &&
            row.parent_run_id === parent_run_id && row.parent_task_id === parent_task_id &&
            row.status !== 'closed')) return { rowCount: 0 };
        rows.set(key, { company_id, request_key, fingerprint, agent_id, parent_run_id,
          parent_task_id, deadline_at, data: JSON.parse(data), status: 'claimed',
          session_id: null, shadow_id: null, execution_id: null, outcome: null,
          lease_owner: null, lease_expires_at: null });
        return { rowCount: 1 };
      }
      const row = rows.get(`${args[0]}/${args[1]}`);
      if (!row) return { rowCount: 0 };
      if (sql.includes('SET lease_owner=$3')) {
        const [,, owner, ttl] = args;
        if (row.status === 'closed' || row.lease_expires_at &&
            Date.parse(row.lease_expires_at) > Date.now() && row.lease_owner !== owner) return { rowCount: 0 };
        row.lease_owner = owner;
        row.lease_expires_at = new Date(Date.now() + ttl * 1000).toISOString();
      } else if (sql.includes('SET lease_owner=NULL')) {
        if (row.lease_owner !== args[2]) return { rowCount: 0 };
        row.lease_owner = null; row.lease_expires_at = null;
      } else if (sql.includes('SET data=data || $3')) {
        if (row.status === 'closed' || !leaseOkay(row, args[3])) return { rowCount: 0 };
        Object.assign(row.data, JSON.parse(args[2]));
      } else if (sql.includes('SET status=$4')) {
        const [, , from, to, sessionId, shadowId, executionId, outcome, data, leaseOwner] = args;
        if (row.status !== from || !leaseOkay(row, leaseOwner)) return { rowCount: 0 };
        row.status = to;
        row.session_id = sessionId ?? row.session_id;
        row.shadow_id = shadowId ?? row.shadow_id;
        row.execution_id = executionId ?? row.execution_id;
        row.outcome = outcome ?? row.outcome;
        Object.assign(row.data, JSON.parse(data));
      } else throw new Error(`Unexpected SQL: ${sql}`);
      return { rowCount: 1 };
    },
    async query(sql, args) {
      statements.push(sql);
      if (sql.includes('request_key=$2')) return [rows.get(`${args[0]}/${args[1]}`)].filter(Boolean);
      if (sql.includes('parent_run_id=$2')) return [...rows.values()].filter(row =>
        row.company_id === args[0] && row.parent_run_id === args[1] &&
        row.parent_task_id === args[2] && row.status !== 'closed');
      return [...rows.values()].filter(row => row.company_id === args[0] && row.status !== 'closed');
    },
  };
  return { db, rows, statements };
}

function leaseOkay(row, owner) {
  return !owner || row.lease_owner === owner && Date.parse(row.lease_expires_at) > Date.now();
}

const input = { companyId: 'company-a', requestKey: 'request-a', fingerprint: 'digest-a',
  agentId: 'agent-a', parentRunId: 'run-a', parentTaskId: 'review',
  deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  data: { packet: { sourceRunId: 'run-a' }, taskKey: 'native-task-a' } };

test('launch claim stores restart data and blocks a second open launch for the same task', async () => {
  const { db, statements } = database(), store = createShadowLaunchStore(db);
  const first = await store.claim(input);
  assert.equal(first.created, true);
  assert.deepEqual(first.data, input.data);
  assert.equal((await store.claim(input)).created, false);
  await assert.rejects(store.claim({ ...input, requestKey: 'other-key', fingerprint: 'digest-b' }), /already has a Shadow launch/);
  assert.equal(await store.get('other-company', input.requestKey), null);
  assert.deepEqual(await store.list('other-company'), []);
  assert.ok(statements.every(sql => sql.includes('company_id')));
});

test('leases guard recovery writes and CAS transitions without repeating a claimed action', async () => {
  const { db, rows } = database(), store = createShadowLaunchStore(db);
  await store.claim(input);
  assert.equal((await store.acquireLease({ companyId: input.companyId, requestKey: input.requestKey,
    owner: 'worker-a', ttlSeconds: 30 })).leaseOwner, 'worker-a');
  assert.equal(await store.acquireLease({ companyId: input.companyId, requestKey: input.requestKey,
    owner: 'worker-b', ttlSeconds: 30 }), null);
  await assert.rejects(store.patchData({ companyId: input.companyId, requestKey: input.requestKey,
    patch: { contextRef: { snapshotId: 'snapshot-a' } }, leaseOwner: 'worker-b' }), /lease expired/);
  const patched = await store.patchData({ companyId: input.companyId, requestKey: input.requestKey,
    patch: { contextRef: { snapshotId: 'snapshot-a' } }, leaseOwner: 'worker-a' });
  assert.deepEqual(patched.data.packet, input.data.packet);
  assert.equal(patched.data.contextRef.snapshotId, 'snapshot-a');
  const creating = await store.transition({ companyId: input.companyId, requestKey: input.requestKey,
    from: 'claimed', to: 'creating', data: { actor: { id: 'owner' } }, leaseOwner: 'worker-a' });
  assert.equal(creating.status, 'creating');
  assert.equal(creating.data.taskKey, input.data.taskKey);
  await assert.rejects(store.transition({ companyId: input.companyId, requestKey: input.requestKey,
    from: 'claimed', to: 'session-created', leaseOwner: 'worker-a' }), /state changed/);
  assert.equal(await store.releaseLease({ companyId: input.companyId, requestKey: input.requestKey,
    owner: 'worker-b' }), false);
  assert.equal(await store.releaseLease({ companyId: input.companyId, requestKey: input.requestKey,
    owner: 'worker-a' }), true);
  assert.equal((await store.acquireLease({ companyId: input.companyId, requestKey: input.requestKey,
    owner: 'worker-b', ttlSeconds: 30 })).leaseOwner, 'worker-b');
  rows.get('company-a/request-a').lease_expires_at = new Date(Date.now() - 1000).toISOString();
  assert.equal((await store.acquireLease({ companyId: input.companyId, requestKey: input.requestKey,
    owner: 'worker-c', ttlSeconds: 30 })).leaseOwner, 'worker-c');
  await assert.rejects(store.acquireLease({ companyId: input.companyId,
    requestKey: input.requestKey, owner: 'worker-d', ttlSeconds: 301 }), /Invalid Shadow launch lease/);
});

test('closed launch leaves the open list and permits a new claim for the parent task', async () => {
  const { db } = database(), store = createShadowLaunchStore(db);
  await store.claim(input);
  await store.transition({ companyId: input.companyId, requestKey: input.requestKey,
    from: 'claimed', to: 'closed', outcome: 'cancelled' });
  assert.deepEqual(await store.list(input.companyId), []);
  assert.equal((await store.claim({ ...input, requestKey: 'next', fingerprint: 'next' })).created, true);
});
