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
  return { decision, pr, judge, run, merges: () => merges, args: { engine, github, runId: 'run', pullNumber: 1,
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


test('assisted mode uses trusted risk and head-bound reviews for an independent CTO', async () => {
  const { args, decision, pr, run, merges } = fixture();
  args.project.automationMode = 'assisted';
  decision.actor = { id: 'reviewer', kind: 'agent', roles: ['cto-caio'] };
  decision.evidence.push({ kind: 'implementation-risk', riskLevel: 'low', subjectRefs: decision.evidence[0].subjectRefs });
  for (const review of ['interrogate', 'deep-review', 'edge-cases', 'security-review']) {
    run.nodeStates[review] = { status: 'completed', attempts: [
      { output: { reviewDisposition: { headSha: pr.headSha, status: 'pass' } } },
    ] };
  }
  args.github.getDependencyChanges = async pins => {
    assert.equal(pins.baseSha, pr.baseSha);
    assert.equal(pins.headSha, pr.headSha);
    return [];
  };
  const assessDeterministicRisk = () => ({ floor: 'low', neverAutoMerge: [], rules: ['test'] });
  args.authorAgentId = 'reviewer';
  await assert.rejects(mergeImplementation(args, { assessDeterministicRisk }), /owner approval/);
  args.authorAgentId = 'author';
  await assert.rejects(mergeImplementation(args, { assessDeterministicRisk: null }), /owner approval/);
  await assert.rejects(mergeImplementation(args, {
    assessDeterministicRisk: () => ({ ...assessDeterministicRisk(), neverAutoMerge: ['iam'] }),
  }), /owner approval/);
  await assert.rejects(mergeImplementation(args, {
    assessDeterministicRisk: () => ({ ...assessDeterministicRisk(), floor: 'medium' }),
  }), /owner approval/);
  run.nodeStates.interrogate.attempts[0].output.reviewDisposition.status = 'not-run';
  await assert.rejects(mergeImplementation(args, { assessDeterministicRisk }), /owner approval/);
  run.nodeStates.interrogate.attempts[0].output.reviewDisposition.status = 'pass';
  const receipt = await mergeImplementation(args, { assessDeterministicRisk });
  assert.equal(receipt.riskLevel, 'low');
  assert.deepEqual(receipt.rules, ['test']);
  assert.equal(receipt.autoMerged, true);
  assert.equal(merges(), 1);
});

test('assisted mode accepts the aggregated review-head evidence and forwards project risk config', async () => {
  const { args, decision, pr, run, merges } = fixture();
  args.project = { ...args.project, automationMode: 'assisted', ciPaths: ['ops/ci/'], riskRules: [{ id: 'custom' }] };
  args.authorAgentId = 'author';
  decision.actor = { id: 'reviewer', kind: 'agent', roles: ['cto-caio'] };
  decision.evidence.push({ kind: 'implementation-risk', riskLevel: 'low', subjectRefs: decision.evidence[0].subjectRefs });
  const review = findings => ({ status: 'completed', findings });
  const reviews = { interrogate: review([]), 'deep-review': review([{ severity: 'P1', disposition: 'fixed' }]),
    'edge-cases': review([{ severity: 'nit' }]), 'security-review': review([]) };
  run.nodeStates['review-head'] = { status: 'completed', attempts: [
    { output: { adlcProductMethods: { pr_reviews: { headSha: pr.headSha, reviews } } } },
  ] };
  args.github.getDependencyChanges = async () => [];
  let seen;
  const assessDeterministicRisk = input => { seen = input; return { floor: 'low', neverAutoMerge: [], rules: [] }; };

  reviews['security-review'] = review([{ severity: 'P2', disposition: 'open' }]);
  await assert.rejects(mergeImplementation(args, { assessDeterministicRisk }), /owner approval/);
  reviews['security-review'] = review([]);
  run.nodeStates['review-head'].attempts[0].output.adlcProductMethods.pr_reviews.headSha = 'f'.repeat(40);
  await assert.rejects(mergeImplementation(args, { assessDeterministicRisk }), /owner approval/);
  run.nodeStates['review-head'].attempts[0].output.adlcProductMethods.pr_reviews.headSha = pr.headSha;

  const receipt = await mergeImplementation(args, { assessDeterministicRisk });
  assert.equal(receipt.autoMerged, true);
  assert.deepEqual(seen.ciPaths, ['ops/ci/']);
  assert.deepEqual(seen.riskRules, [{ id: 'custom' }]);
  assert.equal(merges(), 1);
});
