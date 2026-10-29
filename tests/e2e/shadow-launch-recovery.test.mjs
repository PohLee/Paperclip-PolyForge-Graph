import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createShadowLaunchStore } from '../../src/plugin/shadow-launch-store.mjs';
import { createShadowRuntime } from '../../src/plugin/shadow-runtime.mjs';
import { createPostgresShadowDatabase, postgresShadowAvailable } from '../helpers/postgres-shadow.mjs';

const pgTest = (name, fn) => test(name, { skip: !postgresShadowAvailable &&
  'Set POLYFORGE_RUN_POSTGRES_TESTS=1 to run against PostgreSQL' }, fn);

function claimInput(companyId, requestKey, agentId = randomUUID()) {
  return { companyId, requestKey, fingerprint: `fingerprint:${requestKey}`,
    agentId, parentRunId: 'graph-run', parentTaskId: 'review',
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    data: { packet: { sourceRunId: 'graph-run' }, taskKey: `native:${requestKey}` } };
}

pgTest('PostgreSQL claim is unique by request and open parent task, scoped to company', async (t) => {
  const { db, companyId, otherCompanyId } = await createPostgresShadowDatabase(t);
  const store = createShadowLaunchStore(db);
  const input = claimInput(companyId, 'request-a');
  const claimed = await Promise.all([store.claim(input), store.claim(input)]);
  assert.deepEqual(claimed.map((row) => row.created).sort(), [false, true]);
  assert.deepEqual((await store.get(companyId, input.requestKey)).data, input.data);
  await assert.rejects(store.claim({ ...input, requestKey: 'request-b', fingerprint: 'other' }),
    /already has a Shadow launch/);
  assert.equal(await store.get(otherCompanyId, input.requestKey), null);
  assert.deepEqual(await store.list(otherCompanyId), []);
  assert.equal((await store.claim(claimInput(otherCompanyId, 'request-a'))).created, true);
});

pgTest('PostgreSQL lease and CAS enforce legal progress and stop before native send', async (t) => {
  const { db, sql, namespace, companyId } = await createPostgresShadowDatabase(t);
  const store = createShadowLaunchStore(db);
  const input = claimInput(companyId, 'request-c');
  await store.claim(input);
  assert.equal((await store.acquireLease({ companyId, requestKey: input.requestKey,
    owner: 'worker-a', ttlSeconds: 30 })).leaseOwner, 'worker-a');
  assert.equal(await store.acquireLease({ companyId, requestKey: input.requestKey,
    owner: 'worker-b', ttlSeconds: 30 }), null);
  await assert.rejects(store.transition({ companyId, requestKey: input.requestKey,
    from: 'claimed', to: 'creating' }), /requires a lease owner/);
  await assert.rejects(store.transition({ companyId, requestKey: input.requestKey,
    from: 'claimed', to: 'closed', leaseOwner: 'worker-a' }), /Illegal Shadow launch transition/);
  await assert.rejects(store.transition({ companyId, requestKey: input.requestKey,
    from: 'claimed', to: 'creating', leaseOwner: 'worker-b' }), /state changed/);
  await store.transition({ companyId, requestKey: input.requestKey,
    from: 'claimed', to: 'creating', leaseOwner: 'worker-a' });
  await assert.rejects(store.transition({ companyId, requestKey: input.requestKey,
    from: 'claimed', to: 'creating', leaseOwner: 'worker-a' }), /state changed/);
  await store.transition({ companyId, requestKey: input.requestKey,
    from: 'creating', to: 'session-created', sessionId: 'session', leaseOwner: 'worker-a' });
  await store.transition({ companyId, requestKey: input.requestKey,
    from: 'session-created', to: 'reserved', shadowId: 'shadow', leaseOwner: 'worker-a' });
  await store.patchData({ companyId, requestKey: input.requestKey,
    patch: { stopRequested: true }, leaseOwner: 'worker-a' });
  await assert.rejects(store.transition({ companyId, requestKey: input.requestKey,
    from: 'reserved', to: 'starting', leaseOwner: 'worker-a' }), /state changed/);
  assert.equal((await store.get(companyId, input.requestKey)).status, 'reserved');
  await sql.unsafe(`UPDATE ${namespace}.graph_shadow_launch SET lease_expires_at=now()-interval '1 second'
    WHERE company_id=$1 AND request_key=$2`, [companyId, input.requestKey]);
  assert.equal((await store.acquireLease({ companyId, requestKey: input.requestKey,
    owner: 'worker-b', ttlSeconds: 30 })).leaseOwner, 'worker-b');
  await assert.rejects(store.transition({ companyId, requestKey: input.requestKey,
    from: 'reserved', to: 'closing', leaseOwner: 'worker-a' }), /state changed/);
  await store.transition({ companyId, requestKey: input.requestKey,
    from: 'reserved', to: 'closing', outcome: 'cancelled', leaseOwner: 'worker-b' });
  await store.transition({ companyId, requestKey: input.requestKey,
    from: 'closing', to: 'closed', leaseOwner: 'worker-b' });
  assert.deepEqual(await store.list(companyId), []);
  assert.equal((await store.claim({ ...input, requestKey: 'next', fingerprint: 'next' })).created, true);
});

pgTest('runtime restart reconciles one native result through the PostgreSQL launch store', async (t) => {
  const { db, companyId } = await createPostgresShadowDatabase(t);
  const agentId = randomUUID();
  const events = [];
  let nativeRun = null;
  const agent = { id: agentId, companyId, adapterType: 'codex_local', status: 'idle',
    adapterConfig: { timeoutSec: 120 },
    runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } },
    budgetMonthlyCents: 1000, spentMonthlyCents: 0 };
  const policy = { enabled: true, allowSameAgent: true, allowGraphTrigger: true,
    maxDurationSeconds: 180, allowedAdapterTypes: ['codex_local'] };
  const ref = { kind: 'candidate', id: 'artifact', version: 'v1', digest: `sha256:${'a'.repeat(64)}` };
  const run = { id: 'graph-run', status: 'running', packId: 'pack', packVersion: '1',
    input: { paperclipCompanyId: companyId, projectId: 'project', paperclipIssueId: 'issue' },
    graph: { id: 'graph', nodes: [{ id: 'source' }, { id: 'review', role: 'reviewer',
      shadow: { trigger: 'before-dispatch', reviewer: 'same-agent', required: true } }],
    edges: [{ from: 'source', to: 'review' }] },
    nodeStates: { source: { status: 'completed', artifacts: [ref],
      attempts: [{ output: { implementation: 'candidate content' } }] },
    review: { status: 'pending', attempts: [] } } };
  const shadow = { id: 'shadow', status: 'reserved', executionId: null };
  const control = { getShadowPolicy: async () => policy,
    recordShadowContext: async () => ({ id: 'snapshot-record' }),
    prepareShadow: async () => { events.push('prepare'); return shadow; },
    getShadows: async () => [shadow],
    bindShadowExecution: async ({ executionId }) => { events.push('bind');
      shadow.status = 'active'; shadow.executionId = executionId; },
    closeShadow: async ({ outcome, reviewResult }) => { events.push('close');
      shadow.status = 'closed'; shadow.outcome = outcome; shadow.reviewResult = reviewResult;
      return shadow; } };
  const host = { manifest: { id: 'plugin' }, db: { ...db,
    query: async (statement, params) => statement.includes('public.heartbeat_runs')
      ? statement.includes('count(*)') ? [{ total: 0 }] : nativeRun ? [nativeRun] : []
      : db.query(statement, params) },
  agents: { get: async () => agent, sessions: {
    create: async () => { events.push('create'); return { sessionId: 'session' }; },
    sendMessage: async () => { events.push('send'); nativeRun = { id: 'heartbeat',
      status: 'queued', result_json: null, finished_at: null }; return { runId: 'heartbeat' }; },
    close: async () => { events.push('session-close'); },
  } } };
  const deps = { host, launchStore: createShadowLaunchStore(db),
    engineFor: async () => ({ engine: { getRun: async () => run }, control }),
    getConfig: async () => ({ roleBindings: { 'pack:reviewer': agentId } }) };
  const actor = { id: 'plugin', kind: 'system', roles: ['shadow-orchestrator'] };
  const payload = { parentRunId: 'graph-run', parentTaskId: 'review', agentId };
  const common = { idempotencyKey: 'request', reason: 'Independent review' };
  const opened = await createShadowRuntime(deps).open({ companyId, actor, payload, common });
  assert.equal(opened.executionId, 'heartbeat');
  const store = createShadowLaunchStore(db);
  const launch = await store.get(companyId, `${companyId}:request`);
  const packet = launch.data.packet;
  const reply = { schema: 'polyforge.shadow.review.v1', status: 'reviewed', schemaVersion: 1,
    verdict: 'accept', snapshotId: packet.snapshotId, sourceRunId: packet.sourceRunId,
    candidateRefs: packet.candidates, findings: [] };
  nativeRun = { id: 'heartbeat', status: 'succeeded',
    result_json: { summary: JSON.stringify(reply) }, finished_at: new Date().toISOString() };
  await createShadowRuntime(deps).reconcile({ companyId });
  const closed = await store.get(companyId, `${companyId}:request`);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.outcome, 'completed');
  assert.equal(closed.data.reviewResult.verdict, 'accept');
  assert.equal((await createShadowRuntime(deps).open({ companyId, actor, payload, common })).replayed, true);
  assert.equal(events.filter((event) => event === 'send').length, 1);
});
