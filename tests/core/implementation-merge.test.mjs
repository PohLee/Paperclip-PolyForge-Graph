import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GraphEngine, MemoryStore } from '../../src/core/index.mjs';
import { createImplementationGitHubAdapter } from '../../src/host/implementation-github.mjs';
import { approvalBody, approvalTime, authoredProposal, publicationGitHub, repositoryId, root, sha256 } from '../helpers/g2-publication-fixture.mjs';
import { mergeImplementation } from '../../src/host/implementation-merge.mjs';

function fixture() {
  const baseSha = 'a'.repeat(40), headSha = 'b'.repeat(40), mergeCommitSha = 'c'.repeat(40);
  const type = 'implementation-merge-approval';
  const decision = { id: 'approval', nodeId: 'gate', type, status: 'decided', outcome: 'accept',
    actor: { id: 'owner', kind: 'human', roles: ['human-owner'] },
    evidence: [{ subjectRefs: [{ artifactId: 'pr:org/repo#1', version: headSha }, { artifactId: 'qa', version: 'rev' }] }] };
  const run = { mode: 'assisted', contract_pins: [{ section: 'product', contractId: 'PRD-0042', commit: baseSha }], input: { projectId: 'project' }, graph: { nodes: [{ id: 'gate', decisionType: type, candidateNodes: ['prepare'] }] },
    nodeStates: { prepare: { status: 'completed', attempts: [], artifacts: [
      { id: 'pr:org/repo#1', version: headSha }, { id: 'qa', version: 'rev' },
    ] }, gate: { status: 'completed', attempts: [{ decisionId: decision.id }] } } };
  const pr = { headSha, baseSha, baseRef: 'main', changes: [{ path: 'src/app.mjs' }] };
  const judge = { status: 'pass', gaps: [] };
  const engine = {
    getAudit: async () => run.contract_pins.map(({ contractId }) => ({ kind: 'contract.merged',
      projectId: 'project', repository: 'org/repo', contractId, lockDigest: '0'.repeat(64) })),
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
  f.pr.changes[0].previousPath = 'knowledge/contracts/INDEX.json';
  await assert.rejects(mergeImplementation(f.args), /outside contract paths/);
  for (const spelling of ['knowledge/contractſ/INDEX.json', 'KNOWLEDGE/ｃｏｎｔｒａｃｔｓ/INDEX.json']) {
    const g = fixture();
    g.pr.changes[0].previousPath = spelling;
    await assert.rejects(mergeImplementation(g.args), /outside contract paths/);
  }
  for (const contractsRoot of ['équipe/contracts', 'knowledge/contracts/']) {
    const g = fixture();
    g.args.project.contractsRoot = contractsRoot;
    await assert.rejects(mergeImplementation(g.args), /Invalid contracts root/);
  }
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

  Object.assign(args.project, { automationMode: 'full-auto', allowFullAuto: true });
  await assert.rejects(mergeImplementation(args, {
    assessDeterministicRisk: () => ({ floor: 'medium', neverAutoMerge: [], rules: [] }),
  }), /owner approval/);
  assert.equal(merges(), 0);

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


for (const condition of ['intact', 'edited file', 'deleted file', 'older lock', 'unreceipted folder', 'unrelated unreceipted folder', 'moved folder', 'removed index entry', 'legacy product receipt',
  'changed legacy product lock', 'transient blob failure']) {
  test('G5 checks approved contract bytes (' + condition + ')', async () => {
    const { args, run, decision, pr, merges } = fixture();
    const { github } = args;
    const manifest = { id: 'manifest', revisionId: 'r1', bytes: Buffer.from(JSON.stringify(approvalBody())) };
    const first = authoredProposal({ id: 'first', at: approvalTime }, manifest);
    const latest = authoredProposal({ id: 'replacement', at: approvalTime }, manifest, { ...first, commit: 'e'.repeat(40) });
    const folder = root + '/' + latest.folder;
    const lockPath = folder + '/contract.lock.json';
    const productPath = folder + '/product/prd.md';
    const tree = new Map(latest.tree);
    if (condition === 'unrelated unreceipted folder') {
      tree.set(root + '/2026/09/26091007_feat-extra_PRC-000000000001/product/prd.md', Buffer.from('unapproved folder'));
    }
    if (condition === 'edited file') tree.set(productPath, Buffer.from('unapproved edit'));
    if (condition === 'deleted file') tree.delete(productPath);
    if (['older lock', 'changed legacy product lock'].includes(condition)) tree.set(lockPath, first.tree.get(lockPath));
    const indexPath = root + '/INDEX.json';
    if (condition === 'removed index entry') tree.set(indexPath, Buffer.from('[]'));
    if (condition === 'moved folder') {
      const moved = latest.folder.replace('26091007', '26091008');
      for (const [path, bytes] of latest.tree) if (path.startsWith(folder + '/')) {
        tree.delete(path);
        tree.set(path.replace(latest.folder, moved), bytes);
      }
      tree.set(indexPath, Buffer.from(JSON.stringify([{ contractId: latest.contractId, folder: moved, status: 'active' }])));
    }
    const receiptCommit = 'd'.repeat(40);
    run.id = args.runId;
    run.status = 'completed';
    Object.assign(run.contract_pins[0], { contractId: latest.contractId, commit: receiptCommit });
    const store = new MemoryStore();
    const engine = args.engine = new GraphEngine({ store });
    await store.write({ revision: 1, packs: {}, idempotency: {}, decisions: [{ ...decision, runId: run.id }],
      runs: { [run.id]: run }, audit: [] }, 0);
    if (condition !== 'unreceipted folder') {
      const receipt = { repository: args.project.repository, contractId: latest.contractId, section: 'product',
        mergeCommitSha: receiptCommit, pullNumber: 42, supersedes: null };
      if (!condition.includes('legacy')) Object.assign(receipt, { folder, lockDigest: sha256(latest.tree.get(lockPath)) });
      await engine.recordContractMerge(run.id, receipt);
    }
    const remote = publicationGitHub(args.project.repository, latest);
    remote.commit(receiptCommit, latest.tree);
    remote.commit(pr.baseSha, tree, [receiptCommit]);
    const adapter = createImplementationGitHubAdapter({ getInstallationToken: async () => 'repo-token',
      installedValidator: {
        async readVerificationCriteria(_input, { readFile }) { return JSON.parse(await readFile(folder + '/product/criteria.json')); },
        judgeVerificationManifest: () => ({ status: 'pass', gaps: [] }),
      },
      fetch: async (url, options) => {
        if (condition === 'transient blob failure' && url.includes('/contents/' + productPath)) {
          return new Response(null, { status: 503 });
        }
        return remote.fetch(url.replace('/repos/org/repo/', '/repositories/' + repositoryId + '/'), options);
      },
    });
    github.loadValidator = adapter.loadValidator;
    args.manifest.bytes = JSON.stringify({ ...JSON.parse(args.manifest.bytes), expectedScenarios: ['AC-7'] });
    if (['intact', 'unrelated unreceipted folder', 'legacy product receipt'].includes(condition)) {
      await mergeImplementation(args);
      assert.equal(merges(), 1);
    } else {
      await assert.rejects(mergeImplementation(args), condition === 'transient blob failure' ? { status: 503 } : { code: 'contract-drift' });
      assert.equal(merges(), 0);
    }
  });
}
