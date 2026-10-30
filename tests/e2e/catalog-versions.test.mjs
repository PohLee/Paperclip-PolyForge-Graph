import test from 'node:test';
import assert from 'node:assert/strict';
import { latestPackReleases, selectPack } from '../../src/plugin/catalog.mjs';

test('installed immutable versions remain selectable while managed resources use one newest release', () => {
  const releases = [{ id: 'adlc', version: '0.2.3' }, { id: 'marketing', version: '0.0.3' },
    { id: 'adlc', version: '0.2.1' }, { id: 'marketing', version: '0.0.1' }];
  assert.equal(selectPack(releases, 'adlc', '0.2.1'), releases[2]);
  assert.equal(selectPack(releases, 'adlc'), releases[0]);
  assert.deepEqual(latestPackReleases(releases), releases.slice(0, 2));
  assert.throws(() => selectPack(releases, 'missing'), /not installed/);
});
