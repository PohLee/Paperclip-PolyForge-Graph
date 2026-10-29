import test from 'node:test';
import assert from 'node:assert/strict';
import { shadowReviewPacket } from '../../src/plugin/shadow-context.mjs';

const parent = () => ({ id: 'run-1', packId: 'adlc', packVersion: '1.0.0',
  input: { projectId: 'project-1', goalContext: { forged: true } },
  goalContext: { revisions: [{ id: 'trusted-goals' }] },
  graph: { id: 'review', edges: [{ from: 'candidate', to: 'reviewer' }], nodes: [
    { id: 'candidate' }, { id: 'reviewer', candidateNodes: ['candidate'], candidateKinds: ['release_record'] },
  ] }, nodeStates: {
    candidate: { status: 'completed', artifacts: [
      { id: 'artifact-1', version: 'v2', kind: 'release_record', digest: 'sha256:123' },
      { id: 'draft', version: 'v1', kind: 'draft', digest: 'sha256:draft' },
    ] }, reviewer: { status: 'awaiting_supervisor_review' },
  } });

test('shadow packet contains completed candidate and trusted goals only', () => {
  const packet = shadowReviewPacket(parent(), 'reviewer');
  assert.deepEqual(packet.candidates, [{ sourceNodeId: 'candidate', id: 'artifact-1',
    version: 'v2', kind: 'release_record', digest: 'sha256:123' }]);
  assert.deepEqual(packet.goalContext, { revisions: [{ id: 'trusted-goals' }] });
  assert.equal(JSON.stringify(packet).includes('forged'), false);
  assert.match(packet.snapshotId, /^[a-f0-9]{64}$/);
  assert.equal(shadowReviewPacket(parent(), 'reviewer').snapshotId, packet.snapshotId);
});

test('shadow packet rejects uncompleted or unversioned candidate', () => {
  const run = parent();
  run.nodeStates.candidate.status = 'running';
  assert.throws(() => shadowReviewPacket(run, 'reviewer'), /No completed/);
  run.nodeStates.candidate.status = 'completed';
  run.nodeStates.candidate.artifacts[0].digest = null;
  assert.throws(() => shadowReviewPacket(run, 'reviewer'), /No completed/);
});
