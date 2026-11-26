import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeImplementation } from '../../src/host/implementation-merge.mjs';

function fixture() {
  const baseSha = 'a'.repeat(40), headSha = 'b'.repeat(40), mergeCommitSha = 'c'.repeat(40);
  const type = 'implementation-merge-approval';
  const decision = { id: 'approval', nodeId: 'gate', type, status: 'decided', outcome: 'accept',
    actor: { id: 'owner', kind: 'human', roles: ['human-owner'] },
    evidence: [{ subjectRefs: [{ artifactId: 'pr:org/repo#1', version: headSha }, { artifactId: 'qa', version: 'rev' }] }] };
  const run = { input: { projectId: 'project' }, graph: { nodes: [{ id: 'gate', decisionType: type }] },
    nodeStates: { gate: { status: 'completed', attempts: [{ decisionId: decision.id }] } } };
  const pr = { headSha, baseSha, baseRef: 'main', changes: [{ path: 'src/app.mjs' }] };
  const judge = { status: 'pass', gaps: [] };
  const engine = {
    getRun: async () => run, listDecisions: async () => [decision], assertCurrentContractPins: async () => {},
    recordImplementationMerge: async (_id, receipt) => { run.implementationMerges = [receipt]; return receipt; },
  };
  let merges = 0;
  const github = {
    getRef: async () => baseSha, getPullSnapshot: async () => pr, getMergeReceipt: async () => null,
    loadValidator: async () => ({ judgeVerificationManifest: () => judge }),
    merge: async () => { merges++; return mergeCommitSha; },
  };
  return { decision, pr, judge, merges: () => merges, args: { engine, github, runId: 'run', pullNumber: 1,
    decisionId: decision.id, project: { id: 'project', repository: 'org/repo', ownerId: 'owner' },
    manifest: { id: 'qa', revisionId: 'rev', bytes: JSON.stringify({ checkoutSha: headSha, results: [] }) } } };
}

test('owner approval binds both immutable subjects and merge replay is idempotent', async () => {
  const { args, merges } = fixture();
  const receipt = await mergeImplementation(args);
  assert.deepEqual(await mergeImplementation(args), receipt);
  assert.equal(merges(), 1);
});

test('rejects stale pins, incomplete verification, contract renames and agent decisions in manual mode', async () => {
  let f = fixture();
  f.args.engine.assertCurrentContractPins = async () => { throw new Error('Stale contract'); };
  await assert.rejects(mergeImplementation(f.args), /Stale contract/);
  f = fixture();
  f.judge.status = 'unverified';
  await assert.rejects(mergeImplementation(f.args), /Passing verification/);
  f = fixture();
  f.pr.changes[0].previousPath = 'docs/contracts/INDEX.json';
  await assert.rejects(mergeImplementation(f.args), /outside contract paths/);
  f = fixture();
  f.decision.actor = { id: 'agent', kind: 'agent' };
  await assert.rejects(mergeImplementation(f.args), /owner approval/);
  assert.equal(f.merges(), 0);
});

