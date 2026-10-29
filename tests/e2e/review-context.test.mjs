import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewPacket, projectReviewRun, handoffSnapshot, contextInventory } from '../../src/plugin/review-context.mjs';

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
