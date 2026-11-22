import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowRuntime } from '../../src/plugin/shadow-runtime.mjs';
import { shadowTaskKey } from '../../src/plugin/shadow-native.mjs';
import { shadowReviewPacket } from '../../src/plugin/shadow-context.mjs';

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

test('authorized dispatch finishes a closing native Shadow without resending its review', async () => {
  const launches = memoryLaunches();
  const packet = shadowReviewPacket(run, 'review');
  const requestKey = `company:before-dispatch:${run.id}:review:1:${packet.snapshotId}`;
  const reviewResult = { status: 'reviewed', verdict: 'accept', candidateRefs: [ref], findings: [] };
  launches.seed({ companyId: 'company', requestKey, agentId: 'review-agent', parentRunId: run.id,
    parentTaskId: 'review', sessionId: 'session', shadowId: 'shadow', executionId: 'heartbeat',
    status: 'closing', outcome: 'completed', data: { reviewResult } });
  let authorizedScope = false;
  const closes = [];
  const host = { manifest: { id: 'plugin' }, agents: { sessions: {
    close: async (sessionId, companyId) => {
      closes.push({ sessionId, companyId, authorizedScope });
      if (!authorizedScope) throw new Error('Invocation scope expired');
    },
    create: async () => assert.fail('Existing Shadow must not create another session'),
    sendMessage: async () => assert.fail('Existing Shadow must not send another review'),
  } } };
  const control = { getShadows: async () => [{ id: 'shadow', status: 'closed',
    outcome: 'completed', reviewResult }], closeShadow: async () => assert.fail('Accepted Core result must be preserved') };
  const runtime = createShadowRuntime({ host, launchStore: launches, engineFor: async () => ({ control }) });
  await runtime.reconcile({ companyId: 'company' });
  assert.equal((await launches.get('company', requestKey)).status, 'closing');
  authorizedScope = true;
  const admission = await runtime.beforeDispatch({ companyId: 'company', run,
    node: run.graph.nodes.find(node => node.id === 'review'), agentId: 'review-agent' });
  assert.equal(admission.ready, true, 'Fresh owner dispatch must resume the reviewed Graph work');
  assert.equal(admission.status, 'accepted');
  const closed = await launches.get('company', requestKey);
  assert.equal(closed.status, 'closed');
  assert.deepEqual(closed.data.reviewResult, reviewResult);
  assert.equal(closed.data.stopRequested, undefined);
  assert.deepEqual(closes, [
    { sessionId: 'session', companyId: 'company', authorizedScope: false },
    { sessionId: 'session', companyId: 'company', authorizedScope: true },
  ]);
});

for (const [adapterType, interruption] of [
  ['codex_local'], ['process'], ['paperclip_runner'], ['paperclip_runner', 'create'],
  ['paperclip_runner', 'assignment'], ['paperclip_runner', 'wake'], ['paperclip_runner', 'revocation'],
  ['paperclip_runner', 'late reconciliation'], ['paperclip_runner', 'late finish'], ['paperclip_runner', 'owner replay'],
  ['paperclip_runner', 'disabled owner replay'], ['paperclip_runner', 'lost assignment'],
  ['paperclip_runner', 'ambiguous executions'], ['paperclip_runner', 'unfinished issue'],
  ['paperclip_runner', 'reassigned issue'],
]) {
test(`${adapterType} launch ${interruption ? `handles ${interruption} interruption` : 'wakes once and replays closed'}`, async () => {
  const launches = memoryLaunches();
  const events = [];
  let nativeRun = null;
  const agent = { id: 'review-agent', companyId: 'company', adapterType,
    status: 'idle', adapterConfig: { timeoutSec: 120 },
    runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } },
    budgetMonthlyCents: 1000, spentMonthlyCents: 0 };
  const policy = { enabled: true, allowSameAgent: true, allowGraphTrigger: true,
    maxDurationSeconds: 180, allowedAdapterTypes: [adapterType] };
  const issueBacked = adapterType === 'paperclip_runner';
  const disabledRecovery = interruption === 'disabled owner replay';
  const ownerReplay = disabledRecovery || interruption === 'owner replay';
  let authorizedScope = true;
  let issue;
  let assignmentLost = false;
  const shadow = { id: 'shadow', status: 'reserved', executionId: null };
  const control = {
    getShadowPolicy: async () => policy,
    recordShadowContext: async () => ({ id: 'snapshot-record' }),
    prepareShadow: async ({ sessionId }) => {
      assert.equal(sessionId, issueBacked ? 'shadow-issue' : 'session');
      events.push('prepare'); return shadow;
    },
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
    query: async (sql, params) => {
      if (sql.includes('count(*)')) return [{ total: 0 }];
      if (issueBacked) {
        assert.match(sql, /issue_id=/);
        assert.equal(params.at(-1), 'shadow-issue');
      }
      if (nativeRun && interruption === 'ambiguous executions') return [nativeRun, { ...nativeRun, id: 'heartbeat-2' }];
      return nativeRun ? [nativeRun] : [];
    } },
  agents: { get: async () => agent, sessions: {
    create: async () => { assert.equal(issueBacked, false); events.push('create'); return { sessionId: 'session' }; },
    sendMessage: async () => { assert.equal(issueBacked, false); events.push('send'); nativeRun = { id: 'heartbeat',
      status: 'queued', result_json: null, finished_at: null }; return { runId: 'heartbeat' }; },
    close: async () => { assert.equal(issueBacked, false); events.push('session-close'); },
  } }, issues: {
    list: async () => issue ? [issue] : [],
    create: async (request) => {
      assert.equal(request.projectId, 'project');
      assert.equal(request.parentId, 'issue');
      assert.equal(request.status, 'backlog');
      assert.equal(request.assigneeAgentId, undefined);
      assert.match(request.description, /paperclip_finish/);
      assert.match(request.description, /Do not call Graph commands/);
      events.push('issue-create');
      issue = { ...request, id: 'shadow-issue', workMode: 'standard', assigneeAgentId: null };
      if (interruption === 'create') throw new Error('Fixture reply lost');
      return issue;
    },
    get: async (id, companyId) => {
      assert.equal(id, 'shadow-issue'); assert.equal(companyId, 'company');
      if (!authorizedScope) throw new Error('Invocation scope expired');
      return issue;
    },
    update: async (id, patch, companyId) => {
      assert.equal(id, 'shadow-issue'); assert.equal(companyId, 'company');
      if (patch.status === 'cancelled') events.push('issue-cancel');
      else {
        assert.deepEqual(patch, { assigneeAgentId: 'review-agent', status: 'todo' });
        events.push('issue-assign');
        if (interruption === 'lost assignment' && !assignmentLost) {
          assignmentLost = true; throw new Error('Fixture reply lost');
        }
        if (interruption === 'revocation') policy.allowGraphTrigger = false;
      }
      issue = { ...issue, ...patch };
      if (interruption === 'assignment' && patch.assigneeAgentId) throw new Error('Fixture reply lost');
      return issue;
    },
    requestWakeup: async (id, companyId, options) => {
      assert.equal(id, 'shadow-issue'); assert.equal(companyId, 'company');
      assert.ok(options?.idempotencyKey);
      events.push('send'); nativeRun = { id: 'heartbeat', status: 'queued', result_json: null, finished_at: null };
      if (['wake', 'ambiguous executions'].includes(interruption)) throw new Error('Fixture reply lost');
      return { queued: true, runId: 'heartbeat' };
    },
  } };
  const deps = { host, launchStore: launches, engineFor: async () =>
    ({ engine: { getRun: async () => run }, control }),
  getConfig: async () => ({ roleBindings: { 'pack:reviewer': 'review-agent' } }) };
  const runtime = createShadowRuntime(deps);
  const actor = ownerReplay ? { id: 'owner', kind: 'human', roles: ['human-owner'] }
    : { id: 'plugin', kind: 'system', roles: ['shadow-orchestrator'] };
  const payload = { parentRunId: 'graph-run', parentTaskId: 'review', agentId: 'review-agent' };
  const common = { idempotencyKey: 'request', reason: 'Independent review' };
  const request = { companyId: 'company', actor, payload, common };
  let opened;
  if (['create', 'assignment', 'wake', 'lost assignment', 'ambiguous executions'].includes(interruption)) {
    await assert.rejects(runtime.open(request), /Fixture reply lost/);
    [opened] = await createShadowRuntime(deps).reconcile({ companyId: 'company' });
  } else opened = await runtime.open(request);
  if (interruption === 'ambiguous executions') {
    assert.equal(opened.status, 'closed');
    assert.equal(shadow.outcome, 'failed');
    assert.equal(issue.status, 'cancelled');
    assert.deepEqual(events, ['issue-create', 'prepare', 'issue-assign', 'send', 'close', 'issue-cancel']);
    return;
  }
  if (interruption === 'revocation') {
    assert.equal(opened.status, 'closed');
    assert.equal(opened.executionId, null);
    assert.equal(shadow.outcome, 'cancelled');
    assert.deepEqual(events, ['issue-create', 'prepare', 'issue-assign', 'close', 'issue-cancel']);
    return;
  }
  assert.equal(opened.executionId, 'heartbeat');
  const assignments = interruption === 'lost assignment' ? ['issue-assign', 'issue-assign'] : ['issue-assign'];
  assert.deepEqual(events, issueBacked ? ['issue-create', 'prepare', ...assignments, 'send', 'bind'] : ['create', 'prepare', 'send', 'bind']);
  if (ownerReplay) {
    assert.equal((await runtime.open(request)).status, 'active');
    assert.equal(events.at(-1), 'bind');
  }
  const stored = await launches.get('company', 'company:request');
  if (interruption?.startsWith('late ')) {
    launches.seed({ ...stored, deadlineAt: new Date(Date.now() - 1_000).toISOString() });
  }
  const packet = stored.data.packet;
  const reply = { schema: 'polyforge.shadow.review.v1', status: 'reviewed', schemaVersion: 1,
    verdict: 'accept', snapshotId: packet.snapshotId, sourceRunId: packet.sourceRunId,
    candidateRefs: packet.candidates, findings: [] };
  if (adapterType === 'process') {
    delete reply.schema;
    reply.fixture = 'local-process-shadow-review';
  }
  nativeRun = { id: 'heartbeat', status: 'succeeded',
    result_json: issueBacked ? {
      nativeTerminal: { schema: 'paperclip.prp.terminal.v1', runTerminalState: 'succeeded',
        turnTerminalState: 'completed', reportedWorkDisposition: 'done' },
      nativeResult: { schema: 'paperclip.run_result.v1', reportedWorkDisposition: 'done', summary: JSON.stringify(reply) },
    } : { [adapterType === 'process' ? 'stdout' : 'summary']: JSON.stringify(reply) },
    finished_at: new Date(Date.now() - (interruption === 'late reconciliation' ? 2_000 : 0)).toISOString() };
  if (interruption === 'reassigned issue') issue = { ...issue, assigneeAgentId: 'other-agent', status: 'in_progress' };
  else if (interruption === 'unfinished issue') {
    issue.status = 'in_review';
    await createShadowRuntime(deps).reconcile({ companyId: 'company' });
    assert.equal((await launches.get('company', 'company:request')).status, 'active');
    assert.equal(shadow.status, 'active');
    nativeRun.finished_at = new Date(Date.now() - 2_000).toISOString();
    launches.seed({ ...(await launches.get('company', 'company:request')),
      deadlineAt: new Date(Date.now() - 1_000).toISOString() });
  } else if (issueBacked) issue.status = 'done';
  if (ownerReplay) {
    authorizedScope = false;
    await createShadowRuntime(deps).reconcile({ companyId: 'company' });
    assert.equal((await launches.get('company', 'company:request')).status, 'active');
    assert.equal(shadow.status, 'active');
    authorizedScope = true;
    const retry = { ...request, available: !disabledRecovery };
    if (disabledRecovery) {
      policy.enabled = false;
      await assert.rejects(runtime.open({ ...retry, common: { ...common, idempotencyKey: 'different-request' } }), /capability unavailable/);
      await assert.rejects(runtime.open({ ...retry, actor: { ...actor, roles: [] } }), /capability unavailable/);
      const getIssue = host.issues.get;
      delete host.issues.get;
      await assert.rejects(runtime.open(retry), /terminal cleanup requires issue read and update support/);
      host.issues.get = getIssue;
    }
    await assert.rejects(runtime.open({ ...retry, actor: { ...actor, id: 'different-owner' } }), /idempotency key reused/);
    assert.equal((await launches.get('company', 'company:request')).status, 'active');
    const replay = await runtime.open(retry);
    assert.equal(replay.replayed, true);
    assert.equal(replay.status, 'closed');
    assert.deepEqual(await runtime.open(retry), replay);
  } else await createShadowRuntime(deps).reconcile({ companyId: 'company' });
  const outcome = disabledRecovery ? 'cancelled' : interruption === 'late finish' ? 'timeout'
    : ['unfinished issue', 'reassigned issue'].includes(interruption) ? 'failed' : 'completed';
  if (interruption === 'unfinished issue') assert.equal(issue.status, 'cancelled');
  if (interruption === 'reassigned issue') {
    assert.equal(issue.assigneeAgentId, 'other-agent');
    assert.equal(events.includes('issue-cancel'), false);
  }
  assert.equal(shadow.outcome, outcome);
  assert.equal(shadow.reviewResult?.verdict, outcome === 'completed' ? 'accept' : undefined);
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
