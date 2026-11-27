import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonical } from '../../src/core/canonical.mjs';
import { contractProposalLocation, derivePublication, publicationCriteria, validatePublicationText } from '../../src/host/contract-publication.mjs';
import { contractPublicationDisposition } from '../../src/host/contract-publication-causes.mjs';
import { approvalBody, approvalTime, authoredProposal, base, contents, head, merge, root } from '../helpers/g2-publication-fixture.mjs';

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
    manifestId: 'manifest', revisionId: 'r1', manifestDigest: JSON.parse(proposed.tree.get(root + '/' + proposed.folder + '/contract.lock.json')).approvalManifest.digest };
  const lockPath = root + '/' + proposed.folder + '/contract.lock.json';
  const mainTree = new Map(proposed.tree);
  const mainLock = JSON.parse(mainTree.get(lockPath));
  mainLock.supersedes = head;
  mainTree.set(lockPath, Buffer.from(JSON.stringify(mainLock)));
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
  }), { publicationCause: 'contract-supersedes-stale' });
});

test('malformed main index and lock block configuration with distinct causes', async () => {
  const body = approvalBody();
  const pinned = authoredProposal(decision, manifest(body));
  const lockPath = root + '/' + pinned.folder + '/contract.lock.json';
  const { approvalManifest } = JSON.parse(pinned.tree.get(lockPath));
  const currentReceipt = { contractId: pinned.contractId, mergeCommitSha: merge, supersedes: null,
    manifestId: approvalManifest.id, revisionId: approvalManifest.revisionId, manifestDigest: approvalManifest.digest };
  for (const [path, reason] of [[indexPath, 'contract-index-invalid'], [lockPath, 'contract-lock-invalid']]) {
    const mainTree = new Map(pinned.tree).set(path, Buffer.from('{'));
    await assert.rejects(derive({ ...body, supersedes: merge }, mainTree, {
      priorTree: pinned.tree, currentReceipt, containsCommit: async () => true,
    }), error => {
      assert.deepEqual(contractPublicationDisposition(error), { state: 'blocked-config', reason });
      return true;
    });
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
