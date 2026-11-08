import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphEngine, MemoryStore, runValidationDigest } from '../../src/core/index.mjs';

test('all guarded run mutations reject callbacks admitted before a host revalidation token', async () => {
  const store = new MemoryStore();
  const before = { id: 'run', status: 'running', hostValidationId: 'old-validation' };
  const expectedRunDigest = runValidationDigest(before);
  const state = { revision: 1, packs: {}, runs: { run: { ...before, hostValidationId: 'new-validation' } },
    decisions: [], audit: [], idempotency: {} };
  await store.write(state, 0);
  const engine = new GraphEngine({ store });
  const actor = { id: 'owner', kind: 'human', roles: ['human-owner', 'cpo'], executionId: null };
  for (const method of ['submitNode', 'recordSelfReview', 'decideNode', 'resolveHumanGate', 'escalateNode',
    'recordWorkDecision', 'reviewWork', 'retryNode', 'resolveReworkLimit', 'resolveConflict',
    'openConflict', 'recordConflictPosition', 'resumeRun', 'recordProductDecision']) {
    await assert.rejects(engine[method]({ runId: 'run', nodeId: 'node', actor, expectedRunDigest,
      reason: 'Previously admitted callback', outcome: 'accept' }), /Run changed since validation/,
    `${method} must forward the host snapshot precondition to the storage CAS loop`);
    assert.deepEqual(await store.read(), state, `${method} must not mutate a revalidated run`);
  }
});
