import test from 'node:test';
import assert from 'node:assert/strict';
import { runE2E } from '../../scripts/e2e.mjs';

test('Paperclip Docker plugin dispatches real process agents through all MVP Graphs', {
  skip: process.env.POLYFORGE_RUN_DOCKER_E2E !== '1', timeout: 900_000
}, async () => {
  const result = await runE2E();
  assert.deepEqual(Object.keys(result.completed), ['ui-ux-design', 'implementation', 'verification']);
  assert.equal(result.restarted, true);
});
