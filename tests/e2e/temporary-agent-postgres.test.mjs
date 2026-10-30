import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTemporaryAgentLaunchStore } from '../../src/plugin/temporary-agent-launch-store.mjs';
import { createPostgresTemporaryAgentDatabase,
  postgresTemporaryAgentAvailable } from '../helpers/postgres-temporary-agent.mjs';

const pgTest = (name, fn) => test(name, { skip: !postgresTemporaryAgentAvailable &&
  'Set POLYFORGE_RUN_POSTGRES_TESTS=1 to run against PostgreSQL' }, fn);
const input = (companyId, parentAgentId, parentExecutionId, key, maxConcurrentChildren = 2) => ({
  companyId, requestKey: key, fingerprint: `fingerprint:${key}`,
  parentAgentId, parentExecutionId, agentId: parentAgentId,
  deadlineAt: new Date(Date.now() + 120_000).toISOString(),
  maxConcurrentChildren, data: { request: { kind: 'sub-agent' } },
});

pgTest('PostgreSQL claim is replay safe and enforces per-parent active slots', async (t) => {
  const { db, companyId, otherCompanyId } = await createPostgresTemporaryAgentDatabase(t);
  const store = createTemporaryAgentLaunchStore(db);
  const parentAgentId = randomUUID();
  const first = input(companyId, parentAgentId, 'parent-run', 'first');
  const replays = await Promise.all([store.claim(first), store.claim(first)]);
  assert.deepEqual(replays.map((row) => row.created).sort(), [false, true]);
  await assert.rejects(store.claim({ ...first, fingerprint: 'different' }),
    /idempotency key reused/);
  assert.equal((await store.claim(input(companyId, parentAgentId,
    'parent-run', 'second'))).created, true);
  await assert.rejects(store.claim(input(companyId, parentAgentId,
    'parent-run', 'third')), /concurrency limit/);
  assert.equal(await store.get(otherCompanyId, 'first'), null);
  assert.equal((await store.claim(input(otherCompanyId, parentAgentId,
    'parent-run', 'first'))).created, true);
});

pgTest('parallel claims cannot exceed slot limit and transitions keep audit events', async (t) => {
  const { db, companyId } = await createPostgresTemporaryAgentDatabase(t);
  const store = createTemporaryAgentLaunchStore(db);
  const parentAgentId = randomUUID();
  const attempts = await Promise.allSettled(['one', 'two', 'three', 'four'].map((key) =>
    store.claim(input(companyId, parentAgentId, 'parent-run', key))));
  const claimed = attempts.filter((item) => item.status === 'fulfilled');
  assert.ok(claimed.length <= 2);
  assert.ok(claimed.length >= 1);
  assert.equal((await store.list(companyId, { activeOnly: true })).length, claimed.length);
  const row = claimed[0].value;
  const held = await store.acquireLease({ companyId, requestKey: row.requestKey,
    owner: 'worker-a' });
  assert.equal(held.id, row.id);
  assert.equal(await store.acquireLease({ companyId, requestKey: row.requestKey,
    owner: 'worker-b' }), null);
  await store.transition({ companyId, requestKey: row.requestKey,
    from: 'claimed', to: 'creating', owner: 'worker-a' });
  const updated = await store.get(companyId, row.requestKey);
  assert.equal(updated.data.events.at(-1).to, 'creating');
  await assert.rejects(store.transition({ companyId, requestKey: row.requestKey,
    from: 'creating', to: 'created', owner: 'worker-b', sessionId: 'session' }),
  /lease expired|state changed/);
});
