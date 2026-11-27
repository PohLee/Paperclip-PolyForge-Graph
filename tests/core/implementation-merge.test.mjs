import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeImplementation } from '../../src/host/implementation-merge.mjs';

function fixture() {
  const baseSha = 'a'.repeat(40), headSha = 'b'.repeat(40), mergeCommitSha = 'c'.repeat(40);
  const type = 'implementation-merge-approval';
  const decision = { id: 'approval', nodeId: 'gate', type, status: 'decided', outcome: 'accept',
    actor: { id: 'owner', kind: 'human', roles: ['human-owner'] },
    evidence: [{ subjectRefs: [{ artifactId: 'pr:org/repo#1', version: headSha }, { artifactId: 'qa', version: 'rev' }] }] };
  const run = { contract_pins: [{ section: 'product', contractId: 'PRD-0042', commit: baseSha }], input: { projectId: 'project' }, graph: { nodes: [{ id: 'gate', decisionType: type, candidateNodes: ['prepare'] }] },
    nodeStates: { prepare: { status: 'completed', attempts: [], artifacts: [
      { id: 'pr:org/repo#1', version: headSha }, { id: 'qa', version: 'rev' },
    ] }, gate: { status: 'completed', attempts: [{ decisionId: decision.id }] } } };
  const pr = { headSha, baseSha, baseRef: 'main', changes: [{ path: 'src/app.mjs' }] };
  const judge = { status: 'pass', gaps: [] };
  const engine = {
    getRun: async () => run, listDecisions: async () => [decision], assertCurrentContractPins: async () => {},
    recordImplementationMerge: async (_id, receipt) => { run.implementationMerges = [receipt]; return receipt; },
  };
  let merges = 0;
  const github = {
    getRef: async () => baseSha, getPullSnapshot: async () => pr, getMergeReceipt: async () => null,
    loadValidator: async () => ({ judgeVerificationManifest: () => judge, readVerificationCriteria: async () => [{ id: 'S1' }] }),
    getCheckStatus: async () => [{ name: 'build', status: 'completed', conclusion: 'success' }],
    merge: async (_request, authorize) => { await authorize(); merges++; return mergeCommitSha; },
  };
  return { decision, pr, judge, run, merges: () => merges, args: { engine, github, runId: 'run', pullNumber: 1,
    decisionId: decision.id, project: { id: 'project', repository: 'org/repo', ownerId: 'owner' },
    manifest: { id: 'qa', revisionId: 'rev', bytes: JSON.stringify({ checkoutSha: headSha, expectedScenarios: ['S1'], dimensions: [], results: [] }) } } };
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
  args.project = { ...args.project, automationMode: 'assisted', ciPaths: ['ops/ci/'], riskRules: [{ id: 'custom' }], neverAutoMerge: { 'database-migration': false } };
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
  assert.deepEqual(seen.neverAutoMerge, { 'database-migration': false });
  assert.equal(merges(), 1);
});

test('final G5 authorization blocks a required check that became pending', async () => {
  const { args, merges } = fixture();
  args.project.requiredChecks = ['build'];
  args.github.getCheckStatus = async () => [{ name: 'build', status: 'in_progress', conclusion: null }];
  await assert.rejects(mergeImplementation(args), /implementation checks/);
  assert.equal(merges(), 0);
});

test('G5 requires pins, fresh evidence after a pin update, and the full verification scope', async () => {
  let f = fixture();
  f.run.contract_pins = [];
  await assert.rejects(mergeImplementation(f.args), /non-empty contract pins/);
  f = fixture();
  f.run.contractPinsUpdatedAt = '2026-11-26T01:00:00Z';
  f.decision.at = '2026-11-26T02:00:00Z';
  await assert.rejects(mergeImplementation(f.args), /evidence predates/);
  f = fixture();
  f.args.project.verificationDimensions = ['browser'];
  await assert.rejects(mergeImplementation(f.args), /configured dimension/);
  f = fixture();
  const manifest = JSON.parse(f.args.manifest.bytes);
  f.args.manifest.bytes = JSON.stringify({ ...manifest, expectedScenarios: [] });
  await assert.rejects(mergeImplementation(f.args), /pinned product scenario/);
});

test('G5 rejects superseded candidates even when cited in approval evidence', async () => {
  for (const index of [0, 1]) {
    const { run, args } = fixture();
    const artifacts = run.nodeStates.prepare.artifacts;
    artifacts.push({ ...artifacts[index], version: 'new' });
    await assert.rejects(mergeImplementation(args), /current PR head and verification candidates/);
  }
});

test('G5 requires a product pin before verification scope is checked', async () => {
  const { run, args } = fixture();
  run.contract_pins[0].section = 'technical';
  await assert.rejects(mergeImplementation(args), /product contract pin/);
});
