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

test('native launch wakes once, reconciles durable terminal result after worker restart, and replays closed', async () => {
  const launches = memoryLaunches();
  const events = [];
  let nativeRun = null;
  const agent = { id: 'review-agent', companyId: 'company', adapterType: 'codex_local',
    status: 'idle', adapterConfig: { timeoutSec: 120 },
    runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } },
    budgetMonthlyCents: 1000, spentMonthlyCents: 0 };
  const policy = { enabled: true, allowSameAgent: true, allowGraphTrigger: true,
    maxDurationSeconds: 180, allowedAdapterTypes: ['codex_local'] };
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
  nativeRun = { id: 'heartbeat', status: 'succeeded', result_json: { summary: JSON.stringify(reply) },
    finished_at: new Date().toISOString() };
  await createShadowRuntime(deps).reconcile({ companyId: 'company' });
  assert.equal(shadow.outcome, 'completed');
  assert.equal(shadow.reviewResult.verdict, 'accept');
  assert.equal((await launches.get('company', 'company:request')).status, 'closed');
  agent.spentMonthlyCents = 1000;
  assert.equal((await runtime.open({ companyId: 'company', actor, payload, common })).replayed, true);
  assert.equal(events.filter((event) => event === 'send').length, 1);
});

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
