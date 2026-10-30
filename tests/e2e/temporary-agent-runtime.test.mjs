import test from 'node:test';
import assert from 'node:assert/strict';
import { createTemporaryAgentRuntime } from '../../src/plugin/temporary-agent-runtime.mjs';

const companyId = 'company-a';
const parentAgentId = 'agent-a';
const parentExecutionId = 'parent-run-a';
const actor = { kind: 'agent', id: parentAgentId, executionId: parentExecutionId };
const deadline = () => new Date(Date.now() + 120_000).toISOString();
const request = (kind = 'sub-agent') => ({
  id: 'delegation-a', kind, purpose: 'research',
  parent: { agentId: parentAgentId, executionId: parentExecutionId },
  context: { mode: kind === 'sub-agent' ? 'fresh' : 'fork', parentSessionRef: 'parent-session-a' },
  brief: { objective: 'Research source A', scope: 'One source', outputFormat: 'JSON',
    boundaries: ['Read only'], inputRefs: [{ kind: 'document', id: 'source-a' }],
    acceptanceCriteria: ['Cite source A'], allowedActions: ['research'],
    deadlineAt: deadline() },
  limits: { maxTasks: 1, maxConcurrent: 1 },
  workspace: { mode: 'shared', writeAccess: 'none' },
});

function fixture() {
  const rows = new Map();
  const calls = { create: 0, send: 0, close: 0 };
  let heartbeat = null;
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
      return heartbeat && params[2] === heartbeat.id ? [heartbeat] : [];
    } },
    agents: {
      async get(id, company) { return id === parentAgentId && company === companyId
        ? { id, companyId: company, status: 'running',
          adapterConfig: { timeoutSec: 60 } } : null; },
      sessions: {
        async create() { calls.create++; return { sessionId: 'child-session-a',
          companyId, agentId: parentAgentId }; },
        async sendMessage() { calls.send++; return { runId: 'child-run-a' }; },
        async close() { calls.close++; },
        async list() { return []; },
      },
    },
  };
  const runtime = createTemporaryAgentRuntime({ host, launchStore: store,
    getPolicy: async () => ({ enabled: true }),
    resolveParentAuthority: async () => ({ agentId: parentAgentId,
      canDelegate: true, allowedActions: ['research'] }) });
  return { runtime, calls, setHeartbeat(value) { heartbeat = value; },
    setBusy(value) { busy = value; },
    setLaunchStatus(key, status, sessionId = null) {
      const old = rows.get(key);
      rows.set(key, { ...old, status, sessionId });
    } };
}

test('fresh Sub-Agent creates and sends once, then reconciles a validated result', async () => {
  const { runtime, calls, setHeartbeat } = fixture();
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
  setHeartbeat({ id: 'child-run-a', status: 'succeeded',
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
    request: request('shadow-agent'), idempotencyKey: 'key-b' }), /True Shadow-Agent fork unavailable/);
  assert.deepEqual(await runtime.list({ companyId }), []);
  assert.equal(calls.create, 0);
  assert.equal(calls.send, 0);
});

test('stop suppresses a late child report but waits for the native run to end', async () => {
  const { runtime, calls, setHeartbeat } = fixture();
  const opened = await runtime.open({ companyId, actor, request: request(),
    idempotencyKey: 'key-c' });
  const stopping = await runtime.stop({ companyId,
    temporaryAgentId: opened.temporaryAgentId, actor, reason: 'No longer needed' });
  assert.equal(stopping.status, 'stopping');
  assert.equal(calls.close, 0);
  setHeartbeat({ id: 'child-run-a', status: 'succeeded',
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
  const { runtime, setHeartbeat } = fixture();
  await runtime.open({ companyId, actor, request: request(), idempotencyKey: 'key-f' });
  setHeartbeat({ id: 'child-run-a', status: 'succeeded',
    finished_at: new Date().toISOString(), result_json: { summary: JSON.stringify({
      status: 'failed', summary: 'Source A unavailable',
    }) } });
  const [done] = await runtime.reconcile({ companyId });
  assert.equal(done.outcome, 'failed');
  assert.equal(done.result.status, 'failed');
});

test('unscoped reconciliation records terminal outcome and defers native close', async () => {
  const { runtime, calls, setHeartbeat } = fixture();
  await runtime.open({ companyId, actor, request: request(), idempotencyKey: 'key-h' });
  setHeartbeat({ id: 'child-run-a', status: 'succeeded',
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
