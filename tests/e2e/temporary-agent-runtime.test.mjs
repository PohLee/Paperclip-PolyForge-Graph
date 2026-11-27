import test from 'node:test';
import assert from 'node:assert/strict';
import { createTemporaryAgentRuntime } from '../../src/plugin/temporary-agent-runtime.mjs';
import { createTemporaryAgentSnapshot } from '../../src/plugin/temporary-agent-snapshot.mjs';

const companyId = 'company-a';
const parentAgentId = 'agent-a';
const parentExecutionId = 'parent-run-a';
const actor = { kind: 'agent', id: parentAgentId, executionId: parentExecutionId };
const owner = { kind: 'human', id: 'owner-a', roles: ['human-owner'] };
const deadline = () => new Date(Date.now() + 120_000).toISOString();
const request = (kind = 'sub-agent') => ({
  id: 'delegation-a', kind, purpose: 'research',
  parent: { agentId: parentAgentId, executionId: parentExecutionId, taskId: 'issue-a' },
  context: { mode: kind === 'sub-agent' ? 'fresh' : 'fork', parentSessionRef: 'parent-session-a' },
  brief: { objective: 'Research source A', scope: 'One source', outputFormat: 'JSON',
    boundaries: ['Read only'], inputRefs: [{ kind: 'document', id: 'source-a' }],
    acceptanceCriteria: ['Cite source A'], allowedActions: ['research'],
    deadlineAt: deadline() },
  limits: { maxTasks: 1, maxConcurrent: 1 },
  workspace: { mode: 'shared', writeAccess: 'none' },
});
const snapshotRequest = () => ({ ...request('shadow-agent'),
  context: { mode: 'snapshot', parentSessionRef: 'parent-session-a',
    snapshot: { objective: 'Assess calculator arithmetic',
      currentState: 'Parent suggests floating point, contrary to a prior rejection.',
      conclusions: ['Floating point seems easier'],
      openQuestions: ['Which arithmetic policy is authoritative?'],
      evidenceRefs: [{ kind: 'document', id: 'source-a' }] } } });

function fixture({ capturedAt, parallelAgents = 3, loseSendReceipt = false } = {}) {
  const rows = new Map();
  const calls = { create: 0, send: 0, close: 0, prompts: [] };
  let heartbeats = [];
  let sessions = [];
  let busy = false;
  const store = {
    async get(_company, key) { return rows.get(key) ?? null; },
    async getById(_company, id) { return [...rows.values()].find((row) => row.id === id) ?? null; },
    async list(_company, options = {}) { return [...rows.values()].filter((row) =>
      (!options.activeOnly || row.status !== 'closed') &&
      (!options.parentAgentId || row.parentAgentId === options.parentAgentId) &&
      (!options.parentExecutionId || row.parentExecutionId === options.parentExecutionId)); },
    async claim(input) {
      if (rows.has(input.requestKey)) return { ...rows.get(input.requestKey), created: false };
      const row = { ...input, id: 'temporary-a', status: 'claimed',
        sessionId: null, executionId: null, outcome: null };
      rows.set(input.requestKey, row);
      return { ...row, created: true };
    },
    async acquireLease({ requestKey }) { return busy ? null : rows.get(requestKey); },
    async releaseLease() {},
    async transition({ requestKey, from, to, sessionId, executionId, outcome, data }) {
      const old = rows.get(requestKey);
      assert.equal(old.status, from);
      const next = { ...old, status: to, sessionId: sessionId ?? old.sessionId,
        executionId: executionId ?? old.executionId,
        outcome: outcome ?? old.outcome, data: { ...old.data, ...data } };
      rows.set(requestKey, next);
      return next;
    },
    async patch({ requestKey, data }) {
      const old = rows.get(requestKey);
      const next = { ...old, data: { ...old.data, ...data } };
      rows.set(requestKey, next);
      return next;
    },
    async recordDecision({ requestKey, decision, data }) {
      const old = rows.get(requestKey);
      const next = { ...old, data: { ...old.data, ...data,
        events: [...(old.data.events ?? []), decision] } };
      rows.set(requestKey, next);
      return next;
    },
  };
  const host = {
    manifest: { id: 'polyforge-test' },
    db: { async query(sql, params) {
      if (sql.includes('count(*)')) return [{ total: 1 }];
      const [company, agent, keyOrId, taskKey] = params;
      return heartbeats.filter((row) => row.company_id === company && row.agent_id === agent &&
        (params.length === 3 ? row.task_key === keyOrId
          : row.id === keyOrId && row.task_key === taskKey))
        .slice(0, params.length === 3 ? 2 : 1).map((row) => ({
          ...row,
          message_session_id: sql.includes('AS message_session_id') ? row.message_session_id : undefined,
          wake_session_id: sql.includes('AS wake_session_id') ? row.wake_session_id : undefined,
        }));
    } },
    agents: {
      async get(id, company) { return id === parentAgentId && company === companyId
        ? { id, companyId: company, status: 'running',
          adapterConfig: { timeoutSec: 60 } } : null; },
      sessions: {
        async create() { calls.create++; return { sessionId: 'child-session-a',
          companyId, agentId: parentAgentId }; },
        async sendMessage(_session, _company, message) {
          calls.send++;
          calls.prompts.push(message.prompt);
          if (loseSendReceipt) throw new Error('Native send response was lost');
          return { runId: 'child-run-a' };
        },
        async close() { calls.close++; },
        async list() { return sessions; },
      },
    },
  };
  const makeRuntime = () => createTemporaryAgentRuntime({ host, launchStore: store,
    getPolicy: async () => ({ enabled: true }),
    getDeliveryLimits: async () => ({ parallelAgents }),
    resolveParentAuthority: async ({ companyId: company, request: input }) => ({ agentId: parentAgentId,
      canDelegate: true, allowedActions: ['research'],
      parentSessionRef: 'parent-session-a',
      ...(input.kind === 'shadow-agent' ? { contextSnapshot: createTemporaryAgentSnapshot({
        request: input, companyId: company, parentSessionRef: 'parent-session-a',
        ...(capturedAt ? { capturedAt } : {}),
        decisions: [
          { id: 'approved-a', type: 'product', feature: 'calculator', status: 'approved', outcome: 'Use exact arithmetic' },
          { id: 'rejected-a', type: 'product', feature: 'calculator', status: 'rejected', outcome: 'Floating point arithmetic' },
        ], control: { companyId: company, escalations: [], knowledge: [], feedback: [], plans: [] },
      }) } : {}) }) });
  const runtime = makeRuntime();
  const setHeartbeats = (...records) => {
    const taskKey = JSON.parse(calls.prompts.at(-1)).taskKey;
    heartbeats = records.map((record) => ({
      company_id: companyId, agent_id: parentAgentId, task_key: taskKey, ...record,
    }));
  };
  return { runtime, calls, setHeartbeats,
    setSessions(value) { sessions = value; },
    restart: makeRuntime,
    mutateLaunch(key, mutate) { mutate(rows.get(key)); },
    getLaunch(key) { return rows.get(key); },
    setBusy(value) { busy = value; },
    setLaunchStatus(key, status, sessionId = null) {
      const old = rows.get(key);
      rows.set(key, { ...old, status, sessionId,
        executionId: sessionId ? old.executionId : null,
        data: sessionId ? old.data : { ...old.data, contextReceipt: null } });
    } };
}

test('Temporary Agent admission uses the configured company parallel-agent cap', async () => {
  const { runtime, getLaunch } = fixture({ parallelAgents: 1 });
  await runtime.open({ companyId, actor, request: request(),
    idempotencyKey: 'first-cap', reason: 'First bounded research' });
  assert.equal(getLaunch(`${companyId}:first-cap`).maxConcurrentChildren, 1);
  await assert.rejects(runtime.open({ companyId, actor,
    request: { ...request(), id: 'delegation-b' },
    idempotencyKey: 'second-cap', reason: 'Second bounded research' }), /concurrent|limit/i);
});

test('fresh Sub-Agent creates and sends once, then reconciles a validated result', async () => {
  const { runtime, calls, setHeartbeats } = fixture();
  const input = request();
  const first = await runtime.open({ companyId, actor, request: input,
    idempotencyKey: 'key-a', reason: 'Bounded research' });
  assert.equal(first.status, 'active');
  assert.equal(first.sessionId, 'child-session-a');
  const replay = await runtime.open({ companyId, actor, request: input,
    idempotencyKey: 'key-a', reason: 'Bounded research' });
  assert.equal(replay.replayed, true);
  assert.equal(calls.create, 1);
  assert.equal(calls.send, 1);
  setHeartbeats({ id: 'child-run-a', status: 'succeeded',
    finished_at: new Date().toISOString(), result_json: { summary: JSON.stringify({
      status: 'completed', summary: 'Found source A',
      evidenceRefs: [{ kind: 'document', id: 'source-a' }], output: 'Finding',
    }) } });
  const [done] = await runtime.reconcile({ companyId });
  assert.equal(done.status, 'closed');
  assert.equal(done.outcome, 'completed');
  assert.equal(done.result.output, 'Finding');
  assert.equal(calls.close, 1);
});

test('true Shadow fork is rejected before any claim or session side effect', async () => {
  const { runtime, calls } = fixture();
  await assert.rejects(runtime.open({ companyId, actor,
    request: request('shadow-agent'), idempotencyKey: 'key-b' }), /Native Shadow-Agent fork unavailable/);
  assert.deepEqual(await runtime.list({ companyId }), []);
  assert.equal(calls.create, 0);
  assert.equal(calls.send, 0);
});

test('Shadow snapshot is frozen before fresh-session dispatch and replayed across runtime restart', async () => {
  const { runtime, restart, calls } = fixture();
  const input = snapshotRequest();
  const opened = await runtime.open({ companyId, actor, request: input,
    idempotencyKey: 'snapshot-a', reason: 'Bounded analysis' });
  assert.equal(opened.kind, 'shadow-agent');
  assert.equal(opened.context.mode, 'snapshot');
  assert.match(opened.context.digest, /^sha256:/);
  assert.equal(opened.context.source.taskId, 'issue-a');
  assert.equal(calls.create, 1);
  assert.equal(calls.send, 1);
  const prompt = JSON.parse(calls.prompts[0]);
  assert.equal(prompt.contextSnapshot.digest, opened.context.digest);
  assert.equal(prompt.contextSnapshot.advisory.conclusions[0], 'Floating point seems easier');
  assert.deepEqual(prompt.contextSnapshot.authority.activeProductDecisionIds, ['approved-a']);
  assert.ok(prompt.contextSnapshot.authority.decisions.some((item) => item.id === 'rejected-a'));
  const replay = await restart().open({ companyId, actor, request: input,
    idempotencyKey: 'snapshot-a', reason: 'Bounded analysis' });
  assert.equal(replay.replayed, true);
  assert.equal(replay.context.digest, opened.context.digest);
  assert.equal(calls.create, 1);
  assert.equal(calls.send, 1);
});

test('valid snapshot replay and recovery survive a host clock rollback', async () => {
  const { runtime, restart, calls, setHeartbeats } = fixture();
  const input = snapshotRequest();
  const opened = await runtime.open({ companyId, actor, request: input,
    idempotencyKey: 'snapshot-clock' });
  setHeartbeats({ id: 'child-run-a', status: 'running' });
  const originalNow = Date.now;
  Date.now = () => Date.parse(opened.context.capturedAt) - 30_000;
  try {
    const replay = await restart().open({ companyId, actor, request: input,
      idempotencyKey: 'snapshot-clock' });
    assert.equal(replay.replayed, true);
    assert.equal(replay.context.digest, opened.context.digest);
    const [recovered] = await restart().reconcile({ companyId });
    assert.equal(recovered.status, 'active');
    assert.equal(recovered.context.digest, opened.context.digest);
    assert.equal(calls.create, 1);
    assert.equal(calls.send, 1);
  } finally { Date.now = originalNow; }
});

test('tampered durable Shadow snapshot blocks resumed dispatch and replay', async () => {
  const { runtime, restart, calls, mutateLaunch } = fixture();
  const input = snapshotRequest();
  await runtime.open({ companyId, actor, request: input,
    idempotencyKey: 'snapshot-b' });
  mutateLaunch(`${companyId}:snapshot-b`, (launch) => {
    launch.data.contextSnapshot.authority.decisions[0].outcome = 'Tampered';
    launch.status = 'created';
  });
  const [reconciled] = await restart().reconcile({ companyId });
  assert.equal(reconciled.status, 'created');
  assert.equal(calls.send, 1);
  await assert.rejects(restart().open({ companyId, actor, request: input,
    idempotencyKey: 'snapshot-b' }), /digest mismatch/);
});

test('Shadow snapshot rejects another Agent profile before native effects', async () => {
  const { runtime, calls } = fixture();
  const input = { ...snapshotRequest(), agentId: 'other-agent' };
  await assert.rejects(runtime.open({ companyId, actor, request: input,
    idempotencyKey: 'snapshot-other' }), /same organizational Agent/);
  assert.equal(calls.create, 0);
  assert.equal(calls.send, 0);
});

test('closed snapshot replay rejects a receipt with an altered capture time', async () => {
  const { runtime, mutateLaunch, setHeartbeats } = fixture();
  const input = snapshotRequest();
  await runtime.open({ companyId, actor, request: input, idempotencyKey: 'snapshot-time' });
  setHeartbeats({ id: 'child-run-a', status: 'succeeded',
    finished_at: new Date().toISOString(), result_json: { summary: JSON.stringify({
      status: 'completed', summary: 'Read the fixed context',
      evidenceRefs: [{ kind: 'document', id: 'source-a' }], output: 'Finding',
    }) } });
  const [closed] = await runtime.reconcile({ companyId });
  assert.equal(closed.status, 'closed');
  mutateLaunch(`${companyId}:snapshot-time`, row => {
    row.data.contextReceipt.snapshotCapturedAt = '2020-01-01T00:00:00.000Z';
  });
  await assert.rejects(runtime.open({ companyId, actor, request: input,
    idempotencyKey: 'snapshot-time' }), /durable context receipt mismatch/);
});

test('uncertain Shadow send recovers one native run with the original snapshot receipt', async (t) => {
  for (const status of ['sending', 'needs-repair']) {
    await t.test(`recovers from ${status}`, async () => {
      const { runtime, restart, calls, getLaunch, setHeartbeats } = fixture({ loseSendReceipt: true });
      await assert.rejects(runtime.open({ companyId, actor, request: snapshotRequest(),
        idempotencyKey: 'snapshot-recovery' }), /Native send response was lost/);
      const [waiting] = status === 'sending' ? await runtime.list({ companyId })
        : await restart().reconcile({ companyId });
      assert.equal(waiting.status, status);
      const key = `${companyId}:snapshot-recovery`;
      setHeartbeats({ id: 'child-run-a', status: 'running',
        message_session_id: 'child-session-a', wake_session_id: 'child-session-a' });
      const [recovered] = await restart().reconcile({ companyId });
      assert.equal(recovered.status, 'active');
      assert.equal(recovered.executionId, 'child-run-a');
      assert.equal(recovered.context.digest, waiting.context.digest);
      const { contextReceipt } = getLaunch(key).data;
      assert.equal(contextReceipt.executionId, 'child-run-a');
      assert.equal(contextReceipt.sessionRef, 'child-session-a');
      assert.equal(contextReceipt.snapshotDigest, waiting.context.digest);
      assert.equal(contextReceipt.snapshotCapturedAt, waiting.context.capturedAt);
      assert.equal(contextReceipt.creationMethod, 'new-session');
      assert.equal(calls.create, 1);
      assert.equal(calls.send, 1);
    });
  }
});

test('owner repair attaches one Shadow run and preserves snapshot provenance', async () => {
  const { runtime, restart, calls, getLaunch, setHeartbeats,
    setSessions } = fixture({ loseSendReceipt: true });
  await assert.rejects(runtime.open({ companyId, actor, request: snapshotRequest(),
    idempotencyKey: 'snapshot-repair' }), /Native send response was lost/);
  const key = `${companyId}:snapshot-repair`;
  const [waiting] = await restart().reconcile({ companyId });
  assert.equal(waiting.status, 'needs-repair');
  setHeartbeats({ id: 'child-run-a', status: 'running',
    wake_session_id: 'child-session-a' });
  setSessions([{ sessionId: 'child-session-a', companyId,
    agentId: parentAgentId, status: 'active' }]);
  const repaired = await restart().repair({ companyId,
    temporaryAgentId: waiting.temporaryAgentId, actor: owner,
    reason: 'Exact native run and session verified',
    repair: { outcome: 'attach-session', sessionId: 'child-session-a' } });
  assert.equal(repaired.status, 'active');
  assert.equal(repaired.executionId, 'child-run-a');
  assert.equal(repaired.audit.repairDecision.nativeSessionVerified, true);
  assert.equal(repaired.audit.repairDecision.ownerAttestedSessionAssociation, false);
  assert.equal(repaired.context.digest, waiting.context.digest);
  assert.equal(getLaunch(key).data.contextReceipt.snapshotDigest, waiting.context.digest);
  assert.equal(getLaunch(key).data.contextReceipt.snapshotCapturedAt,
    waiting.context.capturedAt);
  assert.equal(calls.create, 1);
  assert.equal(calls.send, 1);
  assert.equal(calls.close, 0);
});

test('lost-send recovery and owner repair require scoped, unambiguous session evidence', async (t) => {
  const nativeRun = { id: 'child-run-a', status: 'running' };
  for (const { name, runs, rejection, ownerCanAttest } of [
    { name: 'missing association', runs: [nativeRun],
      rejection: /must attest the unbound native session/, ownerCanAttest: true },
    { name: 'execution points at another session',
      runs: [{ ...nativeRun, message_session_id: 'other-session' }],
      rejection: /bound to a different session/ },
    { name: 'message and wake sessions disagree',
      runs: [{ ...nativeRun, message_session_id: 'child-session-a', wake_session_id: 'other-session' }],
      rejection: /bound to a different session/ },
    { name: 'multiple native executions',
      runs: [{ ...nativeRun, message_session_id: 'child-session-a' },
        { ...nativeRun, id: 'child-run-b', message_session_id: 'child-session-a' }],
      rejection: /Multiple native executions/ },
    { name: 'native executions outside launch scope',
      runs: [{ ...nativeRun, company_id: 'other-company', message_session_id: 'child-session-a' },
        { ...nativeRun, agent_id: 'other-agent', message_session_id: 'child-session-a' },
        { ...nativeRun, task_key: 'other-task', message_session_id: 'child-session-a' }],
      rejection: /no uniquely matching native run/ },
  ]) {
    await t.test(name, async () => {
      const { runtime, restart, calls, getLaunch, setHeartbeats, setSessions } =
        fixture({ loseSendReceipt: true });
      const key = `${companyId}:lost-send`;
      await assert.rejects(runtime.open({ companyId, actor, request: snapshotRequest(),
        idempotencyKey: 'lost-send' }), /Native send response was lost/);
      setHeartbeats(...runs);
      setSessions([{ sessionId: 'child-session-a', companyId,
        agentId: parentAgentId, status: 'active' }]);

      const [waiting] = await restart().reconcile({ companyId });
      assert.equal(waiting.status, 'needs-repair');
      assert.equal(waiting.executionId, null);
      assert.equal(getLaunch(key).data.contextReceipt, undefined);
      const [retried] = await restart().reconcile({ companyId });
      assert.equal(retried.status, 'needs-repair');
      assert.equal(retried.executionId, null);
      assert.equal(getLaunch(key).data.contextReceipt, undefined);

      const repair = (confirmSessionAssociation) => restart().repair({ companyId,
        temporaryAgentId: waiting.temporaryAgentId, actor: owner,
        reason: 'Reviewed the native run and session', repair: {
          outcome: 'attach-session', sessionId: 'child-session-a', confirmSessionAssociation,
        } });
      await assert.rejects(repair(undefined), rejection);
      assert.equal(getLaunch(key).data.repairDecision, undefined);
      if (ownerCanAttest) {
        const repaired = await repair(true);
        assert.equal(repaired.status, 'active');
        assert.equal(repaired.executionId, 'child-run-a');
        assert.equal(repaired.audit.repairDecision.nativeSessionVerified, false);
        assert.equal(repaired.audit.repairDecision.ownerAttestedSessionAssociation, true);
        const { contextReceipt } = getLaunch(key).data;
        assert.equal(contextReceipt.sessionRef, 'child-session-a');
        assert.equal(contextReceipt.executionId, 'child-run-a');
        assert.equal(contextReceipt.snapshotDigest, waiting.context.digest);
        assert.equal(contextReceipt.snapshotCapturedAt, waiting.context.capturedAt);
      } else {
        await assert.rejects(repair(true), rejection);
        const launch = getLaunch(key);
        assert.equal(launch.status, 'needs-repair');
        assert.equal(launch.executionId, null);
        assert.equal(launch.data.contextReceipt, undefined);
        assert.equal(launch.data.repairDecision, undefined);
      }
      assert.equal(calls.create, 1);
      assert.equal(calls.send, 1);
      assert.equal(calls.close, 0);
    });
  }
});

test('invalid snapshot capture time blocks open, recovery and owner repair before native effects', async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const initial = fixture({ capturedAt: future });
  await assert.rejects(initial.runtime.open({ companyId, actor,
    request: snapshotRequest(), idempotencyKey: 'future-capture' }), /capture time/);
  assert.equal(initial.calls.create, 0);
  assert.equal(initial.calls.send, 0);
  assert.deepEqual(await initial.runtime.list({ companyId }), []);

  const { runtime, restart, calls, getLaunch, mutateLaunch } = fixture();
  const opened = await runtime.open({ companyId, actor, request: snapshotRequest(),
    idempotencyKey: 'stale-capture' });
  const key = `${companyId}:stale-capture`;
  mutateLaunch(key, (row) => {
    row.data.requestedAt = '2020-01-01T00:00:00.000Z';
    row.status = 'needs-repair'; row.executionId = null;
    row.data.contextReceipt = null;
  });
  const [unchanged] = await restart().reconcile({ companyId });
  assert.equal(unchanged.status, 'needs-repair');
  await assert.rejects(restart().repair({ companyId,
    temporaryAgentId: opened.temporaryAgentId,
    actor: { kind: 'human', id: 'owner-a', roles: ['human-owner'] },
    reason: 'Attempt to attach', repair: { outcome: 'attach-session',
      sessionId: 'child-session-a' } }), /capture time/);
  assert.equal(getLaunch(key).data.repairDecision, undefined);
  assert.equal(calls.create, 1);
  assert.equal(calls.send, 1);
  assert.equal(calls.close, 0);
});

test('stop suppresses a late child report but waits for the native run to end', async () => {
  const { runtime, calls, setHeartbeats } = fixture();
  const opened = await runtime.open({ companyId, actor, request: request(),
    idempotencyKey: 'key-c' });
  const stopping = await runtime.stop({ companyId,
    temporaryAgentId: opened.temporaryAgentId, actor, reason: 'No longer needed' });
  assert.equal(stopping.status, 'stopping');
  assert.equal(calls.close, 0);
  setHeartbeats({ id: 'child-run-a', status: 'succeeded',
    finished_at: new Date().toISOString(), result_json: { summary: JSON.stringify({
      status: 'completed', summary: 'Should not be adopted',
      evidenceRefs: [{ kind: 'document', id: 'source-a' }], output: 'Finding',
    }) } });
  const [done] = await runtime.reconcile({ companyId });
  assert.equal(done.status, 'closed');
  assert.equal(done.outcome, 'cancelled');
  assert.equal(done.result, null);
  assert.equal(calls.close, 1);
});

test('unmetered cost cap is rejected before claim', async () => {
  const { runtime, calls } = fixture();
  const input = request();
  input.limits.maxCostUsd = 1;
  await assert.rejects(runtime.open({ companyId, actor,
    request: input, idempotencyKey: 'key-d' }), /cost cap unavailable/);
  assert.deepEqual(await runtime.list({ companyId }), []);
  assert.equal(calls.create, 0);
});

test('native success with a failed child report is a failed delegation', async () => {
  const { runtime, setHeartbeats } = fixture();
  await runtime.open({ companyId, actor, request: request(), idempotencyKey: 'key-f' });
  setHeartbeats({ id: 'child-run-a', status: 'succeeded',
    finished_at: new Date().toISOString(), result_json: { summary: JSON.stringify({
      status: 'failed', summary: 'Source A unavailable',
    }) } });
  const [done] = await runtime.reconcile({ companyId });
  assert.equal(done.outcome, 'failed');
  assert.equal(done.result.status, 'failed');
});

test('unscoped reconciliation records terminal outcome and defers native close', async () => {
  const { runtime, calls, setHeartbeats } = fixture();
  await runtime.open({ companyId, actor, request: request(), idempotencyKey: 'key-h' });
  setHeartbeats({ id: 'child-run-a', status: 'succeeded',
    finished_at: new Date().toISOString(), result_json: { summary: JSON.stringify({
      status: 'completed', summary: 'Found source A',
      evidenceRefs: [{ kind: 'document', id: 'source-a' }], output: 'Finding',
    }) } });
  const [pendingClose] = await runtime.reconcile({ companyId, allowNativeEffects: false });
  assert.equal(pendingClose.status, 'closing');
  assert.equal(pendingClose.outcome, 'completed');
  assert.equal(calls.close, 0);
  const [closed] = await runtime.reconcile({ companyId,
    parent: { agentId: parentAgentId, executionId: parentExecutionId } });
  assert.equal(closed.status, 'closed');
  assert.equal(calls.close, 1);
});

test('busy launch rejects stop instead of claiming the command was accepted', async () => {
  const { runtime, setBusy } = fixture();
  const opened = await runtime.open({ companyId, actor, request: request(),
    idempotencyKey: 'key-g' });
  setBusy(true);
  await assert.rejects(runtime.stop({ companyId, actor,
    temporaryAgentId: opened.temporaryAgentId }), /busy; retry command/);
});

test('owner attestation closes an ambiguous create as abandoned without retry', async () => {
  const { runtime, calls, setLaunchStatus } = fixture();
  const opened = await runtime.open({ companyId, actor, request: request(),
    idempotencyKey: 'key-e' });
  setLaunchStatus(`${companyId}:key-e`, 'needs-repair');
  await assert.rejects(runtime.repair({ companyId,
    temporaryAgentId: opened.temporaryAgentId, actor,
    reason: 'Operator review', repair: { outcome: 'abandon-unknown-session',
      confirmNoSession: true } }), /Human company owner required/);
  const owner = { kind: 'human', id: 'owner-a', roles: ['human-owner'] };
  await assert.rejects(runtime.repair({ companyId,
    temporaryAgentId: opened.temporaryAgentId, actor: owner,
    reason: 'Operator review', repair: { outcome: 'abandon-unknown-session' } }),
  /explicitly attest/);
  await assert.rejects(runtime.repair({ companyId,
    temporaryAgentId: opened.temporaryAgentId, actor: owner,
    reason: 'Operator review', repair: { outcome: 'abandon-unknown-session',
      confirmNoSession: true, sessionId: 'unrelated-session' } }),
  /only the durable launch session ID/);
  const abandoned = await runtime.repair({ companyId,
    temporaryAgentId: opened.temporaryAgentId, actor: owner,
    reason: 'No matching session can be identified',
    repair: { outcome: 'abandon-unknown-session', confirmNoSession: true } });
  assert.equal(abandoned.status, 'closed');
  assert.equal(abandoned.outcome, 'abandoned');
  assert.equal(calls.create, 1);
  assert.equal(calls.send, 1);
  assert.equal(calls.close, 0);
});
