import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowRuntime } from '../../src/plugin/shadow-runtime.mjs';
import { shadowTaskKey } from '../../src/plugin/shadow-native.mjs';

const ref = { kind: 'candidate', id: 'artifact', version: 'v1', digest: `sha256:${'a'.repeat(64)}` };
const run = { id: 'graph-run', status: 'running', packId: 'pack', packVersion: '1',
  input: { paperclipCompanyId: 'company', projectId: 'project', paperclipIssueId: 'issue' },
  graph: { id: 'graph', nodes: [{ id: 'source' }, { id: 'review', role: 'reviewer',
    shadow: { trigger: 'before-dispatch', reviewer: 'same-agent', required: true } }],
  edges: [{ from: 'source', to: 'review' }] },
  nodeStates: { source: { status: 'completed', artifacts: [ref],
    attempts: [{ output: { implementation: 'candidate content' } }] },
  review: { status: 'pending', attempts: [] } } };

function memoryLaunches() {
  const records = new Map();
  const clone = (value) => structuredClone(value);
  return {
    seed(row) { records.set(row.requestKey, clone(row)); },
    async claim(input) {
      if (records.has(input.requestKey)) return { ...clone(records.get(input.requestKey)), created: false };
      const row = { ...clone(input), status: 'claimed', sessionId: null, shadowId: null,
        executionId: null, outcome: null, leaseOwner: null };
      records.set(input.requestKey, row);
      return { ...clone(row), created: true };
    },
    async get(_companyId, key) { return clone(records.get(key) ?? null); },
    async list(companyId) { return [...records.values()].filter((row) =>
      row.companyId === companyId && row.status !== 'closed').map(clone); },
    async acquireLease({ requestKey, owner }) {
      const row = records.get(requestKey);
      if (!row || row.leaseOwner) return null;
      row.leaseOwner = owner; return clone(row);
    },
    async releaseLease({ requestKey, owner }) {
      const row = records.get(requestKey);
      if (row?.leaseOwner !== owner) return false;
      row.leaseOwner = null; return true;
    },
    async transition({ requestKey, from, to, data = {}, ...patch }) {
      const row = records.get(requestKey);
      assert.equal(row.status, from);
      row.status = to; Object.assign(row, Object.fromEntries(Object.entries(patch).filter(([key, value]) =>
        value !== null && !['companyId', 'leaseOwner'].includes(key))));
      row.data = { ...row.data, ...data }; return clone(row);
    },
    async patchData({ requestKey, patch }) {
      const row = records.get(requestKey); row.data = { ...row.data, ...patch }; return clone(row);
    },
  };
}

for (const adapterType of ['codex_local', 'process']) {
test(`${adapterType} launch wakes once, reconciles terminal review after restart, and replays closed`, async () => {
  const launches = memoryLaunches();
  const events = [];
  let nativeRun = null;
  const agent = { id: 'review-agent', companyId: 'company', adapterType,
    status: 'idle', adapterConfig: { timeoutSec: 120 },
    runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } },
    budgetMonthlyCents: 1000, spentMonthlyCents: 0 };
  const policy = { enabled: true, allowSameAgent: true, allowGraphTrigger: true,
    maxDurationSeconds: 180, allowedAdapterTypes: ['codex_local', 'process'] };
  const shadow = { id: 'shadow', status: 'reserved', executionId: null };
  const control = {
    getShadowPolicy: async () => policy,
    recordShadowContext: async () => ({ id: 'snapshot-record' }),
    prepareShadow: async () => { events.push('prepare'); return shadow; },
    getShadows: async () => [shadow],
    bindShadowExecution: async ({ executionId }) => {
      events.push('bind'); shadow.status = 'active'; shadow.executionId = executionId;
    },
    closeShadow: async ({ outcome, reviewResult }) => {
      events.push('close'); shadow.status = 'closed'; shadow.outcome = outcome;
      shadow.reviewResult = reviewResult;
    },
  };
  const host = { manifest: { id: 'plugin' }, db: { namespace: 'plugin_test',
    query: async (sql) => sql.includes('count(*)') ? [{ total: 0 }] : nativeRun ? [nativeRun] : [] },
  agents: { get: async () => agent, sessions: {
    create: async () => { events.push('create'); return { sessionId: 'session' }; },
    sendMessage: async () => { events.push('send'); nativeRun = { id: 'heartbeat',
      status: 'queued', result_json: null, finished_at: null }; return { runId: 'heartbeat' }; },
    close: async () => { events.push('session-close'); },
  } } };
  const deps = { host, launchStore: launches, engineFor: async () =>
    ({ engine: { getRun: async () => run }, control }),
  getConfig: async () => ({ roleBindings: { 'pack:reviewer': 'review-agent' } }) };
  const runtime = createShadowRuntime(deps);
  const actor = { id: 'plugin', kind: 'system', roles: ['shadow-orchestrator'] };
  const payload = { parentRunId: 'graph-run', parentTaskId: 'review', agentId: 'review-agent' };
  const common = { idempotencyKey: 'request', reason: 'Independent review' };
  const opened = await runtime.open({ companyId: 'company', actor, payload, common });
  assert.equal(opened.executionId, 'heartbeat');
  assert.deepEqual(events, ['create', 'prepare', 'send', 'bind']);
  const stored = await launches.get('company', 'company:request');
  const packet = stored.data.packet;
  const reply = { schema: 'polyforge.shadow.review.v1', status: 'reviewed', schemaVersion: 1,
    verdict: 'accept', snapshotId: packet.snapshotId, sourceRunId: packet.sourceRunId,
    candidateRefs: packet.candidates, findings: [] };
  if (adapterType === 'process') {
    delete reply.schema;
    reply.fixture = 'local-process-shadow-review';
  }
  nativeRun = { id: 'heartbeat', status: 'succeeded',
    result_json: { [adapterType === 'process' ? 'stdout' : 'summary']: JSON.stringify(reply) },
    finished_at: new Date().toISOString() };
  await createShadowRuntime(deps).reconcile({ companyId: 'company' });
  assert.equal(shadow.outcome, 'completed');
  assert.equal(shadow.reviewResult.verdict, 'accept');
  assert.equal((await launches.get('company', 'company:request')).status, 'closed');
  agent.spentMonthlyCents = 1000;
  assert.equal((await runtime.open({ companyId: 'company', actor, payload, common })).replayed, true);
  assert.equal(events.filter((event) => event === 'send').length, 1);
});
}

test('legacy active launch waits for its exact terminal heartbeat and preserves closed Core review', async () => {
  const launches = memoryLaunches();
  const requestKey = 'company:legacy';
  const storedReview = { status: 'reviewed', verdict: 'accept', findings: [] };
  launches.seed({ companyId: 'company', requestKey, agentId: 'review-agent',
    parentRunId: 'graph-run', parentTaskId: 'review', sessionId: 'session',
    shadowId: 'shadow', executionId: 'heartbeat', status: 'active', outcome: null,
    deadlineAt: new Date(Date.now() + 60000).toISOString(), data: {} });
  const events = [];
  let nativeStatus = 'running';
  const host = { manifest: { id: 'plugin' }, db: { namespace: 'plugin_test',
    query: async (_sql, params) => {
      assert.deepEqual(params, ['company', 'review-agent', 'heartbeat',
        shadowTaskKey('plugin', requestKey)]);
      return [{ id: 'heartbeat', status: nativeStatus,
        finished_at: nativeStatus === 'succeeded' ? new Date().toISOString() : null }];
    } }, agents: { sessions: {
      close: async (sessionId, companyId) => { events.push(['session-close', sessionId, companyId]); },
      create: async () => { throw new Error('must not create another session'); },
      sendMessage: async () => { throw new Error('must not wake another run'); },
    } } };
  const control = { getShadows: async () => [{ id: 'shadow', status: 'closed',
    outcome: 'completed', reviewResult: storedReview }],
  closeShadow: async () => { throw new Error('must not close Core again'); } };
  const runtime = createShadowRuntime({ host, launchStore: launches,
    engineFor: async () => ({ control }) });
  await runtime.reconcile({ companyId: 'company' });
  assert.equal((await launches.get('company', requestKey)).status, 'active');
  nativeStatus = 'succeeded';
  await runtime.reconcile({ companyId: 'company' });
  const closed = await launches.get('company', requestKey);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.outcome, 'completed');
  assert.deepEqual(closed.data.reviewResult, storedReview);
  assert.deepEqual(events, [['session-close', 'session', 'company']]);
});

test('stop before native send closes reserved launch without waking an Agent', async () => {
  const launches = memoryLaunches();
  const requestKey = 'company:stopped';
  launches.seed({ companyId: 'company', requestKey, agentId: 'review-agent',
    parentRunId: 'graph-run', parentTaskId: 'review', sessionId: 'session',
    shadowId: 'shadow', executionId: null, status: 'reserved', outcome: null,
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
    data: { stopRequested: true } });
  const events = [];
  const host = { manifest: { id: 'plugin' }, agents: { sessions: {
    close: async () => { events.push('session-close'); },
    sendMessage: async () => { throw new Error('must not wake stopped Shadow'); },
  } } };
  const shadow = { id: 'shadow', status: 'reserved' };
  const control = { getShadows: async () => [shadow],
    closeShadow: async ({ outcome }) => { events.push('core-close'); shadow.status = 'closed';
      shadow.outcome = outcome; } };
  await createShadowRuntime({ host, launchStore: launches,
    engineFor: async () => ({ control }) }).reconcile({ companyId: 'company' });
  const closed = await launches.get('company', requestKey);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.outcome, 'cancelled');
  assert.deepEqual(events, ['core-close', 'session-close']);
});

test('Core veto leaves a launch unchanged; authorized stop closes without native send', async () => {
  const launches = memoryLaunches();
  const requestKey = 'company:stop-veto';
  launches.seed({ companyId: 'company', requestKey, agentId: 'review-agent',
    parentRunId: 'graph-run', parentTaskId: 'review', sessionId: 'session',
    shadowId: 'shadow', executionId: null, status: 'reserved', outcome: null,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(), data: {} });
  const events = [];
  let permitted = false;
  const shadow = { id: 'shadow', status: 'reserved' };
  const control = {
    requestShadowStop: async () => {
      events.push('core-stop');
      if (!permitted) throw new Error('Core veto');
      return { stopReason: 'Operator stop', stopRequestedAt: new Date().toISOString() };
    },
    getShadows: async () => [shadow],
    closeShadow: async ({ outcome }) => {
      events.push('core-close'); shadow.status = 'closed'; shadow.outcome = outcome;
      return shadow;
    },
  };
  const host = { manifest: { id: 'plugin' }, agents: { sessions: {
    sendMessage: async () => { throw new Error('stopped Shadow must not send'); },
    close: async () => { events.push('session-close'); },
  } } };
  const runtime = createShadowRuntime({ host, launchStore: launches,
    engineFor: async () => ({ control }) });
  const input = { companyId: 'company', shadowId: 'shadow',
    actor: { id: 'human', kind: 'human', roles: ['human-owner'] } };
  await assert.rejects(runtime.closeByShadowId(input), /Core veto/);
  assert.equal((await launches.get('company', requestKey)).data.stopRequested, undefined);
  assert.equal((await launches.get('company', requestKey)).status, 'reserved');
  permitted = true;
  const closed = await runtime.closeByShadowId(input);
  assert.equal(closed.status, 'closed');
  assert.equal((await launches.get('company', requestKey)).outcome, 'cancelled');
  assert.deepEqual(events, ['core-stop', 'core-stop', 'core-close', 'session-close']);
});

test('expired uncertain create and send enter repair without repeating either host effect', async () => {
  const launches = memoryLaunches();
  const deadlineAt = new Date(Date.now() - 1000).toISOString();
  for (const [requestKey, status] of [['company:create-unknown', 'creating'],
    ['company:send-unknown', 'starting']]) {
    launches.seed({ companyId: 'company', requestKey, agentId: 'review-agent',
      parentRunId: `run:${requestKey}`, parentTaskId: 'review',
      sessionId: status === 'starting' ? 'session' : null,
      shadowId: status === 'starting' ? 'shadow' : null,
      executionId: null, status, outcome: null, deadlineAt,
      data: { taskKey: shadowTaskKey('plugin', requestKey) } });
  }
  const host = { manifest: { id: 'plugin' }, db: { query: async () => [] },
    agents: { sessions: {
      create: async () => { throw new Error('must not repeat uncertain create'); },
      sendMessage: async () => { throw new Error('must not repeat uncertain send'); },
      close: async () => { throw new Error('must not close unknown native work'); },
    } } };
  const runtime = createShadowRuntime({ host, launchStore: launches,
    engineFor: async () => { throw new Error('must not assume unknown native work is done'); } });
  await runtime.reconcile({ companyId: 'company' });
  const creating = await launches.get('company', 'company:create-unknown');
  const starting = await launches.get('company', 'company:send-unknown');
  assert.equal(creating.status, 'needs-repair');
  assert.equal(creating.data.repairReason, 'session_create_outcome_unknown');
  assert.equal(starting.status, 'needs-repair');
  assert.equal(starting.data.repairReason, 'session_send_outcome_unknown');
});
