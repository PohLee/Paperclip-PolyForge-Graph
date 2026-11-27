import test from 'node:test';
import assert from 'node:assert/strict';
import { validateContractConfiguration } from '../../src/core/evidence-contracts.mjs';

const verify = id => ({ id, type: 'task', role: 'qa', outputContract: 'verification-report',
  produces: [`${id}_report`], review: { supervisorRole: 'lead' } });
const matrix = { id: 'matrix', type: 'task', role: 'qa', outputContract: 'acceptance-matrix',
  produces: ['acceptance_matrix'], verificationReportSources: ['browser', 'cli'] };

function graph(nodes, edges) {
  return { id: 'verification', version: '1', start: 'route', nodes, edges };
}

test('acceptance matrix report sources on parallel branches before an ALL join are accepted', () => {
  assert.doesNotThrow(() => validateContractConfiguration(graph([
    { id: 'route', type: 'task', role: 'qa' }, verify('browser'), verify('cli'),
    { id: 'ready', type: 'join', mode: 'all' }, matrix,
  ], [
    { from: 'route', to: 'browser' }, { from: 'route', to: 'cli' },
    { from: 'browser', to: 'ready' }, { from: 'cli', to: 'ready' }, { from: 'ready', to: 'matrix' },
  ])));
});

test('acceptance matrix report sources on alternative branches are rejected', () => {
  assert.throws(() => validateContractConfiguration(graph([
    { id: 'route', type: 'decision', role: 'qa' }, verify('browser'), verify('cli'), matrix,
  ], [
    { from: 'route', to: 'browser', when: 'browser' }, { from: 'route', to: 'cli', when: 'cli' },
    { from: 'browser', to: 'matrix' }, { from: 'cli', to: 'matrix' },
  ])), /report source browser must run on every path to matrix/);
});
