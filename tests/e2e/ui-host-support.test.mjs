import test from 'node:test';
import assert from 'node:assert/strict';
import { graphHostIssue, runHostActions } from '../../src/plugin/ui-host-support.mjs';

test('Graph availability is scoped to the missing graph service, not the whole Pack', () => {
  const pack = { hostSupport: { available: false, unsupportedGraphs: [{ id: 'image', reason: 'Image provider is not configured' }] } };
  assert.equal(graphHostIssue(pack, 'image'), 'Image provider is not configured');
  assert.equal(graphHostIssue(pack, 'text'), null);
  assert.equal(graphHostIssue({}, 'old'), null);
  assert.match(graphHostIssue({ hostSupport: { available: false } }, 'unknown'), /trusted host adapter/);
});

test('blocked existing runs never offer mutation controls and only a human owner may validate', () => {
  const blocked = { available: false, recoverable: true };
  const owner = { kind: 'human', roles: ['human-owner'] };
  assert.deepEqual(runHostActions(blocked, owner), { blocked: true, canValidate: true });
  for (const viewer of [null, { kind: 'agent', roles: ['human-owner'] }, { kind: 'human', roles: ['cpo'] }]) {
    assert.deepEqual(runHostActions(blocked, viewer), { blocked: true, canValidate: false });
  }
  assert.equal(runHostActions({ available: false, recoverable: false }, owner).canValidate, false);
  assert.deepEqual(runHostActions({ available: true }, owner), { blocked: false, canValidate: false });
  assert.deepEqual(runHostActions(undefined, owner), { blocked: false, canValidate: false });
});
