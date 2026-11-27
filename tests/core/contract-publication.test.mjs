import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonical } from '../../src/core/canonical.mjs';
import { contractProposalLocation, derivePublication, validatePublicationText } from '../../src/host/contract-publication.mjs';
import { approvalBody, approvalTime, authoredProposal, base, contents, merge, root } from '../helpers/g2-publication-fixture.mjs';

const decision = { id: 'g2-decision-7', at: approvalTime };
const run = { input: { backlogItemRef: 'BACKLOG-7' } };
const project = {};
const indexPath = root + '/INDEX.json';
const manifest = body => ({ id: 'manifest', revisionId: 'r1', bytes: Buffer.from(canonical({ id: 'manifest', version: 'r1', ...body })) });
function derive(body = approvalBody(), pinned = new Map([[indexPath, Buffer.from('[]\n')]]), extras = {}) {
  return derivePublication({ binding: { decision, manifest: manifest(body), ...extras }, pinnedMain: base, project, run,
    section: 'product', readApprovedDeliverable: ({ key }) => contents.get(key), readMain: path => pinned.get(path) });
}

test('first and replacement publication match independently authored bytes', async () => {
  const body = approvalBody();
  const proposed = authoredProposal(decision, manifest(body));
  const plan = await derive(body);
  assert.deepEqual(plan.changes, proposed.tree);
  const location = contractProposalLocation({ project, decision, manifest: body });
  assert.equal(location.branch, 'contract/feat-orders_' + plan.contractId);
  assert.match(location.folder, /^2026\/09\/26091007_feat-orders_PRC-\d{12}$/);
  const replacement = { ...body, supersedes: merge, contract: { type: 'fix', slug: 'renamed-orders' } };
  const receipt = { contractId: plan.contractId, mergeCommitSha: merge, supersedes: null,
    manifestId: 'manifest', revisionId: 'r1', manifestDigest: JSON.parse(proposed.tree.get(root + '/' + proposed.folder + '/contract.lock.json')).approvalManifest.digest };
  const updated = await derive(replacement, proposed.tree, { currentReceipt: receipt, containsCommit: async () => true });
  const expected = authoredProposal(decision, manifest(replacement), { ...proposed, commit: merge });
  const lockPath = root + '/' + proposed.folder + '/contract.lock.json';
  assert.deepEqual(updated.changes, new Map([[lockPath, expected.tree.get(lockPath)]]));
  assert.equal(updated.contractId, plan.contractId);
  assert.equal(updated.currentRevision, merge);
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
