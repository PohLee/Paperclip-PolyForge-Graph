import test from 'node:test';
import assert from 'node:assert/strict';
import { triageSubmission } from '../../scripts/e2e-minimal-fixture-agent.mjs';
import { validateRunContracts, validateOutputContract, validateDecisionContract } from '../../src/core/evidence-contracts.mjs';
import { pack, validateRequestBrief } from '../../../Paperclip-PolyForge-Graph-Packs/packs/adlc/index.mjs';
import { signerEnvironment, assertSignerArgv, buildStartInvocation, assertNegativeResult, assertActiveDispatch, assertDispatches, observeGraph } from '../../scripts/e2e-minimal-helpers.mjs';

test('synthetic needs-info fixture satisfies pinned triage and request brief contracts', () => {
  const graph = pack.graphs.find(x => x.id === 'request-triage');
  assert.equal(pack.version, '0.3.2'); assert.equal(graph.version, '0.2.0');
  const input = { source_request: { id: 'fixture-request', version: 'v1' } };
  const data = triageSubmission({ graphRunId: 'run', requestId: input.source_request.id, issueId: 'company', decisionId: 'decision' });
  const state = { runs: {} }, node = graph.nodes.find(x => x.id === 'assess-request');
  validateRunContracts(state, graph, input);
  validateOutputContract(state, { input }, node, data.output, data.artifacts);
  assert.equal(validateRequestBrief(data.payloads.request_brief).id, data.artifacts[1].id);
  const run = { input, nodeStates: { 'assess-request': { status: 'completed', output: data.output } } };
  const decision = graph.nodes.find(x => x.id === 'triage-disposition');
  validateDecisionContract(state, run, decision, { kind: 'agent', roles: ['product-owner'] }, 'needs-info', []);
  assert.throws(() => validateDecisionContract(state, run, decision, {}, 'ready', []), /match/);
});

test('test-only signer is inherited by name and never embedded in Docker argv', () => {
  const { args, env } = buildStartInvocation({ candidate: 'c', fixture: 'f', driver: 'd', helper: 'h', image: 'image', name: 'test', identity: { sha256: 'a'.repeat(64), version: '0.8.9' }, baseEnv: { PATH: 'example' }, generate: () => 'test-only-secret' });
  assertSignerArgv(args, env);
  assert.equal(env.PAPERCLIP_AGENT_JWT_SECRET, 'test-only-secret');
  assert.ok(!JSON.stringify(args).includes(env.PAPERCLIP_AGENT_JWT_SECRET));
  assert.throws(() => signerEnvironment({}, () => ' '), /nonempty/);
  assert.throws(() => assertSignerArgv(['run', '-e', 'PAPERCLIP_AGENT_JWT_SECRET=test-only-secret'], env), /environment name/);
});

test('wrong-agent oracle requires binding rejection and unchanged whole Graph', () => {
  const before = { run: { status: 'running', nodeStates: { work: { attempts: [] }, other: { result: 1 } } }, decisions: [{ id: 'existing' }] };
  const rejected = { status: 403, data: { error: 'Agent is not bound to this Graph node issue' } };
  assert.match(assertNegativeResult(rejected, before, structuredClone(before)), /not bound/);
  assert.throws(() => assertNegativeResult({ status: 404, data: { error: 'not bound' } }, before, before));
  assert.throws(() => assertNegativeResult({ status: 429, data: { error: 'not bound' } }, before, before));
  assert.throws(() => assertNegativeResult({ status: 403, data: { error: 'unrelated policy' } }, before, before));
  const changed = structuredClone(before); changed.run.nodeStates.other.result = 2;
  assert.throws(() => assertNegativeResult(rejected, before, changed));
  const assignment = { issue: { id: 'issue', originKind: 'plugin:pohlee.polyforge-graph:node', originId: 'run:assess-request:1:work' },
    checkedOut: { assigneeAgentId: 'po', checkoutRunId: 'host' }, graphRunId: 'run', nodeId: 'assess-request', attempt: '1', agentId: 'po', hostRunId: 'host',
    dashboard: { run: { id: 'run', status: 'running', nodeStates: { 'assess-request': { status: 'pending', attempts: [] } } } } };
  assert.equal(assertActiveDispatch(assignment).runId, 'host');
  assert.throws(() => assertActiveDispatch({ ...assignment, checkedOut: { ...assignment.checkedOut, checkoutRunId: 'other' } }));
  assert.throws(() => assertActiveDispatch({ ...assignment, issue: { ...assignment.issue, originId: 'run:assess-request:2:work' } }));
});

test('dispatch oracle requires one distinct issue and Host run for each real phase', () => {
  const bindings = { 'adlc:product-owner': 'po', 'adlc:cpo': 'cpo' };
  const triples = [['assess-request', 'work', 'po'], ['assess-request', 'supervisor', 'cpo'], ['triage-disposition', 'work', 'po']];
  const issues = triples.map(([node, phase, agent], i) => ({ id: `issue${i}`, assigneeAgentId: agent,
    originKind: 'plugin:pohlee.polyforge-graph:node', originId: `run:${node}:1:${phase}` }));
  const runs = triples.map(([, , agent], i) => ({ id: `host${i}`, issueId: `issue${i}`, agentId: agent, status: 'succeeded' }));
  assert.equal(assertDispatches(issues, 'run', runs, bindings).length, 3);
  assert.throws(() => assertDispatches([...issues, { ...issues[0], id: 'duplicate' }], 'run', runs, bindings), /exactly three/);
  assert.throws(() => assertDispatches(issues, 'run', [...runs, { ...runs[0], id: 'duplicate' }], bindings), /exactly three/);
  assert.throws(() => assertDispatches(issues, 'run', runs.map((x, i) => i === 1 ? { ...x, agentId: 'po' } : x), bindings));
});

test('observer deadline aborts in-flight reads and discards queued or late events', async () => {
  class FakeSocket extends EventTarget {
    close() { this.closed = true; }
    sendEvent(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
  }
  const socket = new FakeSocket(); let reads = 0, aborted = false;
  const completion = observeGraph({ socket, timeoutMs: 30,
    start: async () => ({ run: { id: 'run' } }),
    read: (_id, signal) => { reads++; return new Promise((_, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    }); },
  });
  socket.dispatchEvent(new Event('open'));
  await Promise.resolve(); await Promise.resolve();
  socket.sendEvent({ type: 'issue.updated' });
  socket.sendEvent({ type: 'issue.updated' });
  await assert.rejects(completion, /deadline/);
  assert.equal(aborted, true); assert.equal(reads, 1); assert.equal(socket.closed, true);
  socket.sendEvent({ type: 'issue.updated' });
  await Promise.resolve(); assert.equal(reads, 1);
});

test('observer settles on real completion events and aborts on read failure', async () => {
  class FakeSocket extends EventTarget {
    close() { this.closed = true; }
    sendEvent(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
  }
  for (const shouldFail of [false, true]) {
    const socket = new FakeSocket(); let signalSeen, calls = 0;
    const completion = observeGraph({ socket, timeoutMs: 1000, start: async () => ({ run: { id: 'run' } }),
      read: async (_id, signal) => { calls++; signalSeen = signal; if (shouldFail) throw new Error('read failed');
        return { run: { status: 'completed', nodeStates: { work: { attempts: [{ actor: { kind: 'agent', executionId: 'host' } }] } } }, decisions: [] }; },
    });
    socket.dispatchEvent(new Event('open'));
    socket.sendEvent({ type: 'heartbeat.run.status', payload: { runId: 'host', status: 'succeeded' } });
    if (shouldFail) await assert.rejects(completion, /read failed/);
    else assert.deepEqual((await completion).ids, ['host']);
    assert.equal(calls, 1); assert.equal(signalSeen.aborted, true); assert.equal(socket.closed, true);
    socket.sendEvent({ type: 'issue.updated' }); await Promise.resolve(); assert.equal(calls, 1);
  }
});
