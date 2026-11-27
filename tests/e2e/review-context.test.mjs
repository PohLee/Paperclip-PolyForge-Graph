import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphEngine } from '../../src/core/index.mjs';
import manifest from '../../src/plugin/manifest.mjs';
import { reviewPacket, projectReviewRun, handoffSnapshot, contextInventory } from '../../src/plugin/review-context.mjs';
import plugin from '../../src/plugin/worker.mjs';

const run = {
  id: 'run-1', status: 'running', packId: 'adlc', packVersion: '0.1.8',
  graph: { id: 'implementation', version: '1', nodes: [
    { id: 'author', type: 'task' }, { id: 'review', type: 'task', independentOf: ['author'] },
  ], edges: [{ from: 'author', to: 'review' }] },
  input: { versioned_requirement: { id: 'REQ-1', version: 'v1' }, architecture_baseline: { id: 'ARCH-1', version: 'v1' } },
  nodeStates: {
    author: { status: 'completed', artifacts: [{ id: 'CODE-1', version: 'v2' }],
      attempts: [{ output: { diffRef: 'git:abc' }, evidence: [{ kind: 'test', result: 'fail' }],
        selfReviews: [{ verdict: 'excellent' }], decisionIds: ['author-choice'], actor: { id: 'author' } }] },
    review: { status: 'pending', attempts: [] },
  },
};

test('independent review retains candidate and constraints while withholding author assessment', () => {
  const packet = reviewPacket(run, 'review');
  assert.deepEqual(packet.requirementsAndConstraints, run.input);
  assert.equal(packet.candidates[0].output.diffRef, 'git:abc');
  assert.equal(packet.candidates[0].evidence[0].result, 'fail');
  assert.equal(JSON.stringify(packet).includes('excellent'), false);
  assert.equal(JSON.stringify(packet).includes('author-choice'), false);
  const projected = projectReviewRun(run, 'review');
  assert.equal(JSON.stringify(projected).includes('selfReviews'), false);
  assert.equal(projected.nodeStates.author.artifacts[0].version, 'v2');
  assert.equal(reviewPacket(run, 'author'), null);
});

test('supervisor child API exposes only its active work and withholds author self-review', async () => {
  const engine = new GraphEngine();
  const requiredEvidence = ['review_findings', 'self_review_history'];
  await engine.registerPack({ id: 'review-fixture', version: '1', decisionRules: [
    { type: 'review', mode: 'manual', allowedRoles: ['reviewer'], requiredEvidence },
  ], graphs: [{ id: 'reviewed', version: '1', start: 'begin', nodes: [
    { id: 'begin', type: 'task' }, { id: 'other-task', type: 'task', role: 'maker' },
    { id: 'make', type: 'task', role: 'maker', review: { supervisorRole: 'reviewer' } }, { id: 'end', type: 'end' },
  ], edges: [{ from: 'begin', to: 'make' }, { from: 'begin', to: 'other-task' }, { from: 'make', to: 'end' }] }] });
  const author = { id: 'author', kind: 'agent', roles: ['maker'], executionId: 'author-run' };
  const reviewer = { id: 'reviewer', kind: 'agent', roles: ['reviewer'], executionId: 'reviewer-run' };
  const started = await engine.startRun({ packId: 'review-fixture', packVersion: '1', graphId: 'reviewed',
    actor: { id: 'owner', kind: 'human', roles: ['human-owner'] },
    input: { paperclipIssueId: 'root-issue', paperclipCompanyId: 'company' } });
  const action = { runId: started.id, nodeId: 'make' };
  await engine.submitNode({ runId: started.id, nodeId: 'begin', actor: author });
  await engine.submitNode({ ...action, actor: author, artifacts: [{ id: 'candidate', version: '1' }] });
  await engine.recordSelfReview({ ...action, actor: author, artifactVersion: '1' });
  await engine.reviewWork({ ...action, actor: reviewer, outcome: 'rework', reason: 'private prior disposition',
    evidence: requiredEvidence.map(kind => ({ kind, subjectRefs: [{ artifactId: 'candidate', version: '1' }] })) });
  await engine.submitNode({ ...action, actor: author, artifacts: [{ id: 'candidate', version: '2' }] });
  await engine.recordSelfReview({ ...action, actor: author, artifactVersion: '2',
    findings: [{ severity: 'P2', detail: 'private author finding' }],
    fixes: ['private author fix'], evidence: [{ kind: 'private author evidence' }] });
  await assert.rejects(engine.reviewWork({ ...action, actor: reviewer, outcome: 'accept', reason: 'Stale proof',
    evidence: requiredEvidence.map(kind => ({ kind, subjectRefs: [{ artifactId: 'candidate', version: '2' }],
      ...(kind === 'self_review_history' && { selfReviewRef: { ...action, attempt: 1, round: 1 } }),
    })),
  }), /self-review occurrence at attempt 2, round 1/);
  assert.ok((await engine.getWorkItems(started.id)).some(item => item.nodeId === 'other-task'));
  let state = await engine.store.read();
  const host = { manifest, logger: { warn() {} }, db: { namespace: 'plugin_test',
    async query(sql, args = []) {
      if (sql.includes('graph_state')) return [{ revision: state.revision, document: structuredClone(state) }];
      if (sql.includes('issue_id=$2 AND graph_run_id=$3') && ['review-current', 'review-old'].includes(args[1])) {
        return [{ issue_id: args[1], agent_id: reviewer.id, agent_run_id: reviewer.executionId,
          node_id: 'make', attempt: args[1] === 'review-current' ? 2 : 1, phase: 'supervisor', state: 'woken' }];
      }
      return [];
    },
    async execute(sql, args) {
      assert.match(sql, /graph_state/);
      if (state.revision !== args[3]) return { rowCount: 0 };
      state = JSON.parse(args[2]); return { rowCount: 1 };
    },
  }, issues: { assertCheckoutOwner: async ({ actorAgentId, actorRunId }) => {
    assert.equal(actorAgentId, reviewer.id);
    assert.equal(actorRunId, reviewer.executionId);
  } }, events: { on() {} }, jobs: { register() {} }, actions: { register() {} }, tools: { register() {} } };
  await plugin.definition.setup(host);
  const read = issueId => plugin.definition.onApiRequest({ routeKey: 'graph-read', companyId: 'company',
    params: { issueId }, query: { runId: started.id },
    actor: { actorType: 'agent', agentId: reviewer.id, runId: reviewer.executionId } });
  const { body } = await read('review-current');
  assert.equal(body.error, undefined, JSON.stringify(body));
  const [work] = body.work;
  const expected = { requiredEvidence, candidateRefs: [{ artifactId: 'candidate', version: '2' }],
    selfReviewRef: { ...action, attempt: 2, round: 1 } };
  assert.equal(body.work.length, 1);
  assert.equal(work.operation, 'review');
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(work[key], value);
    assert.deepEqual(body.run.reviewPacket[key], value);
  }
  assert.doesNotMatch(JSON.stringify(body), /private author|private prior|"selfReviews"|author-run/);
  assert.deepEqual(body.decisions, []);
  assert.deepEqual(body.audit, []);
  const { body: historical } = await read('review-old');
  assert.equal(historical.error, undefined, JSON.stringify(historical));
  assert.deepEqual(historical.work, []);
  assert.equal(historical.run.reviewPacket.selfReviewRef, undefined);
});

test('handoff derives facts from the durable run and inventory labels measurement limits', () => {
  const handoff = handoffSnapshot(run, { decisions: [{ id: 'D-1', type: 'scope', outcome: 'accept', reason: 'Within scope' }],
    workItems: [{ nodeId: 'review', phase: 'work', operation: 'submit', role: 'reviewer' }] });
  assert.equal(handoff.completed[0].artifacts[0].version, 'v2');
  assert.deepEqual(handoff.pending, [{ nodeId: 'review', status: 'pending' }]);
  assert.equal(handoff.fullStateRef, 'graph-run:run-1');
  assert.equal(handoff.decisions[0].id, 'D-1');
  assert.equal(handoff.nextActions[0].nodeId, 'review');
  const inventory = contextInventory({ role: 'abc', context: 'xyz [truncated; fetch Graph run for full value]' });
  assert.equal(inventory.modelRequestMeasured, false);
  assert.equal(inventory.components[1].truncated, true);
});


test('bounded arrays and objects mark omitted entries in context inventory', async () => {
  const { bounded } = await import('../../src/plugin/dispatch.mjs');
  const array = bounded(Array.from({ length: 41 }, (_, i) => i));
  const object = bounded(Object.fromEntries(Array.from({ length: 41 }, (_, i) => ['key' + i, i])));
  assert.equal(array.length, 41);
  assert.match(array[40], /truncated/);
  assert.match(object._truncated, /truncated/);
  assert.deepEqual(contextInventory({ array, object }).components.map(item => item.truncated), [true, true]);
  assert.equal(contextInventory({ exact: bounded(Array(40).fill(0)) }).components[0].truncated, false);
});
