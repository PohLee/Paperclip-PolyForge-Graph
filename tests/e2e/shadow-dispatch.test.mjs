import assert from 'node:assert/strict';
import test from 'node:test';
import { createDispatch } from '../../src/plugin/dispatch.mjs';

const run = { id: 'run', status: 'running', packId: 'adlc', nodeStates: { qa: { status: 'pending' } },
  graph: { nodes: [{ id: 'qa', role: 'qa-engineer',
    shadow: { trigger: 'before-dispatch', reviewer: 'same-agent', required: true } }] } };
const engine = { getRun: async () => run,
  getWorkItems: async () => [{ kind: 'task', role: 'qa-engineer', nodeId: 'qa', phase: 'work' }] };
const config = { roleBindings: { 'adlc:qa-engineer': 'qa-native-agent' } };

test('required graph Shadow fails closed when execution runtime is unavailable', async () => {
  const dispatch = createDispatch({ db: {} }, null, null, {});
  await assert.rejects(dispatch.dispatchReady('company', engine, 'run', config),
    /Required Shadow execution runtime unavailable/);
});

test('pending and rejected Graph Shadows prevent native parent dispatch', async () => {
  for (const status of ['waiting_shadow', 'shadow_rework_required', 'needs-repair']) {
    let checked = 0, nativeCalls = 0;
    const dispatch = createDispatch({ db: {}, agents: { get() { nativeCalls++; } } },
      null, null, { get() { nativeCalls++; } }, {
        async beforeDispatch(input) {
          checked++;
          assert.equal(input.companyId, 'company');
          assert.equal(input.agentId, 'qa-native-agent');
          assert.equal(input.run, run);
          return { ready: false, status };
        },
      });
    const result = await dispatch.dispatchReady('company', engine, 'run', config);
    assert.equal(result[0].status, status);
    assert.equal(checked, 1);
    assert.equal(nativeCalls, 0);
  }
});
