import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchReceiptNotice } from '../../src/plugin/ui-dispatch-notice.mjs';

test('unconfirmed effects remain visible alongside successful dispatches', () => {
  const unknown = { nodeId: 'design', status: 'effect_unknown' };
  const notice = dispatchReceiptNotice([
    { nodeId: 'brief', status: 'woken' }, unknown, unknown,
    { nodeId: 'build', status: 'assignment_pending' },
  ]);
  assert.match(notice, /design: Issue creation is awaiting confirmation/);
  assert.match(notice, /build: Assignment is awaiting confirmation/);
  assert.equal(notice.split('design:').length, 2);
});

test('a contradictory receipt or confirmed failure gives a distinct recovery action', () => {
  for (const status of ['effect_mismatched', 'effect_ambiguous', 'effect_orphaned']) {
    assert.match(dispatchReceiptNotice([{ nodeId: 'design', status }]), /origin and parent/);
  }
  assert.match(dispatchReceiptNotice([{ nodeId: 'design', status: 'effect_confirmed_failure' }]), /creation failed/);
  assert.match(dispatchReceiptNotice([{ nodeId: 'design', status: 'ownership_conflict' }]), /assigned to a human.*Resolve ownership in Paperclip/);
  assert.equal(dispatchReceiptNotice([{ nodeId: 'design', status: 'woken' }]), '');
  assert.equal(dispatchReceiptNotice(), '');
});
