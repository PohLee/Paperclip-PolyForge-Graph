import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphEngine } from '../../src/core/index.mjs';
import { reviewPacket } from '../../src/plugin/review-context.mjs';

const internal = { kind: 'internal', id: 'interviews', version: '2' };
const external = { kind: 'external', id: 'field-study', version: '1' };
const make = (id, role, kind) => ({ id, type: 'task', role: 'author', produces: [kind],
  review: { supervisorRole: role } });
const report = make('summarize', 'chief', 'brief');
report.review.requiredSourceRefs = { reportKind: 'brief',
  sources: [{ nodeId: 'research', kind: 'internal' }, { nodeId: 'compare', kind: 'external' }] };
const pack = { id: 'citations', version: '1', decisionRules: [{ type: 'review', mode: 'manual' }],
  graphs: [{ id: 'study', version: '1', start: 'research',
    nodes: [make('research', 'manager', 'internal'), make('compare', 'manager', 'external'), report],
    edges: [{ from: 'research', to: 'compare' }, { from: 'compare', to: 'summarize' }] }] };
const actor = role => ({ kind: 'agent', id: role, roles: [role], executionId: role });

test('supervisor can return incomplete citations, but only the exact accepted sources can advance the report', async () => {
  const engine = new GraphEngine();
  await engine.registerPack(pack);
  const run = await engine.startRun({ packId: pack.id, packVersion: pack.version, graphId: 'study',
    actor: { id: 'owner', kind: 'human', roles: ['human-owner'] } });
  const scope = nodeId => ({ runId: run.id, nodeId });
  async function submit(nodeId, artifact, output) {
    const args = { ...scope(nodeId), actor: actor('author') };
    await engine.submitNode({ ...args, artifacts: [artifact], output });
    await engine.recordSelfReview({ ...args, artifactVersion: artifact.version });
  }
  const review = (nodeId, role, outcome) => engine.reviewWork({ ...scope(nodeId), actor: actor(role), outcome,
    reason: outcome === 'accept' ? 'Verified the sources' : 'Correct the missing or stale source' });
  await submit('research', { ...internal, version: '1' }, { finding: 'Unverified attribution' });
  await review('research', 'manager', 'rework');
  await submit('research', internal, { internal: { finding: 'Confirmed attribution' } });
  const pm = await review('research', 'manager', 'accept');
  await submit('compare', external, { finding: 'Observed external comparison' });
  await review('compare', 'manager', 'accept');

  const cases = [{ researchRefs: [internal] }, { researchRefs: [external, external] },
    { researchRefs: [{ ...internal, version: '1' }, external] },
    { researchRefs: [internal, { ...external, id: 'unrelated' }] },
    { version: 'superseded-report', researchRefs: [internal, external] }];
  for (const [index, brief] of cases.entries()) {
    await submit('summarize', { kind: 'brief', id: 'summary', version: String(index + 1) }, { brief });
    await assert.rejects(review('summarize', 'chief', 'accept'), /researchRefs.*rework/);
    const current = await engine.getRun(run.id);
    assert.equal(current.nodeStates.summarize.status, 'awaiting_supervisor_review');
    assert.equal(current.nodeStates.summarize.attempts.at(-1).supervisorReview, null);
    const packet = reviewPacket(current, 'summarize', 'supervisor');
    assert.deepEqual(packet.acceptedSourceRefs[0],
      { nodeId: 'research', kind: 'internal', ref: internal, decisionId: pm.decision.id });
    assert.deepEqual(packet.acceptedSourceReports[0], { nodeId: 'research', decisionId: pm.decision.id,
      artifacts: [{ ...internal, body: { finding: 'Confirmed attribution' } }] });
    await review('summarize', 'chief', 'rework');
  }
  await submit('summarize', { kind: 'brief', id: 'summary', version: String(cases.length + 1) }, { brief: { researchRefs: [external, internal] } });
  await review('summarize', 'chief', 'accept');
  const state = (await engine.getRun(run.id)).nodeStates.summarize;
  assert.deepEqual(state.attempts.map(attempt => attempt.supervisorReview.outcome), [...cases.map(() => 'rework'), 'accept']);
});

test('a required report source must be produced by a reviewed upstream task', async () => {
  const invalid = structuredClone(pack);
  invalid.graphs[0].nodes[2].review.requiredSourceRefs.sources[0].nodeId = 'summarize';
  await assert.rejects(new GraphEngine().registerPack(invalid), /Invalid requiredSourceRefs/);
});

test('a cited source must submit exactly one artifact of the cited kind', async () => {
  const engine = new GraphEngine();
  await engine.registerPack(pack);
  const run = await engine.startRun({ packId: pack.id, packVersion: pack.version, graphId: 'study',
    actor: { id: 'owner', kind: 'human', roles: ['human-owner'] } });
  const args = { runId: run.id, nodeId: 'research', actor: actor('author') };
  await assert.rejects(engine.submitNode({ ...args, output: {},
    artifacts: [internal, { ...internal, id: 'second-interviews' }] }), /submit exactly one internal artifact/);
  await engine.submitNode({ ...args, output: { internal: { finding: 'One source' } }, artifacts: [internal] });
  await assert.rejects(engine.recordSelfReview({ ...args, artifactVersion: '1',
    revisedArtifact: { ...internal, id: 'second-interviews', version: '1' } }), /submit exactly one internal artifact/);
  const state = (await engine.getRun(run.id)).nodeStates.research;
  assert.equal(state.status, 'awaiting_self_review');
  assert.deepEqual(state.attempts.at(-1).artifacts, [internal]);
});
