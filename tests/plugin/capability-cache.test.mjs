import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityCache } from '../../src/plugin/capability-cache.mjs';

test('capabilities are cached per company, expire, and invalidation defeats a pending load', async () => {
  let clock = 0, calls = 0, release;
  const cache = createCapabilityCache(async company => {
    const version = ++calls;
    if (company === 'pending') await new Promise(resolve => { release = resolve; });
    return { company, version };
  }, { now: () => clock, ttl: 5 });
  assert.equal((await cache.get('a')).version, 1);
  assert.equal((await cache.get('a')).version, 1);
  assert.equal((await cache.get('b')).version, 2);
  cache.invalidate('a');
  assert.equal((await cache.get('a')).version, 3);
  clock = 6;
  assert.equal((await cache.get('b')).version, 4);
  const pending = cache.get('pending');
  await Promise.resolve();
  cache.invalidate('pending');
  release();
  await pending;
  const next = cache.get('pending');
  await Promise.resolve(); release();
  assert.equal((await next).version, 6);
});
