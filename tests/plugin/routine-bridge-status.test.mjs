import test from 'node:test';
import assert from 'node:assert/strict';
import { routineBridgeStatus } from '../../src/plugin/routine-bridge-status.mjs';

test('native schedule bridge is unavailable when the SDK cannot read detail or claim a witness', () => {
  const status = routineBridgeStatus({ routines: { managed: {
    get: async () => ({}), reconcile: async () => ({}), run: async () => ({}),
  } } });
  assert.deepEqual(status, {
    supported: false,
    missingMethods: ['getDetail', 'claimInvocation'],
    routines: ['polyforge:retro', 'polyforge:improvement-proposal'],
  });
});

test('native schedule bridge dependency check requires both host-owned APIs', () => {
  const status = routineBridgeStatus({ routines: { managed: {
    getDetail: async () => null,
    claimInvocation: async () => null,
  } } });
  assert.deepEqual(status.missingMethods, []);
  assert.equal(status.supported, true);
});
