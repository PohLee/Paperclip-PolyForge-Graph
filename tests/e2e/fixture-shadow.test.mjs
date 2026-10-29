import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureShadow, fixtureShadowAgent, fixtureShadowAvailable, shadowActorForRun } from '../../src/plugin/fixture-shadow.mjs';

const script = '/opt/polyforge/plugin/scripts/e2e-fixture-agent.mjs';
const fixtureAgent = (changes = {}) => ({ id: 'reviewer-a', adapterType: 'process', status: 'idle',
  adapterConfig: { command: 'node', args: [script], timeoutSec: 120 },
  budgetMonthlyCents: 10000, spentMonthlyCents: 0, ...changes });

test('Agent Shadow ownership resolves only the pinned Pack role and retains authenticated identity', () => {
  const actor = { id: 'qa-a', kind: 'agent', roles: ['adlc:qa-engineer', 'marketing:analyst'], executionId: 'run-a' };
  const run = { packId: 'adlc' }, node = { role: 'qa-engineer' };
  assert.deepEqual(shadowActorForRun(actor, run, node), { ...actor, roles: [...actor.roles, 'qa-engineer'] });
  assert.deepEqual(actor.roles, ['adlc:qa-engineer', 'marketing:analyst']);
  for (const invalid of [ { ...actor, executionId: null }, { ...actor, roles: ['marketing:qa-engineer'] },
    { ...actor, roles: ['qa-engineer'] }, { ...actor, roles: [] } ]) {
    assert.throws(() => shadowActorForRun(invalid, run, node), /Owning Graph Agent/);
  }
});

test('optional Shadow discovery is unavailable when a proactive company has no native scope', async () => {
  const host = { agents: { get: async () => { throw new Error('missing, expired, or unknown invocation scope'); } } };
  assert.equal(await fixtureShadowAvailable(host, 'unconfigured-company', ['reviewer-a']), false);
  host.agents.get = async () => fixtureAgent({ companyId: 'configured-company' });
  assert.equal(await fixtureShadowAvailable(host, 'configured-company', ['reviewer-a']), true);
  assert.equal(await fixtureShadowAvailable(host, 'other-company', ['reviewer-a']), false);
});

test('only the exact local process fixture with a bounded timeout and remaining native budget can review', () => {
  assert.equal(fixtureShadowAgent(fixtureAgent()), true);
  for (const changes of [
    { adapterType: 'codex_local' }, { adapterType: 'process', adapterConfig: { command: 'npx', args: [script], timeoutSec: 120 } },
    { adapterConfig: { command: 'node', args: [script, '--model'], timeoutSec: 120 } },
    { adapterConfig: { command: 'node', args: ['/tmp/other.mjs'], timeoutSec: 120 } },
    { adapterConfig: { command: 'node', args: [script], timeoutSec: 901 } },
    { budgetMonthlyCents: 0 }, { spentMonthlyCents: 10000 }, { status: 'paused' },
  ]) assert.equal(fixtureShadowAgent(fixtureAgent(changes)), false);
});

test('fixture Shadow reserves before message, binds one execution, closes, and replays without another session', async () => {
  const rows = new Map(), calls = [], companyId = 'company-a';
  const db = { namespace: 'plugin_test',
    execute: async (sql, args) => {
      if (sql.includes('INSERT INTO')) {
        const [company, key, fingerprint, agentId, parentRunId, parentTaskId, deadlineAt] = args;
        if (rows.has(key)) return { rowCount: 0 };
        rows.set(key, { company_id: company, request_key: key, fingerprint, agent_id: agentId,
          parent_run_id: parentRunId, parent_task_id: parentTaskId, deadline_at: deadlineAt,
          status: 'claimed' });
        return { rowCount: 1 };
      }
      const [company, key, from, to, sessionId, shadowId, executionId, outcome] = args;
      const row = rows.get(key);
      if (!row || row.company_id !== company || row.status !== from) return { rowCount: 0 };
      Object.assign(row, { status: to, session_id: sessionId ?? row.session_id,
        shadow_id: shadowId ?? row.shadow_id, execution_id: executionId ?? row.execution_id,
        outcome: outcome ?? row.outcome });
      return { rowCount: 1 };
    },
    query: async (sql, args) => sql.includes('status<>')
      ? [...rows.values()].filter((row) => row.company_id === args[0] && row.status !== 'closed')
      : [rows.get(args[1])].filter(Boolean),
  };
  const run = { id: 'run-a', status: 'running', packId: 'adlc', packVersion: '0.8.0',
    input: { paperclipCompanyId: companyId, projectId: 'project-a' },
    graph: { id: 'graph-a', nodes: [{ id: 'produce', role: 'maker' }, { id: 'review', role: 'reviewer' }],
      edges: [{ from: 'produce', to: 'review' }] },
    nodeStates: { produce: { status: 'completed', artifacts: [{ id: 'candidate-a', kind: 'design',
      version: 'v1', digest: `sha256:${'a'.repeat(64)}` }] }, review: { status: 'pending' } },
    goalContext: { revisions: [{ id: 'original-goal' }] },
  };
  const control = {
    recordShadowContext: async (input) => { calls.push('context'); assert.equal(input.candidateRefs[0].id, 'candidate-a'); return { id: 'snapshot-a' }; },
    prepareShadow: async (input) => { calls.push('prepare'); assert.equal(input.scope.maxTasks, 1);
      assert.equal(input.scope.maxConcurrent, 1); return { id: 'shadow-a' }; },
    bindShadowExecution: async (input) => { calls.push('bind'); assert.equal(input.executionId, 'execution-a'); },
    closeShadow: async (input) => { calls.push('close-core'); assert.equal(input.outcome, 'completed');
      assert.equal(input.reviewResult.findings[0].sourceRef.id, 'candidate-a');
      assert.match(input.reviewResult.outputDigest, /^sha256:[a-f0-9]{64}$/); },
  };
  const host = { db, manifest: { id: 'pohlee.polyforge-graph' }, logger: { warn: () => {} },
    agents: { get: async () => fixtureAgent(), sessions: {
      create: async (_agentId, _companyId, opts) => { calls.push('create');
        assert.match(opts.taskKey, /^plugin:pohlee\.polyforge-graph:session:shadow:/);
        return { sessionId: 'session-a' }; },
      sendMessage: async (_sessionId, _companyId, opts) => {
        calls.push('send');
        const packet = JSON.parse(opts.prompt.slice(opts.prompt.indexOf('\n') + 1));
        assert.equal(packet.goalContext.revisions[0].id, 'original-goal');
        opts.onEvent({ sessionId: 'session-a', eventType: 'chunk', stream: 'stdout',
          message: JSON.stringify({ fixture: 'local-process-shadow-review', status: 'reviewed',
            snapshotId: packet.snapshotId, sourceRunId: packet.sourceRunId,
            findings: [{ severity: 'P3', summary: 'Synthetic review result',
              sourceRef: { id: 'candidate-a', version: 'v1', digest: `sha256:${'a'.repeat(64)}` } }] }) });
        opts.onEvent({ sessionId: 'session-a', eventType: 'done', stream: 'system', message: null });
        return { runId: 'execution-a' };
      },
      close: async () => { calls.push('close-session'); },
    } },
  };
  const shadow = createFixtureShadow({ host, engineFor: async () => ({ engine: {
    getRun: async () => run }, control }) });
  const request = { companyId, available: true,
    actor: { id: 'owner-a', kind: 'human', roles: ['human-owner'] },
    payload: { parentRunId: run.id, parentTaskId: 'review', agentId: 'reviewer-a' },
    common: { idempotencyKey: 'shadow-a' } };
  const first = await shadow.open(request);
  assert.equal(first.executionId, 'execution-a');
  assert.deepEqual(calls, ['context', 'create', 'prepare', 'send', 'bind', 'close-core', 'close-session']);
  const replay = await shadow.open(request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.status, 'closed');
  assert.equal(calls.filter((item) => item === 'create').length, 1);
  assert.equal((await shadow.open({ ...request, available: false })).replayed, true);
  await assert.rejects(shadow.open({ ...request, payload: { ...request.payload, agentId: 'another' } }),
    /idempotency key reused/);
});
