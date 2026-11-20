import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphEngine, runValidationDigest } from '../../src/core/index.mjs';
import { resolvePendingHuman, rejectHumanGateAsWrongAgent } from '../../scripts/e2e-workflow-composition.mjs';

const owner = { id: 'owner', kind: 'human', roles: ['owner', 'human-owner'] };
const worker = { id: 'worker', kind: 'agent', roles: ['maker'], executionId: 'host-execution' };
const wrongAgent = { id: 'wrong-agent', key: 'synthetic-wrong-key' };

async function fixture(operation) {
  const engine = new GraphEngine();
  await engine.registerPack({ id: 'driver', version: '1', graphs: [{ id: 'flow', version: '1', start: 'work',
    nodes: [{ id: 'work', type: 'task', role: 'maker',
      ...(operation === 'review' ? { review: { supervisorRole: 'owner' } } : {}) },
    { id: 'gate', type: 'decision', decisionType: 'gate', role: 'owner', outcomes: ['accept'] }, { id: 'end', type: 'end' }],
    edges: [{ from: 'work', to: 'gate' }, { from: 'gate', to: 'end', when: 'accept' }] }],
    decisionRules: [{ type: 'gate', mode: 'manual', allowedKinds: ['human'], allowedRoles: ['owner'],
      requiredEvidence: ['verification'] }, { type: 'review', mode: 'manual', allowedKinds: ['human'],
      allowedRoles: ['owner'], requiredEvidence: ['artifact_version', 'review_findings', 'self_review_history'] }] });
  const run = await engine.startRun({ packId: 'driver', packVersion: '1', graphId: 'flow', actor: owner,
    input: { paperclipIssueId: 'issue', paperclipCompanyId: 'company' } });
  await engine.submitNode({ runId: run.id, nodeId: 'work', actor: worker,
    artifacts: [{ id: 'candidate', version: 'v1' }] });
  if (operation === 'review') {
    await engine.recordSelfReview({ runId: run.id, nodeId: 'work', actor: worker, artifactVersion: 'v1' });
  } else if (operation === 'resolve-human-gate') {
    await engine.escalateNode({ runId: run.id, nodeId: 'gate', actor: owner, reason: 'Owner required' });
  }
  const dashboard = async () => {
    const current = await engine.getRun(run.id);
    return { run: current, runDigest: runValidationDigest(current), work: await engine.getWorkItems(run.id),
      decisions: await engine.listDecisions({ runId: run.id }) };
  };
  return { engine, runId: run.id, dashboard };
}

for (const operation of ['resolve-human-gate', 'decide', 'review']) {
  test(`composition driver resolves ${operation} after a valid unauthorized probe`, async (t) => {
    const f = await fixture(operation), requests = [], stages = [];
    const initial = await f.dashboard();
    assert.equal(initial.work[0].operation, operation);
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      if (options.method === 'GET') return Response.json(await f.dashboard());
      const request = JSON.parse(options.body), before = await f.dashboard();
      requests.push(request);
      assert.equal(request.operation, operation);
      if (operation === 'resolve-human-gate') {
        assert.equal(request.expectedDecisionId, before.run.pendingHuman.escalationDecisionId);
        assert.equal(request.expectedRunDigest, before.runDigest);
      }
      const unauthorized = Boolean(options.headers.Authorization);
      if (unauthorized) {
        assert.equal(options.headers.Authorization, `Bearer ${wrongAgent.key}`);
        assert.equal(options.headers['X-Paperclip-Run-Id'], worker.executionId);
      }
      const actor = unauthorized ? { ...worker, id: wrongAgent.id } : owner;
      try {
        const result = await f.engine[operation === 'resolve-human-gate' ? 'resolveHumanGate' :
          operation === 'review' ? 'reviewWork' : 'decideNode']({ ...request, actor });
        return Response.json({ result });
      } catch (error) {
        if (!unauthorized) throw error;
        assert.match(error.message, /Human owner|not allowed|not authorized|supervisor|required role/i);
        return Response.json({ error: error.message }, { status: 403 });
      }
    });
    assert.equal(await resolvePendingHuman('company', 'issue', f.runId, initial, wrongAgent,
      async (stage, details) => stages.push({ stage, ...details })), true);
    assert.equal(requests.length, 2);
    assert.deepEqual(stages.map(item => item.stage), ['wrong-agent-human-gate-denied',
      operation === 'review' ? 'local-owner-review-resolved' : 'local-owner-human-gate-resolved']);
    assert.equal(stages[0].status, 403);
    assert.equal(stages[0].unchanged, true);
    const after = await f.dashboard();
    assert.equal(after.run.status, 'running');
    assert.ok(after.decisions.some(decision => decision.actor.id === owner.id && decision.outcome === 'accept'));
    assert.equal(after.decisions.some(decision => decision.actor.id === wrongAgent.id), false);
  });
}

test('composition driver rejects a malformed-request failure as authorization evidence', async (t) => {
  const f = await fixture('resolve-human-gate'), dashboard = await f.dashboard();
  t.mock.method(globalThis, 'fetch', async (_url, options) => options.method === 'GET'
    ? Response.json(await f.dashboard()) : Response.json({ error: 'Missing run digest' }, { status: 400 }));
  await assert.rejects(rejectHumanGateAsWrongAgent('company', [{ dashboard }], 'issue', f.runId,
    dashboard.work[0], wrongAgent, async () => assert.fail('Malformed requests must not be recorded as authorization proof')),
  /not denied authorization: HTTP 400/);
});

test('composition driver keeps the displayed owner snapshot when upstream evidence changes', async t => {
  const f = await fixture('resolve-human-gate');
  const displayed = await f.dashboard();
  await f.engine.invalidateEvidence({ runId: f.runId, nodeId: 'work', actor: owner, reason: 'Source changed' });
  const current = await f.dashboard();
  assert.equal(current.run.pendingHuman.escalationDecisionId, displayed.run.pendingHuman.escalationDecisionId);
  assert.notEqual(current.runDigest, displayed.runDigest);
  let ownerRequest;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options.method === 'GET') return Response.json(await f.dashboard());
    const request = JSON.parse(options.body);
    if (options.headers.Authorization) {
      assert.equal(request.expectedRunDigest, current.runDigest);
      return Response.json({ error: 'Unauthorized agent' }, { status: 403 });
    }
    ownerRequest = request;
    return Response.json(await f.engine.resolveHumanGate({ ...request, actor: owner }));
  });
  await assert.rejects(resolvePendingHuman('company', 'issue', f.runId, displayed, wrongAgent, async () => {}), /Run changed since validation/);
  assert.equal(ownerRequest.expectedRunDigest, displayed.runDigest);
  assert.deepEqual((await f.dashboard()).run, current.run);
});
