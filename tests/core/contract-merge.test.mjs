import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { GraphEngine, MemoryStore } from '../../src/core/index.mjs';
import { mergeContract } from '../../src/host/contract-merge.mjs';

const main = 'a'.repeat(40);
const head = 'b'.repeat(40);
const merged = 'c'.repeat(40);
const folder = 'docs/contracts/2026/11/2026-11-26-billing-PRD-0042';
const prd = '# Billing';
const digest = value => createHash('sha256').update(value).digest('hex');

async function fixture({ actor = { id: 'owner', kind: 'human', roles: ['human-owner'] } } = {}) {
  const store = new MemoryStore();
  const engine = new GraphEngine({ store });
  const decision = { id: 'g2', runId: 'run', nodeId: 'gate', type: 'requirements-acceptance', actor,
    status: 'decided', outcome: 'accept', evidence: [{ subjectRefs: [{ artifactId: 'manifest', version: 'rev1' }] }] };
  await store.write({ revision: 1, packs: {}, audit: [], idempotency: {}, decisions: [decision], runs: {
    run: { id: 'run', status: 'completed', input: { projectId: 'project' },
      graph: { nodes: [{ id: 'gate', decisionType: decision.type }] },
      nodeStates: { gate: { status: 'completed', attempts: [{ decisionId: decision.id }] } } }
  } }, 0);
  const manifest = { id: 'manifest', revisionId: 'rev1', bytes: JSON.stringify({
    deliverables: [{ key: 'prd', digest: digest(prd) }]
  }) };
  const changes = new Map([
    [folder + '/product/prd.md', prd], [folder + '/product/criteria.json', '[]'],
    [folder + '/contract.lock.json', '{}'], ['docs/contracts/INDEX.json', '[]']
  ]);
  const plan = { supersedes: null, currentRevision: null, changes, deliverables: new Map([['prd', prd]]) };
  const snapshot = { headSha: head, baseSha: main, baseRef: 'main',
    changes: [...changes].map(([path, bytes]) => ({ path, bytes, mode: '100644', status: 'added' })) };
  const refs = [];
  let calls = 0;
  const github = {
    getRef: async ({ ref }) => { assert.equal(ref, 'refs/heads/main'); return main; },
    getPullSnapshot: async () => snapshot,
    getMergeReceipt: async () => null,
    loadValidator: async ({ ref }) => {
      refs.push(ref);
      return ref === main ? { recompute: async () => plan } : { recompute: () => assert.fail('Untrusted validator ran') };
    },
    merge: async ({ baseSha, headSha }) => {
      calls++;
      assert.equal(baseSha, main);
      assert.equal(headSha, head);
      return merged;
    }
  };
  return { args: { engine, github, project: { id: 'project', ownerId: 'owner', repository: 'org/repo' },
    runId: 'run', pullNumber: 42, section: 'product', decisionId: 'g2', manifest },
    snapshot, plan, refs, calls: () => calls };
}

test('merges the approved publication and durably records the SHA and event once', async () => {
  const { args, calls } = await fixture();
  const receipt = await mergeContract(args);
  assert.equal(receipt.mergeCommitSha, merged);
  assert.deepEqual(await mergeContract(args), receipt);
  assert.deepEqual((await args.engine.getRun('run')).contractMerges, [receipt]);
  const events = await args.engine.getAudit({ runId: 'run' });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'contract.merged');
  assert.equal(events[0].mergeCommitSha, merged);
  assert.equal(calls(), 1);
});

test('rejects a non-contract path', async () => {
  const { args, snapshot, calls } = await fixture();
  snapshot.changes[0].path = 'src/index.js';
  await assert.rejects(mergeContract(args), /path is forbidden/);
  assert.equal(calls(), 0);
});

test('rejects stale supersedes', async () => {
  const { args, plan, calls } = await fixture();
  plan.currentRevision = 'current';
  await assert.rejects(mergeContract(args), /supersedes is stale/);
  assert.equal(calls(), 0);
});

test('rejects a digest mismatch in an approved deliverable', async () => {
  const { args, plan, calls } = await fixture();
  plan.deliverables.set('prd', 'tampered');
  await assert.rejects(mergeContract(args), /deliverable digest mismatch/);
  assert.equal(calls(), 0);
});

test('rejects a modified generated lock', async () => {
  const { args, snapshot, calls } = await fixture();
  snapshot.changes.find(file => file.path.endsWith('/contract.lock.json')).bytes = '{"tampered":true}';
  await assert.rejects(mergeContract(args), /file digest mismatch/);
  assert.equal(calls(), 0);
});

test('rejects a missing approver and a human who is not the configured owner', async () => {
  for (const actor of [null, { id: 'other', kind: 'human', roles: ['human-owner'] }]) {
    const { args, calls } = await fixture({ actor });
    await assert.rejects(mergeContract(args), /approver is unauthorized/);
    assert.equal(calls(), 0);
  }
});

test('rejects a technical contract without a G4 decision', async () => {
  const { args, calls } = await fixture();
  await assert.rejects(mergeContract({ ...args, section: 'technical' }), /gate approval is required/);
  assert.equal(calls(), 0);
});

test('loads main validation even when the candidate modifies the validator path', async () => {
  const { args, snapshot, refs, calls } = await fixture();
  snapshot.changes.push({ path: folder + '/product/validator.mjs', bytes: 'tampered head validator',
    mode: '100644', status: 'modified' });
  await assert.rejects(mergeContract(args), /differs from the approved publication/);
  assert.deepEqual(refs, [main]);
  assert.equal(calls(), 0);
});

test('recovers a trusted merge receipt after a run write failure', async () => {
  const { args, calls } = await fixture();
  args.github.getMergeReceipt = async () => ({ baseSha: main, headSha: head, mergeCommitSha: merged });
  assert.equal((await mergeContract(args)).mergeCommitSha, merged);
  assert.equal(calls(), 0);
});
