import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GraphEngine, MemoryStore, runValidationDigest } from '../../src/core/index.mjs';

test('publication and emergency freeze hold pinned runs until the owner unfreezes and the Host updates pins', async () => {
  const store = new MemoryStore();
  const engine = new GraphEngine({ store });
  const project = { id: 'project', ownerId: 'owner' };
  const actor = { kind: 'human', id: 'owner', roles: ['human-owner'] };
  const identity = { id: 'billing', section: 'technical' };
  const first = 'a'.repeat(40), second = 'b'.repeat(40);
  const pin = { contractId: identity.id, section: identity.section, commit: first };
  const input = { projectId: project.id };
  await store.write({ revision: 1, packs: {}, audit: [], idempotency: {}, decisions: [], runs: {
    work: { id: 'work', status: 'running', input, pack: {}, graph: { nodes: [], edges: [] }, nodeStates: {}, conflicts: [], contract_pins: [pin] },
    publication: { id: 'publication', status: 'completed', input },
  } }, 0);
  const publication = { repository: 'org/repo', section: pin.section, contractId: pin.contractId };
  await engine.recordContractMerge('publication', { ...publication, pullNumber: 1, mergeCommitSha: first, supersedes: null });
  await engine.assertCurrentContractPins('work');
  await engine.freezeContract({ project, actor, contractId: pin.contractId, reason: 'Emergency', idempotencyKey: 'freeze' });
  assert.equal((await engine.getRun('work')).status, 'paused');
  await assert.rejects(engine.assertCurrentContractPins('work'), /Frozen contract/);
  await engine.recordContractMerge('publication', { ...publication, pullNumber: 2, mergeCommitSha: second, supersedes: first });
  await engine.unfreezeContract({ project, actor, contractId: pin.contractId, reason: 'Reassessed', idempotencyKey: 'unfreeze' });
  await assert.rejects(engine.assertCurrentContractPins('work'), /Stale or unknown/);
  const pins = [{ ...pin, commit: second }];
  await engine.updateContractPins({ runId: 'work', pins, actor: { kind: 'system', id: 'host', roles: [] },
    reason: 'PE reassessment', idempotencyKey: 'update', expectedRunDigest: runValidationDigest(await engine.getRun('work')) });
  await engine.assertCurrentContractPins('work');
  assert.deepEqual((await engine.getRun('work')).contract_pins, pins);
  assert.ok((await engine.getRun('work')).contractPinsUpdatedAt);
  await engine.recordContractMerge('publication', { ...publication, contractId: 'replacement', pullNumber: 3,
    mergeCommitSha: 'c'.repeat(40), supersedes: second });
  await assert.rejects(engine.assertCurrentContractPins('work'), /Stale or unknown/);
  const replacement = [{ ...pin, contractId: 'replacement', commit: 'c'.repeat(40) }];
  await engine.updateContractPins({ runId: 'work', pins: replacement, actor: { kind: 'system', id: 'host', roles: [] },
    reason: 'Use the superseding contract', idempotencyKey: 'replacement', expectedRunDigest: runValidationDigest(await engine.getRun('work')) });
  await engine.resumeRun({ runId: 'work', actor, reason: 'Pins updated' });
  assert.equal((await engine.getRun('work')).status, 'running');
  await engine.assertCurrentContractPins('work');
});
