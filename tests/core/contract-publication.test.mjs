import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertContractPublication } from '../../src/plugin/adlc-contract-verify.mjs';
import { canonical } from '../../src/core/canonical.mjs';
import { contractProposalLocation, derivePublication, publicationCriteria, readApprovedContract, validatePublicationText } from '../../src/host/contract-publication.mjs';
import { approvalBody, approvalTime, authoredProposal, base, contents, merge, root, sha256 } from '../helpers/g2-publication-fixture.mjs';

const decision = { id: 'g2-decision-7', at: approvalTime };
const run = { input: { backlogItemRef: 'BACKLOG-7' } };
const project = {};
const indexPath = root + '/INDEX.json';
const manifest = body => ({ id: 'manifest', revisionId: 'r1', bytes: Buffer.from(canonical({ id: 'manifest', version: 'r1', ...body })) });
function derive(body = approvalBody(), pinned = new Map([[indexPath, Buffer.from('[]\n')]]), extras = {}) {
  const { priorTree, ...binding } = extras;
  const trees = new Map([[base, pinned], [merge, priorTree]]);
  return derivePublication({ binding: { decision, manifest: manifest(body), ...binding }, pinnedMain: base, project, run,
    section: 'product', readApprovedDeliverable: ({ key }) => contents.get(key), readMain: (path, sha) => trees.get(sha)?.get(path) });
}

test('first and replacement publication match independently authored bytes', async () => {
  const body = approvalBody();
  const proposed = authoredProposal(decision, manifest(body));
  const plan = await derive(body);
  assert.deepEqual(plan.changes, proposed.tree);
  assert.deepEqual(plan.deliverables.get('interaction-design'), contents.get('interaction-design'));
  const location = contractProposalLocation({ project, decision, manifest: body });
  assert.equal(location.branch, 'contract/feat-orders_' + plan.contractId);
  assert.match(location.folder, /^2026\/09\/26091007_feat-orders_PRC-\d{12}$/);
  const replacement = { ...body, supersedes: merge, contract: { type: 'fix', slug: 'renamed-orders' } };
  const receipt = { contractId: plan.contractId, mergeCommitSha: merge, supersedes: null,
    decisionId: decision.id, manifestId: 'manifest', revisionId: 'r1',
    manifestDigest: JSON.parse(proposed.tree.get(root + '/' + proposed.folder + '/contract.lock.json')).approvalManifest.digest };
  const lockPath = root + '/' + proposed.folder + '/contract.lock.json';
  const mainTree = new Map(proposed.tree);
  receipt.lockDigest = sha256(mainTree.get(lockPath));
  const replacementDecision = { ...decision, id: 'distinct-replacement-decision' };
  const updated = await derive(replacement, mainTree, { decision: replacementDecision, priorTree: proposed.tree,
    currentReceipt: receipt, containsCommit: async (commit, main) => commit === merge && main === base });
  const expected = authoredProposal(replacementDecision, manifest(replacement), { ...proposed, commit: merge });
  assert.deepEqual(updated.changes, new Map([[lockPath, expected.tree.get(lockPath)]]));
  assert.equal(updated.contractId, plan.contractId);
  assert.notEqual(updated.contractId, contractProposalLocation({ project, decision: replacementDecision, manifest: replacement }).contractId);
  assert.equal(updated.currentRevision, merge);
  const forgedPrior = new Map(proposed.tree);
  const forgedLock = JSON.parse(forgedPrior.get(lockPath));
  forgedLock.files.find(file => file.path === 'product/prd.md').digest = '0'.repeat(64);
  forgedPrior.set(lockPath, Buffer.from(JSON.stringify(forgedLock)));
  await assert.rejects(derive(replacement, proposed.tree, {
    priorTree: forgedPrior, currentReceipt: receipt, containsCommit: async () => true,
  }), { publicationCause: 'contract-drift' });
});

test('a malformed main index and changed lock bytes have distinct causes', async () => {
  const body = approvalBody();
  const pinned = authoredProposal(decision, manifest(body));
  const lockPath = root + '/' + pinned.folder + '/contract.lock.json';
  const { approvalManifest } = JSON.parse(pinned.tree.get(lockPath));
  const currentReceipt = { contractId: pinned.contractId, mergeCommitSha: merge, supersedes: null, lockDigest: sha256(pinned.tree.get(lockPath)),
    decisionId: decision.id, manifestId: approvalManifest.id,
    revisionId: approvalManifest.revisionId, manifestDigest: approvalManifest.digest };
  for (const [path, reason] of [[indexPath, 'contract-index-invalid'], [lockPath, 'contract-drift']]) {
    const mainTree = new Map(pinned.tree).set(path, Buffer.from('{'));
    await assert.rejects(derive({ ...body, supersedes: merge }, mainTree, {
      priorTree: pinned.tree, currentReceipt, containsCommit: async () => true,
    }), { publicationCause: reason });
  }
});

for (const source of ['pinned main', 'the proven commit']) {
  test('replacement refuses a changed product decision ID at ' + source, async () => {
    const body = approvalBody();
    const { tree, contractId, folder } = authoredProposal(decision, manifest(body));
    const lockPath = root + '/' + folder + '/contract.lock.json';
    const lock = JSON.parse(tree.get(lockPath));
    const { id, revisionId, digest } = lock.approvalManifest;
    const currentReceipt = { contractId, decisionId: decision.id, mergeCommitSha: merge, supersedes: null,
      manifestId: id, revisionId, manifestDigest: digest, lockDigest: sha256(tree.get(lockPath)) };
    lock.sections.product.decisionId = 'different-decision';
    const forged = new Map(tree).set(lockPath, Buffer.from(JSON.stringify(lock)));
    await assert.rejects(derive({ ...body, supersedes: merge }, source === 'pinned main' ? forged : tree, {
      currentReceipt, priorTree: source === 'the proven commit' ? forged : tree, containsCommit: async () => true,
    }), { publicationCause: 'contract-drift' });
  });
}

test('replacement rejects a changed lock even when the original decision ID remains', async () => {
  const body = approvalBody();
  const { tree, contractId, folder } = authoredProposal(decision, manifest(body));
  const lockPath = root + '/' + folder + '/contract.lock.json';
  const { id, revisionId, digest } = JSON.parse(tree.get(lockPath)).approvalManifest;
  const currentReceipt = { contractId, decisionId: decision.id, mergeCommitSha: merge, supersedes: null,
    manifestId: id, revisionId, manifestDigest: digest, lockDigest: sha256(tree.get(lockPath)) };
  for (const approvalManifest of [undefined, null, 'manifest', { id, revisionId }, { id, revisionId, digest: 'bad' }]) {
    const lock = JSON.parse(tree.get(lockPath));
    lock.sections.product.approvalManifest = approvalManifest;
    const main = new Map(tree).set(lockPath, Buffer.from(JSON.stringify(lock)));
    await assert.rejects(derive({ ...body, supersedes: merge }, main, {
      currentReceipt, priorTree: tree, containsCommit: async () => true,
    }), { publicationCause: 'contract-drift' });
  }
});

test('criteria require a unique AC tag on every scenario', () => {
  const scenario = '  Scenario: Orders\n    Given a product\n';
  for (const feature of ['Feature: Orders\n' + scenario,
    'Feature: Orders\n  @AC-7\n' + scenario + '  @AC-7\n' + scenario]) {
    assert.throws(() => publicationCriteria(feature), { publicationCause: 'contract-criteria-invalid' });
  }
});

test('rejects a case-insensitive ID collision and missing or invalid type/slug', async () => {
  const expected = authoredProposal(decision, manifest(approvalBody()));
  const index = Buffer.from(JSON.stringify([{ contractId: expected.contractId.toLowerCase(), folder: expected.folder, status: 'withdrawn' }]));
  await assert.rejects(derive(approvalBody(), new Map([[indexPath, index]])), { message: 'contract-id-collision' });
  for (const contract of [undefined, { type: 'feat' }, { slug: 'orders' }, { type: 'other', slug: 'orders' }]) {
    await assert.rejects(derive({ ...approvalBody(), contract }), { message: 'contract-type-slug-missing' });
  }
});

test('rejects non-Latin letters in UTF-8 bytes, paths, and parsed JSON keys and values', async () => {
  for (const [path, bytes] of [
    ['safe/criteria.json', Buffer.from('{"\\u4e2d":"hello"}')],
    ['safe/criteria.json', Buffer.from('{"english":["\\u0430"]}')],
    ['safe/\u4e2d.md', Buffer.from('English')],
    ['safe/prd.md', Buffer.from('Hello \u4e2d')],
    ['safe/prd.md', Buffer.from([0xff])],
  ]) assert.throws(() => validatePublicationText(path, bytes), { message: 'contract-not-english' });
  assert.doesNotThrow(() => validatePublicationText('safe/prd.md', Buffer.from('Caf\u00e9 \u{1f44b}')));
});


test('a missing slug uses the trusted English epic title and truncates at a word boundary', async () => {
  const body = { ...approvalBody(), contract: { type: 'feat' } };
  const title = 'Orders for customers everywhere requested by the shipping team';
  assert.match(contractProposalLocation({ project, decision, manifest: body, epicTitle: title }).branch,
    /^contract\/feat-orders-for-customers-everywhere_PRC-/);
  assert.throws(() => contractProposalLocation({ project, decision, manifest: body, epicTitle: '\u8ba2\u5355' }),
    { publicationCause: 'contract-type-slug-missing' });
});

test('approved reads propagate a transient file error and reject an index redirect', async () => {
  const proposal = authoredProposal(decision, manifest(approvalBody()));
  const folder = root + '/' + proposal.folder;
  const receipt = { contractId: proposal.contractId, folder, mergeCommitSha: merge,
    lockDigest: sha256(proposal.tree.get(folder + '/contract.lock.json')) };
  const input = { contractId: receipt.contractId, contractsRoot: root, receipt };
  const unavailable = new Error('GitHub unavailable');
  await assert.rejects(readApprovedContract(input, () => { throw unavailable; }), error => error === unavailable);
  const moved = proposal.folder.replace('26091007', '26091008');
  const tree = new Map([...proposal.tree].map(([path, bytes]) => [path.replace(proposal.folder, moved), bytes]));
  tree.set(indexPath, Buffer.from(JSON.stringify([{ contractId: receipt.contractId, folder: moved, status: 'active' }])));
  await assert.rejects(readApprovedContract(input, path => tree.get(path)), { code: 'contract-drift' });
});

test('landed comparison binds its own index entry and the exact contract folder', async () => {
  const plan = await derive();
  const tree = new Map(plan.publication);
  const unrelated = { contractId: 'PRC-000000000001', folder: '2026/09/26091007_feat-extra_PRC-000000000001', status: 'active' };
  const entries = () => new Map([...tree.keys()].map(path => [path, { type: 'blob' }]));
  const compare = () => assertContractPublication(entries(), path => tree.get(path), plan);
  tree.set(indexPath, Buffer.from(JSON.stringify([unrelated, plan.indexEntry], null, 2) + '\n'));
  await compare();
  tree.set(plan.folder + '/product/extra.md', Buffer.from('extra'));
  await assert.rejects(compare(), { code: 'contract-proposal-differs' });
  tree.delete(plan.folder + '/product/extra.md');
  tree.set(indexPath, Buffer.from(JSON.stringify([plan.indexEntry, plan.indexEntry], null, 2) + '\n'));
  await assert.rejects(compare(), { code: 'contract-proposal-differs' });
});
