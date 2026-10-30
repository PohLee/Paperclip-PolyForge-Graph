import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphEngine } from '../../src/core/index.mjs';

const owner = { id: 'owner', kind: 'human', roles: ['human-owner'] };
const engineer = { id: 'engineer', kind: 'agent', roles: ['maker'], executionId: 'agent-run' };
const evidence = (baselineId) => [
  { kind: 'superseded_decision_id', id: baselineId },
  { kind: 'replacement_rationale', summary: 'User requested a changed calculation' },
  { kind: 'impact_analysis', summary: 'The same request would return a different result' },
];

async function fixture() {
  const engine = new GraphEngine();
  await engine.registerPack({ id: 'adlc', version: '1', graphs: [{ id: 'implementation', version: '1',
    start: 'make', nodes: [{ id: 'make', type: 'task', role: 'maker', requiredInputs: ['product_decision_refs'] }], edges: [] }],
  policies: { productMemory: { proposalRequired: true } }, decisionRules: [{
    type: 'product-decision-replacement', mode: 'assisted', allowedKinds: ['human'], requiresHuman: true,
    requiredEvidence: ['superseded_decision_id', 'replacement_rationale', 'impact_analysis'],
  }] });
  const baseline = await engine.recordProductDecision({ feature: 'calculator', actor: owner,
    outcome: 'Subtract returns a-b', reason: 'Accepted product brief' });
  const run = await engine.startRun({ packId: 'adlc', packVersion: '1', graphId: 'implementation',
    mode: 'assisted', actor: owner, input: { feature: 'calculator',
      product_decision_refs: [baseline.id], paperclipIssueId: 'issue-1' } });
  return { engine, baseline, run };
}

test('agent may propose a replacement, but work waits for a human decision', async () => {
  const { engine, baseline, run } = await fixture();
  const input = { runId: run.id, nodeId: 'make', feature: 'calculator', outcome: 'Subtract returns a+b',
    supersedes: baseline.id, changeScope: ['/api/subtract semantics'], evidence: evidence(baseline.id) };
  await assert.rejects(engine.recordProductDecision({ ...input, actor: engineer,
    reason: 'Agent tried to approve' }), /matching proposal/);
  const proposal = await engine.recordProductDecision({ ...input, actor: engineer,
    status: 'proposed', reason: 'User requested changed behavior' });
  assert.equal(proposal.issueId, 'issue-1');
  assert.equal((await engine.getRun(run.id)).status, 'paused');
  assert.equal((await engine.getRun(run.id)).pendingHuman.proposalId, proposal.id);
  assert.equal((await engine.getWorkItems(run.id))[0].operation, 'resolve-product-decision');
  await assert.rejects(engine.submitNode({ runId: run.id, nodeId: 'make', actor: engineer,
    productDecisionRefs: [baseline.id] }), /paused|running|decision/i);
  await assert.rejects(engine.recordProductDecision({ ...input, actor: engineer,
    proposalId: proposal.id, reason: 'Agent tried to approve' }), /Human decision required/);
  const approved = await engine.recordProductDecision({ ...input, actor: owner,
    proposalId: proposal.id, reason: 'Owner accepts the changed behavior' });
  assert.equal(approved.proposalId, proposal.id);
  assert.equal((await engine.getRun(run.id)).status, 'running');
  assert.equal((await engine.getRun(run.id)).nodeStates.make.attempts[0].status, 'abandoned_before_submission');
  assert.equal((await engine.getWorkItems(run.id))[0].nodeId, 'make');
  assert.deepEqual((await engine.getProductMemory('calculator')).active.map((item) => item.id), [approved.id]);
});

test('human rejection of an agent proposal preserves the approved behavior', async () => {
  const { engine, baseline, run } = await fixture();
  const input = { runId: run.id, nodeId: 'make', feature: 'calculator', outcome: 'Subtract returns a+b',
    supersedes: baseline.id, changeScope: ['/api/subtract semantics'], evidence: evidence(baseline.id) };
  const proposal = await engine.recordProductDecision({ ...input, actor: engineer,
    status: 'proposed', reason: 'User requested changed behavior' });
  const rejected = await engine.recordProductDecision({ ...input, actor: owner,
    status: 'rejected', proposalId: proposal.id, reason: 'Keep subtraction' });
  assert.equal(rejected.proposalId, proposal.id);
  assert.equal((await engine.getRun(run.id)).status, 'stopped');
  assert.deepEqual((await engine.getProductMemory('calculator')).active.map((item) => item.id), [baseline.id]);
  await assert.rejects(engine.recordProductDecision({ ...input, actor: owner,
    status: 'approved', proposalId: proposal.id, reason: 'Conflicting late approval' }), /already resolved/);
});

test('deferral leaves the human gate pending for a later final decision', async () => {
  const { engine, baseline, run } = await fixture();
  const input = { runId: run.id, nodeId: 'make', feature: 'calculator', outcome: 'Subtract returns a+b',
    supersedes: baseline.id, changeScope: ['/api/subtract semantics'], evidence: evidence(baseline.id) };
  const proposal = await engine.recordProductDecision({ ...input, actor: engineer,
    status: 'proposed', reason: 'Change requested' });
  const deferred = await engine.recordProductDecision({ ...input, actor: owner,
    status: 'deferred', proposalId: proposal.id, reason: 'Need more customer evidence' });
  assert.equal(deferred.status, 'deferred');
  assert.equal((await engine.getRun(run.id)).status, 'paused');
  assert.equal((await engine.getRun(run.id)).pendingHuman.proposalId, proposal.id);
  const rejected = await engine.recordProductDecision({ ...input, actor: owner,
    status: 'rejected', proposalId: proposal.id, reason: 'Customer evidence did not justify change' });
  assert.equal(rejected.status, 'rejected');
  assert.equal((await engine.getRun(run.id)).status, 'stopped');
});

test('a concurrent baseline change invalidates a pending proposal and stops its Graph run', async () => {
  const { engine, baseline, run } = await fixture();
  const input = { runId: run.id, nodeId: 'make', feature: 'calculator', outcome: 'Subtract returns a+b',
    supersedes: baseline.id, changeScope: ['/api/subtract semantics'], evidence: evidence(baseline.id) };
  const proposal = await engine.recordProductDecision({ ...input, actor: engineer,
    status: 'proposed', reason: 'Change requested' });
  await engine.recordProductDecision({ feature: 'calculator', actor: owner,
    outcome: 'Subtract remains a-b; add accepts arrays', reason: 'Newer product decision',
    supersedes: baseline.id });
  await assert.rejects(engine.recordProductDecision({ ...input, actor: owner,
    status: 'approved', proposalId: proposal.id, reason: 'Late approval' }), /stale|active product decision/);
  const invalidated = await engine.invalidateProductProposal({ proposalId: proposal.id,
    idempotencyKey: 'invalidate-stale' });
  assert.equal(invalidated.status, 'invalidated');
  assert.equal((await engine.getRun(run.id)).status, 'stopped');
  assert.equal((await engine.getRun(run.id)).pendingHuman, undefined);
  assert.equal((await engine.listDecisions({ feature: 'calculator' }))
    .filter((item) => item.proposalId === proposal.id && item.status === 'invalidated').length, 1);
});
