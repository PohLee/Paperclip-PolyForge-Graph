import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from '../../src/core/canonical.mjs';
import { canonicalEvidence } from '../../src/host/evidence-provider.mjs';
import { canonicalPackJson } from '../../src/plugin/pack-snapshot.mjs';

test('shared canonical JSON preserves previous sorted bytes', () => {
  const value = { z: [ { b: 2, a: 1 }, null ], a: { y: true, x: 'text' } };
  const expected = '{"a":{"x":"text","y":true},"z":[{"a":1,"b":2},null]}';
  assert.equal(canonical(value), expected);
  assert.equal(canonicalEvidence(value), expected);
  assert.equal(canonicalPackJson(value), expected);
});
